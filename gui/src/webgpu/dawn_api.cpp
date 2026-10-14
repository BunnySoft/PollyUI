#include "webgpu/dawn_api.h"
#include "webgpu/provider.h"
#include <cstring>
#include <mutex>
#include <vector>

#ifdef _WIN32
#include <dxgi1_4.h>
#include <windows.h>
#elif defined(__APPLE__)
#include <dlfcn.h>
#include <mach-o/dyld.h>
#else
#include <dlfcn.h>
#include <unistd.h>
#endif

PuDawnApi::~PuDawnApi()
{
    if (!module)
        return;
#ifdef _WIN32
    FreeLibrary(static_cast<HMODULE>(module));
#else
    dlclose(module);
#endif
}

static void* load_module(std::string& error)
{
#ifdef _WIN32
    std::vector<wchar_t> path(32768);
    DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (!length || length >= path.size()) {
        error = "Cannot locate executable for Dawn provider";
        return nullptr;
    }
    wchar_t* separator = wcsrchr(path.data(), L'\\');
    if (!separator
        || wcscpy_s(separator + 1, path.size() - (separator + 1 - path.data()),
            L"pollyui-dawn-provider.dll")) {
        error = "Cannot construct Dawn provider path";
        return nullptr;
    }
    void* module = LoadLibraryExW(
        path.data(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (!module)
        error = "Cannot load Dawn provider (Windows error " + std::to_string(GetLastError()) + ")";
    return module;
#else
    std::vector<char> path(32768);
#ifdef __APPLE__
    uint32_t size = static_cast<uint32_t>(path.size());
    if (_NSGetExecutablePath(path.data(), &size)) {
        error = "Cannot locate executable for Dawn provider";
        return nullptr;
    }
    const char* filename = "libpollyui-dawn-provider.dylib";
#else
    ssize_t length = readlink("/proc/self/exe", path.data(), path.size() - 1);
    if (length <= 0 || static_cast<size_t>(length) >= path.size() - 1) {
        error = "Cannot locate executable for Dawn provider";
        return nullptr;
    }
    path[static_cast<size_t>(length)] = 0;
    const char* filename = "libpollyui-dawn-provider.so";
#endif
    std::string file(path.data());
    auto separator = file.find_last_of('/');
    if (separator == std::string::npos) {
        error = "Cannot construct Dawn provider path";
        return nullptr;
    }
    file.replace(separator + 1, std::string::npos, filename);
    void* module = dlopen(file.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!module)
        error = std::string("Cannot load Dawn provider: ") + dlerror();
    return module;
#endif
}
static void* symbol(void* module, const char* name)
{
#ifdef _WIN32
    return reinterpret_cast<void*>(GetProcAddress(static_cast<HMODULE>(module), name));
#else
    return dlsym(module, name);
#endif
}
std::shared_ptr<const PuDawnApi> pu_dawn_load(std::string& error)
{
    static std::mutex mutex;
    static std::weak_ptr<const PuDawnApi> cached;
    std::lock_guard<std::mutex> lock(mutex);
    if (auto api = cached.lock())
        return api;
    auto api = std::make_shared<PuDawnApi>();
    api->module = load_module(error);
    if (!api->module)
        return { };
    auto version
        = reinterpret_cast<PuDawnProviderVersion>(symbol(api->module, "pu_dawn_provider_version"));
    auto hash = reinterpret_cast<PuDawnProviderHeaderHash>(
        symbol(api->module, "pu_dawn_provider_header_hash"));
    auto proc
        = reinterpret_cast<PuDawnProviderGetProc>(symbol(api->module, "pu_dawn_provider_get_proc"));
    api->RequestAdapter = reinterpret_cast<PuDawnProviderRequestAdapter>(
        symbol(api->module, "pu_dawn_provider_request_adapter"));
    if (!version || !hash || !proc || !api->RequestAdapter || version() != PU_DAWN_PROVIDER_ABI
        || !hash() || std::strcmp(hash(), PU_DAWN_HEADER_HASH)) {
        error = "Dawn provider ABI/header fingerprint mismatch";
        return { };
    }
#define PU_DAWN_PROC(suffix)                                                                       \
    api->suffix                                                                                    \
        = reinterpret_cast<WGPUProc##suffix>(proc("wgpu" #suffix, sizeof("wgpu" #suffix) - 1));    \
    if (!api->suffix) {                                                                            \
        error = "Dawn provider lacks wgpu" #suffix;                                                \
        return { };                                                                                \
    }
#include "dawn-procs.inc"
#undef PU_DAWN_PROC
    cached = api;
    return api;
}
WGPUBackendType pu_dawn_backend()
{
#ifdef _WIN32
    return WGPUBackendType_D3D12;
#elif defined(__APPLE__)
    return WGPUBackendType_Metal;
#else
    return WGPUBackendType_Vulkan;
#endif
}
bool pu_dawn_software_options(
    WGPURequestAdapterOptions& options, PuDawnAdapterLuid& luid, std::string& error)
{
#ifdef _WIN32
    IDXGIFactory4* factory = nullptr;
    HRESULT result
        = CreateDXGIFactory1(__uuidof(IDXGIFactory4), reinterpret_cast<void**>(&factory));
    if (FAILED(result)) {
        error = "Cannot create DXGI factory for explicit WARP selection";
        return false;
    }
    IDXGIAdapter1* warp = nullptr;
    result = factory->EnumWarpAdapter(__uuidof(IDXGIAdapter1), reinterpret_cast<void**>(&warp));
    factory->Release();
    if (FAILED(result)) {
        error = "Cannot obtain explicit DXGI WARP adapter";
        return false;
    }
    DXGI_ADAPTER_DESC1 description;
    result = warp->GetDesc1(&description);
    warp->Release();
    if (FAILED(result) || !(description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) {
        error = "Requested WARP adapter does not have the DXGI software flag";
        return false;
    }
    luid = { };
    luid.low = description.AdapterLuid.LowPart;
    luid.high = description.AdapterLuid.HighPart;
    luid.selected = 1;
    /* Dawn may classify WARP as IntegratedGPU; its forceFallback filter then rejects it. */
    options.forceFallbackAdapter = false;
#else
    (void)options;
    (void)luid;
    (void)error;
#endif
    return true;
}
bool pu_dawn_is_software(const WGPUAdapterInfo& info, bool& software, std::string& error)
{
#ifdef _WIN32
    IDXGIFactory1* factory = nullptr;
    if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory)))) {
        error = "Cannot verify adapter against DXGI";
        return false;
    }
    bool found = false;
    bool all_software = true;
    for (UINT index = 0;; ++index) {
        IDXGIAdapter1* adapter = nullptr;
        HRESULT result = factory->EnumAdapters1(index, &adapter);
        if (result == DXGI_ERROR_NOT_FOUND)
            break;
        if (FAILED(result)) {
            factory->Release();
            error = "Cannot enumerate DXGI adapter identities";
            return false;
        }
        DXGI_ADAPTER_DESC1 description;
        result = adapter->GetDesc1(&description);
        adapter->Release();
        if (FAILED(result)) {
            factory->Release();
            error = "Cannot inspect DXGI adapter identity";
            return false;
        }
        if (description.VendorId == info.vendorID && description.DeviceId == info.deviceID) {
            found = true;
            all_software = all_software && !!(description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE);
        }
    }
    factory->Release();
    if (!found) {
        error = "Dawn adapter identity does not match an inspectable DXGI adapter";
        return false;
    }
    software = info.adapterType == WGPUAdapterType_CPU || all_software;
#else
    (void)error;
    software = info.adapterType == WGPUAdapterType_CPU;
#endif
    return true;
}
