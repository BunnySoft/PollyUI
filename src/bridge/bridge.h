#ifndef POLLYUI_BRIDGE_BRIDGE_H
#define POLLYUI_BRIDGE_BRIDGE_H

/* Bridge — exposes the Model to the ScriptEngine (DESIGN.md §6).
 *
 * Installs `document`, a Node class with a wrapper cache (native PuNode <-> JS
 * object identity), and an exotic `style` object. Owns the document body. */

#include "quickjs.h"
#include "model/node.h"
#include "host/input.h"

typedef struct PuBridge PuBridge;

/* Install the DOM bindings into `ctx`. Returns NULL on failure.
 * Free with pu_bridge_free BEFORE destroying the context/runtime, after stopping
 * event dispatch. Native-held listener callbacks must not outlive the VM. */
PuBridge *pu_bridge_install(JSContext *ctx);
void      pu_bridge_free(PuBridge *b);
/* Additional documents share the main bridge's JS runtime, not its input state.
 * Release the native ownership when the window closes; JS references may retain
 * the document. Only pu_bridge_free(main) tears down the shared DOM runtime. */
PuBridge *pu_bridge_new_document(PuBridge *main);
JSValue   pu_bridge_document(PuBridge *b);
void      pu_bridge_release_document(PuBridge *b);

/* The document body element (root of the user's tree). */
PuNode *pu_bridge_body(PuBridge *b);

/* Dispatch an event of `type` to `target`, bubbling up to the root, invoking
 * matching listeners with an event object. */
void pu_bridge_dispatch_event(PuBridge *b, PuNode *target, const char *type);

/* Dispatch a pointer event (mousedown/mouseup/mousemove/click) at `target`,
 * carrying clientX/clientY. mousemove also emits mouseenter/mouseleave as the
 * hovered element changes. Pass the hit-tested target (NULL = empty space). */
/* Returns nonzero if the hovered element changed (so `hover:*` style overrides
 * differ and the host must repaint, independent of any JS re-render). */
int pu_bridge_dispatch_pointer(PuBridge *b, PuNode *target, const PuPointerEvent *event);

/* Wheel at `target`: dispatch a "wheel" event, then, unless prevented, scroll the
 * nearest overflow:scroll/auto ancestor on both axes, clamped to its content.
 * Returns nonzero if the native scroll offset actually changed (this scroll is
 * applied directly to the C-side style, NOT via the JS reactive path, so the
 * host needs this signal to know it must repaint). */
int pu_bridge_dispatch_wheel(PuBridge *b, PuNode *target, const PuWheelEvent *event);

/* --- focus + keyboard --- */
/* Move focus to `node` (NULL = blur), firing blur/focus events. Returns nonzero
 * if focus actually changed (so `focus:*` overrides differ -> host repaints). */
int     pu_bridge_set_focus(PuBridge *b, PuNode *node);
PuNode *pu_bridge_focused(PuBridge *b);
/* Advance focus to the next focusable (tabIndex >= 0) element in tree order. */
void    pu_bridge_focus_next(PuBridge *b);
void    pu_bridge_focus_step(PuBridge *b, int backwards);
/* Returns nonzero if the event was prevented. TEXT becomes textinput.data. */
int     pu_bridge_dispatch_key(PuBridge *b, const PuKeyEvent *event);

#endif /* POLLYUI_BRIDGE_BRIDGE_H */
