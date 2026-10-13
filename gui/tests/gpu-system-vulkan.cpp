#include <windows.h>
#include <vulkan/vulkan_core.h>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

static std::string json(const char* text, size_t bound)
{
    std::string result = "\"";
    for (size_t i = 0; i < bound && text[i]; ++i) {
        unsigned char c = text[i];
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
int main()
{
    HMODULE library = LoadLibraryExW(L"vulkan-1.dll", nullptr,
        LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!library) {
        std::fprintf(stderr, "System Vulkan loader unavailable: %lu\n", GetLastError());
        return 1;
    }
    auto create
        = reinterpret_cast<PFN_vkCreateInstance>(GetProcAddress(library, "vkCreateInstance"));
    auto destroy
        = reinterpret_cast<PFN_vkDestroyInstance>(GetProcAddress(library, "vkDestroyInstance"));
    auto enumerate = reinterpret_cast<PFN_vkEnumeratePhysicalDevices>(
        GetProcAddress(library, "vkEnumeratePhysicalDevices"));
    auto properties = reinterpret_cast<PFN_vkGetPhysicalDeviceProperties>(
        GetProcAddress(library, "vkGetPhysicalDeviceProperties"));
    if (!create || !destroy || !enumerate || !properties)
        return 1;
    VkApplicationInfo application = { };
    application.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    application.pApplicationName = "PollyUI native device inventory";
    application.apiVersion = VK_API_VERSION_1_0;
    VkInstanceCreateInfo info = { };
    info.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    info.pApplicationInfo = &application;
    VkInstance instance = VK_NULL_HANDLE;
    VkResult result = create(&info, nullptr, &instance);
    bool override_present = std::getenv("VK_DRIVER_FILES") || std::getenv("VK_ICD_FILENAMES");
    std::printf("SYSTEM_VULKAN_INVENTORY {\"kind\":\"normal-loader-physical-device-query-only\","
                "\"createResult\":%d,\"driverOverridePresent\":%s,\"devices\":[",
        result, override_present ? "true" : "false");
    int failed = 0;
    if (result == VK_SUCCESS) {
        uint32_t count = 0;
        result = enumerate(instance, &count, nullptr);
        if (result != VK_SUCCESS || count > 4096)
            failed = 1;
        else {
            std::vector<VkPhysicalDevice> devices(count);
            if (count) {
                result = enumerate(instance, &count, devices.data());
                if (result != VK_SUCCESS)
                    failed = 1;
            }
            if (!failed)
                for (uint32_t i = 0; i < count; ++i) {
                    VkPhysicalDeviceProperties value = { };
                    properties(devices[i], &value);
                    bool gpu = value.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
                        || value.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
                        || value.deviceType == VK_PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU;
                    std::printf("%s{\"nativeDeviceType\":%d,\"gpuBacked\":%s,\"vendorId\":%u,"
                                "\"deviceId\":%u,"
                                "\"apiVersion\":%u,\"name\":%s}",
                        i ? "," : "", value.deviceType, gpu ? "true" : "false", value.vendorID,
                        value.deviceID, value.apiVersion,
                        json(value.deviceName, VK_MAX_PHYSICAL_DEVICE_NAME_SIZE).c_str());
                }
        }
        destroy(instance, nullptr);
    } else if (result != VK_ERROR_INCOMPATIBLE_DRIVER)
        failed = 1;
    std::printf("],\"enumerationResult\":%d}\n", result);
    FreeLibrary(library);
    return failed;
}
