#ifndef POLLYUI_SCRIPT_STORAGE_H
#define POLLYUI_SCRIPT_STORAGE_H

/* localStorage — a persistent string key/value store (DESIGN.md §2).
 *
 * Installs a `localStorage` global (getItem/setItem/removeItem/clear/key +
 * length) backed by a simple length-prefixed file at `path`, loaded on install
 * and rewritten on every mutation. */

#include "quickjs.h"

/* Install the `localStorage` global, loading any existing data from `path`
 * (which subsequent writes persist to). Safe to call once per context. */
void pu_storage_install(JSContext *ctx, const char *path);

/* Release the in-memory store (does not delete the file). */
void pu_storage_shutdown(void);

#endif /* POLLYUI_SCRIPT_STORAGE_H */
