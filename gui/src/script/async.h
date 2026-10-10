#ifndef POLLYUI_CONCURRENCY_ASYNC_H
#define POLLYUI_CONCURRENCY_ASYNC_H

/* Concurrency layer (DESIGN: "UI thread + work threads").
 *
 * Installs two JS-facing facilities, both marshaling results back to the UI
 * thread via the dispatcher (the BeginInvoke mechanism):
 *
 *   (A) Worker  — `new Worker(path)` runs a separate QuickJS context on its own
 *       thread (no DOM), talking via postMessage/onmessage (JSON messages).
 *   (B) computeAsync(n, cb) — runs a native compute on a background thread and
 *       calls `cb(result)` on the UI thread (libuv / BackgroundWorker style). */

#include "quickjs.h"
#include "shared/dispatch.h"

void pu_async_install(JSContext *ctx, PuDispatch *dispatch);
void pu_async_shutdown(void); /* terminate workers; call before destroying ctx */

#endif /* POLLYUI_CONCURRENCY_ASYNC_H */
