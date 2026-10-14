#include "webgpu/provider.h"
#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif
EXPORT uint32_t pu_dawn_provider_version(void) { return PU_TEST_PROVIDER_ABI; }
EXPORT const char *pu_dawn_provider_header_hash(void) { return PU_TEST_PROVIDER_HASH; }
EXPORT PuDawnProc pu_dawn_provider_get_proc(const char *name,size_t length)
{
    (void)name;(void)length;return NULL;
}
EXPORT uint64_t pu_dawn_provider_request_adapter(void *instance,const void *options,
    uint32_t low,int32_t high,uint32_t selected,const void *callback)
{
    (void)instance;(void)options;(void)low;(void)high;(void)selected;(void)callback;return 0;
}
