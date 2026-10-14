#include "provider.h"
#include <webgpu/webgpu.h>
#ifdef _WIN32
#include <dawn/native/D3DBackend.h>
#endif

#ifdef _WIN32
#define PU_PROVIDER_EXPORT __declspec(dllexport)
#else
#define PU_PROVIDER_EXPORT __attribute__((visibility("default")))
#endif

extern "C" PU_PROVIDER_EXPORT uint32_t pu_dawn_provider_version(void)
{
    return PU_DAWN_PROVIDER_ABI;
}
extern "C" PU_PROVIDER_EXPORT const char* pu_dawn_provider_header_hash(void)
{
    return PU_DAWN_HEADER_HASH;
}
extern "C" PU_PROVIDER_EXPORT PuDawnProc pu_dawn_provider_get_proc(const char* name, size_t length)
{
    WGPUStringView view = { name, length };
    return wgpuGetProcAddress(view);
}
extern "C" PU_PROVIDER_EXPORT uint64_t pu_dawn_provider_request_adapter(void* instance,
    const void* options, uint32_t low, int32_t high, uint32_t use_luid, const void* callback)
{
    WGPURequestAdapterOptions native = *static_cast<const WGPURequestAdapterOptions*>(options);
#ifdef _WIN32
    dawn::native::d3d::RequestAdapterOptionsLUID selection;
    if (use_luid) {
        selection.adapterLUID.LowPart = low;
        selection.adapterLUID.HighPart = high;
        native.nextInChain = reinterpret_cast<WGPUChainedStruct*>(&selection);
    }
#else
    (void)low;
    (void)high;
    (void)use_luid;
#endif
    WGPUFuture future = wgpuInstanceRequestAdapter(static_cast<WGPUInstance>(instance), &native,
        *static_cast<const WGPURequestAdapterCallbackInfo*>(callback));
    return future.id;
}
