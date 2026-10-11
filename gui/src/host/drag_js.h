#ifndef PU_DRAG_JS_H
#define PU_DRAG_JS_H
#include "quickjs.h"
#include "pollyui/drag.h"
typedef struct PuBridge PuBridge;
typedef struct PuNode PuNode;
int pu_drag_js_install(JSContext *ctx);
JSValue pu_drag_js_input(JSContext *ctx, PuBridge *bridge, PuNode *node, PuDragInput *input);
JSValue pu_drag_js_start(JSContext *ctx, PuBridge *bridge, PuWindow *window,
    int argc, JSValueConst *argv);
void pu_drag_js_pump(void);
void pu_drag_js_close(PuBridge *bridge);
void pu_drag_js_shutdown(JSContext *ctx);
#endif
