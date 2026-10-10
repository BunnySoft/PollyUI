#ifndef POLLY_SYSRT_FFI_H
#define POLLY_SYSRT_FFI_H

#include "quickjs.h"
#include "shared/dispatch.h"

/* Register the native sysrt:ffi module in this VM. It grants native-code
 * capabilities, not a sandbox; the composition root selects who receives it. */
typedef struct SrFfi SrFfi;
SrFfi *sr_ffi_register(JSContext *ctx, PuDispatch *dispatch);

/* Owning VM thread, outside dispatcher drain, before destroying ctx/dispatch.
 * Join accepted calls and settle their actual outcomes; arbitrary native calls
 * cannot be interrupted. The handle is borrowed until VM destruction. */
void sr_ffi_shutdown(SrFfi *ffi);

#endif
