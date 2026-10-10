#include "bridge/bridge.h"
#include "render/skia_c.h"   /* pu_text_measure for the global measureText() */
#include "layout/layout.h"   /* pu_layout_mark_dirty / pu_layout_affects */

#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

/* One class id per runtime; the standard QuickJS file-static idiom. */
static JSClassID pu_node_class_id;
static JSClassID pu_style_class_id;
static JSClassID pu_document_class_id;
static JSClassID pu_bitmap_class_id;

typedef struct PuBitmap {
    struct PuBitmap *next;
    PuBridge *owner;
    char key[64];
} PuBitmap;
static uint64_t bitmap_serial;

struct PuBridge {
    JSContext *ctx;
    PuNode    *body;
    PuNode    *focused;   /* currently focused element, or NULL */
    PuNode    *hovered;   /* element under the pointer (for enter/leave), or NULL */
    PuBridge  *root, *next;
    JSValue    document;
    bool       native_owned;
    PuNode *input_owner, *composition;
    PuTextInputState input;
    bool input_configured;
    PuTextInputFn input_callback;
    void *input_user;
    PuBitmap *bitmaps;
};

static void bitmap_close(PuBitmap *bitmap)
{
    if (!bitmap->owner) return;
    PuBitmap **slot = &bitmap->owner->bitmaps;
    while (*slot && *slot != bitmap) slot = &(*slot)->next;
    if (*slot) *slot = bitmap->next;
    pu_image_remove(bitmap->key);
    pu_node_mark_paint_dirty(NULL);
    bitmap->owner = NULL;
    bitmap->next = NULL;
}

static void bitmap_finalizer(JSRuntime *rt, JSValueConst value)
{
    (void)rt;
    PuBitmap *bitmap = JS_GetOpaque(value, pu_bitmap_class_id);
    if (!bitmap) return;
    bitmap_close(bitmap);
    free(bitmap);
}

static JSValue js_bitmap_close(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)argv;
    PuBitmap *bitmap = JS_GetOpaque2(ctx, self, pu_bitmap_class_id);
    if (!bitmap) return JS_EXCEPTION;
    if (argc) return JS_ThrowTypeError(ctx, "Bitmap close takes no arguments");
    bitmap_close(bitmap);
    return JS_UNDEFINED;
}

static JSValue js_bitmap_closed(JSContext *ctx, JSValueConst self)
{
    PuBitmap *bitmap = JS_GetOpaque2(ctx, self, pu_bitmap_class_id);
    return bitmap ? JS_NewBool(ctx, !bitmap->owner) : JS_EXCEPTION;
}

static int bitmap_property(JSContext *ctx, JSValueConst object, const char *name, JSValue value)
{
    return JS_IsException(value) ? -1 :
        JS_DefinePropertyValueStr(ctx, object, name, value, JS_PROP_ENUMERABLE);
}

static JSValue js_create_bitmap(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    PuBridge *owner = JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
    if (!owner) return JS_ThrowTypeError(ctx, "GUI bitmap scope is closed");
    if (argc != 2 || !JS_IsNumber(argv[1]))
        return JS_ThrowTypeError(ctx, "createBitmap requires bytes and a positive integer pixel limit");
    double pixels;
    if (JS_ToFloat64(ctx, &pixels, argv[1]) < 0) return JS_EXCEPTION;
    if (!isfinite(pixels) || pixels < 1 || pixels > UINT32_MAX || floor(pixels) != pixels)
        return JS_ThrowRangeError(ctx, "Invalid bitmap pixel limit");
    if (bitmap_serial == UINT64_MAX) return JS_ThrowRangeError(ctx, "Bitmap keys exhausted");

    size_t offset = 0, length = 0, buffer_length = 0;
    JSValue buffer;
    if (JS_IsArrayBuffer(argv[0])) {
        buffer = JS_DupValue(ctx, argv[0]);
    } else if (JS_GetTypedArrayType(argv[0]) == JS_TYPED_ARRAY_UINT8) {
        buffer = JS_GetTypedArrayBuffer(ctx, argv[0], &offset, &length, NULL);
        if (JS_IsException(buffer)) return buffer;
    } else {
        return JS_ThrowTypeError(ctx, "Bitmap bytes must be an ArrayBuffer or Uint8Array");
    }
    uint8_t *bytes = JS_GetArrayBuffer(ctx, &buffer_length, buffer);
    if (!bytes) { JS_FreeValue(ctx, buffer); return JS_EXCEPTION; }
    if (JS_IsArrayBuffer(argv[0])) length = buffer_length;
    if (offset > buffer_length || length > buffer_length - offset || !length) {
        JS_FreeValue(ctx, buffer);
        return JS_ThrowTypeError(ctx, "Bitmap bytes must not be empty or detached");
    }
    PuBitmap *bitmap = calloc(1, sizeof(*bitmap));
    if (!bitmap) { JS_FreeValue(ctx, buffer); return JS_ThrowOutOfMemory(ctx); }
    snprintf(bitmap->key, sizeof(bitmap->key), "polly-memory:bitmap-%" PRIu64, ++bitmap_serial);
    int width, height;
    int decoded = pu_image_set_bitmap(bitmap->key, bytes + offset, length, (size_t)pixels, &width, &height);
    JS_FreeValue(ctx, buffer);
    if (!decoded) { free(bitmap); return JS_ThrowTypeError(ctx, "Cannot decode bitmap within the pixel limit"); }
    JSValue result = JS_NewObjectClass(ctx, pu_bitmap_class_id);
    if (JS_IsException(result)) { pu_image_remove(bitmap->key); free(bitmap); return result; }
    bitmap->owner = owner;
    bitmap->next = owner->bitmaps;
    owner->bitmaps = bitmap;
    JS_SetOpaque(result, bitmap);
    if (bitmap_property(ctx, result, "key", JS_NewString(ctx, bitmap->key)) < 0 ||
        bitmap_property(ctx, result, "width", JS_NewInt32(ctx, width)) < 0 ||
        bitmap_property(ctx, result, "height", JS_NewInt32(ctx, height)) < 0) {
        JS_FreeValue(ctx, result);
        return JS_EXCEPTION;
    }
    return result;
}

static void node_set_state(PuNode *n, unsigned flag, int on, int up_path);
static int clear_input(PuBridge *b);
static void end_composition(PuBridge *b, const char *text);

static PuBridge *document_for_node(JSContext *ctx, PuNode *node)
{
    if (!node) return NULL;
    while (node->parent) node = node->parent;
    PuBridge *root = JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
    for (PuBridge *b = root; b; b = b->next)
        if (b->body == node) return b;
    return NULL;
}

static void reset_detached_input(JSContext *ctx)
{
    PuBridge *root = JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
    for (;;) {
        int changed = 0;
        for (PuBridge *b = root; b; b = b->next) {
            PuNode **slot = b->focused && document_for_node(ctx, b->focused) != b ?
                &b->focused : b->hovered && document_for_node(ctx, b->hovered) != b ? &b->hovered : NULL;
            if (!slot) continue;
            JSValue keep = JS_DupValue(ctx, b->document);
            PuNode *node = *slot;
            bool focus = slot == &b->focused;
            *slot = NULL;
            if (focus) clear_input(b);
            node_set_state(node, focus ? PU_STATE_FOCUS : PU_STATE_HOVER, 0, !focus);
            pu_node_unref(node);
            JS_FreeValue(ctx, keep);
            changed = 1;
            break; /* Releasing a node can finalize a retired document. */
        }
        if (!changed) break;
    }
}

static bool document_root(JSContext *ctx, PuNode *node)
{
    PuBridge *b = document_for_node(ctx, node);
    return b && b->body == node;
}

static void free_document(PuBridge *b)
{
    pu_node_unref(b->input_owner);
    pu_node_unref(b->composition);
    if (b->focused) { node_set_state(b->focused, PU_STATE_FOCUS, 0, 0); pu_node_unref(b->focused); }
    if (b->hovered) { node_set_state(b->hovered, PU_STATE_HOVER, 0, 1); pu_node_unref(b->hovered); }
    pu_node_unref(b->body);
    free(b);
}

static void document_finalizer(JSRuntime *rt, JSValueConst value)
{
    (void)rt;
    PuBridge *b = JS_GetOpaque(value, pu_document_class_id);
    if (!b) return;
    PuBridge **link = &b->root->next;
    while (*link && *link != b) link = &(*link)->next;
    if (*link) *link = b->next;
    free_document(b);
}

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
    const char *previous = node ? pu_style_get(&node->style, name) : NULL;
    if (node && val && (!previous || strcmp(previous, val))) {
        pu_style_set(&node->style, name, val);
        if (pu_layout_affects(name)) pu_layout_mark_dirty(); /* skip relayout for render-only props */
    }
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
static const JSClassDef pu_document_class_def = { "Document", .finalizer = document_finalizer };
static const JSClassDef pu_bitmap_class_def = { "Bitmap", .finalizer = bitmap_finalizer };

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
    if (document_root(ctx, child)) return JS_ThrowTypeError(ctx, "Cannot reparent a document body");
    pu_node_append(self, child);
    reset_detached_input(ctx);
    pu_layout_mark_dirty();
    return JS_DupValue(ctx, argv[0]);
}

static JSValue js_node_removeChild(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    PuNode *self  = self_node(this_val);
    PuNode *child = argc >= 1 ? (PuNode *)JS_GetOpaque(argv[0], pu_node_class_id) : NULL;
    if (!self || !child) return JS_ThrowTypeError(ctx, "removeChild: a Node is required");
    pu_node_remove(self, child);
    reset_detached_input(ctx);
    pu_layout_mark_dirty();
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
    if (document_root(ctx, child)) return JS_ThrowTypeError(ctx, "Cannot reparent a document body");
    pu_node_insert_before(self, child, ref);
    reset_detached_input(ctx);
    pu_layout_mark_dirty();
    return JS_DupValue(ctx, argv[0]);
}

static JSValue js_node_get_firstChild(JSContext *ctx, JSValueConst this_val)
{ PuNode *s = self_node(this_val); return s ? pu_node_wrapper(ctx, s->first_child) : JS_NULL; }
static JSValue js_node_get_lastChild(JSContext *ctx, JSValueConst this_val)
{ PuNode *s = self_node(this_val); return s ? pu_node_wrapper(ctx, s->last_child) : JS_NULL; }
static JSValue js_node_get_ownerDocument(JSContext *ctx, JSValueConst this_val)
{
    PuBridge *b = document_for_node(ctx, self_node(this_val));
    return b ? JS_DupValue(ctx, b->document) : JS_NULL;
}

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
    reset_detached_input(ctx);
    pu_layout_mark_dirty(); /* text content changed -> re-measure */
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
    PuBridge *b = document_for_node(ctx, self);
    if (self && b) pu_bridge_set_focus(b, self);
    return JS_UNDEFINED;
}

static JSValue js_node_blur(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    PuNode *self = self_node(this_val);
    PuBridge *b = document_for_node(ctx, self);
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
    PuBridge *b = JS_GetOpaque(this_val, pu_document_class_id);
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
typedef struct PuEventData {
    const PuKeyEvent *key;
    const PuPointerEvent *pointer;
    const PuWheelEvent *wheel;
    const PuDropEvent *drop;
} PuEventData;

static int dispatch_impl(PuBridge *b, PuNode *target, const char *type, const PuEventData *data,
                         int bubble)
{
    if (!b || !target || !type) return 0;
    JSContext *ctx = b->ctx;

    JSValue ev = JS_NewObject(ctx);                       /* one event for the whole walk */
    if (JS_IsException(ev)) { dispatch_report(ctx); return 0; }
    JS_SetPropertyStr(ctx, ev, "type", JS_NewString(ctx, type));
    JS_SetPropertyStr(ctx, ev, "target", pu_node_wrapper(ctx, target));
    JS_SetPropertyStr(ctx, ev, "defaultPrevented", JS_NewBool(ctx, 0));
    const PuKeyEvent *key = data ? data->key : NULL;
    if (key) {
        if (key->type == PU_KEY_TEXT || key->type == PU_KEY_PREEDIT) {
            JS_SetPropertyStr(ctx, ev, "data", JS_NewString(ctx, key->text ? key->text : ""));
            if (key->type == PU_KEY_PREEDIT) {
                JS_SetPropertyStr(ctx, ev, "selectionStart", JS_NewInt32(ctx, key->start));
                JS_SetPropertyStr(ctx, ev, "selectionLength", JS_NewInt32(ctx, key->length));
            }
        } else {
            JS_SetPropertyStr(ctx, ev, "key", JS_NewString(ctx, key->key ? key->key : "Unidentified"));
            JS_SetPropertyStr(ctx, ev, "code", JS_NewString(ctx, key->code ? key->code : "Unidentified"));
            JS_SetPropertyStr(ctx, ev, "repeat", JS_NewBool(ctx, key->repeat));
        }
    }
    if (data) {
        unsigned mods = key ? key->modifiers : data->pointer ? data->pointer->modifiers :
            data->wheel ? data->wheel->modifiers : 0;
        JS_SetPropertyStr(ctx, ev, "shiftKey", JS_NewBool(ctx, mods & PU_MOD_SHIFT));
        JS_SetPropertyStr(ctx, ev, "ctrlKey", JS_NewBool(ctx, mods & PU_MOD_CTRL));
        JS_SetPropertyStr(ctx, ev, "altKey", JS_NewBool(ctx, mods & PU_MOD_ALT));
        JS_SetPropertyStr(ctx, ev, "metaKey", JS_NewBool(ctx, mods & PU_MOD_META));
        JS_SetPropertyStr(ctx, ev, "capsLock", JS_NewBool(ctx, mods & PU_MOD_CAPS));
        JS_SetPropertyStr(ctx, ev, "numLock", JS_NewBool(ctx, mods & PU_MOD_NUM));
        if (data->pointer || data->wheel) {
            JS_SetPropertyStr(ctx, ev, "clientX", JS_NewFloat64(ctx, data->pointer ? data->pointer->x : data->wheel->x));
            JS_SetPropertyStr(ctx, ev, "clientY", JS_NewFloat64(ctx, data->pointer ? data->pointer->y : data->wheel->y));
        }
        if (data->pointer) {
            JS_SetPropertyStr(ctx, ev, "button", JS_NewInt32(ctx, data->pointer->button));
            JS_SetPropertyStr(ctx, ev, "buttons", JS_NewUint32(ctx, data->pointer->buttons));
        }
        if (data->wheel) {
            JS_SetPropertyStr(ctx, ev, "deltaX", JS_NewFloat64(ctx, data->wheel->delta_x));
            JS_SetPropertyStr(ctx, ev, "deltaY", JS_NewFloat64(ctx, data->wheel->delta_y));
            JS_SetPropertyStr(ctx, ev, "deltaMode", JS_NewInt32(ctx, 0));
        }
        if (data->drop) {
            const PuDropEvent *drop = data->drop;
            JS_SetPropertyStr(ctx, ev, "clientX", JS_NewFloat64(ctx, drop->x));
            JS_SetPropertyStr(ctx, ev, "clientY", JS_NewFloat64(ctx, drop->y));
            JS_SetPropertyStr(ctx, ev, "text", drop->text ? JS_NewString(ctx, drop->text) : JS_NULL);
            JS_SetPropertyStr(ctx, ev, "source", drop->source ? JS_NewString(ctx, drop->source) : JS_NULL);
            JS_SetPropertyStr(ctx, ev, "error", drop->error ? JS_NewString(ctx, drop->error) : JS_NULL);
            JSValue files = JS_NewArray(ctx);
            if (JS_IsException(files)) goto failed;
            for (size_t i = 0; i < drop->file_count; i++) {
                if (JS_SetPropertyUint32(ctx, files, (uint32_t)i, JS_NewString(ctx, drop->files[i])) < 0 ||
                    JS_HasException(ctx)) {
                    JS_FreeValue(ctx, files); goto failed;
                }
            }
            if (JS_SetPropertyStr(ctx, ev, "files", files) < 0) goto failed;
        }
    }
    JS_SetPropertyStr(ctx, ev, "stopPropagation",
        JS_NewCFunction(ctx, js_event_stop, "stopPropagation", 0));
    JS_SetPropertyStr(ctx, ev, "stopImmediatePropagation",
        JS_NewCFunction(ctx, js_event_stop_immediate, "stopImmediatePropagation", 0));
    JS_SetPropertyStr(ctx, ev, "preventDefault",
        JS_NewCFunction(ctx, js_event_prevent, "preventDefault", 0));
    if (JS_HasException(ctx)) goto failed;

    for (PuNode *n = target; n; n = n->parent) {
        JS_SetPropertyStr(ctx, ev, "currentTarget", pu_node_wrapper(ctx, n));
        for (int i = 0; i < n->listener_count; i++) {
            if (strcmp(n->listeners[i].type, type) != 0) continue;
            /* Dup the callback across the call: a handler that removeEventListeners
             * itself (e.g. a reconciler swapping handlers on re-render) would
             * otherwise free a function that is still executing. */
            JSValue func = JS_DupValue(ctx, n->listeners[i].func);
            JSValue self = pu_node_wrapper(ctx, n);
            JSValue arg = ev;
            JSValue r = JS_Call(ctx, func, self, 1, &arg);
            if (JS_IsException(r)) dispatch_report(ctx);
            JS_FreeValue(ctx, r);
            JS_FreeValue(ctx, self);
            JS_FreeValue(ctx, func);
            if (js_event_flag(ctx, ev, "__stopImmediate")) break;
        }
        if (!bubble || js_event_flag(ctx, ev, "__stop")) break;
    }

    int prevented = js_event_flag(ctx, ev, "defaultPrevented");
    JS_FreeValue(ctx, ev);
    return prevented;
failed:
    dispatch_report(ctx);
    JS_FreeValue(ctx, ev);
    return 0;
}

int pu_bridge_dispatch_drop(PuBridge *b, PuNode *target, const PuDropEvent *event)
{
    const char *types[] = { "dragenter", "dragover", "drop", "dragleave", "droperror" };
    if (!event || event->type < PU_DROP_ENTER || event->type > PU_DROP_ERROR) return 0;
    return dispatch_impl(b, target, types[event->type], &(PuEventData){ .drop = event }, 1);
}

static void end_composition(PuBridge *b, const char *text)
{
    PuNode *target = b->composition;
    b->composition = NULL;
    if (!target) return;
    PuKeyEvent event = { .type = PU_KEY_PREEDIT, .text = text, .start = -1, .length = -1 };
    dispatch_impl(b, target, "compositionend", &(PuEventData){ .key = &event }, 1);
    pu_node_unref(target);
}

int pu_bridge_dispatch_key(PuBridge *b, const PuKeyEvent *event)
{
    if (!b) return 0;
    if (event->type == PU_KEY_PREEDIT) {
        if (!event->text || !*event->text) { end_composition(b, ""); return 0; }
        if (b->input.enabled && (b->input.purpose == 1 || b->input.purpose == 2)) return 0;
        if (!b->focused) return 0;
        PuNode *target = b->focused;
        pu_node_ref(target);
        if (!b->composition) {
            b->composition = target; pu_node_ref(target);
            PuKeyEvent start = { .type = PU_KEY_PREEDIT, .text = "", .start = 0 };
            dispatch_impl(b, target, "compositionstart", &(PuEventData){ .key = &start }, 1);
        }
        int prevented = b->composition == target ?
            dispatch_impl(b, target, "compositionupdate", &(PuEventData){ .key = event }, 1) : 0;
        pu_node_unref(target);
        return prevented;
    }
    PuNode *target = event->type == PU_KEY_TEXT && b->composition ? b->composition : b->focused;
    pu_node_ref(target);
    if (event->type == PU_KEY_TEXT && b->composition) end_composition(b, event->text ? event->text : "");
    const char *type = event->type == PU_KEY_TEXT ? "textinput" :
                       event->type == PU_KEY_DOWN ? "keydown" : "keyup";
    int result = target && b->focused == target ? dispatch_impl(b, target, type, &(PuEventData){ .key = event }, 1) : 0;
    pu_node_unref(target);
    return result;
}

/* Pointer events: dispatch `type` (mousedown/mouseup/mousemove/click) at the
 * hit-tested target, carrying clientX/clientY. For mousemove, also emit
 * mouseleave/mouseenter (non-bubbling) as the hovered element changes. */
static void node_set_state(PuNode *n, unsigned flag, int on, int up_path); /* fwd */

int pu_bridge_dispatch_pointer(PuBridge *b, PuNode *target, const PuPointerEvent *event)
{
    if (!b) return 0;
    const char *type = pu_pointer_name(event->type);
    PuEventData data = { .pointer = event };

    int hover_changed = 0;
    if (strcmp(type, "mousemove") == 0 && target != b->hovered) {
        PuNode *old = b->hovered;
        b->hovered = target;
        if (old) node_set_state(old, PU_STATE_HOVER, 0, 1);       /* clear old hover path */
        if (target) { pu_node_ref(target); node_set_state(target, PU_STATE_HOVER, 1, 1); } /* mark new path */
        if (old) { dispatch_impl(b, old, "mouseleave", &data, 0); pu_node_unref(old); }
        if (target) dispatch_impl(b, target, "mouseenter", &data, 0);
        hover_changed = 1; /* hover:* overrides changed -> the host should repaint */
    }
    if (target) dispatch_impl(b, target, type, &data, 1);
    return hover_changed;
}

/* Wheel: dispatch a "wheel" event, then apply default scrolling to the nearest
 * overflow:scroll/auto ancestor (clamped to its content height). */
static int scroll_axis(PuNode *sc, int horizontal, float delta)
{
    const char *property = horizontal ? "scrollLeft" : "scrollTop";
    const char *cur_s = pu_style_get(&sc->style, property);
    float cur = cur_s ? (float)atof(cur_s) : 0.0f;

    float content = 0; /* furthest child bottom, relative to the container top */
    for (PuNode *c = sc->first_child; c; c = c->next_sibling) {
        float bottom = horizontal ? c->layout_x + c->layout_w - sc->layout_x :
                                    c->layout_y + c->layout_h - sc->layout_y;
        if (bottom > content) content = bottom;
    }
    float maxs = content - (horizontal ? sc->layout_w : sc->layout_h);
    if (maxs < 0) maxs = 0;

    float next = cur + delta;
    if (next < 0) next = 0;
    if (next > maxs) next = maxs;
    char buf[32];
    snprintf(buf, sizeof(buf), "%g", next);
    pu_style_set(&sc->style, property, buf);
    return next != cur; /* tell the host to repaint only if the offset moved */
}

int pu_bridge_dispatch_wheel(PuBridge *b, PuNode *target, const PuWheelEvent *event)
{
    if (!b || !target) return 0;
    pu_node_ref(target);
    if (dispatch_impl(b, target, "wheel", &(PuEventData){ .wheel = event }, 1)) {
        pu_node_unref(target);
        return 0;
    }
    int moved = 0;
    for (PuNode *p = target; p; p = p->parent) {
        const char *overflow = pu_style_get(&p->style, "overflow");
        if (overflow && (!strcmp(overflow, "scroll") || !strcmp(overflow, "auto"))) {
            moved = scroll_axis(p, 1, event->delta_x) | scroll_axis(p, 0, event->delta_y);
            break;
        }
    }
    pu_node_unref(target);
    return moved;
}

/* Set/clear a state flag on a node, or up the whole ancestor chain to the root.
 * Hover marks the path (CSS :hover applies to ancestors); focus marks one node. */
static void node_set_state(PuNode *n, unsigned flag, int on, int up_path)
{
    for (; n; n = n->parent) {
        unsigned previous = n->state;
        if (on) n->state |= flag; else n->state &= ~flag;
        if (previous != n->state) pu_node_mark_paint_dirty(n);
        if (!up_path) break;
    }
}

int pu_bridge_set_focus(PuBridge *b, PuNode *node)
{
    if (!b || b->focused == node) return 0;
    if (node && document_for_node(b->ctx, node) != b) return 0;
    JSContext *ctx = b->ctx;
    JSValue keep = JS_DupValue(ctx, b->document);
    pu_node_ref(node);

    if (b->focused) {
        PuNode *old = b->focused;
        node_set_state(old, PU_STATE_FOCUS, 0, 0);
        b->focused = NULL;
        clear_input(b);
        dispatch_impl(b, old, "blur", NULL, 0);
        pu_node_unref(old);           /* release the focus ref */
    }
    if (b->focused || (node && document_for_node(b->ctx, node) != b)) {
        pu_node_unref(node);
        JS_FreeValue(ctx, keep);
        return 1;
    }
    b->focused = node;
    if (node) {
        node_set_state(node, PU_STATE_FOCUS, 1, 0);
        dispatch_impl(b, node, "focus", NULL, 0);
    }
    JS_FreeValue(ctx, keep);
    return 1; /* focus changed -> the host should repaint */
}

static void collect_focusable(PuNode *n, PuNode **arr, int *count, int cap)
{
    const char *display = pu_style_get(&n->style, "display");
    if (display && strcmp(display, "none") == 0) return;
    if (n->type == PU_NODE_ELEMENT && n->tab_index >= 0 && *count < cap)
        arr[(*count)++] = n;
    for (PuNode *c = n->first_child; c; c = c->next_sibling)
        collect_focusable(c, arr, count, cap);
}

void pu_bridge_focus_step(PuBridge *b, int backwards)
{
    if (!b) return;
    PuNode *arr[256];
    int count = 0;
    collect_focusable(b->body, arr, &count, 256);
    if (count == 0) return;
    int idx = -1;
    for (int i = 0; i < count; i++)
        if (arr[i] == b->focused) { idx = i; break; }
    int next = idx < 0 ? (backwards ? count - 1 : 0) :
                        (idx + (backwards ? -1 : 1) + count) % count;
    pu_bridge_set_focus(b, arr[next]);
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
    PuBridge *b = JS_GetOpaque(this_val, pu_document_class_id);
    return b ? pu_node_wrapper(ctx, b->body) : JS_NULL;
}

/* measureText(str, fontSize=16) -> advance width in (logical) pixels. Lets JS
 * position carets, truncate labels, etc. */
static JSValue js_measure_text(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    (void)this_val;
    const char *s = argc >= 1 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (argc && !s) return JS_EXCEPTION;
    double fs = 16.0;
    if (argc >= 2 && JS_ToFloat64(ctx, &fs, argv[1]) < 0) { JS_FreeCString(ctx, s); return JS_EXCEPTION; }
    int32_t weight = 400;
    if (argc >= 3 && JS_ToInt32(ctx, &weight, argv[2]) < 0) { JS_FreeCString(ctx, s); return JS_EXCEPTION; }
    if (!isfinite(fs) || fs <= 0 || fs > 4096 || weight < 1 || weight > 1000) {
        JS_FreeCString(ctx, s);
        return JS_ThrowRangeError(ctx, "Invalid measurement font size or weight");
    }
    float w = 0, h = 0;
    pu_text_measure(s ? s : "", (float)fs, weight, 0, NULL, 0, &w, &h);
    if (s) JS_FreeCString(ctx, s);
    return JS_NewFloat64(ctx, w);
}

#if defined(PU_COMPLEX_TEXT)
static JSValue js_text_boundaries(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!argc || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "textBoundaries requires a string");
    size_t length;
    const char *text = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!text) return JS_EXCEPTION;
    int *positions;
    size_t count;
    int ok = pu_text_graphemes(text, length, &positions, &count);
    JS_FreeCString(ctx, text);
    if (!ok) return JS_ThrowInternalError(ctx, "Cannot segment text");
    JSValue result = JS_NewArray(ctx);
    if (JS_IsException(result)) { free(positions); return JS_EXCEPTION; }
    for (size_t i = 0; !JS_HasException(ctx) && i < count; i++)
        JS_SetPropertyUint32(ctx, result, (uint32_t)i, JS_NewInt32(ctx, positions[i]));
    free(positions);
    if (JS_HasException(ctx)) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    return result;
}
static JSValue js_layout_text(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!argc || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "layoutText requires a string");
    double size = 16;
    int32_t weight = 400;
    if (argc > 1 && JS_ToFloat64(ctx, &size, argv[1]) < 0) return JS_EXCEPTION;
    if (argc > 2 && JS_ToInt32(ctx, &weight, argv[2]) < 0) return JS_EXCEPTION;
    if (!isfinite(size) || size <= 0 || size > 4096 || weight < 1 || weight > 1000)
        return JS_ThrowRangeError(ctx, "Invalid text layout size or weight");
    size_t length;
    const char *text = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!text) return JS_EXCEPTION;
    PuTextLayout layout;
    int ok = pu_text_layout(text, length, (float)size, weight, 0, NULL, &layout);
    JS_FreeCString(ctx, text);
    if (!ok) return JS_ThrowInternalError(ctx, "Cannot shape text");
    JSValue result = JS_NewObject(ctx), clusters = JS_NewArray(ctx);
    if (JS_IsException(result) || JS_IsException(clusters)) {
        JS_FreeValue(ctx, result); JS_FreeValue(ctx, clusters); pu_text_layout_dispose(&layout); return JS_EXCEPTION;
    }
    for (size_t i = 0; !JS_HasException(ctx) && i < layout.count; i++) {
        PuTextCluster *cluster = &layout.clusters[i];
        JSValue item = JS_NewObject(ctx);
        if (JS_IsException(item)) break;
        JS_SetPropertyStr(ctx, item, "start", JS_NewInt32(ctx, cluster->start));
        JS_SetPropertyStr(ctx, item, "end", JS_NewInt32(ctx, cluster->end));
        JS_SetPropertyStr(ctx, item, "x", JS_NewFloat64(ctx, cluster->x));
        JS_SetPropertyStr(ctx, item, "width", JS_NewFloat64(ctx, cluster->width));
        JS_SetPropertyStr(ctx, item, "rtl", JS_NewBool(ctx, cluster->rtl));
        JS_SetPropertyUint32(ctx, clusters, (uint32_t)i, item);
    }
    JS_SetPropertyStr(ctx, result, "width", JS_NewFloat64(ctx, layout.width));
    JS_SetPropertyStr(ctx, result, "clusters", clusters);
    pu_text_layout_dispose(&layout);
    if (JS_HasException(ctx)) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    return result;
}
#endif

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

/* Computed layout geometry (absolute logical px), read from the last layout. */
static JSValue js_node_get_offsetLeft(JSContext *ctx, JSValueConst t)   { PuNode *n = self_node(t); return JS_NewFloat64(ctx, n ? n->layout_x : 0); }
static JSValue js_node_get_offsetTop(JSContext *ctx, JSValueConst t)    { PuNode *n = self_node(t); return JS_NewFloat64(ctx, n ? n->layout_y : 0); }
static JSValue js_node_get_offsetWidth(JSContext *ctx, JSValueConst t)  { PuNode *n = self_node(t); return JS_NewFloat64(ctx, n ? n->layout_w : 0); }
static JSValue js_node_get_offsetHeight(JSContext *ctx, JSValueConst t) { PuNode *n = self_node(t); return JS_NewFloat64(ctx, n ? n->layout_h : 0); }

static void viewport_position(PuNode *n, float *x, float *y, bool content)
{
    *x = n ? n->layout_x : 0; *y = n ? n->layout_y : 0;
    for (PuNode *p = content ? n : n ? n->parent : NULL; p; p = p->parent) {
        const char *sl = pu_style_get(&p->style, "scrollLeft");
        const char *st = pu_style_get(&p->style, "scrollTop");
        if (sl) *x -= (float)atof(sl);
        if (st) *y -= (float)atof(st);
    }
}

static JSValue js_node_getBoundingClientRect(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    PuNode *n = self_node(this_val);
    float x, y, w = n ? n->layout_w : 0, h = n ? n->layout_h : 0;
    viewport_position(n, &x, &y, false);
    JSValue r = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, r, "x", JS_NewFloat64(ctx, x));
    JS_SetPropertyStr(ctx, r, "y", JS_NewFloat64(ctx, y));
    JS_SetPropertyStr(ctx, r, "left", JS_NewFloat64(ctx, x));
    JS_SetPropertyStr(ctx, r, "top", JS_NewFloat64(ctx, y));
    JS_SetPropertyStr(ctx, r, "width", JS_NewFloat64(ctx, w));
    JS_SetPropertyStr(ctx, r, "height", JS_NewFloat64(ctx, h));
    JS_SetPropertyStr(ctx, r, "right", JS_NewFloat64(ctx, x + w));
    JS_SetPropertyStr(ctx, r, "bottom", JS_NewFloat64(ctx, y + h));
    return r;
}

static int apply_input(PuBridge *b, int reset)
{
    if (!b->input_callback || !b->input_configured) return 1;
    PuTextInputState state = b->input;
    if (!b->input_owner || b->focused != b->input_owner ||
        b->input_owner->layout_w <= 0 || b->input_owner->layout_h <= 0) state.enabled = 0;
    if (!state.enabled && b->composition) {
        end_composition(b, "");
        return apply_input(b, reset);
    }
    if (state.enabled) {
        float x, y;
        viewport_position(b->input_owner, &x, &y, true);
        state.x += x; state.y += y;
    }
    return b->input_callback(&state, reset, b->input_user);
}
int pu_bridge_sync_text_input(PuBridge *b) { return apply_input(b, 0); }
int pu_bridge_set_text_input_callback(PuBridge *b, PuTextInputFn callback, void *user)
{ b->input_callback = callback; b->input_user = user; return apply_input(b, 1); }
static int clear_input(PuBridge *b)
{
    PuNode *owner = b->input_owner;
    b->input_owner = NULL; b->input.enabled = 0;
    int result = apply_input(b, 1);
    end_composition(b, "");
    pu_node_unref(owner);
    return result;
}
static int input_number(JSContext *ctx, JSValueConst options, const char *name, double minimum, float *result)
{
    JSValue value = JS_GetPropertyStr(ctx, options, name);
    if (JS_IsException(value)) return 0;
    if (JS_IsUndefined(value)) { JS_FreeValue(ctx, value); return 1; }
    double number;
    bool ok = JS_IsNumber(value) && JS_ToFloat64(ctx, &number, value) == 0 &&
        isfinite(number) && number >= minimum && number <= 1000000;
    JS_FreeValue(ctx, value);
    if (!ok) { JS_ThrowTypeError(ctx, "Invalid input-method %s", name); return 0; }
    *result = (float)number;
    return 1;
}
static JSValue js_node_setInputMethod(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    PuNode *node = self_node(self);
    PuBridge *b = document_for_node(ctx, node);
    if (!b) return JS_ThrowTypeError(ctx, "Input-method target is not in a document");
    if (argc && JS_IsNull(argv[0])) {
        if (b->input_owner == node && !clear_input(b))
            return JS_ThrowInternalError(ctx, "Cannot disable native input method");
        return JS_UNDEFINED;
    }
    if (argc != 1 || !JS_IsObject(argv[0]) || JS_IsArray(argv[0]) || b->focused != node)
        return JS_ThrowTypeError(ctx, "setInputMethod requires options on the focused element");
    PuTextInputState state = { .enabled = 1, .width = 1, .height = 16 };
    JSPropertyEnum *properties = NULL;
    uint32_t count = 0;
    if (JS_GetOwnPropertyNames(ctx, &properties, &count, argv[0], JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) < 0)
        return JS_EXCEPTION;
    bool valid = true;
    for (uint32_t i = 0; valid && i < count; i++) {
        const char *name = JS_AtomToCString(ctx, properties[i].atom);
        valid = name && (!strcmp(name, "purpose") || !strcmp(name, "x") || !strcmp(name, "y") ||
            !strcmp(name, "width") || !strcmp(name, "height"));
        JS_FreeCString(ctx, name);
    }
    JS_FreePropertyEnum(ctx, properties, count);
    if (JS_HasException(ctx)) return JS_EXCEPTION;
    if (!valid) return JS_ThrowTypeError(ctx, "Unknown input-method option");
    if (!input_number(ctx, argv[0], "x", -1000000, &state.x) ||
        !input_number(ctx, argv[0], "y", -1000000, &state.y) ||
        !input_number(ctx, argv[0], "width", 1, &state.width) ||
        !input_number(ctx, argv[0], "height", 1, &state.height)) return JS_EXCEPTION;
    JSValue purpose = JS_GetPropertyStr(ctx, argv[0], "purpose");
    if (JS_IsException(purpose)) return purpose;
    if (!JS_IsUndefined(purpose)) {
        size_t length = 0;
        const char *text = JS_IsString(purpose) ? JS_ToCStringLen(ctx, &length, purpose) : NULL;
        const char *names[] = { "text", "password", "pin", "email", "number", "name" };
        state.purpose = -1;
        for (int i = 0; text && i < 6; i++)
            if (length == strlen(names[i]) && !memcmp(text, names[i], length)) state.purpose = i;
        JS_FreeCString(ctx, text);
    }
    JS_FreeValue(ctx, purpose);
    if (JS_HasException(ctx)) return JS_EXCEPTION;
    if (state.purpose < 0) return JS_ThrowTypeError(ctx, "Unknown input-method purpose");
    int reset = b->input_owner != node || b->input.purpose != state.purpose;
    if (reset) end_composition(b, "");
    if (b->focused != node || document_for_node(ctx, node) != b)
        return JS_ThrowTypeError(ctx, "Input-method focus changed while reading options");
    if (b->input_owner != node) { pu_node_ref(node); pu_node_unref(b->input_owner); b->input_owner = node; }
    b->input = state; b->input_configured = true;
    if (!apply_input(b, reset)) return JS_ThrowInternalError(ctx, "Cannot configure native input method");
    return JS_UNDEFINED;
}
static JSValue js_node_cancelComposition(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)argc; (void)argv;
    PuNode *node = self_node(self);
    PuBridge *b = document_for_node(ctx, node);
    if (!b || b->input_owner != node) return JS_UNDEFINED;
    end_composition(b, "");
    if (b->input_owner != node || b->focused != node) return JS_UNDEFINED;
    if (!apply_input(b, 1)) return JS_ThrowInternalError(ctx, "Cannot cancel native composition");
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
    PuBridge *b = JS_GetOpaque(this_val, pu_document_class_id);
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
    PuBridge *b = JS_GetOpaque(this_val, pu_document_class_id);
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
    b->root = b;
    b->document = JS_UNDEFINED;

    JSRuntime *rt = JS_GetRuntime(ctx);
    JS_SetRuntimeOpaque(rt, b);
    pu_node_set_runtime(rt); /* so freed nodes can release their listeners */

    if (pu_node_class_id == 0)  JS_NewClassID(rt, &pu_node_class_id);
    if (pu_style_class_id == 0) JS_NewClassID(rt, &pu_style_class_id);
    if (pu_document_class_id == 0) JS_NewClassID(rt, &pu_document_class_id);
    JS_NewClass(rt, pu_node_class_id,  &pu_node_class_def);
    JS_NewClass(rt, pu_style_class_id, &pu_style_class_def);
    JS_NewClass(rt, pu_document_class_id, &pu_document_class_def);
    if (pu_bitmap_class_id == 0) JS_NewClassID(rt, &pu_bitmap_class_id);
    if (JS_NewClass(rt, pu_bitmap_class_id, &pu_bitmap_class_def) < 0) {
        pu_bridge_free(b);
        return NULL;
    }
    JSValue bitmap_proto = JS_NewObject(ctx);
    if (JS_IsException(bitmap_proto)) { pu_bridge_free(b); return NULL; }
    def_method(ctx, bitmap_proto, "close", js_bitmap_close, 0);
    def_get(ctx, bitmap_proto, "closed", js_bitmap_closed);
    if (JS_HasException(ctx)) {
        JS_FreeValue(ctx, bitmap_proto);
        pu_bridge_free(b);
        return NULL;
    }
    JS_SetClassProto(ctx, pu_bitmap_class_id, bitmap_proto);

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
    def_get(ctx, node_proto, "offsetLeft",   js_node_get_offsetLeft);
    def_method(ctx, node_proto, "setInputMethod", js_node_setInputMethod, 1);
    def_method(ctx, node_proto, "cancelComposition", js_node_cancelComposition, 0);
    def_get(ctx, node_proto, "offsetTop",    js_node_get_offsetTop);
    def_get(ctx, node_proto, "offsetWidth",  js_node_get_offsetWidth);
    def_get(ctx, node_proto, "offsetHeight", js_node_get_offsetHeight);
    def_method(ctx, node_proto, "getBoundingClientRect", js_node_getBoundingClientRect, 0);
    def_get(ctx, node_proto, "classList", js_node_get_classList);
    def_get(ctx, node_proto, "firstChild",      js_node_get_firstChild);
    def_get(ctx, node_proto, "lastChild",       js_node_get_lastChild);
    def_get(ctx, node_proto, "parentNode",      js_node_get_parentNode);
    def_get(ctx, node_proto, "ownerDocument",   js_node_get_ownerDocument);
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
    if (!b->body) {
        JS_SetRuntimeOpaque(rt, NULL);
        pu_node_set_runtime(NULL);
        free(b);
        return NULL;
    }
    b->body->tag = pu_bstrdup("body");
    pu_node_ref(b->body); /* bridge holds a ref so body persists across GC */
    if (!b->body->tag) { pu_bridge_free(b); return NULL; }

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
    JS_SetClassProto(ctx, pu_document_class_id, document);
    b->document = JS_NewObjectClass(ctx, pu_document_class_id);
    if (JS_IsException(b->document)) {
        JS_FreeValue(ctx, global);
        pu_bridge_free(b);
        return NULL;
    }
    b->native_owned = true;
    JS_SetOpaque(b->document, b);
    JSValue body = pu_node_wrapper(ctx, b->body);
    if (JS_IsException(body) ||
        JS_DefinePropertyValueStr(ctx, b->document, "body", body, JS_PROP_ENUMERABLE) < 0) {
        JS_FreeValue(ctx, global);
        pu_bridge_free(b);
        return NULL;
    }
    JS_SetPropertyStr(ctx, global, "document", JS_DupValue(ctx, b->document));
    JS_SetPropertyStr(ctx, global, "measureText",
                      JS_NewCFunction(ctx, js_measure_text, "measureText", 2));
    JSValue create_bitmap = JS_NewCFunction(ctx, js_create_bitmap, "createBitmap", 2);
    if (JS_IsException(create_bitmap) || JS_SetPropertyStr(ctx, global, "createBitmap", create_bitmap) < 0) {
        JS_FreeValue(ctx, global);
        pu_bridge_free(b);
        return NULL;
    }
#if defined(PU_COMPLEX_TEXT)
    JS_SetPropertyStr(ctx, global, "textBoundaries", JS_NewCFunction(ctx, js_text_boundaries, "textBoundaries", 1));
    JS_SetPropertyStr(ctx, global, "layoutText", JS_NewCFunction(ctx, js_layout_text, "layoutText", 2));
#endif
    JS_FreeValue(ctx, global);

    return b;
}

PuNode *pu_bridge_body(PuBridge *b) { return b ? b->body : NULL; }

PuBridge *pu_bridge_new_document(PuBridge *main)
{
    PuBridge *b = calloc(1, sizeof(*b));
    if (!b) return NULL;
    b->root = main->root;
    b->ctx = main->ctx;
    b->body = pu_node_new(PU_NODE_ELEMENT);
    if (!b->body) { free(b); return NULL; }
    pu_node_ref(b->body);
    b->body->tag = pu_bstrdup("body");
    if (!b->body->tag) { free_document(b); return NULL; }
    b->document = JS_NewObjectClass(b->ctx, pu_document_class_id);
    if (JS_IsException(b->document)) { free_document(b); return NULL; }
    JS_SetOpaque(b->document, b);
    JSValue body = pu_node_wrapper(b->ctx, b->body);
    if (JS_IsException(body) ||
        JS_DefinePropertyValueStr(b->ctx, b->document, "body", body, JS_PROP_ENUMERABLE) < 0) {
        JS_SetOpaque(b->document, NULL);
        JS_FreeValue(b->ctx, b->document);
        free_document(b);
        return NULL;
    }
    b->native_owned = true;
    b->next = b->root->next;
    b->root->next = b;
    return b;
}

JSValue pu_bridge_document(PuBridge *b) { return JS_DupValue(b->ctx, b->document); }

void pu_bridge_release_document(PuBridge *b)
{
    if (!b || !b->native_owned) return;
    b->input_callback = NULL; b->input_user = NULL;
    pu_node_unref(b->input_owner); b->input_owner = NULL;
    pu_node_unref(b->composition); b->composition = NULL;
    if (b->focused) { node_set_state(b->focused, PU_STATE_FOCUS, 0, 0); pu_node_unref(b->focused); b->focused = NULL; }
    if (b->hovered) { node_set_state(b->hovered, PU_STATE_HOVER, 0, 1); pu_node_unref(b->hovered); b->hovered = NULL; }
    pu_node_clear_tree_listeners(b->body);
    if (b == b->root) return; /* The global document belongs to the shared realm. */
    b->native_owned = false;
    JS_FreeValue(b->ctx, b->document);
}

void pu_bridge_free(PuBridge *b)
{
    if (!b) return;
    while (b->bitmaps) bitmap_close(b->bitmaps);
    pu_node_clear_all_listeners();
    JS_SetRuntimeOpaque(JS_GetRuntime(b->ctx), NULL);
    while (b->next) {
        PuBridge *child = b->next;
        b->next = child->next;
        JS_SetOpaque(child->document, NULL);
        if (child->native_owned) JS_FreeValue(child->ctx, child->document);
        free_document(child);
    }
    if (JS_IsObject(b->document)) JS_SetOpaque(b->document, NULL);
    if (b->native_owned) JS_FreeValue(b->ctx, b->document);
    pu_node_set_runtime(NULL);
    free_document(b);
}
