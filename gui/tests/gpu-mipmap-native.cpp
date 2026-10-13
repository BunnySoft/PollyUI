#include "render/gpu_device.h"
#include <cstdio>
#include <vector>

static void diagnose(PuGpuDevice* device, const char* mode, bool immutable)
{
    PuGpuCurrent current(device);
    if (!current.ok()) {
        std::fprintf(stderr, "native mip diagnostic could not bind context\n");
        return;
    }
    auto gl = pu_gles();
    GLuint texture = 0, fbo = 0;
    gl->GenTextures(1, &texture);
    gl->BindTexture(GL_TEXTURE_2D, texture);
    std::vector<uint8_t> white(64, 255);
    if (immutable) {
        gl->TexStorage2D(GL_TEXTURE_2D, 5, GL_RGBA8, 16, 16);
        gl->TexSubImage2D(GL_TEXTURE_2D, 2, 0, 0, 4, 4, GL_RGBA, GL_UNSIGNED_BYTE, white.data());
    } else
        gl->TexImage2D(
            GL_TEXTURE_2D, 2, GL_RGBA8, 4, 4, 0, GL_RGBA, GL_UNSIGNED_BYTE, white.data());
    gl->TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_BASE_LEVEL, 2);
    gl->TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAX_LEVEL, 3);
    gl->GenFramebuffers(1, &fbo);
    gl->BindFramebuffer(GL_FRAMEBUFFER, fbo);
    gl->FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 2);
    uint8_t before[4] = { }, after[4] = { };
    GLenum before_status = gl->CheckFramebufferStatus(GL_FRAMEBUFFER);
    gl->ReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, before);
    GLenum before_error = gl->GetError();
    gl->BindFramebuffer(GL_FRAMEBUFFER, 0);
    gl->GenerateMipmap(GL_TEXTURE_2D);
    GLenum generated_error = gl->GetError();
    gl->Finish();
    gl->BindFramebuffer(GL_FRAMEBUFFER, fbo);
    gl->FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 3);
    GLenum after_status = gl->CheckFramebufferStatus(GL_FRAMEBUFFER);
    gl->ReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, after);
    GLenum after_error = gl->GetError();
    std::printf("MIPMAP_NATIVE_DIAGNOSTIC {\"mode\":\"%s\",\"immutable\":%s,\"baseStatus\":%u,"
                "\"basePixels\":[%u,%u,%u,%u],\"baseError\":%u,\"generateError\":%u,"
                "\"mipStatus\":%u,\"mipPixels\":[%u,%u,%u,%u],\"mipError\":%u}\n",
        mode, immutable ? "true" : "false", before_status, before[0], before[1], before[2],
        before[3], before_error, generated_error, after_status, after[0], after[1], after[2],
        after[3], after_error);
    gl->DeleteFramebuffers(1, &fbo);
    gl->DeleteTextures(1, &texture);
}
int main()
{
    std::puts("Native driver diagnostic only: no JS/shadow state and no PASS/conformance claim.");
    PuGpuDevice selected;
    if (!pu_gpu_device_open(&selected))
        return 1;
    diagnose(&selected, "selected-product-WebGL-compatible-robust", false);
    diagnose(&selected, "selected-product-WebGL-compatible-robust", true);
#ifdef _WIN32
    auto platform = reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(
        pu_gpu_proc("eglGetPlatformDisplayEXT"));
    auto initialize = reinterpret_cast<decltype(&eglInitialize)>(pu_gpu_proc("eglInitialize"));
    auto choose = reinterpret_cast<decltype(&eglChooseConfig)>(pu_gpu_proc("eglChooseConfig"));
    auto create = reinterpret_cast<decltype(&eglCreateContext)>(pu_gpu_proc("eglCreateContext"));
    auto pbuffer = reinterpret_cast<decltype(&eglCreatePbufferSurface)>(
        pu_gpu_proc("eglCreatePbufferSurface"));
    if (!platform || !initialize || !choose || !create || !pbuffer)
        return 1;
    const EGLint display_attributes[] = { 0x3203, 0x3208, EGL_NONE };
    const EGLint attributes[]
        = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT_KHR,
              EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE };
    const EGLint surface_attributes[] = { EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE };
    for (bool compatible : { true, false }) {
        PuGpuDevice d3d;
        d3d.display = platform(0x3202, EGL_DEFAULT_DISPLAY, display_attributes);
        d3d.thread = std::this_thread::get_id();
        EGLConfig config;
        EGLint count = 0, major = 0, minor = 0;
        {
            PuGpuCurrent current(&selected);
            if (!current.ok() || !initialize(d3d.display, &major, &minor)
                || !choose(d3d.display, attributes, &config, 1, &count) || !count)
                return 1;
            const EGLint qualified_context[]
                = { EGL_CONTEXT_CLIENT_VERSION, 3, 0x33AC, EGL_TRUE, 0x3453, EGL_TRUE, EGL_NONE };
            const EGLint ordinary_context[] = { EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE };
            d3d.context = create(d3d.display, config, EGL_NO_CONTEXT,
                compatible ? qualified_context : ordinary_context);
            d3d.surface = pbuffer(d3d.display, config, surface_attributes);
        }
        if (d3d.context == EGL_NO_CONTEXT || d3d.surface == EGL_NO_SURFACE)
            return 1;
        diagnose(&d3d,
            compatible ? "D3D11-WebGL-compatible-robust-diagnostic-only"
                       : "D3D11-ordinary-ES3-diagnostic-only",
            false);
        diagnose(&d3d,
            compatible ? "D3D11-WebGL-compatible-robust-diagnostic-only"
                       : "D3D11-ordinary-ES3-diagnostic-only",
            true);
        pu_gpu_device_close(&d3d);
    }
#endif
    pu_gpu_device_close(&selected);
    return 0;
}
