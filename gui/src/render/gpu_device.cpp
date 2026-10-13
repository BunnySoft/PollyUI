#include "render/gpu_device.h"
#ifdef PU_WEBGL2
#include <cstdio>
#include <cstring>
#include <vector>
#include <cstdlib>
#include <algorithm>
#include <memory>
#include <type_traits>
#ifdef _WIN32
#include <windows.h>
#include <EGL/eglext_angle.h>
#include <vulkan/vulkan_core.h>
#else
#include <dlfcn.h>
#endif

namespace
{
struct Egl {
#define EGL_PROC(name) decltype(&egl##name) name = nullptr;
    EGL_PROC(GetDisplay)
    EGL_PROC(Initialize)
    EGL_PROC(BindAPI)
    EGL_PROC(QueryAPI)
    EGL_PROC(ChooseConfig)
    EGL_PROC(CreatePbufferSurface)
    EGL_PROC(CreateContext)
    EGL_PROC(MakeCurrent)
    EGL_PROC(GetCurrentContext)
    EGL_PROC(GetCurrentDisplay)
    EGL_PROC(GetCurrentSurface)
    EGL_PROC(DestroyContext)
    EGL_PROC(DestroySurface)
    EGL_PROC(GetError)
    EGL_PROC(GetProcAddress)
    EGL_PROC(QueryString)
#undef EGL_PROC
    PFNEGLGETPLATFORMDISPLAYEXTPROC GetPlatformDisplayEXT = nullptr;
    PFNEGLQUERYDISPLAYATTRIBEXTPROC QueryDisplayAttribEXT = nullptr;
    PFNEGLQUERYDEVICEATTRIBEXTPROC QueryDeviceAttribEXT = nullptr;
    PFNEGLQUERYDEVICESTRINGEXTPROC QueryDeviceStringEXT = nullptr;
} egl;
PuGles gl;
bool loaded, attempted;
#ifdef _WIN32
HMODULE egl_library, gles_library;
void* symbol(HMODULE library, const char* name)
{
    return reinterpret_cast<void*>(GetProcAddress(library, name));
}
#else
void *egl_library, *gles_library;
void* symbol(void* library, const char* name) { return dlsym(library, name); }
#endif
bool load()
{
    if (attempted)
        return loaded;
    attempted = true;
#ifdef _WIN32
    // Restrict development ANGLE DLLs to the application's directory, not PATH/CWD.
    egl_library = LoadLibraryExW(
        L"libEGL.dll", nullptr, LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    gles_library = LoadLibraryExW(L"libGLESv2.dll", nullptr,
        LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
#else
    egl_library = dlopen("libEGL.so.1", RTLD_NOW | RTLD_LOCAL);
    gles_library = dlopen("libGLESv2.so.2", RTLD_NOW | RTLD_LOCAL);
#endif
    if (!egl_library || !gles_library) {
        std::fprintf(stderr, "[webgl2] EGL/GLES libraries unavailable\n");
        return false;
    }
#define EGL_PROC(name)                                                                             \
    egl.name = reinterpret_cast<decltype(egl.name)>(symbol(egl_library, "egl" #name));             \
    if (!egl.name) {                                                                               \
        std::fprintf(stderr, "[webgl2] missing egl" #name "\n");                                   \
        return false;                                                                              \
    }
    EGL_PROC(GetDisplay)
    EGL_PROC(Initialize)
    EGL_PROC(BindAPI)
    EGL_PROC(QueryAPI)
    EGL_PROC(ChooseConfig)
    EGL_PROC(CreatePbufferSurface)
    EGL_PROC(CreateContext)
    EGL_PROC(MakeCurrent)
    EGL_PROC(GetCurrentContext)
    EGL_PROC(GetCurrentDisplay)
    EGL_PROC(GetCurrentSurface) EGL_PROC(DestroyContext) EGL_PROC(DestroySurface) EGL_PROC(GetError)
        EGL_PROC(GetProcAddress) EGL_PROC(QueryString)
#undef EGL_PROC
            egl.GetPlatformDisplayEXT = reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(
        egl.GetProcAddress("eglGetPlatformDisplayEXT"));
    egl.QueryDisplayAttribEXT = reinterpret_cast<PFNEGLQUERYDISPLAYATTRIBEXTPROC>(
        egl.GetProcAddress("eglQueryDisplayAttribEXT"));
    egl.QueryDeviceAttribEXT = reinterpret_cast<PFNEGLQUERYDEVICEATTRIBEXTPROC>(
        egl.GetProcAddress("eglQueryDeviceAttribEXT"));
    egl.QueryDeviceStringEXT = reinterpret_cast<PFNEGLQUERYDEVICESTRINGEXTPROC>(
        egl.GetProcAddress("eglQueryDeviceStringEXT"));
#define PU_GL(name)                                                                                \
    gl.name = reinterpret_cast<decltype(gl.name)>(symbol(gles_library, "gl" #name));               \
    if (!gl.name)                                                                                  \
        gl.name = reinterpret_cast<decltype(gl.name)>(egl.GetProcAddress("gl" #name));             \
    if (!gl.name) {                                                                                \
        std::fprintf(stderr, "[webgl2] missing ES3 gl" #name "\n");                                \
        return false;                                                                              \
    }
#include "render/gles_api.inc"
#undef PU_GL
    loaded = true;
    return true;
}
bool extension(const char* list, const char* name)
{
    if (!list)
        return false;
    size_t length = strlen(name);
    for (const char* at = list; *at;) {
        const char* end = strchr(at, ' ');
        size_t size = end ? (size_t)(end - at) : strlen(at);
        if (size == length && !memcmp(at, name, length))
            return true;
        if (!end)
            break;
        at = end + 1;
    }
    return false;
}
bool failure(PuGpuDevice* d, const char* message, PuGpuFailure reason = PuGpuFailure::DeviceQuery)
{
    d->error = message;
    d->failure = reason;
    std::fprintf(stderr, "[webgl2] %s\n", message);
    return false;
}
#ifdef _WIN32
bool module_path(HMODULE module, std::string& result)
{
    wchar_t path[32768];
    DWORD size = GetModuleFileNameW(module, path, 32768);
    if (!size || size >= 32768)
        return false;
    int bytes = WideCharToMultiByte(CP_UTF8, 0, path, size, nullptr, 0, nullptr, nullptr);
    if (!bytes)
        return false;
    result.resize(bytes);
    return WideCharToMultiByte(CP_UTF8, 0, path, size, result.data(), bytes, nullptr, nullptr)
        == bytes;
}
bool hardware_inventory(PuGpuDevice* d)
{
    for (const char* name : { "VK_DRIVER_FILES", "VK_ICD_FILENAMES", "VK_ADD_DRIVER_FILES",
             "VK_LOADER_DRIVERS_SELECT", "VK_LOADER_DRIVERS_DISABLE" }) {
        const char* value = std::getenv(name);
        if (value && *value)
            return failure(d,
                "Hardware policy requires normal installed-driver discovery; Vulkan driver "
                "override is present",
                PuGpuFailure::Configuration);
    }
    HMODULE loader = LoadLibraryExW(L"vulkan-1.dll", nullptr,
        LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!loader)
        return failure(d,
            "Normal Vulkan loader unavailable; native runtime must be staged or installed",
            PuGpuFailure::Runtime);
    std::unique_ptr<std::remove_pointer_t<HMODULE>, decltype(&FreeLibrary)> owned_loader(
        loader, &FreeLibrary);
    if (!module_path(loader, d->info.vulkan_entry_library))
        return failure(d, "Cannot identify loaded Vulkan discovery library", PuGpuFailure::Runtime);
    auto create
        = reinterpret_cast<PFN_vkCreateInstance>(GetProcAddress(loader, "vkCreateInstance"));
    auto destroy
        = reinterpret_cast<PFN_vkDestroyInstance>(GetProcAddress(loader, "vkDestroyInstance"));
    auto enumerate = reinterpret_cast<PFN_vkEnumeratePhysicalDevices>(
        GetProcAddress(loader, "vkEnumeratePhysicalDevices"));
    auto properties = reinterpret_cast<PFN_vkGetPhysicalDeviceProperties>(
        GetProcAddress(loader, "vkGetPhysicalDeviceProperties"));
    bool ok = false;
    if (!create || !destroy || !enumerate || !properties) {
        failure(d, "Normal Vulkan discovery ABI unavailable", PuGpuFailure::Runtime);
    } else {
        VkApplicationInfo application = { };
        application.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
        application.pApplicationName = "PollyUI hardware discovery";
        application.apiVersion = VK_API_VERSION_1_0;
        VkInstanceCreateInfo info = { };
        info.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
        info.pApplicationInfo = &application;
        VkInstance instance = VK_NULL_HANDLE;
        VkResult result = create(&info, nullptr, &instance);
        if (result == VK_ERROR_INCOMPATIBLE_DRIVER) {
            failure(d,
                "Normal Vulkan loader reports no compatible GPU driver; hardware qualification "
                "unavailable",
                PuGpuFailure::NoHardware);
        } else if (result != VK_SUCCESS || !instance) {
            failure(d, "Normal Vulkan instance discovery failed", PuGpuFailure::DeviceQuery);
        } else {
            const auto release = [destroy](VkInstance value) { destroy(value, nullptr); };
            std::unique_ptr<std::remove_pointer_t<VkInstance>, decltype(release)> owned_instance(
                instance, release);
            uint32_t count = 0;
            result = enumerate(instance, &count, nullptr);
            if (result != VK_SUCCESS || count > 4096) {
                failure(d, "Native Vulkan physical-device enumeration failed",
                    PuGpuFailure::DeviceQuery);
            } else {
                std::vector<VkPhysicalDevice> devices(count);
                if (count)
                    result = enumerate(instance, &count, devices.data());
                if (result != VK_SUCCESS) {
                    failure(d, "Native Vulkan physical-device list changed or failed",
                        PuGpuFailure::DeviceQuery);
                } else {
                    bool valid = true;
                    for (uint32_t i = 0; i < count; ++i) {
                        if (!devices[i]) {
                            valid = false;
                            failure(d, "Native Vulkan returned an invalid physical-device handle",
                                PuGpuFailure::DeviceQuery);
                            break;
                        }
                        VkPhysicalDeviceProperties value = { };
                        properties(devices[i], &value);
                        if (!value.apiVersion) {
                            valid = false;
                            failure(d, "Native Vulkan inventory properties are invalid",
                                PuGpuFailure::DeviceQuery);
                            break;
                        }
                        if (value.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
                            || value.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
                            || value.deviceType == VK_PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU)
                            ok = true;
                    }
                    if (!valid)
                        ok = false;
                    else if (!ok)
                        failure(d,
                            "Native Vulkan inventory contains no eligible GPU-backed device; "
                            "CPU/unknown is not hardware",
                            PuGpuFailure::NoHardware);
                }
            }
        }
    }
    return ok;
}
#endif
bool query_device(PuGpuDevice* d)
{
#ifdef _WIN32
    const char* client_extensions = egl.QueryString(EGL_NO_DISPLAY, EGL_EXTENSIONS);
    const char* display_extensions = egl.QueryString(d->display, EGL_EXTENSIONS);
    if (!extension(client_extensions, "EGL_EXT_device_query")
        && !extension(client_extensions, "EGL_EXT_device_base")
        && !extension(display_extensions, "EGL_EXT_device_query"))
        return failure(
            d, "The EGL implementation does not advertise native device-query capability");
#endif
    if (!egl.QueryDisplayAttribEXT || !egl.QueryDeviceStringEXT || !egl.QueryDeviceAttribEXT) {
#ifdef _WIN32
        return failure(
            d, "Native EGL device-query ABI unavailable; device type cannot be verified");
#else
        return d->options.strict
            ? failure(d, "Strict request rejected: native device type cannot be verified",
                  PuGpuFailure::Caveat)
            : true;
#endif
    }
    EGLAttrib device_value = 0;
    if (!egl.QueryDisplayAttribEXT(d->display, EGL_DEVICE_EXT, &device_value) || !device_value) {
#ifdef _WIN32
        return failure(d, "Cannot query ANGLE's actual EGL device");
#else
        return d->options.strict
            ? failure(d, "Strict request rejected: native EGL device cannot be queried",
                  PuGpuFailure::Caveat)
            : true;
#endif
    }
    EGLDeviceEXT device = reinterpret_cast<EGLDeviceEXT>(device_value);
    const char* extensions = egl.QueryDeviceStringEXT(device, EGL_EXTENSIONS);
#ifdef _WIN32
    if (!extension(extensions, "EGL_ANGLE_device_vulkan"))
        return failure(d, "The selected EGL device does not expose a verified Vulkan device");
    EGLAttrib instance_value = 0, physical_value = 0, proc_value = 0;
    if (!egl.QueryDeviceAttribEXT(device, EGL_VULKAN_INSTANCE_ANGLE, &instance_value)
        || !egl.QueryDeviceAttribEXT(device, EGL_VULKAN_PHYSICAL_DEVICE_ANGLE, &physical_value)
        || !egl.QueryDeviceAttribEXT(device, EGL_VULKAN_GET_INSTANCE_PROC_ADDR, &proc_value)
        || !instance_value || !physical_value || !proc_value)
        return failure(
            d, "Cannot query Vulkan instance, physical device and function ABI from ANGLE");
    auto get_proc = reinterpret_cast<PFN_vkGetInstanceProcAddr>(proc_value);
    HMODULE entry_module = nullptr;
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(get_proc), &entry_module)
        || !module_path(entry_module, d->info.vulkan_entry_library))
        return failure(
            d, "Cannot identify ANGLE's queried Vulkan entry-point library", PuGpuFailure::Runtime);
    auto instance = reinterpret_cast<VkInstance>(instance_value);
    auto physical = reinterpret_cast<VkPhysicalDevice>(physical_value);
    auto get_properties = reinterpret_cast<PFN_vkGetPhysicalDeviceProperties>(
        get_proc(instance, "vkGetPhysicalDeviceProperties"));
    if (!get_properties)
        return failure(d, "Native vkGetPhysicalDeviceProperties unavailable");
    VkPhysicalDeviceProperties properties = { };
    get_properties(physical, &properties);
    if (!properties.apiVersion)
        return failure(d, "Native Vulkan physical-device properties are invalid");
    switch (properties.deviceType) {
    case VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU:
        d->info.type = PuGpuType::Integrated;
        break;
    case VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU:
        d->info.type = PuGpuType::Discrete;
        break;
    case VK_PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU:
        d->info.type = PuGpuType::Virtual;
        break;
    case VK_PHYSICAL_DEVICE_TYPE_CPU:
        d->info.type = PuGpuType::Cpu;
        break;
    default:
        d->info.type = PuGpuType::Unknown;
        break;
    }
    d->info.name.assign(properties.deviceName,
        std::find(
            properties.deviceName, properties.deviceName + VK_MAX_PHYSICAL_DEVICE_NAME_SIZE, '\0'));
    d->info.vendor = properties.vendorID;
    d->info.device = properties.deviceID;
    d->info.api_version = properties.apiVersion;
    d->info.driver_version = properties.driverVersion;
    std::fprintf(stderr,
        "[webgl2] native-device policy=%s type=%s vendor=0x%x device=0x%x api=0x%x driver=0x%x "
        "name=%s requested-power=%s hint-submitted=%s\n",
        pu_gpu_policy_name(d->options.policy), pu_gpu_type_name(d->info.type), d->info.vendor,
        d->info.device, d->info.api_version, d->info.driver_version, d->info.name.c_str(),
        pu_gpu_power_name(d->options.power), d->info.power_hint_submitted ? "true" : "false");
    if (d->options.policy == PuGpuPolicy::Hardware && !pu_gpu_is_hardware(d->info.type))
        return failure(d,
            "No GPU-backed hardware Vulkan device was selected; CPU/unknown device rejected (no "
            "software fallback)",
            PuGpuFailure::DeviceRejected);
    if (d->options.policy == PuGpuPolicy::Software && d->info.type != PuGpuType::Cpu)
        return failure(d, "Explicit SwiftShader policy did not yield a verified CPU device",
            PuGpuFailure::DeviceRejected);
#else
    if (extension(extensions, "EGL_MESA_device_software"))
        d->info.type = PuGpuType::NativeSoftware;
#endif
    if (d->options.strict && !pu_gpu_is_hardware(d->info.type))
        return failure(d,
            "Strict performance-caveat request refused for software or unclassified native device",
            PuGpuFailure::Caveat);
    return true;
}
}
bool pu_gpu_is_hardware(PuGpuType type)
{
    return type == PuGpuType::Integrated || type == PuGpuType::Discrete
        || type == PuGpuType::Virtual;
}
const char* pu_gpu_type_name(PuGpuType type)
{
    switch (type) {
    case PuGpuType::Integrated:
        return "integrated-gpu";
    case PuGpuType::Discrete:
        return "discrete-gpu";
    case PuGpuType::Virtual:
        return "gpu-backed-virtual";
    case PuGpuType::Cpu:
        return "cpu";
    case PuGpuType::NativeSoftware:
        return "native-software";
    default:
        return "unknown";
    }
}
const char* pu_gpu_policy_name(PuGpuPolicy policy)
{
    switch (policy) {
    case PuGpuPolicy::Hardware:
        return "hardware";
    case PuGpuPolicy::Software:
        return "software";
    case PuGpuPolicy::System:
        return "system-gles";
    default:
        return "unresolved";
    }
}
const char* pu_gpu_power_name(PuGpuPower power)
{
    return power == PuGpuPower::LowPower       ? "low-power"
        : power == PuGpuPower::HighPerformance ? "high-performance"
                                               : "default";
}
PuGles* pu_gles() { return &gl; }
void* pu_gpu_proc(const char* name)
{
    void* proc = symbol(!strncmp(name, "egl", 3) ? egl_library : gles_library, name);
    return proc ? proc : reinterpret_cast<void*>(egl.GetProcAddress(name));
}
bool pu_gpu_device_is_current(const PuGpuDevice* d)
{
    return egl.GetCurrentContext() == d->context && egl.GetCurrentDisplay() == d->display
        && egl.GetCurrentSurface(EGL_DRAW) == d->surface
        && egl.GetCurrentSurface(EGL_READ) == d->surface;
}

PuGpuCurrent::PuGpuCurrent(PuGpuDevice* d)
    : device(d)
{
    display = egl.GetCurrentDisplay();
    context = egl.GetCurrentContext();
    draw = egl.GetCurrentSurface(EGL_DRAW);
    read = egl.GetCurrentSurface(EGL_READ);
    api = egl.QueryAPI();
    if (device->thread != std::this_thread::get_id()) {
        std::fprintf(stderr, "[webgl2] rejected foreign-thread context access\n");
        return;
    }
    current = egl.BindAPI(EGL_OPENGL_ES_API)
        && egl.MakeCurrent(device->display,
            device->context == EGL_NO_CONTEXT ? EGL_NO_SURFACE : device->surface,
            device->context == EGL_NO_CONTEXT ? EGL_NO_SURFACE : device->surface, device->context);
    touched = true;
    if (!current)
        std::fprintf(stderr, "[webgl2] eglMakeCurrent failed: 0x%x\n", egl.GetError());
}
PuGpuCurrent::~PuGpuCurrent()
{
    if (!touched)
        return;
    bool released
        = egl.MakeCurrent(device->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    bool rebound = egl.BindAPI(api);
    bool restored = display == EGL_NO_DISPLAY || egl.MakeCurrent(display, draw, read, context);
    if (!released || !rebound || !restored) {
        std::fprintf(
            stderr, "[webgl2] FAILED to restore owning UI EGL context: 0x%x\n", egl.GetError());
        device->failed = true;
    }
}
bool pu_gpu_device_open(PuGpuDevice* d)
{
    std::unique_ptr<PuGpuDevice, decltype(&pu_gpu_device_close)> rollback(d, &pu_gpu_device_close);
    d->error.clear();
    d->info = { };
    d->failure = PuGpuFailure::None;
#ifdef _WIN32
    if (d->options.policy == PuGpuPolicy::Default) {
        const char* policy = std::getenv("PU_WEBGL2_DEVICE");
        if (!policy || !*policy || !strcmp(policy, "hardware"))
            d->options.policy = PuGpuPolicy::Hardware;
        else if (!strcmp(policy, "software"))
            d->options.policy = PuGpuPolicy::Software;
        else
            return failure(
                d, "PU_WEBGL2_DEVICE must be hardware or software", PuGpuFailure::Configuration);
    }
#else
    d->options.policy = PuGpuPolicy::System;
#endif
    if (!load())
        return failure(d, "Native EGL/GLES libraries unavailable", PuGpuFailure::Runtime);
#ifdef _WIN32
    if (!module_path(egl_library, d->info.egl_library)
        || !module_path(gles_library, d->info.gles_library))
        return failure(d, "Cannot identify loaded EGL/GLES libraries", PuGpuFailure::Runtime);
    if (d->options.policy == PuGpuPolicy::Hardware && !hardware_inventory(d))
        return false;
#endif
    d->thread = std::this_thread::get_id();
    d->failed = false;
    EGLenum old_api = egl.QueryAPI();
    if (egl.GetPlatformDisplayEXT) {
#ifdef _WIN32
        std::vector<EGLint> attributes = { EGL_PLATFORM_ANGLE_TYPE_ANGLE,
            EGL_PLATFORM_ANGLE_TYPE_VULKAN_ANGLE, EGL_PLATFORM_ANGLE_DEVICE_TYPE_ANGLE,
            d->options.policy == PuGpuPolicy::Software
                ? EGL_PLATFORM_ANGLE_DEVICE_TYPE_SWIFTSHADER_ANGLE
                : EGL_PLATFORM_ANGLE_DEVICE_TYPE_HARDWARE_ANGLE };
        if (d->options.policy == PuGpuPolicy::Hardware && d->options.power != PuGpuPower::Default
            && extension(egl.QueryString(EGL_NO_DISPLAY, EGL_EXTENSIONS),
                "EGL_ANGLE_display_power_preference")) {
            attributes.insert(attributes.end(),
                { EGL_POWER_PREFERENCE_ANGLE,
                    d->options.power == PuGpuPower::LowPower ? EGL_LOW_POWER_ANGLE
                                                             : EGL_HIGH_POWER_ANGLE });
            d->info.power_hint_submitted = true;
        }
        attributes.push_back(EGL_NONE);
        std::fprintf(stderr,
            "[webgl2] requested ANGLE Vulkan policy=%s; no hardware/software or D3D fallback\n",
            pu_gpu_policy_name(d->options.policy));
        d->display = egl.GetPlatformDisplayEXT(
            EGL_PLATFORM_ANGLE_ANGLE, EGL_DEFAULT_DISPLAY, attributes.data());
#else
        d->display = egl.GetPlatformDisplayEXT(
            0x31DD /* EGL_PLATFORM_SURFACELESS_MESA */, EGL_DEFAULT_DISPLAY, nullptr);
#endif
    }
    if (d->display == EGL_NO_DISPLAY)
#ifdef _WIN32
        return failure(d, "Requested ANGLE Vulkan display unavailable", PuGpuFailure::Unavailable);
#else
        d->display = egl.GetDisplay(EGL_DEFAULT_DISPLAY);
#endif
    EGLint major, minor, count;
    EGLConfig config;
    const EGLint attributes[]
        = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT_KHR,
              EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE };
    const EGLint pbuffer[] = { EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE };
    std::vector<EGLint> context = { EGL_CONTEXT_CLIENT_VERSION, 3 };
    bool ok = d->display != EGL_NO_DISPLAY && egl.Initialize(d->display, &major, &minor)
        && egl.BindAPI(EGL_OPENGL_ES_API)
        && egl.ChooseConfig(d->display, attributes, &config, 1, &count) && count;
    if (ok) {
        const char* extensions = egl.QueryString(d->display, EGL_EXTENSIONS);
#ifdef _WIN32
        if (d->options.policy == PuGpuPolicy::Hardware && d->options.power != PuGpuPower::Default
            && extension(extensions, "EGL_ANGLE_power_preference")) {
            context.insert(context.end(),
                { EGL_POWER_PREFERENCE_ANGLE,
                    d->options.power == PuGpuPower::LowPower ? EGL_LOW_POWER_ANGLE
                                                             : EGL_HIGH_POWER_ANGLE });
            d->info.power_hint_submitted = true;
        }
#endif
        if (extensions && strstr(extensions, "EGL_ANGLE_create_context_webgl_compatibility")) {
            context.insert(
                context.end(), { 0x33AC /* EGL_CONTEXT_WEBGL_COMPATIBILITY_ANGLE */, EGL_TRUE });
            std::fprintf(stderr, "[webgl2] ANGLE WebGL compatibility validation enabled\n");
        }
        if (extensions && strstr(extensions, "EGL_ANGLE_create_context_extensions_enabled"))
            context.insert(context.end(), { 0x345F /* EGL_EXTENSIONS_ENABLED_ANGLE */, EGL_FALSE });
        if (extensions && strstr(extensions, "EGL_ANGLE_robust_resource_initialization")) {
            context.insert(
                context.end(), { 0x3453 /* EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE */, EGL_TRUE });
            std::fprintf(stderr, "[webgl2] ANGLE robust resource initialization enabled\n");
        }
        if (extensions && strstr(extensions, "EGL_EXT_create_context_robustness")) {
            context.insert(
                context.end(), { 0x30BF /* EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT */, EGL_TRUE });
            std::fprintf(stderr, "[webgl2] EGL robust access requested\n");
        }
        context.push_back(EGL_NONE);
        d->surface = egl.CreatePbufferSurface(d->display, config, pbuffer);
        d->context = egl.CreateContext(d->display, config, EGL_NO_CONTEXT, context.data());
        ok = d->surface != EGL_NO_SURFACE && d->context != EGL_NO_CONTEXT;
    }
    EGLint creation_failure = ok ? EGL_SUCCESS : egl.GetError();
    if (!egl.BindAPI(old_api)) {
        std::fprintf(stderr, "[webgl2] failed to restore EGL client API\n");
        creation_failure = egl.GetError();
        ok = false;
    }
    if (!ok) {
        std::fprintf(stderr, "[webgl2] ES3 offscreen context unavailable: EGL error 0x%x\n",
            creation_failure);
        pu_gpu_device_close(d);
        return failure(d,
            "Requested native EGL/GLES context could not be created; no provider fallback",
            PuGpuFailure::Unavailable);
    }
    {
        PuGpuCurrent current(d);
        if (!current.ok()) {
            pu_gpu_device_close(d);
            return failure(
                d, "Cannot bind the selected native device context", PuGpuFailure::Unavailable);
        }
        GLint version = 0;
        gl.GetIntegerv(GL_MAJOR_VERSION, &version);
        if (version < 3) {
            std::fprintf(stderr, "[webgl2] context is not ES3\n");
            pu_gpu_device_close(d);
            return failure(d, "Native context does not satisfy OpenGL ES 3", PuGpuFailure::Runtime);
        }
        if (!query_device(d)) {
            pu_gpu_device_close(d);
            return false;
        }
        std::fprintf(stderr, "[webgl2] EGL %d.%d; vendor=%s; renderer=%s; version=%s\n", major,
            minor, gl.GetString(GL_VENDOR), gl.GetString(GL_RENDERER), gl.GetString(GL_VERSION));
    }
    if (d->failed) {
        pu_gpu_device_close(d);
        return failure(d, "Failed to restore owning EGL state after native context creation",
            PuGpuFailure::Runtime);
    }
    rollback.release();
    return true;
}
void pu_gpu_device_close(PuGpuDevice* d)
{
    if (d->context == EGL_NO_CONTEXT && d->surface == EGL_NO_SURFACE)
        return;
    const auto destroy = [&]() {
        if (!egl.MakeCurrent(d->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT))
            std::fprintf(stderr, "[webgl2] cannot release context before destruction: 0x%x\n",
                egl.GetError());
        if (d->context != EGL_NO_CONTEXT && !egl.DestroyContext(d->display, d->context))
            std::fprintf(stderr, "[webgl2] cannot destroy owned context: 0x%x\n", egl.GetError());
        if (d->surface != EGL_NO_SURFACE && !egl.DestroySurface(d->display, d->surface))
            std::fprintf(stderr, "[webgl2] cannot destroy owned surface: 0x%x\n", egl.GetError());
        d->context = EGL_NO_CONTEXT;
        d->surface = EGL_NO_SURFACE;
    };
    if (egl.GetCurrentDisplay() == d->display && egl.GetCurrentContext() == d->context) {
        destroy();
    } else {
        // ANGLE handles are display-scoped. Never destroy a colliding handle while another display
        // owns TLS.
        PuGpuCurrent owned(d);
        destroy();
    }
    // EGLDisplay is process-shared (including SDL/Skia). Never terminate their display.
}
#endif
