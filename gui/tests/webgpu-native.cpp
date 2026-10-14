#include "webgpu/dawn_api.h"
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>

struct Result {
    bool done = false;
    bool ok = false;
    WGPUAdapter adapter = nullptr;
    WGPUDevice device = nullptr;
    std::string message;
};
static std::string copy_string(WGPUStringView value)
{
    return value.data ? std::string(value.data,
                            value.length == WGPU_STRLEN ? std::strlen(value.data) : value.length)
                      : "";
}
static void adapter_ready(WGPURequestAdapterStatus status, WGPUAdapter adapter,
    WGPUStringView message, void* userdata, void*)
{
    auto& result = *static_cast<Result*>(userdata);
    result.adapter = adapter;
    result.ok = status == WGPURequestAdapterStatus_Success;
    result.message = copy_string(message);
    result.done = true;
}
static void device_ready(WGPURequestDeviceStatus status, WGPUDevice device, WGPUStringView message,
    void* userdata, void*)
{
    auto& result = *static_cast<Result*>(userdata);
    result.device = device;
    result.ok = status == WGPURequestDeviceStatus_Success;
    result.message = copy_string(message);
    result.done = true;
}
static void map_ready(WGPUMapAsyncStatus status, WGPUStringView message, void* userdata, void*)
{
    auto& result = *static_cast<Result*>(userdata);
    result.ok = status == WGPUMapAsyncStatus_Success;
    result.message = copy_string(message);
    result.done = true;
}
static void error_ready(
    WGPUDevice const*, WGPUErrorType type, WGPUStringView message, void* userdata, void*)
{
    auto& result = *static_cast<Result*>(userdata);
    result.ok = false;
    result.message = "uncaptured error " + std::to_string(type) + ": " + copy_string(message);
}
static bool wait(const PuDawnApi& api, WGPUInstance instance, Result& result)
{
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!result.done && std::chrono::steady_clock::now() < deadline) {
        api.InstanceProcessEvents(instance);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (!result.done || !result.ok)
        std::fprintf(stderr, "FAIL: native callback: %s\n", result.message.c_str());
    return result.done && result.ok;
}
int main(int argc, char** argv)
{
    bool software = argc == 2 && !std::strcmp(argv[1], "--software");
    bool hardware = argc == 2 && !std::strcmp(argv[1], "--hardware");
    if (!software && !hardware) {
        std::fprintf(stderr, "usage: webgpu-native-test --software|--hardware\n");
        return 2;
    }
    std::string error;
    auto api = pu_dawn_load(error);
    if (!api) {
        std::fprintf(stderr, "FAIL: %s\n", error.c_str());
        return 1;
    }
    WGPUInstanceDescriptor instance_descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
    WGPUInstance instance = api->CreateInstance(&instance_descriptor);
    if (!instance) {
        std::fprintf(stderr, "FAIL: native instance\n");
        return 1;
    }
    Result request;
    WGPURequestAdapterOptions options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    options.backendType = pu_dawn_backend();
    PuDawnAdapterLuid luid;
    if (software && !pu_dawn_software_options(options, luid, error)) {
        std::fprintf(stderr, "FAIL: %s\n", error.c_str());
        api->InstanceRelease(instance);
        return 1;
    }
    WGPURequestAdapterCallbackInfo callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    callback.mode = WGPUCallbackMode_AllowProcessEvents;
    callback.callback = adapter_ready;
    callback.userdata1 = &request;
    api->RequestAdapter(instance, &options, luid.low, luid.high, luid.selected, &callback);
    bool ok = wait(*api, instance, request);
    int exit_code = 1;
    WGPUAdapter adapter = request.adapter;
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    WGPUBuffer storage = nullptr, readback = nullptr;
    WGPUShaderModule shader = nullptr;
    WGPUComputePipeline pipeline = nullptr;
    WGPUBindGroupLayout layout = nullptr;
    WGPUBindGroup group = nullptr;
    WGPUCommandEncoder encoder = nullptr;
    WGPUComputePassEncoder pass = nullptr;
    WGPUCommandBuffer command = nullptr;
    Result errors;
    if (ok) {
        WGPUAdapterInfo info = WGPU_ADAPTER_INFO_INIT;
        ok = api->AdapterGetInfo(adapter, &info) == WGPUStatus_Success;
        bool cpu = false;
        ok = ok && pu_dawn_is_software(info, cpu, error);
        bool virtual_adapter = false;
#ifdef _WIN32
        /* Microsoft DXGI adapters include WARP and synthetic/remote adapters, not physical
         * qualification. */
        virtual_adapter = info.vendorID == 0x1414;
#endif
        std::printf("Native adapter backend=%d type=%d software=%d virtual=%d vendor=%u "
                    "deviceId=%u device=%s description=%s\n",
            info.backendType, info.adapterType, cpu, virtual_adapter, info.vendorID, info.deviceID,
            copy_string(info.device).c_str(), copy_string(info.description).c_str());
        ok = ok && info.backendType == pu_dawn_backend();
        api->AdapterInfoFreeMembers(info);
        if (ok && hardware && (cpu || virtual_adapter)) {
            std::puts(
                "UNAVAILABLE: CPU/synthetic/remote adapter; no physical hardware qualification");
            ok = false;
            exit_code = 77;
        }
        if (software && !cpu) {
#ifdef __APPLE__
            std::puts("UNAVAILABLE: Metal adapter is not CPU; no software qualification");
            exit_code = 77;
#else
            std::fprintf(stderr, "FAIL: explicit software request returned a non-CPU adapter\n");
#endif
            ok = false;
        }
    }
    if (ok) {
        request = { };
        WGPUDeviceDescriptor descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
        descriptor.uncapturedErrorCallbackInfo.callback = error_ready;
        descriptor.uncapturedErrorCallbackInfo.userdata1 = &errors;
        WGPURequestDeviceCallbackInfo callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_AllowProcessEvents;
        callback.callback = device_ready;
        callback.userdata1 = &request;
        api->AdapterRequestDevice(adapter, &descriptor, callback);
        ok = wait(*api, instance, request);
        device = request.device;
    }
    if (ok) {
        queue = api->DeviceGetQueue(device);
        WGPUShaderSourceWGSL source = WGPU_SHADER_SOURCE_WGSL_INIT;
        source.code = { "@group(0) @binding(0) var<storage,read_write> a:array<u32>;"
                        "@compute @workgroup_size(1) fn main(){a[0]=a[0]*2u+1u;}",
            WGPU_STRLEN };
        WGPUShaderModuleDescriptor shader_descriptor = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
        shader_descriptor.nextInChain = &source.chain;
        shader = api->DeviceCreateShaderModule(device, &shader_descriptor);
        WGPUComputePipelineDescriptor pipeline_descriptor = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
        pipeline_descriptor.compute.module = shader;
        pipeline_descriptor.compute.entryPoint = { "main", WGPU_STRLEN };
        pipeline = api->DeviceCreateComputePipeline(device, &pipeline_descriptor);
        WGPUBufferDescriptor buffer_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        buffer_descriptor.size = 4;
        buffer_descriptor.usage
            = WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst;
        storage = api->DeviceCreateBuffer(device, &buffer_descriptor);
        buffer_descriptor.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
        readback = api->DeviceCreateBuffer(device, &buffer_descriptor);
        uint32_t input = 3;
        api->QueueWriteBuffer(queue, storage, 0, &input, 4);
        layout = api->ComputePipelineGetBindGroupLayout(pipeline, 0);
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.buffer = storage;
        entry.size = 4;
        WGPUBindGroupDescriptor group_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group_descriptor.layout = layout;
        group_descriptor.entryCount = 1;
        group_descriptor.entries = &entry;
        group = api->DeviceCreateBindGroup(device, &group_descriptor);
        WGPUCommandEncoderDescriptor encoder_descriptor = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
        encoder = api->DeviceCreateCommandEncoder(device, &encoder_descriptor);
        WGPUComputePassDescriptor pass_descriptor = WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
        pass = api->CommandEncoderBeginComputePass(encoder, &pass_descriptor);
        api->ComputePassEncoderSetPipeline(pass, pipeline);
        api->ComputePassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
        api->ComputePassEncoderDispatchWorkgroups(pass, 1, 1, 1);
        api->ComputePassEncoderEnd(pass);
        api->CommandEncoderCopyBufferToBuffer(encoder, storage, 0, readback, 0, 4);
        WGPUCommandBufferDescriptor command_descriptor = WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
        command = api->CommandEncoderFinish(encoder, &command_descriptor);
        api->QueueSubmit(queue, 1, &command);
        request = { };
        WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_AllowProcessEvents;
        callback.callback = map_ready;
        callback.userdata1 = &request;
        api->BufferMapAsync(readback, WGPUMapMode_Read, 0, 4, callback);
        ok = wait(*api, instance, request);
        if (ok) {
            const void* mapped = api->BufferGetConstMappedRange(readback, 0, 4);
            uint32_t actual = 0;
            if (mapped)
                std::memcpy(&actual, mapped, 4);
            std::printf("Native WGSL compute: input=3 expected=7 actual=%u\n", actual);
            ok = mapped && actual == 7 && errors.message.empty();
            api->BufferUnmap(readback);
        }
        if (!errors.message.empty())
            std::fprintf(stderr, "FAIL: %s\n", errors.message.c_str());
        if (ok)
            exit_code = 0;
    }
    if (command)
        api->CommandBufferRelease(command);
    if (pass)
        api->ComputePassEncoderRelease(pass);
    if (encoder)
        api->CommandEncoderRelease(encoder);
    if (group)
        api->BindGroupRelease(group);
    if (layout)
        api->BindGroupLayoutRelease(layout);
    if (pipeline)
        api->ComputePipelineRelease(pipeline);
    if (shader)
        api->ShaderModuleRelease(shader);
    if (readback)
        api->BufferRelease(readback);
    if (storage)
        api->BufferRelease(storage);
    if (queue)
        api->QueueRelease(queue);
    if (device) {
        api->DeviceDestroy(device);
        api->DeviceRelease(device);
    }
    if (adapter)
        api->AdapterRelease(adapter);
    api->InstanceRelease(instance);
    return exit_code;
}
