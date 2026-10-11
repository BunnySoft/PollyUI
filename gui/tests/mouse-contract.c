#include "bridge/bridge.h"
#include "script/script.h"
#include <stdio.h>
#include <string.h>

static int mode, calls, failed;
static int capture(int enabled, void *user)
{
    (void)user;
    calls++;
    return mode == 1 || (mode == 2 && enabled);
}
static void check(int valid, const char *name)
{
    if (!valid) { fprintf(stderr, "FAIL: %s\n", name); failed = 1; }
    else printf("PASS: %s\n", name);
}
static int evaluate(JSContext *ctx, const char *source)
{
    JSValue result = JS_Eval(ctx, source, strlen(source), "mouse-contract", JS_EVAL_TYPE_GLOBAL);
    int ok = !JS_IsException(result);
    if (!ok) {
        JSValue exception = JS_GetException(ctx);
        const char *text = JS_ToCString(ctx, exception);
        fprintf(stderr, "Mouse contract exception: %s\n", text ? text : "unknown");
        JS_FreeCString(ctx, text); JS_FreeValue(ctx, exception);
    }
    JS_FreeValue(ctx, result);
    return ok;
}
int main(void)
{
    PuScript *script = pu_script_create();
    if (!script) return 1;
    JSContext *ctx = pu_script_jsctx(script);
    PuBridge *bridge = pu_bridge_install(ctx);
    if (!bridge) { pu_script_destroy(script); return 1; }
    pu_bridge_set_mouse_capture_callback(bridge, capture, NULL);
    check(evaluate(ctx,
        "globalThis.node=document.createElement('view');document.body.appendChild(node);"
        "globalThis.got=0;globalThis.lost=0;"
        "node.addEventListener('gotmousecapture',()=>got++);"
        "node.addEventListener('lostmousecapture',()=>lost++);"), "capture fixture is installed");
    PuNode *node = pu_bridge_body(bridge)->first_child;
    PuPointerEvent event = { .type = PU_POINTER_DOWN, .x = 10, .y = 10, .button = 0, .buttons = 1 };
    pu_bridge_dispatch_pointer(bridge, node, &event);
    check(evaluate(ctx,
        "let unavailable=false;try{node.setMouseCapture()}catch(e){unavailable=e instanceof InternalError}"
        "if(!unavailable||node.hasMouseCapture()||got)throw Error('failure looked successful');"),
        "unavailable backend throws without captured state or a got event");
    mode = 2;
    check(evaluate(ctx,
        "node.setMouseCapture();if(!node.hasMouseCapture()||got!==1)throw Error('capture missing');"
        "let releaseFailed=false;try{node.releaseMouseCapture()}catch(e){releaseFailed=e instanceof InternalError}"
        "if(!releaseFailed||node.hasMouseCapture()||lost!==1)throw Error('release failure hidden');"),
        "release backend failure is explicit and retires bridge ownership");
    mode = 1;
    PuBridge *other = pu_bridge_new_document(bridge);
    if (!other) return 1;
    pu_bridge_set_mouse_capture_callback(other, capture, NULL);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "otherDocument", pu_bridge_document(other));
    JS_FreeValue(ctx, global);
    check(evaluate(ctx,
        "globalThis.otherNode=otherDocument.createElement('view');otherDocument.body.appendChild(otherNode);"
        "let wrongDocument=false;try{otherNode.setMouseCapture()}catch(e){wrongDocument=e instanceof TypeError}"
        "if(!wrongDocument)throw Error('cross-document mouse state admitted');"
        "node.setMouseCapture();"), "active press does not leak into another document");
    int before = calls;
    pu_bridge_release_document(other);
    check(pu_bridge_has_mouse_capture(bridge) && calls == before, "closing another document preserves capture");
    check(evaluate(ctx,
        "let closed=false;try{otherNode.hasMouseCapture()}catch(e){closed=e instanceof TypeError}"
        "if(!closed)throw Error('closed capture API admitted');"),
        "closed documents cannot retain live mouse APIs");
    pu_bridge_cancel_mouse(bridge, "host-cancelled");
    check(!pu_bridge_has_mouse_capture(bridge), "native cancellation releases the owning document");
    pu_bridge_free(bridge); pu_script_destroy(script);
    return failed;
}
