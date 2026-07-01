// RenderEngine — Apple Metal backend (Ganesh) for PollyUI.
//
// Built ONLY on Apple targets, where CMake compiles this file and defines
// PU_METAL_BACKEND (which makes skia_c.cpp drop its create_metal stub and
// forward present/resize/destroy here). Everything downstream of `s->surface`
// — every fill/text/gradient/clip call in skia_c.cpp — is backend-agnostic and
// untouched: this file only owns surface creation and the per-frame drawable.
//
// Pipeline per frame (driven by the host, e.g. src/host/sdl/window_sdl.c):
//   pu_metal_begin_frame(s)  -> SkSurfaces::WrapCAMetalLayer (grabs the next
//                               CAMetalLayer drawable) -> s->surface
//   app_paint(s, ...)        -> the usual Skia draw calls (skia_c.cpp)
//   pu_surface_present(s)    -> flush/submit + present the drawable
//
// NOTE: manual reference counting (compile WITHOUT -fobjc-arc; the CMake Apple
// branch sets -fno-objc-arc). Verified against Skia m124's Ganesh Metal headers
// (the aseprite prebuilt header tree).

#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>

#include <new>

#include "render/skia_c.h"
#include "render/skia_internal.h"

#include "include/core/SkColorSpace.h"
#include "include/core/SkColorType.h"
#include "include/core/SkSurface.h"
#include "include/core/SkSurfaceProps.h"
#include "include/gpu/GrDirectContext.h"
#include "include/gpu/ganesh/SkSurfaceGanesh.h"            // skgpu::ganesh::FlushAndSubmit
#include "include/gpu/ganesh/mtl/GrMtlBackendContext.h"    // GrMtlBackendContext
#include "include/gpu/ganesh/mtl/GrMtlDirectContext.h"     // GrDirectContexts::MakeMetal
#include "include/gpu/ganesh/mtl/GrMtlTypes.h"             // GrMTLHandle
#include "include/gpu/ganesh/mtl/SkSurfaceMetal.h"         // SkSurfaces::WrapCAMetalLayer

#include <cstdio>

#define PU_MTLLOG(msg) std::fprintf(stderr, "[metal] %s\n", msg)

// Apple-specific surface state, hung off PuSurface::metal (opaque void* there).
struct PuMetalState {
    id<MTLDevice>       device   = nil;
    id<MTLCommandQueue> queue    = nil;
    CAMetalLayer       *layer    = nil;
    void               *drawable = nullptr;  // GrMTLHandle (id<CAMetalDrawable>) in flight
};

extern "C" {

// Public C ABI (declared in skia_c.h). Replaces the GL/raster stub on Apple.
PuSurface *pu_surface_create_metal(void *ca_metal_layer, int width, int height) {
    if (!ca_metal_layer) { PU_MTLLOG("create_metal: null CAMetalLayer"); return nullptr; }
    if (width  < 1) width  = 1;
    if (height < 1) height = 1;

    id<MTLDevice> device = MTLCreateSystemDefaultDevice();  // +1 owned
    if (!device) { PU_MTLLOG("no Metal device"); return nullptr; }
    id<MTLCommandQueue> queue = [device newCommandQueue];   // +1 owned

    CAMetalLayer *layer = (__bridge CAMetalLayer *)ca_metal_layer;
    layer.device                  = device;
    layer.pixelFormat             = MTLPixelFormatBGRA8Unorm;
    layer.framebufferOnly         = NO;     // Skia may need to read back / blit
    layer.presentsWithTransaction = YES;    // sync present with layer geometry -> clean live resize
    layer.drawableSize            = CGSizeMake(width, height);

    GrMtlBackendContext backendContext = {};
    backendContext.fDevice.retain((__bridge GrMTLHandle)device);
    backendContext.fQueue.retain((__bridge GrMTLHandle)queue);
    sk_sp<GrDirectContext> ctx = GrDirectContexts::MakeMetal(backendContext);
    if (!ctx) {
        PU_MTLLOG("GrDirectContexts::MakeMetal failed");
        [queue release];
        [device release];
        return nullptr;
    }
    ctx->setResourceCacheLimit(64 * 1024 * 1024);

    PuSurface *s = new (std::nothrow) PuSurface();
    if (!s) { [queue release]; [device release]; return nullptr; }
    s->gl     = true;   // GPU-backed: pu_surface_present must be called
    s->grctx  = ctx;
    s->width  = width;
    s->height = height;

    PuMetalState *st = new (std::nothrow) PuMetalState();
    st->device = device;          // take ownership of the +1
    st->queue  = queue;           // take ownership of the +1
    st->layer  = [layer retain];
    st->drawable = nil;
    s->metal = st;

    std::fprintf(stderr, "[render] GPU backend: Metal (%s)\n",
                 device.name ? device.name.UTF8String : "?");
    return s;
}

// Grab the next CAMetalLayer drawable and wrap it as the frame's SkSurface.
// Called by the host immediately before the per-frame paint.
void pu_metal_begin_frame(PuSurface *s) {
    if (!s || !s->metal) return;
    PuMetalState *st = (PuMetalState *)s->metal;
    if (st->drawable) { CFRelease(st->drawable); st->drawable = nullptr; }

    GrMTLHandle drawable = nullptr;
    SkSurfaceProps props;
    s->surface = SkSurfaces::WrapCAMetalLayer(
        s->grctx.get(), (__bridge GrMTLHandle)st->layer,
        kTopLeft_GrSurfaceOrigin, /*sampleCnt*/ 1, kBGRA_8888_SkColorType,
        /*colorSpace*/ nullptr, &props, &drawable);
    if (drawable) CFRetain(drawable);   // keep alive until present
    st->drawable = (void *)drawable;    // GrMTLHandle is const void*; store mutably
}

// Flush the recorded Skia work and present the drawable.
void pu_metal_present(PuSurface *s) {
    if (!s || !s->metal) return;
    PuMetalState *st = (PuMetalState *)s->metal;
    if (s->surface) skgpu::ganesh::FlushAndSubmit(s->surface.get());
    if (st->drawable) {
        id<CAMetalDrawable> d = (__bridge id<CAMetalDrawable>)st->drawable;
        id<MTLCommandBuffer> cb = [st->queue commandBuffer];
        [cb commit];
        if (st->layer.presentsWithTransaction) {
            /* Present in lockstep with the layer's geometry: no tearing/wobble
             * while the window is being live-resized. */
            [cb waitUntilScheduled];
            [d present];
        } else {
            [cb presentDrawable:d];
        }
        CFRelease(st->drawable);
        st->drawable = nullptr;
    }
    s->surface.reset();   // re-wrapped next begin_frame
}

void pu_metal_resize(PuSurface *s, int width, int height) {
    if (!s || !s->metal) return;
    if (width  < 1) width  = 1;
    if (height < 1) height = 1;
    PuMetalState *st = (PuMetalState *)s->metal;
    st->layer.drawableSize = CGSizeMake(width, height);
    s->width  = width;
    s->height = height;
    s->surface.reset();   // re-wrapped against the new size next begin_frame
}

void pu_metal_destroy(PuSurface *s) {
    if (!s || !s->metal) return;
    PuMetalState *st = (PuMetalState *)s->metal;
    s->surface.reset();
    if (s->grctx) { s->grctx->abandonContext(); s->grctx.reset(); }
    if (st->drawable) { CFRelease(st->drawable); st->drawable = nullptr; }
    [st->layer release];
    [st->queue release];
    [st->device release];
    delete st;
    s->metal = nullptr;
}

} // extern "C"
