#ifndef POLLY_SYSRT_FFI_H
#define POLLY_SYSRT_FFI_H

#include "quickjs.h"
#include "shared/dispatch.h"

/* Register the native sysrt:ffi module in this VM. It grants native-code
 * capabilities, not a sandbox; the composition root selects who receives it. */
typedef struct SrFfi SrFfi;
SrFfi *sr_ffi_register(JSContext *ctx, PuDispatch *dispatch);

/* callback(signature, fn) creates a VM-owned scalar callback handle. Only
 * 'callback' parameters of synchronous scalar-only calls accept it. The native
 * address exists only until that call returns: native code MUST NOT retain it
 * or invoke it after returning, even if the JS handle is still open. A joined
 * foreign-thread invocation rejects the outer call without entering QuickJS.
 * close() refuses active use; GC retains the JS function through the handle.
 * Exceptions reject the outer call after native code returns; libffi receives
 * a zero ABI placeholder and later JS entries are suppressed. This does not
 * cancel native execution or roll back its side effects.
 *
 * Owning VM thread, outside dispatcher drain, before destroying ctx/dispatch.
 * Join accepted calls and settle their actual outcomes; arbitrary native calls
 * cannot be interrupted. During a synchronous call, shutdown closes admission
 * and defers joins until it returns. The host MUST NOT destroy ctx/runtime while
 * JS or native synchronous calls are on the stack. The handle is borrowed until
 * VM destruction. */
void sr_ffi_shutdown(SrFfi *ffi);

#endif
