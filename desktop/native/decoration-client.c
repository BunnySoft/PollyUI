#include "decoration-client.h"
#include "windows.h"
#include "appearance-config.h"
#include "appearance-document.h"
#include "decoration-frame.h"
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

struct RenderRequest {
    struct RenderRequest *next;
    uint32_t meta[PU_FRAME_META_WORDS];
    char *title, *document;
};
static struct {
    JSContext *ctx;
    JSValue api;
    struct polly_appearance_v1 *appearance;
    struct wl_display *display;
    int (*roundtrip)(struct wl_display *display);
    struct RenderRequest *requests;
    uint32_t serial, reply, phase, accepted, frame_token, frame_revision, frame_status;
    unsigned count;
    bool enabled, enable_reply, frame_reply;
    bool painter, bootstrap, status_changed, stopping;
    uint32_t service_state;
    char service_message[192];
    char error[192];
} renderer;
static int property(JSContext *ctx, JSValueConst object, const char *key, JSValue value)
{ return !JS_IsException(value) && JS_SetPropertyStr(ctx, object, key, value) >= 0; }
static void free_request(struct RenderRequest *request)
{ free(request->title); free(request->document); free(request); }
static void remove_request(uint32_t token)
{
    struct RenderRequest **item = &renderer.requests;
    while (*item) {
        if ((*item)->meta[PU_FRAME_TOKEN] != token) { item = &(*item)->next; continue; }
        struct RenderRequest *old = *item; *item = old->next; free_request(old); renderer.count--;
    }
}
static void prepared(void *data, struct polly_appearance_v1 *appearance, uint32_t serial,
    uint32_t accepted, const char *message)
{
    (void)data; (void)appearance;
    if (serial != renderer.serial) return;
    renderer.reply = serial; renderer.phase = 1; renderer.accepted = accepted;
    snprintf(renderer.error, sizeof(renderer.error), "%s", message);
}
static void applied(void *data, struct polly_appearance_v1 *appearance, uint32_t serial,
    uint32_t accepted, const char *message)
{
    prepared(data, appearance, serial, accepted, message);
    if (serial == renderer.serial) renderer.phase = 2;
}
static void enabled(void *data, struct polly_appearance_v1 *appearance, uint32_t accepted, const char *message)
{
    (void)data; (void)appearance;
    renderer.enable_reply = true; renderer.enabled = accepted == 1;
    snprintf(renderer.error, sizeof(renderer.error), "%s", message);
}
static void requested(void *data, struct polly_appearance_v1 *appearance, struct wl_array *meta,
    const char *title, int32_t document, uint32_t length)
{
    (void)data;
    if (!renderer.enabled) { close(document); return; }
    uint32_t words[PU_FRAME_META_WORDS];
    if (meta->size != sizeof(words)) {
        close(document); fprintf(stderr, "[decoration] Invalid render metadata length\n"); return;
    }
    memcpy(words, meta->data, sizeof(words));
    struct PuFrameStrip strips[PU_FRAME_STRIPS]; uint32_t bytes;
    if (!pu_frame_strips(words, strips, &bytes)) {
        close(document);
        polly_appearance_v1_frame_failed(appearance, words[0], words[1], "Invalid render metadata"); return;
    }
    remove_request(words[0]);
    char *text = pu_appearance_document_read(document, length);
    close(document);
    struct RenderRequest *request = renderer.count < 128 ? calloc(1, sizeof(*request)) : NULL;
    if (!text || !request || !(request->title = strndup(title, 2048))) {
        free(text); free(request);
        polly_appearance_v1_frame_failed(appearance, words[0], words[1], "Cannot queue GUI render request");
        fprintf(stderr, "[decoration] Cannot retain bounded render request\n"); return;
    }
    request->document = text; memcpy(request->meta, words, sizeof(words));
    request->next = renderer.requests; renderer.requests = request; renderer.count++;
}
static void frame_result(void *data, struct polly_appearance_v1 *appearance, uint32_t token,
    uint32_t revision, uint32_t status, const char *message)
{
    (void)data; (void)appearance;
    if (token != renderer.frame_token || revision != renderer.frame_revision) return;
    renderer.frame_reply = true; renderer.frame_status = status;
    snprintf(renderer.error, sizeof(renderer.error), "%s", message);
}
static void closed(void *data, struct polly_appearance_v1 *appearance, uint32_t token)
{ (void)data; (void)appearance; remove_request(token); }
static void service_status(void *data, struct polly_appearance_v1 *appearance,
    uint32_t state, uint32_t bootstrap, const char *message)
{
    (void)data; (void)appearance;
    renderer.service_state = state; renderer.bootstrap = bootstrap == 1;
    snprintf(renderer.service_message, sizeof(renderer.service_message), "%s", message);
    renderer.status_changed = true;
}
const struct polly_appearance_v1_listener pu_decoration_client_listener = {
    .prepared = prepared, .applied = applied, .renderer_enabled = enabled,
    .render_request = requested, .frame_result = frame_result, .render_cancelled = closed,
    .renderer_status = service_status,
};
void pu_decoration_client_attach(struct polly_appearance_v1 *appearance, struct wl_display *display,
    int (*roundtrip)(struct wl_display *display))
{ renderer.appearance = appearance; renderer.display = display; renderer.roundtrip = roundtrip; }
uint32_t pu_decoration_client_status(bool *bootstrap, const char **message)
{
    if (bootstrap) *bootstrap = renderer.bootstrap;
    if (message) *message = renderer.service_message;
    return renderer.service_state;
}
static bool read_integer(JSContext *ctx, JSValueConst value, uint32_t *word)
{
    double number;
    if (!JS_IsNumber(value) || JS_ToFloat64(ctx, &number, value) || !isfinite(number) ||
        number < 0 || number > UINT32_MAX || floor(number) != number) return false;
    *word = (uint32_t)number;
    return true;
}
static bool read_words(JSContext *ctx, JSValueConst array, uint32_t *words, unsigned count)
{
    JSValue length = JS_GetPropertyStr(ctx, array, "length");
    uint32_t size = 0;
    bool valid = JS_IsArray(array) && !JS_IsException(length) && !JS_ToUint32(ctx, &size, length) && size == count;
    JS_FreeValue(ctx, length);
    for (unsigned i = 0; valid && i < count; i++) {
        JSValue value = JS_GetPropertyUint32(ctx, array, i);
        valid = read_integer(ctx, value, &words[i]);
        JS_FreeValue(ctx, value);
    }
    if (!valid && !JS_HasException(ctx)) JS_ThrowTypeError(ctx, "A bounded integer metadata array is required");
    return valid;
}
static JSValue requests(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    JSValue list = JS_NewArray(ctx); unsigned index = 0;
    if (JS_IsException(list)) return list;
    while (renderer.requests) {
        struct RenderRequest *request = renderer.requests;
        JSValue item = JS_NewObject(ctx), meta = JS_NewArray(ctx);
        bool valid = !JS_IsException(item) && !JS_IsException(meta);
        for (unsigned i = 0; valid && i < PU_FRAME_META_WORDS; i++)
            valid = JS_SetPropertyUint32(ctx, meta, i, JS_NewUint32(ctx, request->meta[i])) >= 0;
        if (valid) valid = property(ctx, item, "meta", JS_DupValue(ctx, meta)) &&
            property(ctx, item, "title", JS_NewString(ctx, request->title)) &&
            property(ctx, item, "document", JS_NewString(ctx, request->document));
        JS_FreeValue(ctx, meta);
        if (!valid || JS_SetPropertyUint32(ctx, list, index++, JS_DupValue(ctx, item)) < 0) {
            JS_FreeValue(ctx, item); JS_FreeValue(ctx, list); return JS_EXCEPTION;
        }
        JS_FreeValue(ctx, item);
        renderer.requests = request->next; renderer.count--; free_request(request);
    }
    return list;
}
static JSValue submit(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (renderer.stopping) return JS_NewBool(ctx, false);
    uint32_t meta[PU_FRAME_META_WORDS], bytes;
    struct PuFrameStrip strips[PU_FRAME_STRIPS];
    if (!renderer.enabled || !renderer.appearance || argc != 2)
        return JS_ThrowTypeError(ctx, "A paired GUI renderer and complete frame are required");
    if (!read_words(ctx, argv[0], meta, PU_FRAME_META_WORDS)) return JS_EXCEPTION;
    if (!pu_frame_strips(meta, strips, &bytes)) return JS_ThrowRangeError(ctx, "Invalid frame metadata");
    const uint8_t *pixels[PU_FRAME_STRIPS] = {0}; size_t lengths[PU_FRAME_STRIPS] = {0};
    JSValue buffers[PU_FRAME_STRIPS] = {JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED};
    bool valid = JS_IsArray(argv[1]);
    JSValue length_value = JS_GetPropertyStr(ctx, argv[1], "length"); uint32_t count;
    valid = valid && !JS_IsException(length_value) && !JS_ToUint32(ctx, &count, length_value) && count == PU_FRAME_STRIPS;
    JS_FreeValue(ctx, length_value);
    for (unsigned i = 0; valid && i < PU_FRAME_STRIPS; i++) {
        JSValue image = JS_GetPropertyUint32(ctx, argv[1], i);
        JSValue width = JS_GetPropertyStr(ctx, image, "width"), height = JS_GetPropertyStr(ctx, image, "height");
        JSValue data = JS_GetPropertyStr(ctx, image, "data");
        uint32_t w, h; size_t offset = 0, length = 0, element = 0, backing = 0;
        valid = !JS_IsException(image) && !JS_IsException(data) &&
            read_integer(ctx, width, &w) && read_integer(ctx, height, &h) &&
            w == strips[i].width && h == strips[i].height;
        if (valid) {
            buffers[i] = JS_GetTypedArrayBuffer(ctx, data, &offset, &length, &element);
            uint8_t *base = JS_IsException(buffers[i]) ? NULL : JS_GetArrayBuffer(ctx, &backing, buffers[i]);
            valid = !JS_IsException(buffers[i]) && !JS_HasException(ctx) && (!length || base) &&
                element == 1 && length == (size_t)w * h * 4 && offset <= backing && length <= backing - offset;
            if (valid) { pixels[i] = length ? base + offset : NULL; lengths[i] = length; }
        }
        JS_FreeValue(ctx, image); JS_FreeValue(ctx, width); JS_FreeValue(ctx, height); JS_FreeValue(ctx, data);
    }
    int fd = valid ? pu_frame_create(meta, pixels, lengths, &bytes) : -1;
    for (unsigned i = 0; i < PU_FRAME_STRIPS; i++) JS_FreeValue(ctx, buffers[i]);
    if (!valid) return JS_HasException(ctx) ? JS_EXCEPTION : JS_ThrowTypeError(ctx, "Four exact RGBA strip images are required");
    if (fd < 0) return JS_ThrowInternalError(ctx, "Cannot seal GUI frame: %s", strerror(errno));
    renderer.frame_token = meta[0]; renderer.frame_revision = meta[1]; renderer.frame_reply = false;
    polly_appearance_v1_submit_frame(renderer.appearance, meta[0], meta[1], fd, bytes);
    close(fd);
    if (!renderer.roundtrip(renderer.display) || !renderer.frame_reply) {
        if (renderer.stopping) return JS_NewBool(ctx, false);
        return JS_ThrowInternalError(ctx, "GUI frame submission was not acknowledged");
    }
    if (renderer.frame_status > 1)
        return JS_ThrowInternalError(ctx, "GUI frame rejected: %s", renderer.error);
    return JS_NewBool(ctx, renderer.frame_status == 0);
}
static JSValue stop_renderer(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    bool failed = false;
    if (renderer.enabled && renderer.appearance) {
        polly_appearance_v1_disable_renderer(renderer.appearance);
        failed = wl_display_flush(renderer.display) < 0 && errno != EAGAIN && errno != EINTR;
    }
    pu_decoration_client_disconnect();
    return failed ? JS_ThrowInternalError(ctx, "Cannot stop GUI decoration renderer") : JS_UNDEFINED;
}
static JSValue fail_frame(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; uint32_t meta[PU_FRAME_META_WORDS];
    if (renderer.stopping) return JS_UNDEFINED;
    if (!renderer.enabled || argc != 2) return JS_ThrowTypeError(ctx, "An active render request is required");
    if (!read_words(ctx, argv[0], meta, PU_FRAME_META_WORDS)) return JS_EXCEPTION;
    const char *message = JS_ToCString(ctx, argv[1]);
    if (!message) return JS_EXCEPTION;
    char bounded[192]; snprintf(bounded, sizeof(bounded), "%s", message); JS_FreeCString(ctx, message);
    polly_appearance_v1_frame_failed(renderer.appearance, meta[0], meta[1], bounded);
    if (wl_display_flush(renderer.display) < 0 && errno != EAGAIN && errno != EINTR)
        return JS_ThrowInternalError(ctx, "Cannot report GUI decoration failure");
    return JS_UNDEFINED;
}
static JSValue start_renderer(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!renderer.painter || !renderer.appearance || !renderer.roundtrip)
        return JS_ThrowTypeError(ctx, "A private decorator connection is required");
    renderer.enable_reply = false;
    polly_appearance_v1_enable_renderer(renderer.appearance);
    if (!renderer.roundtrip(renderer.display) || !renderer.enable_reply || !renderer.enabled)
        return JS_ThrowInternalError(ctx, "Cannot enable independent renderer: %s", renderer.error);
    return JS_UNDEFINED;
}
static JSValue get_status(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    JSValue result = JS_NewObject(ctx);
    if (JS_IsException(result)) return result;
    if (!property(ctx, result, "state", JS_NewUint32(ctx, renderer.service_state)) ||
        !property(ctx, result, "bootstrap", JS_NewBool(ctx, renderer.bootstrap)) ||
        !property(ctx, result, "message", JS_NewString(ctx, renderer.service_message))) {
        JS_FreeValue(ctx, result); return JS_EXCEPTION;
    }
    return result;
}
JSValue pu_decoration_client_configure(JSContext *ctx, int argc, JSValueConst *argv,
    struct polly_appearance_v1 *appearance, struct wl_display *display)
{
    uint32_t words[PU_APPEARANCE_WORDS]; struct PuDecorationLayout layout;
    if (renderer.stopping) return JS_NewBool(ctx, false);
    if (argc != 2 || !JS_IsObject(argv[0])) return JS_ThrowTypeError(ctx, "A theme and paired GUI layout are required");
    if (!read_words(ctx, argv[1], words, PU_APPEARANCE_WORDS)) return JS_EXCEPTION;
    if (!pu_appearance_decode(&layout, words)) return JS_ThrowRangeError(ctx, "Invalid decoration geometry");
    if (!appearance || polly_appearance_v1_get_version(appearance) < 5)
        return JS_ThrowTypeError(ctx, "GUI decorations require paired PollyWM/Shell/decorator appearance v5");
    renderer.appearance = appearance; renderer.display = display;
    if (!renderer.roundtrip) renderer.roundtrip = pu_desktop_wayland_roundtrip;
    JSValue id = JS_GetPropertyStr(ctx, argv[0], "id"), envelope = JS_NewObject(ctx), serialized = JS_UNDEFINED;
    size_t id_length = 0;
    const char *name = JS_IsString(id) ? JS_ToCStringLen(ctx, &id_length, id) : NULL, *document = NULL;
    int fd = -1; size_t length = 0;
    if (!name || strlen(name) != id_length || !pu_appearance_identifier(name)) {
        JS_ThrowTypeError(ctx, "Invalid appearance identity"); goto failure;
    }
    if (JS_IsException(envelope) || !property(ctx, envelope, "schemaVersion", JS_NewInt32(ctx, 1)) ||
        !property(ctx, envelope, "theme", JS_DupValue(ctx, argv[0]))) goto failure;
    serialized = JS_JSONStringify(ctx, envelope, JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(serialized) || !(document = JS_ToCStringLen(ctx, &length, serialized))) goto failure;
    if (!length || length > PU_APPEARANCE_DOCUMENT_LIMIT || strlen(document) != length || renderer.serial == UINT32_MAX) {
        JS_ThrowRangeError(ctx, "Appearance snapshot or serial exceeds supported bounds"); goto failure;
    }
    fd = pu_appearance_document_create(document, length);
    if (fd < 0) { JS_ThrowInternalError(ctx, "Cannot seal theme snapshot: %s", strerror(errno)); goto failure; }
    uint32_t serial = ++renderer.serial;
    struct wl_array configuration = {.size = sizeof(words), .alloc = sizeof(words), .data = words};
    renderer.reply = renderer.phase = renderer.accepted = 0; renderer.error[0] = 0;
    polly_appearance_v1_prepare(appearance, serial, name, &configuration, fd, (uint32_t)length);
    close(fd); fd = -1;
    if (!renderer.roundtrip(display) || renderer.reply != serial || renderer.phase != 1 || renderer.accepted != 1) {
        if (renderer.stopping) goto obsolete;
        polly_appearance_v1_cancel(appearance, serial);
        if (renderer.painter && renderer.reply == serial && renderer.phase == 1 &&
            !renderer.accepted && !renderer.bootstrap) goto obsolete;
        JS_ThrowInternalError(ctx, "GUI appearance preparation failed: %s", renderer.error); goto failure;
    }
    renderer.phase = 0; polly_appearance_v1_commit(appearance, serial);
    if (!renderer.roundtrip(display) || renderer.reply != serial || renderer.phase != 2 || renderer.accepted != 1) {
        if (renderer.stopping) goto obsolete;
        if (renderer.painter && renderer.reply == serial && renderer.phase == 2 &&
            !renderer.accepted && !renderer.bootstrap) goto obsolete;
        JS_ThrowInternalError(ctx, "Cannot confirm GUI appearance commit: %s", renderer.error); goto failure;
    }
    JS_FreeCString(ctx, name); JS_FreeCString(ctx, document);
    JS_FreeValue(ctx, id); JS_FreeValue(ctx, envelope); JS_FreeValue(ctx, serialized);
    return renderer.painter ? JS_NewBool(ctx, true) : JS_UNDEFINED;
obsolete:
    JS_FreeCString(ctx, name); JS_FreeCString(ctx, document);
    JS_FreeValue(ctx, id); JS_FreeValue(ctx, envelope); JS_FreeValue(ctx, serialized);
    return JS_NewBool(ctx, false);
failure:
    if (fd >= 0) close(fd);
    JS_FreeCString(ctx, name); JS_FreeCString(ctx, document);
    JS_FreeValue(ctx, id); JS_FreeValue(ctx, envelope); JS_FreeValue(ctx, serialized);
    return JS_EXCEPTION;
}
int pu_decoration_client_install(JSContext *ctx, JSValueConst api)
{
    renderer.ctx = ctx; renderer.api = JS_DupValue(ctx, api);
    return 1;
}
int pu_decoration_renderer_install(JSContext *ctx, JSValueConst api)
{
    if (!pu_decoration_client_install(ctx, api)) return 0;
    renderer.painter = true;
    return property(ctx, api, "decorationRequests", JS_NewCFunction(ctx, requests, "decorationRequests", 0)) &&
        property(ctx, api, "submitDecorationFrame", JS_NewCFunction(ctx, submit, "submitDecorationFrame", 2)) &&
        property(ctx, api, "failDecorationFrame", JS_NewCFunction(ctx, fail_frame, "failDecorationFrame", 2)) &&
        property(ctx, api, "stopDecorationRenderer", JS_NewCFunction(ctx, stop_renderer, "stopDecorationRenderer", 0)) &&
        property(ctx, api, "startDecorationRenderer", JS_NewCFunction(ctx, start_renderer, "startDecorationRenderer", 0)) &&
        property(ctx, api, "decorationStatus", JS_NewCFunction(ctx, get_status, "decorationStatus", 0)) &&
        property(ctx, api, "onDecorationRequestsChanged", JS_NULL) &&
        property(ctx, api, "onDecorationStatusChanged", JS_NULL);
}
static int notify(const char *name)
{
    JSValue callback = JS_GetPropertyStr(renderer.ctx, renderer.api, name), result = JS_UNDEFINED;
    if (JS_IsException(callback)) result = JS_EXCEPTION;
    else if (JS_IsFunction(renderer.ctx, callback)) result = JS_Call(renderer.ctx, callback, renderer.api, 0, NULL);
    bool failed = JS_IsException(result);
    if (failed) {
        JSValue error = JS_GetException(renderer.ctx);
        const char *message = JS_ToCString(renderer.ctx, error);
        fprintf(stderr, "[decoration] GUI callback failed: %s\n", message ? message : "unknown");
        JS_FreeCString(renderer.ctx, message); JS_FreeValue(renderer.ctx, error);
    }
    JS_FreeValue(renderer.ctx, callback); JS_FreeValue(renderer.ctx, result);
    return failed ? -1 : 1;
}
int pu_decoration_client_pump(void)
{
    if (!renderer.ctx || !renderer.painter || renderer.stopping) return 0;
    int work = 0;
    if (renderer.status_changed) {
        renderer.status_changed = false;
        work = notify("onDecorationStatusChanged");
        if (work < 0) return work;
    }
    if (renderer.requests) return notify("onDecorationRequestsChanged");
    return work;
}
bool pu_decoration_client_pending(void)
{ return renderer.painter && !renderer.stopping && (renderer.requests || renderer.status_changed); }
void pu_decoration_client_cancel_requests(void)
{
    renderer.stopping = true;
    renderer.enabled = false;
    while (renderer.requests) {
        struct RenderRequest *request = renderer.requests;
        renderer.requests = request->next; free_request(request);
    }
    renderer.count = 0;
}
void pu_decoration_client_disconnect(void)
{
    while (renderer.requests) {
        struct RenderRequest *request = renderer.requests; renderer.requests = request->next; free_request(request);
    }
    renderer.count = 0; renderer.enabled = false; renderer.appearance = NULL; renderer.display = NULL;
    renderer.roundtrip = NULL;
}
void pu_decoration_client_shutdown(void)
{
    pu_decoration_client_disconnect();
    if (renderer.ctx) JS_FreeValue(renderer.ctx, renderer.api);
    memset(&renderer, 0, sizeof(renderer));
}
