#ifndef POLLY_SYSRT_FFI_H
#define POLLY_SYSRT_FFI_H

#include "quickjs.h"

/* Register the native sysrt:ffi module in this VM. It grants native-code
 * capabilities, not a sandbox; the composition root selects who receives it. */
int sr_ffi_register(JSContext *ctx);

#endif
