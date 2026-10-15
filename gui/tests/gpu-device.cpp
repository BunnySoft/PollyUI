#include "render/gpu_device.h"
#include <cstdio>
#include <cstring>
#include <string>

static std::string json(const std::string& text)
{
    std::string result = "\"";
    for (unsigned char c : text) {
        if (c == '"' || c == '\\') {
            result += '\\';
            result += (char)c;
        } else if (c < ' ') {
            char encoded[7];
            std::snprintf(encoded, sizeof(encoded), "\\u%04x", c);
            result += encoded;
        } else
            result += (char)c;
    }
    return result + "\"";
}
int main(int argc, char** argv)
{
    PuGpuDevice device;
    bool require_physical = false;
    bool require_metal = false;
    for (int i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "--software"))
            device.options.policy = PuGpuPolicy::Software;
        else if (!strcmp(argv[i], "--hardware"))
            device.options.policy = PuGpuPolicy::Hardware;
        else if (!strcmp(argv[i], "--hardware-required")) {
            device.options.policy = PuGpuPolicy::Hardware;
            require_physical = true;
        } else if (!strcmp(argv[i], "--metal-required")) {
            device.options.policy = PuGpuPolicy::Hardware;
            require_metal = true;
        } else if (!strcmp(argv[i], "--strict"))
            device.options.strict = true;
        else if (!strcmp(argv[i], "--low-power"))
            device.options.power = PuGpuPower::LowPower;
        else if (!strcmp(argv[i], "--high-performance"))
            device.options.power = PuGpuPower::HighPerformance;
        else {
            std::fprintf(stderr, "Unknown native device verifier argument: %s\n", argv[i]);
            return 2;
        }
    }
#ifndef __APPLE__
    if (require_metal) {
        std::fprintf(stderr, "Native Metal qualification requires a macOS executable; another platform cannot substitute.\n");
        return 2;
    }
#endif
    bool available = pu_gpu_device_open(&device);
    bool gpu = available && pu_gpu_is_hardware(device.info.type);
    bool physical = gpu
        && (device.info.type == PuGpuType::Integrated || device.info.type == PuGpuType::Discrete);
    std::printf(
        "NATIVE_WEBGL_DEVICE {\"available\":%s,\"policy\":\"%s\",\"type\":\"%s\","
        "\"gpuBacked\":%s,\"physicalGpu\":%s,\"vendorId\":%u,\"deviceId\":%u,\"apiVersion\":%u,"
        "\"driverVersion\":%u,\"name\":%s,\"requestedPower\":\"%s\",\"powerHintSubmitted\":%s,"
        "\"strictCaveat\":%s,\"failureKind\":%d,\"eglLibrary\":%s,\"glesLibrary\":%s,"
        "\"vulkanEntryLibrary\":%s,\"metalRegistryId\":\"%llu\",\"metalLowPower\":%s,"
        "\"metalRemovable\":%s,\"metalHeadless\":%s,\"metalUnifiedMemory\":%s,"
        "\"automaticGraphicsSwitching\":%s,\"error\":%s}\n",
        available ? "true" : "false", pu_gpu_policy_name(device.options.policy),
        pu_gpu_type_name(device.info.type), gpu ? "true" : "false", physical ? "true" : "false",
        device.info.vendor, device.info.device, device.info.api_version, device.info.driver_version,
        json(device.info.name).c_str(), pu_gpu_power_name(device.options.power),
        device.info.power_hint_submitted ? "true" : "false",
        device.options.strict ? "true" : "false", static_cast<int>(device.failure),
        json(device.info.egl_library).c_str(), json(device.info.gles_library).c_str(),
        json(device.info.vulkan_entry_library).c_str(),
        static_cast<unsigned long long>(device.info.metal_registry_id),
        device.info.metal_low_power ? "true" : "false",
        device.info.metal_removable ? "true" : "false",
        device.info.metal_headless ? "true" : "false",
        device.info.metal_unified_memory ? "true" : "false",
        device.info.automatic_graphics_switching ? "true" : "false", json(device.error).c_str());
    pu_gpu_device_close(&device);
    if (require_metal) {
        if (!available && device.failure == PuGpuFailure::NoHardware) {
            std::puts(
                "SKIP: native Metal inventory has no accessible GPU; no CPU substitute was used.");
            return 77;
        }
        return available && device.info.type == PuGpuType::MetalGpu ? 0 : 1;
    }
    if (require_physical && !physical
        && ((available && device.options.policy == PuGpuPolicy::Hardware
                && device.info.type == PuGpuType::Virtual)
            || device.failure == PuGpuFailure::NoHardware)) {
        std::puts("SKIP: physical Windows Vulkan GPU qualification unavailable; no software proxy "
                  "was used.");
        return 77;
    }
    return (require_physical ? physical : available) ? 0 : 1;
}
