// RenderEngine — Apple Metal backend (Ganesh) for PollyUI.
//
// Built ONLY on Apple targets, where CMake compiles this file and defines
// PU_METAL_BACKEND (which makes skia_c.cpp drop its create_metal stub and
// forward present/resize/destroy here). Everything downstream of `s->surface`
// — every fill/text/gradient/clip call in skia_c.cpp — is backend-agnostic and
// untouched: this file only owns surface creation and the per-frame drawable.
//
// Pipeline per frame (driven by the host, e.g. src/host/sdl/window_sdl.c):
//   pu_metal_begin_frame(s)  -> [layer nextDrawable] + wrap its texture as a
//                               Skia GPU SkSurface (s->surface)
//   app_paint(s, ...)        -> the usual Skia draw calls (skia_c.cpp)
//   pu_surface_present(s)    -> flush/submit + [commandBuffer presentDrawable]
//
// NOTE: written for manual reference counting (compile WITHOUT -fobjc-arc; the
// CMake Apple branch sets -fno-objc-arc). Header paths follow Skia's Ganesh
// Metal layout (m124+, the aseprite prebuilt); adjust if your Skia differs.

#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>

#include <new>

#include "render/skia_c.h"
#include "render/skia_internal.h"

#include "include/core/SkColorSpace.h"
#include "include/core/SkColorType.h"
#include "include/core/SkSurface.h"
#include "include/core/SkSurfaceProps.h"
#include "include/gpu/GrBackendSurface.h"
#include "include/gpu/GrDirectContext.h"
#include "include/gpu/ganesh/SkSurfaceGanesh.h"            // SkSurfaces::WrapBackendRenderTarget, FlushAndSubmit
#include "include/gpu/ganesh/mtl/GrMtlBackendContext.h"    // GrMtlBackendContext
#include "include/gpu/ganesh/mtl/GrMtlBackendSurface.h"    // GrBackendRenderTargets::MakeMetal
#include "include/gpu/ganesh/mtl/GrMtlDirectContext.h"     // GrDirectContexts::MakeMetal
#include "include/gpu/ganesh/mtl/GrMtlTypes.h"             // GrMtlTextureInfo

#include <cstdio>

#define PU_MTLLOG(msg) std::fprintf(stderr, "[metal] %s\n", msg)

// Apple-specific surface state, hung off PuSurface::metal (opaque void* there).
struct PuMetalState {
    id<MTLDevice>        device   = nil;
    id<MTLCommandQueue>  queue    = nil;
    CAMetalLayer        *layer    = nil;
    id<CAMetalDrawable>  drawable = nil;  // the drawable for the in-flight frame
};

// Wrap the current drawable's texture as a Skia GPU render-target surface.
static void wrap_drawable(PuSurface *s, PuMetalState *st) {
    GrMtlTextureInfo texInfo;
    texInfo.fTexture.retain((__bridge GrMTLHandle)st->drawable.texture);
    GrBackendRenderTarget backendRT =
        GrBackendRenderTargets::MakeMetal(s->width, s->height, texInfo);
    SkSurfaceProps props;
    s->surface = SkSurfaces::WrapBackendRenderTarget(
        s->grctx.get(), backendRT, kTopLeft_GrSurfaceOrigin,
        kBGRA_8888_SkColorType, nullptr, &props);
}

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
    layer.device          = device;
    layer.pixelFormat     = MTLPixelFormatBGRA8Unorm;
    layer.framebufferOnly  = NO;     // Skia may need to read back / blit
    layer.drawableSize     = CGSizeMake(width, height);

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

// Acquire the next drawable and (re)wrap the SkSurface. Must be called by the
// host immediately before the per-frame paint. No-op on non-Metal surfaces, so
// the SDL host can call it unconditionally on Apple.
void pu_metal_begin_frame(PuSurface *s) {
    if (!s || !s->metal) return;
    PuMetalState *st = (PuMetalState *)s->metal;
    @autoreleasepool {
        if (st->drawable) { [st->drawable release]; st->drawable = nil; }
        id<CAMetalDrawable> d = [st->layer nextDrawable];
        if (!d) { s->surface.reset(); return; }   // e.g. occluded; skip the frame
        st->drawable = [d retain];
        wrap_drawable(s, st);
    }
}

// Flush the recorded Skia work and present the drawable (called via
// pu_surface_present in skia_c.cpp).
void pu_metal_present(PuSurface *s) {
    if (!s || !s->metal) return;
    PuMetalState *st = (PuMetalState *)s->metal;
    if (s->surface) skgpu::ganesh::FlushAndSubmit(s->surface.get());
    @autoreleasepool {
        if (st->drawable) {
            id<MTLCommandBuffer> cb = [st->queue commandBuffer];
            [cb presentDrawable:st->drawable];
            [cb commit];
            [st->drawable release];
            st->drawable = nil;
        }
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
    if (st->drawable) { [st->drawable release]; st->drawable = nil; }
    [st->layer release];
    [st->queue release];
    [st->device release];
    delete st;
    s->metal = nullptr;
}

} // extern "C"
