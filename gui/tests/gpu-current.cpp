#include "render/gpu_canvas_internal.h"
#include "render/canvas_c.h"
#include <cstdio>
#include <cstring>

#ifdef __linux__
static PuGlProc resolve(void*, const char* name)
{
    return reinterpret_cast<PuGlProc>(pu_gpu_proc(name));
}
#endif
static const uint8_t green[] = { 0, 255, 0, 255 };
static const GLint expected_viewport[] = { 2, 3, 5, 7 };
static const GLfloat expected_color[] = { .25f, .5f, .75f, 1.f };
int main()
{
    PuGpuDevice ui;
    if (!pu_gpu_device_open(&ui)) {
        std::fprintf(stderr, "FAIL: real owning GLES context\n");
        return 1;
    }
    int failed = 0;
    {
        PuGpuCurrent owning(&ui);
        if (!owning.ok())
            return 1;
        auto gl = pu_gles();
        PuSurface* surface = nullptr;
#ifdef __linux__
        surface = pu_surface_create_current_gl(resolve, nullptr, 1, 1);
        if (!surface) {
            std::fprintf(stderr, "FAIL: borrowed Skia GLES surface\n");
            failed = 1;
        }
#endif
        if (!surface) {
            gl->Viewport(2, 3, 5, 7);
            gl->ClearColor(.25f, .5f, .75f, 1.f);
            gl->Enable(GL_SCISSOR_TEST);
            gl->Scissor(0, 0, 1, 1);
        }
        GLuint buffer = 0;
        const uint32_t marker[] = { 0x11223344, 0x55667788 };
        if (!surface) {
            gl->GenBuffers(1, &buffer);
            gl->BindBuffer(GL_ARRAY_BUFFER, buffer);
            gl->BufferData(GL_ARRAY_BUFFER, sizeof(marker), marker, GL_STATIC_DRAW);
        }
        GLint framebuffer = 0;
        gl->GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &framebuffer);
        for (int i = 0; i < 8; ++i) {
            PuCanvas* canvas = pu_canvas_create(8, 8);
            PuGpuCanvas* gpu = pu_canvas_acquire_gpu(canvas, 0, 1, 1, 0, 1);
            if (!gpu) {
                failed = 1;
                pu_canvas_destroy(canvas);
                break;
            }
            {
                PuGpuCurrent drawing(&gpu->device);
                if (!drawing.ok())
                    failed = 1;
                else {
                    gl->ClearColor(0, 1, 0, 1);
                    gl->Clear(GL_COLOR_BUFFER_BIT);
                    ++gpu->revision;
                }
            }
            uint8_t rgba[8 * 8 * 4];
            if (!pu_gpu_canvas_read(gpu, rgba, sizeof(rgba)) || memcmp(rgba, green, 4)) {
                std::fprintf(stderr, "FAIL: isolated readback: %u,%u,%u,%u\n", rgba[0], rgba[1],
                    rgba[2], rgba[3]);
                failed = 1;
            }
            if (!pu_gpu_device_is_current(&ui)) {
                std::fprintf(stderr, "FAIL: owning EGL current handles after read\n");
                failed = 1;
            }
            if (surface) {
                pu_surface_clear(surface, 255, 0, 0, 255);
                pu_canvas_composite(surface, canvas, 0, 0, 1, 1);
                pu_surface_present(surface);
                uint8_t pixel[4] = { };
                gl->ReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, pixel);
                if (memcmp(pixel, green, 4)) {
                    std::fprintf(stderr, "FAIL: borrowed Skia composed pixel: %u,%u,%u,%u\n",
                        pixel[0], pixel[1], pixel[2], pixel[3]);
                    failed = 1;
                }
            }
            // Resize and shutdown must also restore the owning context, not merely draws.
            if (!pu_canvas_resize(canvas, 16, 4))
                failed = 1;
            pu_canvas_destroy(canvas);
            if (!pu_gpu_device_is_current(&ui)) {
                std::fprintf(stderr, "FAIL: owning EGL current handles after resize/close\n");
                failed = 1;
            }
            GLint viewport[4] = { }, bound_buffer = 0, bound_fbo = 0;
            GLfloat color[4] = { };
            gl->GetIntegerv(GL_VIEWPORT, viewport);
            gl->GetFloatv(GL_COLOR_CLEAR_VALUE, color);
            gl->GetIntegerv(GL_ARRAY_BUFFER_BINDING, &bound_buffer);
            gl->GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &bound_fbo);
            if (!surface
                && (memcmp(viewport, expected_viewport, sizeof(viewport))
                    || memcmp(color, expected_color, sizeof(color)) || bound_buffer != (GLint)buffer
                    || bound_fbo != framebuffer || !gl->IsEnabled(GL_SCISSOR_TEST)))
                failed = 1;
            GLenum error = gl->GetError();
            if (error != GL_NO_ERROR) {
                std::fprintf(stderr, "FAIL: owning GL error 0x%x\n", error);
                failed = 1;
            }
        }
        pu_surface_destroy(surface);
        gl->DeleteBuffers(1, &buffer);
    }
    pu_gpu_device_close(&ui);
    pu_render_shutdown();
    if (pu_gpu_canvas_live_contexts() || pu_canvas_live_backings())
        failed = 1;
    std::puts(failed ? "FAIL: EGL ownership/current-context isolation"
                     : "PASS: independent GPU contexts, resize/readback/shutdown restore owning "
                       "EGL context and Skia composition");
    return failed;
}
