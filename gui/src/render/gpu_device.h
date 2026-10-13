#ifndef POLLYUI_GPU_DEVICE_H
#define POLLYUI_GPU_DEVICE_H

#ifdef PU_WEBGL2
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <thread>

struct PuGles {
#define PU_GL(name) decltype(&gl##name) name = nullptr;
#include "render/gles_api.inc"
#undef PU_GL
};
struct PuGpuDevice {
    EGLDisplay display = EGL_NO_DISPLAY;
    EGLContext context = EGL_NO_CONTEXT;
    EGLSurface surface = EGL_NO_SURFACE;
    std::thread::id thread;
    bool failed = false;
};
class PuGpuCurrent
{
public:
    explicit PuGpuCurrent(PuGpuDevice* device);
    ~PuGpuCurrent();
    bool ok() const { return current; }

private:
    PuGpuDevice* device;
    EGLDisplay display;
    EGLContext context;
    EGLSurface draw, read;
    EGLenum api;
    bool current = false;
    bool touched = false;
};
PuGles* pu_gles();
void* pu_gpu_proc(const char* name);
bool pu_gpu_device_is_current(const PuGpuDevice* device);
bool pu_gpu_device_open(PuGpuDevice* device);
void pu_gpu_device_close(PuGpuDevice* device);
#endif
#endif
