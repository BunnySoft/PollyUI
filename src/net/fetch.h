#ifndef POLLYUI_NET_FETCH_H
#define POLLYUI_NET_FETCH_H

/* fetch() — a Promise-based HTTP/file client (DESIGN.md §2).
 *
 * The request runs on a background thread (WinHTTP/Linux libcurl, a local read
 * for file://); the result is marshaled back to the UI thread via the
 * dispatcher to resolve/reject the Promise — the same pattern as computeAsync. */

#include "quickjs.h"
#include "core/dispatch.h"

/* Install the `fetch` global. Returns 0 with a diagnostic on initialization failure. */
int pu_fetch_install(JSContext *ctx, PuDispatch *dispatch);
/* Cancel/join requests and release queued callbacks before destroying the VM. */
void pu_fetch_shutdown(void);

#endif /* POLLYUI_NET_FETCH_H */
