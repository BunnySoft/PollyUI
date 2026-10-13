#include "bridge/media.h"
#include "bridge/image_file.h"
#include "bridge/webgl.h"
#include "canvas-script.h"
#include "layout/layout.h"
#include "render/canvas_c.h"
#include "render/color.h"
#include "script/script.h"
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static JSClassID resource_class, canvas_prototype_class, image_prototype_class;
static uint64_t image_serial;
static void resource_finalizer(JSRuntime *rt, JSValueConst value)
{
    (void)rt;
    pu_canvas_resource_destroy(JS_GetOpaque(value, resource_class));
}
static JSValue resource_value(JSContext *ctx, PuCanvasResource *resource)
{
    if (!resource)
        return JS_ThrowOutOfMemory(ctx);
    JSValue value = JS_NewObjectClass(ctx, resource_class);
    if (JS_IsException(value))
        pu_canvas_resource_destroy(resource);
    else
        JS_SetOpaque(value, resource);
    return value;
}
static JSValue numbers(JSContext *ctx, const double *values, size_t count)
{
    JSValue result = JS_NewArray(ctx);
    for (size_t i = 0; i < count && !JS_HasException(ctx); ++i)
        JS_SetPropertyUint32(ctx, result, (uint32_t)i, JS_NewFloat64(ctx, values[i]));
    if (JS_HasException(ctx)) {
        JS_FreeValue(ctx, result);
        return JS_EXCEPTION;
    }
    return result;
}
static int dimensions(double w, double h)
{
    return isfinite(w) && isfinite(h) && w >= 0 && h >= 0 && w <= INT32_MAX && h <= INT32_MAX &&
           floor(w) == w && floor(h) == h && (!h || w <= PU_CANVAS_PIXEL_LIMIT / h);
}
static JSValue native_media(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc != 5)
        return JS_ThrowTypeError(ctx, "Invalid media operation");
    if (!JS_IsString(argv[1]) || !JS_IsString(argv[3]))
        return JS_ThrowTypeError(ctx, "Invalid media command");
    const char *op = JS_ToCString(ctx, argv[1]);
    size_t text_length = 0;
    const char *text = JS_ToCStringLen(ctx, &text_length, argv[3]);
    if (!op || !text) {
        JS_FreeCString(ctx, op);
        JS_FreeCString(ctx, text);
        return JS_EXCEPTION;
    }
    JSValue result = JS_UNDEFINED, buffer = JS_UNDEFINED;
    size_t offset = 0, length = 0, total = 0;
    double args[4096];
    size_t count = 0;
    if (!JS_IsNull(argv[2])) {
        if (JS_GetTypedArrayType(argv[2]) != JS_TYPED_ARRAY_FLOAT64) {
            result = JS_ThrowTypeError(ctx, "Invalid media arguments");
            goto done;
        }
        buffer = JS_GetTypedArrayBuffer(ctx, argv[2], &offset, &length, NULL);
        if (JS_IsException(buffer)) {
            result = JS_EXCEPTION;
            goto done;
        }
        uint8_t *bytes = JS_GetArrayBuffer(ctx, &total, buffer);
        if (!bytes || offset > total || length > total - offset || length > sizeof(args) ||
            length % sizeof(double)) {
            result = JS_ThrowRangeError(ctx, "Invalid media argument buffer");
            goto done;
        }
        count = length / sizeof(double);
        memcpy(args, bytes + offset, length);
        for (size_t i = 0; i < count; ++i)
            if (!isfinite(args[i])) {
                result = JS_ThrowTypeError(ctx, "Non-finite media argument");
                goto done;
            }
    }
    if (!strcmp(op, "alive")) {
        result = JS_NewBool(ctx, JS_GetRuntimeOpaque(JS_GetRuntime(ctx)) != NULL);
        goto done;
    }
    if (!JS_GetRuntimeOpaque(JS_GetRuntime(ctx))) {
        result = JS_ThrowTypeError(ctx, "GUI media scope is closed");
        goto done;
    }
    if (!strcmp(op, "namedColor")) {
        uint8_t rgba[4];
        if (pu_color_named(text, rgba)) {
            double color[] = {rgba[0], rgba[1], rgba[2], rgba[3]};
            result = numbers(ctx, color, 4);
        } else
            result = JS_NULL;
        goto done;
    }
    PuNode *node = pu_bridge_node(argv[0]);
    PuCanvasResource *target = JS_GetOpaque(argv[0], resource_class);
    PuCanvasResource *resource = JS_GetOpaque(argv[4], resource_class);
    if (node && !strcmp(op, "state")) {
        if (!JS_IsNull(argv[4])) {
            JS_FreeValue(ctx, node->media_state);
            node->media_state = JS_DupValue(ctx, argv[4]);
            node->media_runtime = JS_GetRuntime(ctx);
        }
        result = JS_DupValue(ctx, node->media_state);
        goto done;
    }
    if (node && !strcmp(op, "event")) {
        if (strcmp(text, "load") && strcmp(text, "error") &&
            strcmp(text, "webglcontextlost") && strcmp(text, "webglcontextrestored") &&
            strcmp(text, "webglcontextcreationerror")) {
            result = JS_ThrowTypeError(ctx, "Invalid image event");
            goto done;
        }
        if(JS_IsString(argv[4])){
            const char *status=JS_ToCString(ctx,argv[4]);
            if(!status){result=JS_EXCEPTION;goto done;}
            result=JS_NewBool(ctx,pu_bridge_media_event_status(ctx,node,text,status));
            JS_FreeCString(ctx,status);
        }else result = JS_NewBool(ctx, pu_bridge_media_event(ctx, node, text));
        goto done;
    }
    if (node && !strcmp(op, "layout")) {
        pu_layout_mark_dirty();
        pu_node_mark_paint_dirty(node);
        goto done;
    }
    if (node && !strcmp(op, "direction")) {
        const char *direction = NULL;
        for (PuNode *n = node; n; n = n->parent) {
            direction = pu_style_get(&n->style, "direction");
            if (direction && (!strcmp(direction, "ltr") || !strcmp(direction, "rtl")))
                break;
            direction = NULL;
        }
        result = JS_NewString(ctx, direction ? direction : "ltr");
        goto done;
    }
    if (!strcmp(op, "path") || !strcmp(op, "linear") || !strcmp(op, "radial") ||
        !strcmp(op, "pattern")) {
        if ((!strcmp(op, "path") && resource == NULL && text_length &&
             memchr(text, 0, text_length)) ||
            (strcmp(op, "path") && strcmp(op, "pattern") &&
             count != (!strcmp(op, "linear") ? 10u : 12u))) {
            result = JS_ThrowTypeError(ctx, "Invalid media resource");
            goto done;
        }
        PuCanvasResource *created = pu_canvas_resource(op, args, count, text, resource);
        result = created ? resource_value(ctx, created)
                         : JS_ThrowTypeError(ctx, "Cannot create canvas resource");
        goto done;
    }
    if (!strcmp(op, "snapshot")) {
        const char *key = node ? node->image_key : pu_bridge_bitmap_key(argv[0]);
        PuCanvasResource *snapshot = node && node->canvas ? pu_canvas_snapshot(node->canvas)
                                     : key                ? pu_canvas_image(key)
                                                          : NULL;
        result = snapshot ? resource_value(ctx, snapshot) : JS_NULL;
        goto done;
    }
    if (!strcmp(op, "sourcePixels")) {
        if (!resource || count != 2 || !dimensions(args[0], args[1])) {
            result = JS_ThrowTypeError(ctx, "Invalid image snapshot");
            goto done;
        }
        size_t size = (size_t)args[0] * (size_t)args[1] * 4;
        uint8_t *bytes = malloc(size ? size : 1);
        if (!bytes) { result = JS_ThrowOutOfMemory(ctx); goto done; }
        result = pu_canvas_resource_read(resource, (int)args[0], (int)args[1], bytes) ?
            JS_NewArrayBufferCopy(ctx, bytes, size) : JS_ThrowTypeError(ctx, "Cannot read image snapshot");
        free(bytes);
        goto done;
    }
    if (node && node->tag && !strcmp(node->tag, "img")) {
        if (!strcmp(op, "displaySize")) {
            PuNode *root = node;
            while (root->parent)
                root = root->parent;
            const char *display = pu_style_get(&node->style, "display");
            if (node->parent && root->layout_view_width > 0 && root->layout_view_height > 0 &&
                (!display || strcmp(display, "none"))) {
                pu_layout_calculate(root, root->layout_view_width, root->layout_view_height);
                double size[] = {node->layout_w, node->layout_h};
                result = numbers(ctx, size, 2);
            } else
                result = JS_NULL;
            goto done;
        }
        if (!strcmp(op, "resolve")) {
            if (memchr(text, 0, text_length)) {
                result = JS_ThrowTypeError(ctx, "Invalid local image path");
                goto done;
            }
            char *path = pu_script_resource_path(JS_GetContextOpaque(ctx), text);
            char *absolute = path ? pu_image_absolute_path(path) : NULL;
            free(path);
            result = absolute ? JS_NewString(ctx, absolute)
                              : JS_ThrowTypeError(ctx, "Invalid or remote local image path");
            free(absolute);
            goto done;
        }
        if (!strcmp(op, "imageSize")) {
            double size[] = {node->image_width, node->image_height};
            result = numbers(ctx, size, 2);
            goto done;
        }
        if (!strcmp(op, "clearImage") || !strcmp(op, "load")) {
            if (node->image_key)
                pu_image_remove(node->image_key);
            free(node->image_key);
            node->image_key = NULL;
            node->image_width = node->image_height = 0;
            pu_node_mark_paint_dirty(node);
            pu_layout_mark_dirty();
            if (!strcmp(op, "clearImage"))
                goto done;
            size_t bytes_length = 0;
            uint8_t *bytes =
                JS_IsArrayBuffer(argv[4]) ? JS_GetArrayBuffer(ctx, &bytes_length, argv[4]) : NULL;
            uint8_t *owned = NULL;
            if (!bytes && !JS_IsNull(argv[4])) {
                result = JS_ThrowTypeError(ctx, "Invalid image bytes");
                goto done;
            }
            if (!bytes) {
                if (memchr(text, 0, text_length) || strstr(text, "://") ||
                    !strncmp(text, "data:", 5) || !strncmp(text, "file:", 5)) {
                    result = JS_ThrowTypeError(ctx, "Unsupported image source");
                    goto done;
                }
                if (!pu_image_read_file(text, &owned, &bytes_length)) {
                    result = JS_ThrowTypeError(ctx, "Cannot read bounded regular image file");
                    goto done;
                }
                bytes = owned;
            }
            if (!bytes_length || bytes_length > PU_IMAGE_BYTE_LIMIT || image_serial == UINT64_MAX) {
                free(owned);
                result = JS_ThrowRangeError(ctx, "Invalid image resource size");
                goto done;
            }
            char key[64];
            snprintf(key, sizeof(key), "polly-memory:html-image-%" PRIu64, ++image_serial);
            int ok = pu_image_set_bitmap(key, bytes, bytes_length, PU_CANVAS_PIXEL_LIMIT,
                                         &node->image_width, &node->image_height);
            free(owned);
            if (!ok) {
                result =
                    JS_ThrowTypeError(ctx, "Cannot decode PNG/JPEG image within safety limits");
                goto done;
            }
            node->image_key = malloc(strlen(key) + 1);
            if (!node->image_key) {
                pu_image_remove(key);
                node->image_width = node->image_height = 0;
                result = JS_ThrowOutOfMemory(ctx);
                goto done;
            }
            strcpy(node->image_key, key);
            double size[] = {node->image_width, node->image_height};
            result = numbers(ctx, size, 2);
            goto done;
        }
    }
    if (node) {
        if (!node->tag || strcmp(node->tag, "canvas")) {
            result = JS_ThrowTypeError(ctx, "Expected a canvas");
            goto done;
        }
        if (!node->canvas)
            node->canvas = pu_canvas_create(300, 150);
        if (!node->canvas) {
            result = JS_ThrowOutOfMemory(ctx);
            goto done;
        }
        if (!strcmp(op, "size")) {
            double size[] = {pu_canvas_width(node->canvas), pu_canvas_height(node->canvas)};
            result = numbers(ctx, size, 2);
            goto done;
        }
        if (!strcmp(op, "alpha") && count == 1) {
            double alpha[] = {args[0]};
            size_t unused = 0;
            if (!pu_canvas_command(node->canvas, NULL, "alpha", alpha, 1, "", 0, NULL, alpha,
                                   &unused))
                result = JS_ThrowOutOfMemory(ctx);
            else
                pu_node_mark_paint_dirty(node);
            goto done;
        }
        if (!strcmp(op, "resize")) {
            if (count != 2 || !dimensions(args[0], args[1])) {
                result = JS_ThrowRangeError(ctx, "Canvas backing store exceeds safety limits");
                goto done;
            }
            if (!pu_canvas_resize(node->canvas, (int)args[0], (int)args[1])) {
                result = JS_ThrowOutOfMemory(ctx);
                goto done;
            }
            pu_layout_mark_dirty();
            pu_node_mark_paint_dirty(node);
            goto done;
        }
        if (!strcmp(op, "pixels")) {
            if (count != 4 || !dimensions(args[2], args[3]) || args[0] < INT32_MIN ||
                args[0] > INT32_MAX || args[1] < INT32_MIN || args[1] > INT32_MAX) {
                result = JS_ThrowRangeError(ctx, "Invalid pixel rectangle");
                goto done;
            }
            size_t size = (size_t)args[2] * (size_t)args[3] * 4;
            uint8_t *bytes = malloc(size ? size : 1);
            if (!bytes) {
                result = JS_ThrowOutOfMemory(ctx);
                goto done;
            }
            int ok = pu_canvas_read(node->canvas, (int)args[0], (int)args[1], (int)args[2],
                                    (int)args[3], bytes);
            result = ok ? JS_NewArrayBufferCopy(ctx, bytes, size)
                        : JS_ThrowInternalError(ctx, "Cannot read canvas pixels");
            free(bytes);
            goto done;
        }
        if (!strcmp(op, "put")) {
            size_t size = 0;
            uint8_t *bytes =
                JS_IsArrayBuffer(argv[4]) ? JS_GetArrayBuffer(ctx, &size, argv[4]) : NULL;
            if (count != 8 || !dimensions(args[0], args[1]) || !bytes ||
                size != (size_t)args[0] * (size_t)args[1] * 4) {
                result = JS_ThrowTypeError(ctx, "Invalid RGBA8 pixel buffer");
                goto done;
            }
            for (size_t i = 2; i < 8; ++i)
                if (args[i] < INT32_MIN || args[i] > INT32_MAX) {
                    result = JS_ThrowRangeError(ctx, "Invalid pixel coordinate");
                    goto done;
                }
            if (!pu_canvas_write(node->canvas, (int)args[0], (int)args[1], bytes, (int)args[2],
                                 (int)args[3], (int)args[4], (int)args[5], (int)args[6],
                                 (int)args[7]))
                result = JS_ThrowInternalError(ctx, "Cannot write canvas pixels");
            else
                pu_node_mark_paint_dirty(node);
            goto done;
        }
        if (!strcmp(op, "encode")) {
            uint8_t *bytes = NULL;
            size_t size = 0;
            if (count != 2) {
                result = JS_ThrowTypeError(ctx, "Invalid canvas encoding");
                goto done;
            }
            if (!pu_canvas_encode(node->canvas, args[0] != 0, args[1], &bytes, &size))
                result = JS_ThrowInternalError(ctx, "Cannot encode canvas");
            else
                result = JS_NewArrayBufferCopy(ctx, bytes, size);
            pu_canvas_bytes_free(bytes);
            goto done;
        }
    }
    if ((!node && !target) || ((!strcmp(op, "text") || !strcmp(op, "measure")) &&
                               (!memchr(text, 0, text_length) || text_length > 1024 * 1024))) {
        result = JS_ThrowTypeError(ctx, "Invalid canvas target or text");
        goto done;
    }
    double values[16];
    size_t value_count;
    int ok = pu_canvas_command(node ? node->canvas : NULL, target, op, args, count, text,
                               text_length, resource, values, &value_count);
    if (ok < 0)
        result = JS_ThrowTypeError(ctx, "Invalid canvas operation");
    else if (!ok)
        result = JS_ThrowOutOfMemory(ctx);
    else if (value_count)
        result = numbers(ctx, values, value_count);
    if (node && ok > 0 &&
        (!strcmp(op, "fill") || !strcmp(op, "stroke") || !strcmp(op, "fillRect") ||
         !strcmp(op, "strokeRect") || !strcmp(op, "clearRect") || !strcmp(op, "image") ||
         !strcmp(op, "text")))
        pu_node_mark_paint_dirty(node);
done:
    JS_FreeValue(ctx, buffer);
    JS_FreeCString(ctx, op);
    JS_FreeCString(ctx, text);
    return result;
}
int pu_media_install(JSContext *ctx, JSValueConst node_proto)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    if (!resource_class)
        JS_NewClassID(rt, &resource_class);
    if (!canvas_prototype_class)
        JS_NewClassID(rt, &canvas_prototype_class);
    if (!image_prototype_class)
        JS_NewClassID(rt, &image_prototype_class);
    JSClassDef resource_def = {"CanvasResource", .finalizer = resource_finalizer};
    JSClassDef canvas_def = {"HTMLCanvasElement"}, image_def = {"HTMLImageElement"};
    if (JS_NewClass(rt, resource_class, &resource_def) < 0 ||
        JS_NewClass(rt, canvas_prototype_class, &canvas_def) < 0 ||
        JS_NewClass(rt, image_prototype_class, &image_def) < 0)
        return -1;
    JSValue installer = JS_Eval(ctx, (const char *)pu_canvas_script, sizeof(pu_canvas_script) - 1,
                                "polly:canvas", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(installer))
        return -1;
    JSValue args[] = {JS_NewCFunction(ctx, native_media, "media", 5), JS_DupValue(ctx, node_proto),
        pu_webgl_factory(ctx)};
    JSValue protos = JS_IsException(args[2]) ? JS_EXCEPTION :
        JS_Call(ctx, installer, JS_UNDEFINED, 3, args);
    JS_FreeValue(ctx, installer);
    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, args[1]);
    JS_FreeValue(ctx, args[2]);
    if (JS_IsException(protos))
        return -1;
    JS_SetClassProto(ctx, canvas_prototype_class, JS_GetPropertyUint32(ctx, protos, 0));
    JS_SetClassProto(ctx, image_prototype_class, JS_GetPropertyUint32(ctx, protos, 1));
    JS_FreeValue(ctx, protos);
    return JS_HasException(ctx) ? -1 : 0;
}
int pu_media_prototype(JSContext *ctx, JSValueConst object, const char *tag)
{
    JSClassID id = tag && !strcmp(tag, "canvas") ? canvas_prototype_class
                   : tag && !strcmp(tag, "img")  ? image_prototype_class
                                                 : 0;
    if (!id)
        return 0;
    JSValue proto = JS_GetClassProto(ctx, id);
    int result = JS_SetPrototype(ctx, object, proto);
    JS_FreeValue(ctx, proto);
    return result;
}
