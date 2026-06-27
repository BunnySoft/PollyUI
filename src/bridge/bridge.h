#ifndef POLLYUI_BRIDGE_BRIDGE_H
#define POLLYUI_BRIDGE_BRIDGE_H

/* Bridge — exposes the Model to the ScriptEngine (DESIGN.md §6).
 *
 * Installs `document`, a Node class with a wrapper cache (native PuNode <-> JS
 * object identity), and an exotic `style` object. Owns the document body. */

#include "quickjs.h"
#include "model/node.h"

typedef struct PuBridge PuBridge;

/* Install the DOM bindings into `ctx`. Returns NULL on failure.
 * Free with pu_bridge_free AFTER the context is destroyed (it only frees the
 * native node tree, which outlives the JS wrappers). */
PuBridge *pu_bridge_install(JSContext *ctx);
void      pu_bridge_free(PuBridge *b);

/* The document body element (root of the user's tree). */
PuNode *pu_bridge_body(PuBridge *b);

/* Dispatch an event of `type` to `target`, bubbling up to the root, invoking
 * matching listeners with an event object. */
void pu_bridge_dispatch_event(PuBridge *b, PuNode *target, const char *type);

#endif /* POLLYUI_BRIDGE_BRIDGE_H */
