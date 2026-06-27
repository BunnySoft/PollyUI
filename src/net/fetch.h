#ifndef POLLYUI_NET_FETCH_H
#define POLLYUI_NET_FETCH_H

/* fetch() — a Promise-based HTTP/file client (DESIGN.md §2).
 *
 * The request runs on a background thread (WinHTTP for http/https, a local read
 * for file://); the result is marshaled back to the UI thread via the
 * dispatcher to resolve/reject the Promise — the same pattern as computeAsync. */

#include "quickjs.h"
#include "core/dispatch.h"

/* Install the `fetch` global. `dispatch` delivers results to the UI thread. */
void pu_fetch_install(JSContext *ctx, PuDispatch *dispatch);

#endif /* POLLYUI_NET_FETCH_H */
