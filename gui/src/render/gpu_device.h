#ifndef POLLYUI_GPU_DEVICE_H
#define POLLYUI_GPU_DEVICE_H

#ifdef PU_WEBGL2
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <thread>
#include <string>

enum class PuGpuPolicy { Default, Hardware, Software, System };
enum class PuGpuType { Unknown, Integrated, Discrete, Virtual, Cpu, NativeSoftware };
enum class PuGpuPower { Default, LowPower, HighPerformance };
enum class PuGpuFailure {
    None,
    Runtime,
    Configuration,
    Unavailable,
    NoHardware,
    DeviceQuery,
    DeviceRejected,
    Caveat
};
struct PuGpuOptions {
    PuGpuPolicy policy = PuGpuPolicy::Default;
    PuGpuPower power = PuGpuPower::Default;
    bool strict = false;
};
struct PuGpuInfo {
    PuGpuType type = PuGpuType::Unknown;
    uint32_t vendor = 0, device = 0, api_version = 0, driver_version = 0;
    std::string name;
    std::string egl_library, gles_library, vulkan_entry_library;
    bool power_hint_submitted = false;
};

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
    PuGpuOptions options;
    PuGpuInfo info;
    std::string error;
    PuGpuFailure failure = PuGpuFailure::None;
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
bool pu_gpu_is_hardware(PuGpuType type);
const char* pu_gpu_type_name(PuGpuType type);
const char* pu_gpu_policy_name(PuGpuPolicy policy);
const char* pu_gpu_power_name(PuGpuPower power);
#endif
#endif
