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
#ifdef _WIN32
    PuGpuDevice provider;
    if (!pu_gpu_device_open(&provider))
        return 1;
    auto platform = reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(
        pu_gpu_proc("eglGetPlatformDisplayEXT"));
    auto initialize = reinterpret_cast<decltype(&eglInitialize)>(pu_gpu_proc("eglInitialize"));
    auto choose = reinterpret_cast<decltype(&eglChooseConfig)>(pu_gpu_proc("eglChooseConfig"));
    auto create = reinterpret_cast<decltype(&eglCreateContext)>(pu_gpu_proc("eglCreateContext"));
    auto pbuffer = reinterpret_cast<decltype(&eglCreatePbufferSurface)>(
        pu_gpu_proc("eglCreatePbufferSurface"));
    const EGLint display_attributes[] = { 0x3203, 0x3208, EGL_NONE };
    const EGLint attributes[]
        = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT_KHR,
              EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE };
    const EGLint context_attributes[] = { EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE };
    const EGLint surface_attributes[] = { EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE };
    if (!platform || !initialize || !choose || !create || !pbuffer)
        return 1;
    ui.display = platform(0x3202, EGL_DEFAULT_DISPLAY, display_attributes);
    ui.thread = std::this_thread::get_id();
    EGLint major = 0, minor = 0, count = 0;
    EGLConfig config;
    {
        PuGpuCurrent current(&provider);
        if (!current.ok() || !initialize(ui.display, &major, &minor)
            || !choose(ui.display, attributes, &config, 1, &count) || !count)
            return 1;
        ui.context = create(ui.display, config, EGL_NO_CONTEXT, context_attributes);
        ui.surface = pbuffer(ui.display, config, surface_attributes);
    }
    if (ui.context == EGL_NO_CONTEXT || ui.surface == EGL_NO_SURFACE)
        return 1;
#else
    if (!pu_gpu_device_open(&ui)) {
        std::fprintf(stderr, "FAIL: real owning GLES context\n");
        return 1;
    }
#endif
    int failed = 0;
    {
        PuGpuCurrent owning(&ui);
        if (!owning.ok())
            return 1;
        auto gl = pu_gles();
        std::fprintf(
            stderr, "[gpu-current] actual owning UI renderer=%s\n", gl->GetString(GL_RENDERER));
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
        PuCanvas* impossible = pu_canvas_create(0, INT32_MAX);
        if (!impossible || pu_canvas_acquire_gpu(impossible, 0, 1, 1, 0, 1)) {
            std::fprintf(stderr, "FAIL: oversized zero backing must not acquire a GPU target\n");
            failed = 1;
        }
        pu_canvas_destroy(impossible);
        if (!pu_gpu_device_is_current(&ui)) {
            std::fprintf(stderr, "FAIL: owning EGL handles after failed context acquisition\n");
            failed = 1;
        }
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
            if (i & 1) {
                pu_gpu_canvas_close(gpu);
                if (!pu_gpu_canvas_lost(gpu) || !pu_gpu_device_is_current(&ui)) {
                    std::fprintf(stderr, "FAIL: owning EGL handles after actual context loss\n");
                    failed = 1;
                }
            }
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
#ifdef _WIN32
    pu_gpu_device_close(&provider);
#endif
    pu_render_shutdown();
    if (pu_gpu_canvas_live_contexts() || pu_canvas_live_backings())
        failed = 1;
    std::puts(failed ? "FAIL: EGL ownership/current-context isolation"
                     : "PASS: independent GPU contexts, resize/readback/shutdown restore owning "
                       "EGL context and Skia composition");
    return failed;
}
