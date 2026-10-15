#include "render/gpu_metal.h"
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <mach-o/dyld.h>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <vector>

bool pu_gpu_metal_runtime_directory(std::string& directory, std::string& error)
{
    for (const char* name : { "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
             "DYLD_VERSIONED_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_FRAMEWORK_PATH",
             "DYLD_FALLBACK_FRAMEWORK_PATH", "DYLD_IMAGE_SUFFIX", "DYLD_ROOT_PATH" }) {
        const char* value = std::getenv(name);
        if (value && *value) {
            error = "Application-local ANGLE refuses DYLD library/framework override variables";
            return false;
        }
    }
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    if (!size) {
        error = "Cannot determine the native application executable path";
        return false;
    }
    std::vector<char> path(size);
    if (_NSGetExecutablePath(path.data(), &size)) {
        error = "Cannot read the native application executable path";
        return false;
    }
    std::unique_ptr<char, decltype(&std::free)> canonical(
        realpath(path.data(), nullptr), &std::free);
    if (!canonical) {
        error = "Cannot resolve the native application executable path";
        return false;
    }
    @autoreleasepool {
        NSString* executable = [[NSFileManager defaultManager]
            stringWithFileSystemRepresentation:canonical.get()
                                        length:strlen(canonical.get())];
        if (!executable) {
            error = "Cannot decode the native executable path";
            return false;
        }
        NSString* parent = executable.stringByDeletingLastPathComponent;
        NSString* contents = parent.stringByDeletingLastPathComponent;
        NSString* bundle = contents.stringByDeletingLastPathComponent;
        NSString* target = nil;
        if ([parent.lastPathComponent isEqualToString:@"MacOS"] &&
            [contents.lastPathComponent isEqualToString:@"Contents"] &&
            [bundle.pathExtension isEqualToString:@"app"])
            target = [contents stringByAppendingPathComponent:@"Frameworks/PollyANGLE"];
        else
            target = [parent stringByAppendingPathComponent:@"polly-angle"];
        const char* bytes = target.fileSystemRepresentation;
        if (!bytes) {
            error = "Cannot encode the application-local ANGLE directory";
            return false;
        }
        directory = bytes;
    }
    return true;
}

PuGpuFailure pu_gpu_metal_inventory(std::string& error)
{
    @autoreleasepool {
        NSArray<id<MTLDevice>>* devices = MTLCopyAllDevices();
        if (!devices) {
            error = "Native Metal inventory did not return a device array; availability is unverified";
            return PuGpuFailure::DeviceQuery;
        }
        if (!devices.count) {
            error = "Native Metal inventory contains no accessible GPU device";
            return PuGpuFailure::NoHardware;
        }
        for (id<MTLDevice> device in devices) {
            if (![device conformsToProtocol:@protocol(MTLDevice)]) {
                error = "Native Metal inventory returned an invalid device protocol";
                return PuGpuFailure::DeviceQuery;
            }
            if ([device supportsFamily:MTLGPUFamilyMac2])
                return PuGpuFailure::None;
        }
        error = "Native Metal devices do not meet the pinned ANGLE Mac GPU Family 2 requirement";
        return PuGpuFailure::DeviceRejected;
    }
}

bool pu_gpu_metal_automatic_switching()
{
    @autoreleasepool {
        id setting = [[NSBundle mainBundle]
            objectForInfoDictionaryKey:@"NSSupportsAutomaticGraphicsSwitching"];
        return [setting isKindOfClass:[NSNumber class]] && [setting boolValue];
    }
}

bool pu_gpu_metal_query(void* pointer, PuGpuInfo& info, std::string& error)
{
    @autoreleasepool {
        id<MTLDevice> device = (__bridge id<MTLDevice>)pointer;
        if (!device || ![device conformsToProtocol:@protocol(MTLDevice)]) {
            error = "ANGLE did not return a valid native MTLDevice protocol";
            return false;
        }
        const char* name = device.name.UTF8String;
        if (!name || ![device supportsFamily:MTLGPUFamilyMac2]) {
            error = "ANGLE's native Metal device properties do not satisfy the pinned provider";
            return false;
        }
        info.type = PuGpuType::MetalGpu;
        info.name = name;
        info.metal_registry_id = device.registryID;
        info.metal_low_power = device.lowPower;
        info.metal_removable = device.removable;
        info.metal_headless = device.headless;
        info.metal_unified_memory = device.hasUnifiedMemory;
    }
    return true;
}
