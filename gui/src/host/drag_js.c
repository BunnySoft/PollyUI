#include "host/drag_js.h"
#include "bridge/bridge.h"
#include "model/node.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Credential
{
    PuDragInput *input;
    PuBridge *bridge;
    PuNode *node;
    JSValue document;
} Credential;
typedef struct Operation
{
    struct Operation *next;
    JSContext *ctx;
    PuDragSession *session;
    PuBridge *bridge;
    PuNode *node;
    JSValue document, resolve, reject;
    JSValue native_document, native_resolve, native_reject;
    int closed, wrapper_gone, completing;
} Operation;
static JSClassID input_class, operation_class;
static Operation *operations;

static void input_mark(JSRuntime *runtime, JSValueConst value, JS_MarkFunc *mark)
{
    Credential *credential = JS_GetOpaque(value, input_class);
    if (credential)
        JS_MarkValue(runtime, credential->document, mark);
}
static void input_finalizer(JSRuntime *runtime, JSValueConst value)
{
    Credential *credential = JS_GetOpaque(value, input_class);
    if (!credential)
        return;
    pu_drag_input_unref(credential->input);
    pu_node_unref(credential->node);
    JS_FreeValueRT(runtime, credential->document);
    free(credential);
}
JSValue pu_drag_js_input(JSContext *ctx, PuBridge *bridge, PuNode *node, PuDragInput *input)
{
    if (!input || !input_class)
        return JS_NULL;
    Credential *credential = calloc(1, sizeof(*credential));
    if (!credential)
        return JS_ThrowOutOfMemory(ctx);
    JSValue value = JS_NewObjectClass(ctx, input_class);
    if (JS_IsException(value))
    {
        free(credential);
        return value;
    }
    credential->input = input;
    pu_drag_input_ref(input);
    credential->bridge = bridge;
    credential->node = node;
    pu_node_ref(node);
    credential->document = pu_bridge_document(bridge);
    JS_SetOpaque(value, credential);
    return value;
}
static void unlink_operation(Operation *operation)
{
    Operation **slot = &operations;
    while (*slot && *slot != operation)
        slot = &(*slot)->next;
    if (*slot)
        *slot = operation->next;
}
static void stop_operation(Operation *operation)
{
    if (operation->closed)
        return;
    operation->closed = 1;
    pu_drag_set_callback(operation->session, NULL, NULL);
    pu_drag_release(operation->session);
    operation->session = NULL;
    unlink_operation(operation);
    pu_node_unref(operation->node);
    operation->node = NULL;
    JS_FreeValue(operation->ctx, operation->document);
    operation->document = JS_UNDEFINED;
    JS_FreeValue(operation->ctx, operation->resolve);
    operation->resolve = JS_UNDEFINED;
    JS_FreeValue(operation->ctx, operation->reject);
    operation->reject = JS_UNDEFINED;
    JS_FreeValue(operation->ctx, operation->native_document);
    operation->native_document = JS_UNDEFINED;
    JS_FreeValue(operation->ctx, operation->native_resolve);
    operation->native_resolve = JS_UNDEFINED;
    JS_FreeValue(operation->ctx, operation->native_reject);
    operation->native_reject = JS_UNDEFINED;
}
static void operation_finalizer(JSRuntime *runtime, JSValueConst value)
{
    (void)runtime;
    Operation *operation = JS_GetOpaque(value, operation_class);
    if (!operation)
        return;
    if (operation->closed && !operation->completing)
        free(operation);
    else
    {
        operation->wrapper_gone = 1;
        pu_drag_cancel(operation->session);
    }
}
static void operation_mark(JSRuntime *runtime, JSValueConst value, JS_MarkFunc *mark)
{
    Operation *operation = JS_GetOpaque(value, operation_class);
    if (!operation)
        return;
    JS_MarkValue(runtime, operation->document, mark);
    JS_MarkValue(runtime, operation->resolve, mark);
    JS_MarkValue(runtime, operation->reject, mark);
}
static JSValue cancel(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)argv;
    Operation *operation = JS_GetOpaque2(ctx, self, operation_class);
    if (!operation)
        return JS_EXCEPTION;
    if (argc)
        return JS_ThrowTypeError(ctx, "Drag cancel takes no arguments");
    pu_drag_cancel(operation->session);
    return JS_UNDEFINED;
}
static void complete(const PuDragResult *result, void *data)
{
    Operation *operation = data;
    operation->completing = 1;
    JSContext *ctx = operation->ctx;
    JSValue resolve = JS_DupValue(ctx, operation->resolve);
    JSValue reject = JS_DupValue(ctx, operation->reject);
    JSValue value;
    if (result->status == PU_DRAG_ERROR)
    {
        value = JS_NewError(ctx);
        JS_SetPropertyStr(
            ctx, value, "message", JS_NewString(ctx, result->reason ? result->reason : "Native drag failed"));
    }
    else
    {
        value = JS_NewObject(ctx);
        JS_SetPropertyStr(
            ctx, value, "status", JS_NewString(ctx, result->status == PU_DRAG_COPIED ? "copied" : "cancelled"));
        JS_SetPropertyStr(ctx, value, "action", result->status == PU_DRAG_COPIED ? JS_NewString(ctx, "copy") : JS_NULL);
        JS_SetPropertyStr(ctx, value, "reason", result->reason ? JS_NewString(ctx, result->reason) : JS_NULL);
    }
    int failed = result->status == PU_DRAG_ERROR;
    if (JS_IsException(value) || JS_HasException(ctx))
    {
        JS_FreeValue(ctx, value);
        value = JS_GetException(ctx);
        failed = 1;
    }
    /* Remove every native/user reference before JS can GC, close/quit or create
     * a replacement window from the Promise's continuation. */
    stop_operation(operation);
    JSValue returned = JS_Call(ctx, failed ? reject : resolve, JS_UNDEFINED, 1, &value);
    if (JS_IsException(returned))
    {
        JSValue error = JS_GetException(ctx);
        const char *message = JS_ToCString(ctx, error);
        fprintf(stderr, "[drag] Completion failed: %s\n", message ? message : "allocation failure");
        JS_FreeCString(ctx, message);
        JS_FreeValue(ctx, error);
    }
    JS_FreeValue(ctx, returned);
    JS_FreeValue(ctx, value);
    JS_FreeValue(ctx, resolve);
    JS_FreeValue(ctx, reject);
    operation->completing = 0;
    if (operation->wrapper_gone)
        free(operation);
}
static int keys(JSContext *ctx, JSValueConst object, const char *const *allowed)
{
    if (!JS_IsObject(object) || JS_IsArray(object) || JS_IsFunction(ctx, object))
    {
        JS_ThrowTypeError(ctx, "Expected drag options or MIME item object");
        return 0;
    }
    JSPropertyEnum *props;
    uint32_t count;
    if (JS_GetOwnPropertyNames(ctx, &props, &count, object, JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) < 0)
        return 0;
    int ok = 1;
    for (uint32_t i = 0; i < count; i++)
    {
        const char *name = JS_AtomToCString(ctx, props[i].atom);
        if (!name)
        {
            ok = 0;
            break;
        }
        int found = 0;
        if (name)
            for (size_t j = 0; allowed[j]; j++)
                if (!strcmp(name, allowed[j]))
                    found = 1;
        if (!found)
        {
            JS_ThrowTypeError(ctx, "Unknown drag option or MIME item field");
            ok = 0;
        }
        JS_FreeCString(ctx, name);
        if (!ok)
            break;
    }
    JS_FreePropertyEnum(ctx, props, count);
    return ok;
}
static void free_items(PuDragItem *items, size_t count)
{
    for (size_t i = 0; i < count; i++)
    {
        free((void *)items[i].type);
        free((void *)items[i].data);
    }
    free(items);
}
static PuDragItem *read_items(JSContext *ctx, JSValueConst array, size_t *count)
{
    *count = 0;
    if (JS_IsException(array))
        return NULL;
    if (!JS_IsArray(array))
    {
        JS_ThrowTypeError(ctx, "Drag items must be an array");
        return NULL;
    }
    JSValue length = JS_GetPropertyStr(ctx, array, "length");
    uint32_t n;
    int ok = !JS_IsException(length) && JS_ToUint32(ctx, &n, length) == 0;
    JS_FreeValue(ctx, length);
    if (!ok)
        return NULL;
    if (!n || SIZE_MAX / n < sizeof(PuDragItem))
    {
        JS_ThrowRangeError(ctx, "Drag items must be a nonempty representable array");
        return NULL;
    }
    PuDragItem *items = calloc(n, sizeof(*items));
    if (!items)
    {
        JS_ThrowOutOfMemory(ctx);
        return NULL;
    }
    const char *const fields[] = { "type", "data", NULL };
    for (uint32_t i = 0; i < n; i++)
    {
        JSValue item = JS_GetPropertyUint32(ctx, array, i);
        if (JS_IsException(item) || !keys(ctx, item, fields))
        {
            JS_FreeValue(ctx, item);
            goto failed;
        }
        JSValue type_value = JS_GetPropertyStr(ctx, item, "type");
        if (JS_IsException(type_value))
        {
            JS_FreeValue(ctx, item);
            goto failed;
        }
        JSValue data = JS_GetPropertyStr(ctx, item, "data");
        JS_FreeValue(ctx, item);
        if (JS_IsException(data))
        {
            JS_FreeValue(ctx, type_value);
            goto failed;
        }
        size_t type_size = 0;
        const char *type = JS_IsString(type_value) ? JS_ToCStringLen(ctx, &type_size, type_value) : NULL;
        JS_FreeValue(ctx, type_value);
        if (!type || !type_size || memchr(type, 0, type_size))
        {
            JS_FreeCString(ctx, type);
            JS_FreeValue(ctx, data);
            if (!JS_HasException(ctx))
                JS_ThrowTypeError(ctx, "Drag MIME type must be a nonempty string without NUL");
            goto failed;
        }
        char *type_copy = malloc(type_size + 1);
        if (type_copy)
            memcpy(type_copy, type, type_size + 1);
        JS_FreeCString(ctx, type);
        if (!type_copy)
        {
            JS_FreeValue(ctx, data);
            JS_ThrowOutOfMemory(ctx);
            goto failed;
        }
        items[i].type = type_copy;
        *count = i + 1;
        const unsigned char *bytes;
        const char *text = NULL;
        size_t size = 0, storage = 0, offset = 0;
        JSValue buffer = JS_UNDEFINED;
        if (JS_IsString(data))
        {
            if (strcmp(type_copy, "text/plain") && strcmp(type_copy, "text/plain;charset=utf-8"))
            {
                JS_FreeValue(ctx, data);
                JS_ThrowTypeError(ctx, "String drag data requires UTF-8 text/plain");
                goto failed;
            }
            text = JS_ToCStringLen(ctx, &size, data);
            bytes = (const unsigned char *)text;
        }
        else if (JS_IsArrayBuffer(data) || JS_GetTypedArrayType(data) >= 0)
        {
            int direct = JS_IsArrayBuffer(data);
            buffer = direct ? JS_DupValue(ctx, data) : JS_GetTypedArrayBuffer(ctx, data, &offset, &size, NULL);
            bytes = JS_GetArrayBuffer(ctx, &storage, buffer);
            if (direct)
                size = storage;
            if (offset > storage || size > storage - offset)
                bytes = NULL;
            if (bytes)
                bytes += offset;
            else if (!size && !JS_HasException(ctx))
                bytes = (const unsigned char *)"";
        }
        else
        {
            bytes = NULL;
            if (!JS_HasException(ctx))
                JS_ThrowTypeError(ctx, "Drag data must be text, ArrayBuffer or Uint8Array");
        }
        unsigned char *copy = bytes && size != SIZE_MAX ? malloc(size + 1) : NULL;
        if (bytes && size != SIZE_MAX && !copy)
            JS_ThrowOutOfMemory(ctx);
        if (copy)
        {
            if (size)
                memcpy(copy, bytes, size);
            copy[size] = 0;
        }
        JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, buffer);
        JS_FreeValue(ctx, data);
        if (!copy)
        {
            if (!JS_HasException(ctx))
                JS_ThrowTypeError(ctx, "Cannot copy detached or invalid drag data");
            goto failed;
        }
        items[i].data = copy;
        items[i].size = size;
    }
    return items;
failed:
    free_items(items, *count);
    *count = 0;
    return NULL;
}
JSValue pu_drag_js_start(JSContext *ctx, PuBridge *bridge, PuWindow *window, int argc, JSValueConst *argv)
{
    const char *const fields[] = { "input", "items", NULL };
    if (argc != 1 || !keys(ctx, argv[0], fields))
    {
        if (argc != 1)
            JS_ThrowTypeError(ctx, "startDrag requires {input,items}");
        return JS_EXCEPTION;
    }
    JSValue input = JS_GetPropertyStr(ctx, argv[0], "input");
    if (JS_IsException(input))
        return input;
    Credential *credential = JS_GetOpaque2(ctx, input, input_class);
    if (!credential)
    {
        JS_FreeValue(ctx, input);
        return JS_EXCEPTION;
    }
    if (credential->bridge != bridge || !pu_bridge_contains_node(bridge, credential->node))
    {
        JS_FreeValue(ctx, input);
        return JS_ThrowTypeError(ctx, "Drag input belongs to another or detached document");
    }
    JSValue array = JS_GetPropertyStr(ctx, argv[0], "items");
    size_t count;
    PuDragItem *items = read_items(ctx, array, &count);
    JS_FreeValue(ctx, array);
    if (!items)
    {
        JS_FreeValue(ctx, input);
        return JS_EXCEPTION;
    }
    if (credential->bridge != bridge || !pu_bridge_contains_node(bridge, credential->node))
    {
        free_items(items, count);
        JS_FreeValue(ctx, input);
        return JS_ThrowTypeError(ctx, "Drag document detached while evaluating its payload");
    }
    Operation *operation = calloc(1, sizeof(*operation));
    JSValue object = operation ? JS_NewObjectClass(ctx, operation_class) : JS_ThrowOutOfMemory(ctx);
    if (JS_IsException(object))
    {
        free(operation);
        free_items(items, count);
        JS_FreeValue(ctx, input);
        return object;
    }
    JSValue resolving[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving);
    if (JS_IsException(promise))
    {
        JS_FreeValue(ctx, object);
        free(operation);
        free_items(items, count);
        JS_FreeValue(ctx, input);
        return promise;
    }
    operation->ctx = ctx;
    operation->bridge = bridge;
    operation->node = credential->node;
    pu_node_ref(operation->node);
    operation->document = pu_bridge_document(bridge);
    operation->resolve = resolving[0];
    operation->reject = resolving[1];
    /* Native completion owns separate roots outside the wrapper's GC graph:
     * collecting the wrapper cancels, but its already-returned Promise settles. */
    operation->native_document = JS_DupValue(ctx, operation->document);
    operation->native_resolve = JS_DupValue(ctx, operation->resolve);
    operation->native_reject = JS_DupValue(ctx, operation->reject);
    operation->session = pu_window_start_drag(window, credential->input, items, count, complete, operation);
    free_items(items, count);
    JS_FreeValue(ctx, input);
    if (!operation->session)
    {
        JS_FreeValue(ctx, promise);
        JS_FreeValue(ctx, object);
        stop_operation(operation);
        free(operation);
        return JS_ThrowTypeError(ctx, "%s", pu_drag_error());
    }
    operation->next = operations;
    operations = operation;
    JS_SetOpaque(object, operation);
    if (JS_DefinePropertyValueStr(ctx, object, "finished", promise, JS_PROP_ENUMERABLE) < 0)
    {
        JS_FreeValue(ctx, object);
        return JS_EXCEPTION;
    }
    pu_bridge_cancel_mouse(bridge, "native-drag");
    return object;
}
void pu_drag_js_pump(void)
{
    for (Operation *operation = operations; operation; operation = operation->next)
        if (!pu_bridge_contains_node(operation->bridge, operation->node))
            pu_drag_cancel(operation->session);
}
void pu_drag_js_close(PuBridge *bridge)
{
    for (Operation *operation = operations; operation; operation = operation->next)
        if (operation->bridge == bridge)
            pu_drag_cancel(operation->session);
}
void pu_drag_js_shutdown(JSContext *ctx)
{
    while (operations)
    {
        Operation *operation = operations;
        stop_operation(operation);
        if (operation->wrapper_gone)
            free(operation);
    }
    (void)ctx;
}
int pu_drag_js_install(JSContext *ctx)
{
    JSRuntime *runtime = JS_GetRuntime(ctx);
    if (!input_class)
        JS_NewClassID(runtime, &input_class);
    if (!operation_class)
        JS_NewClassID(runtime, &operation_class);
    JSClassDef input = { .class_name = "NativeDragInput", .finalizer = input_finalizer, .gc_mark = input_mark };
    JSClassDef operation = { .class_name = "NativeDrag", .finalizer = operation_finalizer, .gc_mark = operation_mark };
    if (JS_NewClass(runtime, input_class, &input) < 0 || JS_NewClass(runtime, operation_class, &operation) < 0)
        return 0;
    JSValue prototype = JS_NewObject(ctx);
    if (JS_IsException(prototype))
        return 0;
    if (JS_SetPropertyStr(ctx, prototype, "cancel", JS_NewCFunction(ctx, cancel, "cancel", 0)) < 0)
    {
        JS_FreeValue(ctx, prototype);
        return 0;
    }
    JS_SetClassProto(ctx, operation_class, prototype);
    return 1;
}
