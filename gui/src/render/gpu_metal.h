#ifndef POLLYUI_GPU_METAL_H
#define POLLYUI_GPU_METAL_H
#include "render/gpu_device.h"
#if defined(__APPLE__) && defined(PU_WEBGL2)
bool pu_gpu_metal_runtime_directory(std::string& directory, std::string& error);
PuGpuFailure pu_gpu_metal_inventory(std::string& error);
bool pu_gpu_metal_automatic_switching();
bool pu_gpu_metal_query(void* device, PuGpuInfo& info, std::string& error);
#endif
#endif
