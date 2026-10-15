#include "render/gpu_canvas_internal.h"
#include "render/canvas_c.h"
#include "render/gpu_metal.h"
#import <Metal/Metal.h>
#include <cstdio>
#include <cstring>

int main()
{
    PuGpuDevice probe;
    probe.options.strict = true;
    if (!pu_gpu_device_open(&probe)) {
        std::fprintf(stderr, "Native Metal probe failed: %s\n", probe.error.c_str());
        return probe.failure == PuGpuFailure::NoHardware ? 77 : 1;
    }
    if (probe.info.type != PuGpuType::MetalGpu) {
        pu_gpu_device_close(&probe);
        return 1;
    }
    pu_gpu_device_close(&probe);
    auto get_display
        = reinterpret_cast<decltype(&eglGetCurrentDisplay)>(pu_gpu_proc("eglGetCurrentDisplay"));
    auto get_context
        = reinterpret_cast<decltype(&eglGetCurrentContext)>(pu_gpu_proc("eglGetCurrentContext"));
    auto get_surface
        = reinterpret_cast<decltype(&eglGetCurrentSurface)>(pu_gpu_proc("eglGetCurrentSurface"));
    auto get_api = reinterpret_cast<decltype(&eglQueryAPI)>(pu_gpu_proc("eglQueryAPI"));
    if (!get_display || !get_context || !get_surface || !get_api)
        return 1;
    EGLDisplay display = get_display();
    EGLContext context = get_context();
    EGLSurface draw = get_surface(EGL_DRAW), read = get_surface(EGL_READ);
    EGLenum api = get_api();
    const auto restored = [&]() {
        return get_display() == display && get_context() == context && get_surface(EGL_DRAW) == draw
            && get_surface(EGL_READ) == read && get_api() == api;
    };
    if (display != EGL_NO_DISPLAY || context != EGL_NO_CONTEXT)
        return 1;
    int failed = 0;
    @autoreleasepool {
        id<MTLDevice> owner = MTLCreateSystemDefaultDevice();
        id<MTLCommandQueue> queue = [owner newCommandQueue];
        id<MTLBuffer> buffer = [owner newBufferWithLength:256 options:MTLResourceStorageModeShared];
        if (!owner || !queue || !buffer)
            return 1;
        const auto native_blit = [&]() {
            id<MTLCommandBuffer> command = [queue commandBuffer];
            id<MTLBlitCommandEncoder> encoder = [command blitCommandEncoder];
            if (!command || !encoder)
                return false;
            [encoder fillBuffer:buffer range:NSMakeRange(0, 256) value:0x5a];
            [encoder endEncoding];
            [command commit];
            [command waitUntilCompleted];
            if (command.status != MTLCommandBufferStatusCompleted || command.error) {
                const char* reason = command.error.localizedDescription.UTF8String;
                std::fprintf(stderr, "Native owning Metal queue failed: %s\n",
                    reason ? reason : "command did not complete");
                return false;
            }
            const auto* bytes = static_cast<const unsigned char*>(buffer.contents);
            if (!bytes)
                return false;
            for (int i = 0; i < 256; ++i)
                if (bytes[i] != 0x5a)
                    return false;
            return restored();
        };
        if (!native_blit())
            failed = 1;
        for (int i = 0; i < 8; ++i) {
            PuCanvas* canvas = pu_canvas_create(8, 8);
            PuGpuCanvas* gpu = pu_canvas_acquire_gpu(canvas, 1, 1, 1, 0, 1, i & 1 ? 1 : 2, 1);
            if (!gpu) {
                failed = 1;
                pu_canvas_destroy(canvas);
                break;
            }
            {
                PuGpuCurrent current(&gpu->device);
                if (!current.ok())
                    failed = 1;
                else {
                    pu_gles()->ClearColor(0, 1, 0, 1);
                    pu_gles()->Clear(GL_COLOR_BUFFER_BIT);
                    ++gpu->revision;
                }
            }
            unsigned char pixels[8 * 8 * 4] = { };
            const unsigned char green[] = { 0, 255, 0, 255 };
            if (!pu_gpu_canvas_read(gpu, pixels, sizeof(pixels)) || memcmp(pixels, green, 4))
                failed = 1;
            if (!pu_canvas_resize(canvas, 16, 4) || !restored() || !native_blit())
                failed = 1;
            if (i & 1)
                pu_gpu_canvas_close(gpu);
            pu_canvas_destroy(canvas);
            if (!restored() || !native_blit())
                failed = 1;
        }
    }
    pu_render_shutdown();
    if (pu_gpu_canvas_live_contexts() || pu_canvas_live_backings() || !restored())
        failed = 1;
    std::puts(failed ? "FAIL: ANGLE/Metal owning-queue and no-EGL-state isolation"
                     : "PASS: real Metal queue pixels survive private GLES "
                       "contexts/readback/resize/loss/close; all tracked backings zero");
    return failed;
}
