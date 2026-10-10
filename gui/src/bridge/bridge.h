#ifndef POLLYUI_BRIDGE_BRIDGE_H
#define POLLYUI_BRIDGE_BRIDGE_H

/* Bridge — exposes the Model to the ScriptEngine (DESIGN.md §6).
 *
 * Installs `document`, a Node class with a wrapper cache (native PuNode <-> JS
 * object identity), and an exotic `style` object. Owns the document body. */

#include "quickjs.h"
#include "model/node.h"
#include "pollyui/input.h"

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
typedef int (*PuTextInputFn)(const PuTextInputState *state, int reset, void *user);
int pu_bridge_set_text_input_callback(PuBridge *bridge, PuTextInputFn callback, void *user);
int pu_bridge_sync_text_input(PuBridge *bridge);

/* The document body element (root of the user's tree). */
PuNode *pu_bridge_body(PuBridge *b);

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
int pu_bridge_dispatch_drop(PuBridge *b, PuNode *target, const PuDropEvent *event);

/* --- focus + keyboard --- */
/* Move focus to `node` (NULL = blur), firing blur/focus events. Returns nonzero
 * if focus actually changed (so `focus:*` overrides differ -> host repaints). */
int     pu_bridge_set_focus(PuBridge *b, PuNode *node);
/* Move focus forward or backward through focusable elements in tree order. */
void    pu_bridge_focus_step(PuBridge *b, int backwards);
/* Returns nonzero if the event was prevented. TEXT becomes textinput.data. */
int     pu_bridge_dispatch_key(PuBridge *b, const PuKeyEvent *event);

#endif /* POLLYUI_BRIDGE_BRIDGE_H */
