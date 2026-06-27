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

/* Dispatch a pointer event (mousedown/mouseup/mousemove/click) at `target`,
 * carrying clientX/clientY. mousemove also emits mouseenter/mouseleave as the
 * hovered element changes. Pass the hit-tested target (NULL = empty space). */
void pu_bridge_dispatch_pointer(PuBridge *b, const char *type, PuNode *target, float x, float y);

/* Wheel at `target`: dispatch a "wheel" event, then scroll the nearest
 * overflow:scroll/auto ancestor by dy (logical px), clamped to its content. */
void pu_bridge_dispatch_wheel(PuBridge *b, PuNode *target, float x, float y, float dy);

/* --- focus + keyboard --- */
/* Move focus to `node` (NULL = blur), firing blur/focus events. */
void    pu_bridge_set_focus(PuBridge *b, PuNode *node);
PuNode *pu_bridge_focused(PuBridge *b);
/* Advance focus to the next focusable (tabIndex >= 0) element in tree order. */
void    pu_bridge_focus_next(PuBridge *b);
/* Dispatch a keyboard event (with a `key` field) to the focused element. */
void    pu_bridge_dispatch_key(PuBridge *b, const char *type, const char *key);

#endif /* POLLYUI_BRIDGE_BRIDGE_H */
