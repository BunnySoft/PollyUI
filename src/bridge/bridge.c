#include "bridge/bridge.h"
#include "render/skia_c.h"   /* pu_text_measure for the global measureText() */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* One class id per runtime; the standard QuickJS file-static idiom. */
static JSClassID pu_node_class_id;
static JSClassID pu_style_class_id;

struct PuBridge {
    JSContext *ctx;
    PuNode    *body;
    PuNode    *focused;   /* currently focused element, or NULL */
    PuNode    *hovered;   /* element under the pointer (for enter/leave), or NULL */
};

static char *pu_bstrdup(const char *s)
{
    if (!s) return NULL;
    size_t n = strlen(s) + 1;
    char *p = (char *)malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}

/* ---- wrapper cache (DESIGN.md §6) ------------------------------------------*/

/* Return the JS wrapper for `node`, creating + caching it on first use. The
 * cached handle is weak: the finalizer clears it. Object identity holds because
 * the same node always maps to the same wrapper while it is alive. */
static JSValue pu_node_wrapper(JSContext *ctx, PuNode *node)
{
    if (!node) return JS_NULL;
    if (node->has_wrapper) return JS_DupValue(ctx, node->js_wrapper);

    JSValue obj = JS_NewObjectClass(ctx, pu_node_class_id);
    if (JS_IsException(obj)) return obj;
    JS_SetOpaque(obj, node);
    pu_node_ref(node);          /* the wrapper keeps the node alive */
    node->js_wrapper = obj;     /* weak cache (not duped) */
    node->has_wrapper = true;
    return obj;                 /* hand our created ref to the caller */
}

static void pu_node_finalizer(JSRuntime *rt, JSValueConst val)
{
    PuNode *node = (PuNode *)JS_GetOpaque(val, pu_node_class_id);
    if (!node) return;
    node->has_wrapper = false;
    node->js_wrapper = JS_UNDEFINED;
    pu_node_unref(node);
    (void)rt;
}

static JSValue pu_style_wrapper(JSContext *ctx, PuNode *node)
{
    if (node->has_style) return JS_DupValue(ctx, node->js_style);
    JSValue obj = JS_NewObjectClass(ctx, pu_style_class_id);
    if (JS_IsException(obj)) return obj;
    JS_SetOpaque(obj, node);
    pu_node_ref(node);
    node->js_style = obj;
    node->has_style = true;
    return obj;
}

static void pu_style_finalizer(JSRuntime *rt, JSValueConst val)
{
    PuNode *node = (PuNode *)JS_GetOpaque(val, pu_style_class_id);
    if (!node) return;
    node->has_style = false;
    node->js_style = JS_UNDEFINED;
    pu_node_unref(node);
    (void)rt;
}

/* ---- style exotic object (el.style.x = y) ---------------------------------*/

static int js_style_get_own(JSContext *ctx, JSPropertyDescriptor *desc,
                            JSValueConst obj, JSAtom prop)
{
    PuNode *node = (PuNode *)JS_GetOpaque(obj, pu_style_class_id);
    const char *name = JS_AtomToCString(ctx, prop);
    if (!name) return -1;
    const char *val = node ? pu_style_get(&node->style, name) : NULL;
    JS_FreeCString(ctx, name);
    if (!val) return 0; /* not an own property -> fall through to prototype */
    if (desc) {
        desc->flags  = JS_PROP_C_W_E;
        desc->value  = JS_NewString(ctx, val);
        desc->getter = JS_UNDEFINED;
        desc->setter = JS_UNDEFINED;
    }
    return 1;
}

static int js_style_set(JSContext *ctx, JSValueConst obj, JSAtom atom,
                        JSValueConst value, JSValueConst receiver, int flags)
{
    PuNode *node = (PuNode *)JS_GetOpaque(obj, pu_style_class_id);
    const char *name = JS_AtomToCString(ctx, atom);
    if (!name) return -1;
    const char *val = JS_ToCString(ctx, value);
    if (node && val) pu_style_set(&node->style, name, val);
    JS_FreeCString(ctx, name);
    if (val) JS_FreeCString(ctx, val);
    (void)receiver; (void)flags;
    return 1;
}

/* ---- class definitions -----------------------------------------------------*/

static JSClassExoticMethods pu_style_exotic = {
    .get_own_property = js_style_get_own,
    .set_property     = js_style_set,
};
static const JSClassDef pu_node_class_def  = { "Node", .finalizer = pu_node_finalizer };
static const JSClassDef pu_style_class_def = {
    "CSSStyleDeclaration", .finalizer = pu_style_finalizer, .exotic = &pu_style_exotic
};

/* ---- element / node methods ------------------------------------------------*/

static PuNode *self_node(JSValueConst this_val)
{
    return (PuNode *)JS_GetOpaque(this_val, pu_node_class_id);
}

static JSValue js_node_appendChild(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    PuNode *self  = self_node(this_val);
    PuNode *child = argc >= 1 ? (PuNode *)JS_GetOpaque(argv[0], pu_node_class_id) : NULL;
    if (!self || !child) return JS_ThrowTypeError(ctx, "appendChild: a Node is required");
    pu_node_append(self, child);
    return JS_DupValue(ctx, argv[0]);
}

static JSValue js_node_removeChild(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    PuNode *self  = self_node(this_val);
    PuNode *child = argc >= 1 ? (PuNode *)JS_GetOpaque(argv[0], pu_node_class_id) : NULL;
    if (!self || !child) return JS_ThrowTypeError(ctx, "removeChild: a Node is required");
    pu_node_remove(self, child);
    return JS_DupValue(ctx, argv[0]);
}

static JSValue js_node_insertBefore(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    PuNode *self  = self_node(this_val);
    PuNode *child = argc >= 1 ? (PuNode *)JS_GetOpaque(argv[0], pu_node_class_id) : NULL;
    PuNode *ref   = (argc >= 2 && !JS_IsNull(argv[1]))
                        ? (PuNode *)JS_GetOpaque(argv[1], pu_node_class_id) : NULL;
    if (!self || !child) return JS_ThrowTypeError(ctx, "insertBefore: a Node is required");
    pu_node_insert_before(self, child, ref);
    return JS_DupValue(ctx, argv[0]);
}

static JSValue js_node_get_firstChild(JSContext *ctx, JSValueConst this_val)
{ PuNode *s = self_node(this_val); return s ? pu_node_wrapper(ctx, s->first_child) : JS_NULL; }
static JSValue js_node_get_lastChild(JSContext *ctx, JSValueConst this_val)
{ PuNode *s = self_node(this_val); return s ? pu_node_wrapper(ctx, s->last_child) : JS_NULL; }
static JSValue js_node_get_parentNode(JSContext *ctx, JSValueConst this_val)
{ PuNode *s = self_node(this_val); return s ? pu_node_wrapper(ctx, s->parent) : JS_NULL; }
static JSValue js_node_get_nextSibling(JSContext *ctx, JSValueConst this_val)
{ PuNode *s = self_node(this_val); return s ? pu_node_wrapper(ctx, s->next_sibling) : JS_NULL; }
static JSValue js_node_get_prevSibling(JSContext *ctx, JSValueConst this_val)
{ PuNode *s = self_node(this_val); return s ? pu_node_wrapper(ctx, s->prev_sibling) : JS_NULL; }

static JSValue js_node_get_nodeType(JSContext *ctx, JSValueConst this_val)
{
    PuNode *s = self_node(this_val);
    int t = 1; /* ELEMENT_NODE */
    if (s && s->type == PU_NODE_TEXT)     t = 3;  /* TEXT_NODE */
    else if (s && s->type == PU_NODE_DOCUMENT) t = 9; /* DOCUMENT_NODE */
    return JS_NewInt32(ctx, t);
}

static JSValue js_node_get_tagName(JSContext *ctx, JSValueConst this_val)
{
    PuNode *s = self_node(this_val);
    if (!s || !s->tag) return JS_UNDEFINED;
    return JS_NewString(ctx, s->tag);
}

static JSValue js_node_get_childNodes(JSContext *ctx, JSValueConst this_val)
{
    PuNode *s = self_node(this_val);
    JSValue arr = JS_NewArray(ctx);
    if (!s) return arr;
    uint32_t i = 0;
    for (PuNode *c = s->first_child; c; c = c->next_sibling)
        JS_SetPropertyUint32(ctx, arr, i++, pu_node_wrapper(ctx, c));
    return arr;
}

static JSValue js_node_get_style(JSContext *ctx, JSValueConst this_val)
{
    PuNode *s = self_node(this_val);
    return s ? pu_style_wrapper(ctx, s) : JS_UNDEFINED;
}

/* textContent: getter gathers descendant text; setter replaces children. */
typedef struct { char *p; size_t len, cap; } Buf;
static void buf_add(Buf *b, const char *s)
{
    if (!s) return;
    size_t n = strlen(s);
    if (b->len + n + 1 > b->cap) {
        size_t nc = b->cap ? b->cap * 2 : 32;
        while (nc < b->len + n + 1) nc *= 2;
        char *np = (char *)realloc(b->p, nc);
        if (!np) return;
        b->p = np; b->cap = nc;
    }
    memcpy(b->p + b->len, s, n);
    b->len += n;
    b->p[b->len] = '\0';
}
static void gather_text(const PuNode *n, Buf *b)
{
    if (n->type == PU_NODE_TEXT) buf_add(b, n->text);
    for (const PuNode *c = n->first_child; c; c = c->next_sibling) gather_text(c, b);
}

static JSValue js_node_get_textContent(JSContext *ctx, JSValueConst this_val)
{
    PuNode *s = self_node(this_val);
    if (!s) return JS_UNDEFINED;
    Buf b = { 0 };
    gather_text(s, &b);
    JSValue r = JS_NewString(ctx, b.p ? b.p : "");
    free(b.p);
    return r;
}

static JSValue js_node_set_textContent(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    PuNode *s = self_node(this_val);
    if (!s) return JS_UNDEFINED;
    const char *str = JS_ToCString(ctx, val);
    if (s->type == PU_NODE_TEXT) {
        pu_node_set_text(s, str);
    } else {
        while (s->first_child) pu_node_remove(s, s->first_child);
        if (str && *str) {
            PuNode *t = pu_node_new(PU_NODE_TEXT);
            if (t) { pu_node_set_text(t, str); pu_node_append(s, t); }
        }
    }
    if (str) JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

/* ---- events ----------------------------------------------------------------*/

static JSValue js_node_addEventListener(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    PuNode *self = self_node(this_val);
    if (!self || argc < 2 || !JS_IsFunction(ctx, argv[1]))
        return JS_ThrowTypeError(ctx, "addEventListener(type, fn)");
    const char *type = JS_ToCString(ctx, argv[0]);
    if (!type) return JS_EXCEPTION;
    pu_node_add_listener(self, type, JS_DupValue(ctx, argv[1]));
    JS_FreeCString(ctx, type);
    return JS_UNDEFINED;
}

static JSValue js_node_removeEventListener(JSContext *ctx, JSValueConst this_val,
                                           int argc, JSValueConst *argv)
{
    PuNode *self = self_node(this_val);
    if (!self || argc < 2) return JS_UNDEFINED;
    const char *type = JS_ToCString(ctx, argv[0]);
    if (type) { pu_node_remove_listener(self, type, argv[1]); JS_FreeCString(ctx, type); }
    return JS_UNDEFINED;
}

static JSValue js_node_focus(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    PuNode *self = self_node(this_val);
    PuBridge *b = (PuBridge *)JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
    if (self && b) pu_bridge_set_focus(b, self);
    return JS_UNDEFINED;
}

static JSValue js_node_blur(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    PuNode *self = self_node(this_val);
    PuBridge *b = (PuBridge *)JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
    if (self && b && b->focused == self) pu_bridge_set_focus(b, NULL);
    return JS_UNDEFINED;
}

static JSValue js_node_get_tabIndex(JSContext *ctx, JSValueConst this_val)
{
    PuNode *s = self_node(this_val);
    return JS_NewInt32(ctx, s ? s->tab_index : -1);
}

static JSValue js_node_set_tabIndex(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    PuNode *s = self_node(this_val);
    if (s) { int32_t t = -1; JS_ToInt32(ctx, &t, val); s->tab_index = t; }
    return JS_UNDEFINED;
}

static JSValue js_document_get_activeElement(JSContext *ctx, JSValueConst this_val)
{
    PuBridge *b = (PuBridge *)JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
    return b ? pu_node_wrapper(ctx, b->focused) : JS_NULL;
}

static void dispatch_report(JSContext *ctx)
{
    JSValue exc = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, exc);
    fprintf(stderr, "Uncaught (in event listener) %s\n", msg ? msg : "error");
    if (msg) JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, exc);
}

/* event.stopPropagation() / stopImmediatePropagation() / preventDefault() set
 * flags on the event object itself; dispatch_impl reads them between listeners. */
static JSValue js_event_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)argc; (void)argv;
    JS_SetPropertyStr(ctx, this_val, "__stop", JS_NewBool(ctx, 1));
    return JS_UNDEFINED;
}

static JSValue js_event_stop_immediate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)argc; (void)argv;
    JS_SetPropertyStr(ctx, this_val, "__stop", JS_NewBool(ctx, 1));
    JS_SetPropertyStr(ctx, this_val, "__stopImmediate", JS_NewBool(ctx, 1));
    return JS_UNDEFINED;
}

static JSValue js_event_prevent(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)argc; (void)argv;
    JS_SetPropertyStr(ctx, this_val, "defaultPrevented", JS_NewBool(ctx, 1));
    return JS_UNDEFINED;
}

static int js_event_flag(JSContext *ctx, JSValueConst ev, const char *name)
{
    JSValue v = JS_GetPropertyStr(ctx, ev, name);
    int set = JS_ToBool(ctx, v);
    JS_FreeValue(ctx, v);
    return set;
}

/* Dispatch `type` to `target`. With bubble, walk up to the root invoking
 * matching listeners; stopPropagation/stopImmediatePropagation cut the walk.
 * `key` (keyboard) and px,py (pointer) are attached when provided. Returns 1 if
 * a listener called preventDefault(). */
static int dispatch_impl(PuBridge *b, PuNode *target, const char *type, const char *key,
                         int has_pos, float px, float py, int bubble)
{
    if (!b || !target || !type) return 0;
    JSContext *ctx = b->ctx;

    JSValue ev = JS_NewObject(ctx);                       /* one event for the whole walk */
    JS_SetPropertyStr(ctx, ev, "type", JS_NewString(ctx, type));
    JS_SetPropertyStr(ctx, ev, "target", pu_node_wrapper(ctx, target));
    JS_SetPropertyStr(ctx, ev, "defaultPrevented", JS_NewBool(ctx, 0));
    if (key) JS_SetPropertyStr(ctx, ev, "key", JS_NewString(ctx, key));
    if (has_pos) {
        JS_SetPropertyStr(ctx, ev, "clientX", JS_NewFloat64(ctx, px));
        JS_SetPropertyStr(ctx, ev, "clientY", JS_NewFloat64(ctx, py));
    }
    JS_SetPropertyStr(ctx, ev, "stopPropagation",
        JS_NewCFunction(ctx, js_event_stop, "stopPropagation", 0));
    JS_SetPropertyStr(ctx, ev, "stopImmediatePropagation",
        JS_NewCFunction(ctx, js_event_stop_immediate, "stopImmediatePropagation", 0));
    JS_SetPropertyStr(ctx, ev, "preventDefault",
        JS_NewCFunction(ctx, js_event_prevent, "preventDefault", 0));

    for (PuNode *n = target; n; n = n->parent) {
        JS_SetPropertyStr(ctx, ev, "currentTarget", pu_node_wrapper(ctx, n));
        for (int i = 0; i < n->listener_count; i++) {
            if (strcmp(n->listeners[i].type, type) != 0) continue;
            JSValue self = pu_node_wrapper(ctx, n);
            JSValue arg = ev;
            JSValue r = JS_Call(ctx, n->listeners[i].func, self, 1, &arg);
            if (JS_IsException(r)) dispatch_report(ctx);
            JS_FreeValue(ctx, r);
            JS_FreeValue(ctx, self);
            if (js_event_flag(ctx, ev, "__stopImmediate")) break;
        }
        if (!bubble || js_event_flag(ctx, ev, "__stop")) break;
    }

    int prevented = js_event_flag(ctx, ev, "defaultPrevented");
    JS_FreeValue(ctx, ev);
    return prevented;
}

void pu_bridge_dispatch_event(PuBridge *b, PuNode *target, const char *type)
{
    dispatch_impl(b, target, type, NULL, 0, 0, 0, 1);
}

void pu_bridge_dispatch_key(PuBridge *b, const char *type, const char *key)
{
    if (b && b->focused) dispatch_impl(b, b->focused, type, key, 0, 0, 0, 1);
}

/* Pointer events: dispatch `type` (mousedown/mouseup/mousemove/click) at the
 * hit-tested target, carrying clientX/clientY. For mousemove, also emit
 * mouseleave/mouseenter (non-bubbling) as the hovered element changes. */
void pu_bridge_dispatch_pointer(PuBridge *b, const char *type, PuNode *target, float x, float y)
{
    if (!b || !type) return;

    if (strcmp(type, "mousemove") == 0 && target != b->hovered) {
        PuNode *old = b->hovered;
        b->hovered = target;
        if (target) pu_node_ref(target);          /* keep hovered alive (like focus) */
        if (old) { dispatch_impl(b, old, "mouseleave", NULL, 1, x, y, 0); pu_node_unref(old); }
        if (target) dispatch_impl(b, target, "mouseenter", NULL, 1, x, y, 0);
    }
    if (target) dispatch_impl(b, target, type, NULL, 1, x, y, 1);
}

/* Wheel: dispatch a "wheel" event, then apply default scrolling to the nearest
 * overflow:scroll/auto ancestor (clamped to its content height). */
void pu_bridge_dispatch_wheel(PuBridge *b, PuNode *target, float x, float y, float dy)
{
    if (!b) return;
    if (target) dispatch_impl(b, target, "wheel", NULL, 1, x, y, 1);

    PuNode *sc = NULL;
    for (PuNode *p = target; p; p = p->parent) {
        if (p->type != PU_NODE_ELEMENT) continue;
        const char *ov = pu_style_get(&p->style, "overflow");
        if (ov && (strcmp(ov, "scroll") == 0 || strcmp(ov, "auto") == 0)) { sc = p; break; }
    }
    if (!sc) return;

    const char *cur_s = pu_style_get(&sc->style, "scrollTop");
    float cur = cur_s ? (float)atof(cur_s) : 0.0f;

    float content = 0; /* furthest child bottom, relative to the container top */
    for (PuNode *c = sc->first_child; c; c = c->next_sibling) {
        float bottom = (c->layout_y + c->layout_h) - sc->layout_y;
        if (bottom > content) content = bottom;
    }
    float maxs = content - sc->layout_h;
    if (maxs < 0) maxs = 0;

    float next = cur + dy;
    if (next < 0) next = 0;
    if (next > maxs) next = maxs;
    char buf[32];
    snprintf(buf, sizeof(buf), "%g", next);
    pu_style_set(&sc->style, "scrollTop", buf);
}

PuNode *pu_bridge_focused(PuBridge *b) { return b ? b->focused : NULL; }

void pu_bridge_set_focus(PuBridge *b, PuNode *node)
{
    if (!b || b->focused == node) return;

    if (b->focused) {
        PuNode *old = b->focused;
        b->focused = NULL;
        dispatch_impl(b, old, "blur", NULL, 0, 0, 0, 0);
        pu_node_unref(old);           /* release the focus ref */
    }
    b->focused = node;
    if (node) {
        pu_node_ref(node);            /* keep the focused node alive */
        dispatch_impl(b, node, "focus", NULL, 0, 0, 0, 0);
    }
}

static void collect_focusable(PuNode *n, PuNode **arr, int *count, int cap)
{
    if (n->type == PU_NODE_ELEMENT && n->tab_index >= 0 && *count < cap)
        arr[(*count)++] = n;
    for (PuNode *c = n->first_child; c; c = c->next_sibling)
        collect_focusable(c, arr, count, cap);
}

void pu_bridge_focus_next(PuBridge *b)
{
    if (!b) return;
    PuNode *arr[256];
    int count = 0;
    collect_focusable(b->body, arr, &count, 256);
    if (count == 0) return;
    int idx = -1;
    for (int i = 0; i < count; i++)
        if (arr[i] == b->focused) { idx = i; break; }
    pu_bridge_set_focus(b, arr[(idx + 1) % count]);
}

/* ---- document --------------------------------------------------------------*/

static JSValue js_document_createElement(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    const char *tag = argc >= 1 ? JS_ToCString(ctx, argv[0]) : NULL;
    PuNode *n = pu_node_new(PU_NODE_ELEMENT);
    if (!n) { if (tag) JS_FreeCString(ctx, tag); return JS_ThrowOutOfMemory(ctx); }
    n->tag = pu_bstrdup(tag ? tag : "div");
    if (tag) JS_FreeCString(ctx, tag);
    return pu_node_wrapper(ctx, n);
}

static JSValue js_document_createTextNode(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv)
{
    const char *text = argc >= 1 ? JS_ToCString(ctx, argv[0]) : NULL;
    PuNode *n = pu_node_new(PU_NODE_TEXT);
    if (!n) { if (text) JS_FreeCString(ctx, text); return JS_ThrowOutOfMemory(ctx); }
    pu_node_set_text(n, text ? text : "");
    if (text) JS_FreeCString(ctx, text);
    return pu_node_wrapper(ctx, n);
}

static JSValue js_document_get_body(JSContext *ctx, JSValueConst this_val)
{
    PuBridge *b = (PuBridge *)JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
    return b ? pu_node_wrapper(ctx, b->body) : JS_NULL;
}

/* measureText(str, fontSize=16) -> advance width in (logical) pixels. Lets JS
 * position carets, truncate labels, etc. */
static JSValue js_measure_text(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    const char *s = argc >= 1 ? JS_ToCString(ctx, argv[0]) : NULL;
    double fs = 16.0;
    if (argc >= 2) JS_ToFloat64(ctx, &fs, argv[1]);
    int32_t weight = 400;
    if (argc >= 3) JS_ToInt32(ctx, &weight, argv[2]);
    float w = 0, h = 0;
    pu_text_measure(s ? s : "", (float)fs, weight, 0, &w, &h);
    if (s) JS_FreeCString(ctx, s);
    return JS_NewFloat64(ctx, w);
}

/* ---- attributes / id / class / queries ------------------------------------*/

static JSValue js_node_setAttribute(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    PuNode *n = self_node(this_val);
    if (!n || argc < 2) return JS_UNDEFINED;
    const char *name = JS_ToCString(ctx, argv[0]);
    const char *val  = JS_ToCString(ctx, argv[1]);
    if (name) pu_style_set(&n->attrs, name, val ? val : "");
    if (name) JS_FreeCString(ctx, name);
    if (val)  JS_FreeCString(ctx, val);
    return JS_UNDEFINED;
}

static JSValue js_node_getAttribute(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    PuNode *n = self_node(this_val);
    if (!n || argc < 1) return JS_NULL;
    const char *name = JS_ToCString(ctx, argv[0]);
    const char *v = name ? pu_style_get(&n->attrs, name) : NULL;
    JSValue r = v ? JS_NewString(ctx, v) : JS_NULL;
    if (name) JS_FreeCString(ctx, name);
    return r;
}

static JSValue js_node_hasAttribute(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    PuNode *n = self_node(this_val);
    if (!n || argc < 1) return JS_NewBool(ctx, 0);
    const char *name = JS_ToCString(ctx, argv[0]);
    int has = name && pu_style_get(&n->attrs, name) != NULL;
    if (name) JS_FreeCString(ctx, name);
    return JS_NewBool(ctx, has);
}

static JSValue js_node_removeAttribute(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    PuNode *n = self_node(this_val);
    if (!n || argc < 1) return JS_UNDEFINED;
    const char *name = JS_ToCString(ctx, argv[0]);
    if (name) { pu_style_remove(&n->attrs, name); JS_FreeCString(ctx, name); }
    return JS_UNDEFINED;
}

static JSValue js_attr_get(JSContext *ctx, JSValueConst this_val, const char *key)
{
    PuNode *n = self_node(this_val);
    const char *v = n ? pu_style_get(&n->attrs, key) : NULL;
    return JS_NewString(ctx, v ? v : "");
}

static JSValue js_attr_set(JSContext *ctx, JSValueConst this_val, JSValueConst val, const char *key)
{
    PuNode *n = self_node(this_val);
    const char *v = JS_ToCString(ctx, val);
    if (n) pu_style_set(&n->attrs, key, v ? v : "");
    if (v) JS_FreeCString(ctx, v);
    return JS_UNDEFINED;
}

static JSValue js_scroll_get(JSContext *ctx, JSValueConst this_val, const char *key)
{
    PuNode *n = self_node(this_val);
    const char *v = n ? pu_style_get(&n->style, key) : NULL;
    return JS_NewFloat64(ctx, v ? atof(v) : 0.0);
}

static JSValue js_scroll_set(JSContext *ctx, JSValueConst this_val, JSValueConst val, const char *key)
{
    PuNode *n = self_node(this_val);
    double d = 0;
    JS_ToFloat64(ctx, &d, val);
    if (n) { char buf[32]; snprintf(buf, sizeof(buf), "%g", d < 0 ? 0 : d); pu_style_set(&n->style, key, buf); }
    return JS_UNDEFINED;
}

static JSValue js_node_get_scrollTop(JSContext *ctx, JSValueConst t)        { return js_scroll_get(ctx, t, "scrollTop"); }
static JSValue js_node_set_scrollTop(JSContext *ctx, JSValueConst t, JSValueConst v){ return js_scroll_set(ctx, t, v, "scrollTop"); }
static JSValue js_node_get_scrollLeft(JSContext *ctx, JSValueConst t)       { return js_scroll_get(ctx, t, "scrollLeft"); }
static JSValue js_node_set_scrollLeft(JSContext *ctx, JSValueConst t, JSValueConst v){ return js_scroll_set(ctx, t, v, "scrollLeft"); }

static JSValue js_node_get_id(JSContext *ctx, JSValueConst t)              { return js_attr_get(ctx, t, "id"); }
static JSValue js_node_set_id(JSContext *ctx, JSValueConst t, JSValueConst v){ return js_attr_set(ctx, t, v, "id"); }
static JSValue js_node_get_className(JSContext *ctx, JSValueConst t)       { return js_attr_get(ctx, t, "class"); }
static JSValue js_node_set_className(JSContext *ctx, JSValueConst t, JSValueConst v){ return js_attr_set(ctx, t, v, "class"); }

/* Whitespace-separated token membership in a class string. */
static int class_has(const char *classes, const char *cls)
{
    if (!classes || !cls || !*cls) return 0;
    size_t len = strlen(cls);
    for (const char *p = classes; *p; ) {
        while (*p == ' ') p++;
        const char *start = p;
        while (*p && *p != ' ') p++;
        if ((size_t)(p - start) == len && strncmp(start, cls, len) == 0) return 1;
    }
    return 0;
}

static void class_add(PuNode *n, const char *cls)
{
    if (!cls || !*cls || strchr(cls, ' ')) return;
    const char *cur = pu_style_get(&n->attrs, "class");
    if (class_has(cur, cls)) return;
    size_t cl = cur ? strlen(cur) : 0, al = strlen(cls);
    char *buf = (char *)malloc(cl + 2 + al);
    if (!buf) return;
    if (cl) { memcpy(buf, cur, cl); buf[cl] = ' '; memcpy(buf + cl + 1, cls, al + 1); }
    else    { memcpy(buf, cls, al + 1); }
    pu_style_set(&n->attrs, "class", buf);
    free(buf);
}

static void class_remove(PuNode *n, const char *cls)
{
    const char *cur = pu_style_get(&n->attrs, "class");
    if (!cur || !cls || !*cls) return;
    size_t len = strlen(cls);
    char *buf = (char *)malloc(strlen(cur) + 1);
    if (!buf) return;
    char *out = buf; *out = 0;
    for (const char *p = cur; *p; ) {
        while (*p == ' ') p++;
        const char *start = p;
        while (*p && *p != ' ') p++;
        size_t tl = (size_t)(p - start);
        if (tl == 0 || (tl == len && strncmp(start, cls, len) == 0)) continue;
        if (out != buf) *out++ = ' ';
        memcpy(out, start, tl); out += tl; *out = 0;
    }
    pu_style_set(&n->attrs, "class", buf);
    free(buf);
}

static PuNode *classlist_node(JSContext *ctx, JSValueConst this_val)
{
    JSValue nw = JS_GetPropertyStr(ctx, this_val, "__node");
    PuNode *n = self_node(nw);
    JS_FreeValue(ctx, nw);
    return n;
}

static JSValue js_classlist_contains(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    PuNode *n = classlist_node(ctx, this_val);
    if (!n || argc < 1) return JS_NewBool(ctx, 0);
    const char *cls = JS_ToCString(ctx, argv[0]);
    int has = cls && class_has(pu_style_get(&n->attrs, "class"), cls);
    if (cls) JS_FreeCString(ctx, cls);
    return JS_NewBool(ctx, has);
}

static JSValue js_classlist_add(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    PuNode *n = classlist_node(ctx, this_val);
    for (int i = 0; n && i < argc; i++) {
        const char *cls = JS_ToCString(ctx, argv[i]);
        if (cls) { class_add(n, cls); JS_FreeCString(ctx, cls); }
    }
    return JS_UNDEFINED;
}

static JSValue js_classlist_remove(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    PuNode *n = classlist_node(ctx, this_val);
    for (int i = 0; n && i < argc; i++) {
        const char *cls = JS_ToCString(ctx, argv[i]);
        if (cls) { class_remove(n, cls); JS_FreeCString(ctx, cls); }
    }
    return JS_UNDEFINED;
}

static JSValue js_classlist_toggle(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    PuNode *n = classlist_node(ctx, this_val);
    if (!n || argc < 1) return JS_NewBool(ctx, 0);
    const char *cls = JS_ToCString(ctx, argv[0]);
    int present = 0;
    if (cls) {
        present = class_has(pu_style_get(&n->attrs, "class"), cls);
        if (present) class_remove(n, cls); else class_add(n, cls);
        JS_FreeCString(ctx, cls);
    }
    return JS_NewBool(ctx, !present); /* true if now present */
}

static JSValue js_node_get_classList(JSContext *ctx, JSValueConst this_val)
{
    JSValue list = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, list, "__node", JS_DupValue(ctx, this_val));
    JS_SetPropertyStr(ctx, list, "add",      JS_NewCFunction(ctx, js_classlist_add,      "add",      1));
    JS_SetPropertyStr(ctx, list, "remove",   JS_NewCFunction(ctx, js_classlist_remove,   "remove",   1));
    JS_SetPropertyStr(ctx, list, "toggle",   JS_NewCFunction(ctx, js_classlist_toggle,   "toggle",   1));
    JS_SetPropertyStr(ctx, list, "contains", JS_NewCFunction(ctx, js_classlist_contains, "contains", 1));
    return list;
}

/* Simple selector match: "#id", ".class", "tag", or "*". */
static int node_matches(PuNode *n, const char *sel)
{
    if (!n || n->type != PU_NODE_ELEMENT || !sel || !*sel) return 0;
    if (sel[0] == '#') { const char *v = pu_style_get(&n->attrs, "id");    return v && strcmp(v, sel + 1) == 0; }
    if (sel[0] == '.') {                                                   return class_has(pu_style_get(&n->attrs, "class"), sel + 1); }
    if (strcmp(sel, "*") == 0) return 1;
    return n->tag && strcmp(n->tag, sel) == 0;
}

static PuNode *query_first(PuNode *root, const char *sel)
{
    for (PuNode *c = root->first_child; c; c = c->next_sibling) {
        if (node_matches(c, sel)) return c;
        PuNode *r = query_first(c, sel);
        if (r) return r;
    }
    return NULL;
}

static void query_all(JSContext *ctx, PuNode *root, const char *sel, JSValue arr, uint32_t *idx)
{
    for (PuNode *c = root->first_child; c; c = c->next_sibling) {
        if (node_matches(c, sel)) JS_SetPropertyUint32(ctx, arr, (*idx)++, pu_node_wrapper(ctx, c));
        query_all(ctx, c, sel, arr, idx);
    }
}

static PuNode *query_root(JSContext *ctx, JSValueConst this_val)
{
    PuNode *n = self_node(this_val);
    if (n) return n; /* element.querySelector searches descendants */
    PuBridge *b = (PuBridge *)JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
    return b ? b->body : NULL; /* document.querySelector searches the whole tree */
}

static JSValue js_querySelector(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    PuNode *root = query_root(ctx, this_val);
    if (!root || argc < 1) return JS_NULL;
    const char *sel = JS_ToCString(ctx, argv[0]);
    PuNode *r = sel ? query_first(root, sel) : NULL;
    if (sel) JS_FreeCString(ctx, sel);
    return r ? pu_node_wrapper(ctx, r) : JS_NULL;
}

static JSValue js_querySelectorAll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    PuNode *root = query_root(ctx, this_val);
    JSValue arr = JS_NewArray(ctx);
    if (root && argc >= 1) {
        const char *sel = JS_ToCString(ctx, argv[0]);
        if (sel) { uint32_t i = 0; query_all(ctx, root, sel, arr, &i); JS_FreeCString(ctx, sel); }
    }
    return arr;
}

static JSValue js_document_getElementById(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    PuBridge *b = (PuBridge *)JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
    if (!b || argc < 1) return JS_NULL;
    const char *id = JS_ToCString(ctx, argv[0]);
    char sel[256]; sel[0] = '#';
    PuNode *r = NULL;
    if (id) {
        snprintf(sel + 1, sizeof(sel) - 1, "%s", id);
        r = node_matches(b->body, sel) ? b->body : query_first(b->body, sel);
        JS_FreeCString(ctx, id);
    }
    return r ? pu_node_wrapper(ctx, r) : JS_NULL;
}

/* ---- install ---------------------------------------------------------------*/

static void def_method(JSContext *ctx, JSValueConst obj, const char *name,
                       JSCFunction *fn, int len)
{
    JS_SetPropertyStr(ctx, obj, name, JS_NewCFunction(ctx, fn, name, len));
}

static void def_get(JSContext *ctx, JSValueConst obj, const char *name,
                    JSValue (*getter)(JSContext *, JSValueConst))
{
    JSAtom atom = JS_NewAtom(ctx, name);
    JSValue g = JS_NewCFunction2(ctx, (JSCFunction *)getter, name, 0, JS_CFUNC_getter, 0);
    JS_DefinePropertyGetSet(ctx, obj, atom, g, JS_UNDEFINED,
                            JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
    JS_FreeAtom(ctx, atom);
}

static void def_getset(JSContext *ctx, JSValueConst obj, const char *name,
                       JSValue (*getter)(JSContext *, JSValueConst),
                       JSValue (*setter)(JSContext *, JSValueConst, JSValueConst))
{
    JSAtom atom = JS_NewAtom(ctx, name);
    JSValue g = JS_NewCFunction2(ctx, (JSCFunction *)getter, name, 0, JS_CFUNC_getter, 0);
    JSValue s = JS_NewCFunction2(ctx, (JSCFunction *)setter, name, 1, JS_CFUNC_setter, 0);
    JS_DefinePropertyGetSet(ctx, obj, atom, g, s,
                            JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
    JS_FreeAtom(ctx, atom);
}

PuBridge *pu_bridge_install(JSContext *ctx)
{
    PuBridge *b = (PuBridge *)calloc(1, sizeof(PuBridge));
    if (!b) return NULL;
    b->ctx = ctx;

    JSRuntime *rt = JS_GetRuntime(ctx);
    JS_SetRuntimeOpaque(rt, b);
    pu_node_set_runtime(rt); /* so freed nodes can release their listeners */

    if (pu_node_class_id == 0)  JS_NewClassID(rt, &pu_node_class_id);
    if (pu_style_class_id == 0) JS_NewClassID(rt, &pu_style_class_id);
    JS_NewClass(rt, pu_node_class_id,  &pu_node_class_def);
    JS_NewClass(rt, pu_style_class_id, &pu_style_class_def);

    /* Shared Node prototype: methods + accessors. */
    JSValue node_proto = JS_NewObject(ctx);
    def_method(ctx, node_proto, "appendChild",  js_node_appendChild,  1);
    def_method(ctx, node_proto, "removeChild",  js_node_removeChild,  1);
    def_method(ctx, node_proto, "insertBefore", js_node_insertBefore, 2);
    def_method(ctx, node_proto, "addEventListener",    js_node_addEventListener,    2);
    def_method(ctx, node_proto, "removeEventListener", js_node_removeEventListener, 2);
    def_method(ctx, node_proto, "focus", js_node_focus, 0);
    def_method(ctx, node_proto, "blur",  js_node_blur,  0);
    def_getset(ctx, node_proto, "tabIndex", js_node_get_tabIndex, js_node_set_tabIndex);
    def_method(ctx, node_proto, "setAttribute",     js_node_setAttribute,    2);
    def_method(ctx, node_proto, "getAttribute",     js_node_getAttribute,    1);
    def_method(ctx, node_proto, "hasAttribute",     js_node_hasAttribute,    1);
    def_method(ctx, node_proto, "removeAttribute",  js_node_removeAttribute, 1);
    def_method(ctx, node_proto, "querySelector",    js_querySelector,    1);
    def_method(ctx, node_proto, "querySelectorAll", js_querySelectorAll, 1);
    def_getset(ctx, node_proto, "id",        js_node_get_id,        js_node_set_id);
    def_getset(ctx, node_proto, "className", js_node_get_className, js_node_set_className);
    def_getset(ctx, node_proto, "scrollTop",  js_node_get_scrollTop,  js_node_set_scrollTop);
    def_getset(ctx, node_proto, "scrollLeft", js_node_get_scrollLeft, js_node_set_scrollLeft);
    def_get(ctx, node_proto, "classList", js_node_get_classList);
    def_get(ctx, node_proto, "firstChild",      js_node_get_firstChild);
    def_get(ctx, node_proto, "lastChild",       js_node_get_lastChild);
    def_get(ctx, node_proto, "parentNode",      js_node_get_parentNode);
    def_get(ctx, node_proto, "nextSibling",     js_node_get_nextSibling);
    def_get(ctx, node_proto, "previousSibling", js_node_get_prevSibling);
    def_get(ctx, node_proto, "childNodes",      js_node_get_childNodes);
    def_get(ctx, node_proto, "nodeType",        js_node_get_nodeType);
    def_get(ctx, node_proto, "tagName",         js_node_get_tagName);
    def_get(ctx, node_proto, "style",           js_node_get_style);
    def_getset(ctx, node_proto, "textContent",  js_node_get_textContent, js_node_set_textContent);
    JS_SetClassProto(ctx, pu_node_class_id, node_proto);

    JS_SetClassProto(ctx, pu_style_class_id, JS_NewObject(ctx));

    /* document.body root element. */
    b->body = pu_node_new(PU_NODE_ELEMENT);
    if (!b->body) { free(b); return NULL; }
    b->body->tag = pu_bstrdup("body");
    pu_node_ref(b->body); /* bridge holds a ref so body persists across GC */

    /* The `document` global. */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue document = JS_NewObject(ctx);
    def_method(ctx, document, "createElement",  js_document_createElement,  1);
    def_method(ctx, document, "createTextNode", js_document_createTextNode, 1);
    def_get(ctx, document, "body", js_document_get_body);
    def_get(ctx, document, "activeElement", js_document_get_activeElement);
    def_method(ctx, document, "getElementById",   js_document_getElementById, 1);
    def_method(ctx, document, "querySelector",    js_querySelector,    1);
    def_method(ctx, document, "querySelectorAll", js_querySelectorAll, 1);
    JS_SetPropertyStr(ctx, global, "document", document);
    JS_SetPropertyStr(ctx, global, "measureText",
                      JS_NewCFunction(ctx, js_measure_text, "measureText", 2));
    JS_FreeValue(ctx, global);

    return b;
}

PuNode *pu_bridge_body(PuBridge *b) { return b ? b->body : NULL; }

void pu_bridge_free(PuBridge *b)
{
    if (!b) return;
    if (b->hovered) pu_node_unref(b->hovered);
    if (b->body) pu_node_unref(b->body); /* releases the native tree */
    free(b);
}
