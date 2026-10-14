#ifndef POLLYUI_DAWN_PROVIDER_H
#define POLLYUI_DAWN_PROVIDER_H

#include <stddef.h>
#include <stdint.h>

#define PU_DAWN_PROVIDER_ABI 2u
#ifdef __cplusplus
extern "C" {
#endif
typedef void (*PuDawnProc)(void);
typedef uint32_t (*PuDawnProviderVersion)(void);
typedef const char* (*PuDawnProviderHeaderHash)(void);
typedef PuDawnProc (*PuDawnProviderGetProc)(const char* name, size_t length);
typedef uint64_t (*PuDawnProviderRequestAdapter)(void* instance, const void* options,
    uint32_t luid_low, int32_t luid_high, uint32_t use_luid, const void* callback);
#ifdef __cplusplus
}
#endif
#endif
