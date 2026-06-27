#include "bridge/bridge.h"

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

/* Bubble `type` from `target` to the root, invoking matching listeners with an
 * event object. `key` (optional) is attached for keyboard events. */
static void dispatch_impl(PuBridge *b, PuNode *target, const char *type, const char *key)
{
    if (!b || !target || !type) return;
    JSContext *ctx = b->ctx;

    for (PuNode *n = target; n; n = n->parent) {       /* bubble to the root */
        for (int i = 0; i < n->listener_count; i++) {
            if (strcmp(n->listeners[i].type, type) != 0) continue;

            JSValue ev = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, ev, "type", JS_NewString(ctx, type));
            JS_SetPropertyStr(ctx, ev, "target", pu_node_wrapper(ctx, target));
            JS_SetPropertyStr(ctx, ev, "currentTarget", pu_node_wrapper(ctx, n));
            if (key) JS_SetPropertyStr(ctx, ev, "key", JS_NewString(ctx, key));

            JSValue self = pu_node_wrapper(ctx, n);
            JSValue arg = ev;
            JSValue r = JS_Call(ctx, n->listeners[i].func, self, 1, &arg);
            if (JS_IsException(r)) dispatch_report(ctx);
            JS_FreeValue(ctx, r);
            JS_FreeValue(ctx, self);
            JS_FreeValue(ctx, ev);
        }
    }
}

void pu_bridge_dispatch_event(PuBridge *b, PuNode *target, const char *type)
{
    dispatch_impl(b, target, type, NULL);
}

void pu_bridge_dispatch_key(PuBridge *b, const char *type, const char *key)
{
    if (b && b->focused) dispatch_impl(b, b->focused, type, key);
}

PuNode *pu_bridge_focused(PuBridge *b) { return b ? b->focused : NULL; }

void pu_bridge_set_focus(PuBridge *b, PuNode *node)
{
    if (!b || b->focused == node) return;

    if (b->focused) {
        PuNode *old = b->focused;
        b->focused = NULL;
        dispatch_impl(b, old, "blur", NULL);
        pu_node_unref(old);           /* release the focus ref */
    }
    b->focused = node;
    if (node) {
        pu_node_ref(node);            /* keep the focused node alive */
        dispatch_impl(b, node, "focus", NULL);
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
    JS_SetPropertyStr(ctx, global, "document", document);
    JS_FreeValue(ctx, global);

    return b;
}

PuNode *pu_bridge_body(PuBridge *b) { return b ? b->body : NULL; }

void pu_bridge_free(PuBridge *b)
{
    if (!b) return;
    if (b->body) pu_node_unref(b->body); /* releases the native tree */
    free(b);
}
