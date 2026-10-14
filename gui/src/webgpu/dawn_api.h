#ifndef POLLYUI_DAWN_API_H
#define POLLYUI_DAWN_API_H

#include "webgpu/provider.h"
#include <memory>
#include <string>
#include <webgpu/webgpu.h>

struct PuDawnApi {
#define PU_DAWN_PROC(suffix) WGPUProc##suffix suffix = nullptr;
#include "dawn-procs.inc"
#undef PU_DAWN_PROC
    void* module = nullptr;
    PuDawnProviderRequestAdapter RequestAdapter = nullptr;
    ~PuDawnApi();
};

std::shared_ptr<const PuDawnApi> pu_dawn_load(std::string& error);
WGPUBackendType pu_dawn_backend();
/* The native adapter's software identity, not a claimed physical qualification. */
bool pu_dawn_is_software(const WGPUAdapterInfo& info, bool& software, std::string& error);
struct PuDawnAdapterLuid {
    uint32_t low = 0;
    int32_t high = 0;
    uint32_t selected = 0;
};
bool pu_dawn_software_options(
    WGPURequestAdapterOptions& options, PuDawnAdapterLuid& luid, std::string& error);
#endif
