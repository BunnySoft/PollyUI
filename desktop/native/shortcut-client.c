#include "native/shortcut-client.h"
#include "native/windows.h"
#include "polly-shortcuts-client.h"
#include "shortcuts.h"
#include "gui/src/context/native-window.h"
#include "pollyui/window.h"

#include <SDL3/SDL.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>

struct Entry { char *title, *app_id; };
struct Picker {
    struct Entry *items;
    uint32_t count, selected, serial;
    int active;
};
static struct {
    JSContext *ctx;
    JSValue api;
    struct wl_display *display;
    struct polly_shortcuts_v1 *proxy;
    struct PuShortcutBinding bindings[PU_SHORTCUT_COUNT], pending[PU_SHORTCUT_COUNT];
    uint32_t mask, next_serial, result_serial;
    char *result_error;
    struct Picker picker, pending_picker;
    int ready, failed, changed, picker_changed;
    int preview_supported, preview_reply_accepted, preview_configured;
    int projection_supported, preview_projection;
    uint32_t preview_next, preview_waiting, preview_reply, preview_reply_mask;
    uint32_t preview_request, preview_serial, preview_mask, preview_count;
    char preview_reply_error[192], preview_error[192];
    uint32_t projection_probe_next, projection_probe_waiting, projection_probe_reply, projection_probe_index;
    char projection_probe_error[192];
    int cube_supported, cube_enabled, cube_motion, cube_active, cube_changed;
    uint32_t cube_selected, cube_next, cube_waiting, cube_reply;
    char cube_error[192], cube_reply_error[192];
} client;

static void free_picker(struct Picker *picker)
{
    for (uint32_t i = 0; i < picker->count; i++) {
        free(picker->items[i].title); free(picker->items[i].app_id);
    }
    free(picker->items);
    memset(picker, 0, sizeof(*picker));
}

static void binding(void *data, struct polly_shortcuts_v1 *proxy, uint32_t action, uint32_t mods, const char *name)
{
    (void)data; (void)proxy;
    if (action >= PU_SHORTCUT_COUNT || (client.mask & (1u << action)) ||
        !pu_shortcut_key(name, &client.pending[action].key)) {
        client.failed = client.changed = 1;
        return;
    }
    client.pending[action].modifiers = mods;
    client.mask |= 1u << action;
}

static void bindings_done(void *data, struct polly_shortcuts_v1 *proxy)
{
    (void)data; (void)proxy;
    if (client.mask != (1u << PU_SHORTCUT_COUNT) - 1 || pu_shortcut_validate(client.pending)) {
        client.failed = client.changed = 1;
        return;
    }
    memcpy(client.bindings, client.pending, sizeof(client.bindings));
    client.mask = 0;
    client.ready = client.changed = 1;
}

static void configured(void *data, struct polly_shortcuts_v1 *proxy, uint32_t serial, const char *error)
{
    (void)data; (void)proxy;
    free(client.result_error);
    client.result_error = strdup(error);
    if (!client.result_error) client.failed = client.changed = 1;
    client.result_serial = serial;
}

static void picker_begin(void *data, struct polly_shortcuts_v1 *proxy, uint32_t serial, uint32_t count, uint32_t selected)
{
    (void)data; (void)proxy;
    free_picker(&client.pending_picker);
    if (!count || count > PU_SHORTCUT_MAX_WINDOWS || selected >= count) { client.failed = client.picker_changed = 1; return; }
    client.pending_picker.items = calloc(count, sizeof(struct Entry));
    if (!client.pending_picker.items) { client.failed = client.picker_changed = 1; return; }
    client.pending_picker.count = count;
    client.pending_picker.selected = selected;
    client.pending_picker.serial = serial;
    client.pending_picker.active = 1;
}

static void picker_item(void *data, struct polly_shortcuts_v1 *proxy, uint32_t index, const char *title, const char *app_id)
{
    (void)data; (void)proxy;
    if (index >= client.pending_picker.count) { client.failed = client.picker_changed = 1; return; }
    struct Entry *item = &client.pending_picker.items[index];
    free(item->title); free(item->app_id);
    item->title = strdup(title); item->app_id = strdup(app_id);
    if (!item->title || !item->app_id) client.failed = client.picker_changed = 1;
}

static void picker_done(void *data, struct polly_shortcuts_v1 *proxy)
{
    (void)data; (void)proxy;
    if (!client.pending_picker.active) { client.failed = client.picker_changed = 1; return; }
    for (uint32_t i = 0; i < client.pending_picker.count; i++)
        if (!client.pending_picker.items[i].title || !client.pending_picker.items[i].app_id) {
            client.failed = client.picker_changed = 1;
            return;
        }
    if (client.picker.serial != client.pending_picker.serial) {
        client.preview_configured = 0;
        client.preview_projection = 0;
        client.preview_mask = client.preview_request = client.preview_serial = 0;
        client.preview_error[0] = '\0';
    }
    free_picker(&client.picker);
    client.picker = client.pending_picker;
    memset(&client.pending_picker, 0, sizeof(client.pending_picker));
    client.picker_changed = 1;
}

static void picker_closed(void *data, struct polly_shortcuts_v1 *proxy)
{
    (void)data; (void)proxy;
    free_picker(&client.picker); free_picker(&client.pending_picker);
    client.preview_configured = 0;
    client.preview_projection = 0;
    client.preview_mask = client.preview_request = client.preview_serial = 0;
    client.preview_error[0] = '\0';
    client.picker_changed = 1;
}
static void preview_capability(void *data, struct polly_shortcuts_v1 *proxy, uint32_t supported)
{
    (void)data; (void)proxy;
    if (supported > 1) { client.failed = client.changed = 1; return; }
    client.preview_supported = supported == 1;
}
static void projection_capability(void *data, struct polly_shortcuts_v1 *proxy, uint32_t supported)
{
    (void)data; (void)proxy;
    if (supported > 1) { client.failed = client.changed = 1; return; }
    client.projection_supported = supported == 1;
}
static void projection_hit(void *data, struct polly_shortcuts_v1 *proxy,
    uint32_t serial, uint32_t probe, uint32_t index, const char *error)
{
    (void)data; (void)proxy;
    if (probe != client.projection_probe_waiting || serial != client.picker.serial) return;
    if (index != UINT32_MAX && index >= client.picker.count) {
        client.failed = client.picker_changed = 1;
        return;
    }
    client.projection_probe_reply = probe;
    client.projection_probe_index = index;
    snprintf(client.projection_probe_error, sizeof(client.projection_probe_error), "%s", error);
}
static void previews_status(void *data, struct polly_shortcuts_v1 *proxy,
    uint32_t serial, uint32_t request, uint32_t accepted, uint32_t ready, const char *message)
{
    (void)data; (void)proxy;
    if (accepted > 1 || ready > 0x1ff) { client.failed = client.picker_changed = 1; return; }
    if (request == client.preview_waiting) {
        client.preview_reply = request;
        client.preview_reply_accepted = accepted;
        client.preview_reply_mask = ready;
        snprintf(client.preview_reply_error, sizeof(client.preview_reply_error), "%s", message);
    }
    if (request == client.preview_request && serial == client.preview_serial &&
        client.picker.active && serial == client.picker.serial) {
        if (ready >> client.preview_count) { client.failed = client.picker_changed = 1; return; }
        if (client.preview_mask != ready || client.preview_configured != (int)accepted ||
            strcmp(client.preview_error, message)) client.picker_changed = 1;
        client.preview_configured = accepted;
        client.preview_mask = accepted ? ready : 0;
        snprintf(client.preview_error, sizeof(client.preview_error), "%s", message);
    }
}
static void cube_configured(void *data, struct polly_shortcuts_v1 *proxy, uint32_t serial, const char *error)
{
    (void)data; (void)proxy;
    if (serial != client.cube_waiting) return;
    client.cube_reply = serial;
    snprintf(client.cube_reply_error, sizeof(client.cube_reply_error), "%s", error);
}
static void cube_status(void *data, struct polly_shortcuts_v1 *proxy, uint32_t supported,
    uint32_t enabled, uint32_t motion, uint32_t active, uint32_t selected, const char *error)
{
    (void)data; (void)proxy;
    if (supported > 1 || enabled > 1 || motion > 1 || active > 1 || selected > 3) {
        client.failed = client.cube_changed = 1; return;
    }
    client.cube_supported = supported;
    client.cube_enabled = enabled;
    client.cube_motion = motion;
    client.cube_active = active;
    client.cube_selected = selected;
    snprintf(client.cube_error, sizeof(client.cube_error), "%s", error);
    client.cube_changed = 1;
}
static const struct polly_shortcuts_v1_listener listener = {
    .binding = binding, .bindings_done = bindings_done, .configured = configured,
    .switcher_begin = picker_begin, .switcher_item = picker_item,
    .switcher_done = picker_done, .switcher_closed = picker_closed,
    .preview_capability = preview_capability, .previews_status = previews_status,
    .projection_capability = projection_capability, .projection_hit = projection_hit,
    .cube_configured = cube_configured, .cube_status = cube_status,
};

int pu_shortcut_client_bind(struct wl_display *display, struct wl_registry *registry, uint32_t name,
    const char *interface, uint32_t version)
{
    if (strcmp(interface, "polly_shortcuts_v1")) return 0;
    if (version < 2) {
        SDL_Log("Shortcut control requires version 2 and the ten-action catalog (server version %u)", version);
        client.failed = client.changed = 1;
        return 1;
    }
    if (client.proxy) return 1;
    client.display = display;
    client.proxy = wl_registry_bind(registry, name, &polly_shortcuts_v1_interface, version >= 5 ? 5 : version);
    if (!client.proxy || polly_shortcuts_v1_add_listener(client.proxy, &listener, NULL) < 0)
        client.failed = client.changed = 1;
    return 1;
}

static int ensure(JSContext *ctx)
{
    if (!pu_desktop_windows_ready(ctx)) return 0;
    if (!client.proxy) { JS_ThrowTypeError(ctx, "Shortcut control requires a trusted PollyWM connection"); return 0; }
    if (client.failed || !client.ready) { JS_ThrowInternalError(ctx, "Shortcut state is unavailable"); return 0; }
    return 1;
}

static int property(JSContext *ctx, JSValueConst object, const char *name, JSValue value)
{ return !JS_IsException(value) && JS_SetPropertyStr(ctx, object, name, value) >= 0; }

static JSValue get_bindings(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int defaults)
{
    (void)self; (void)argc; (void)argv;
    if (!defaults && !ensure(ctx)) return JS_EXCEPTION;
    struct PuShortcutBinding bindings[PU_SHORTCUT_COUNT];
    if (defaults) pu_shortcut_defaults(bindings);
    else memcpy(bindings, client.bindings, sizeof(bindings));
    JSValue result = JS_NewArray(ctx);
    if (JS_IsException(result)) return result;
    for (uint32_t i = 0; i < PU_SHORTCUT_COUNT; i++) {
        JSValue item = JS_NewObject(ctx);
        char key[128] = "";
        if (bindings[i].key) xkb_keysym_get_name(bindings[i].key, key, sizeof(key));
        if (JS_IsException(item) ||
            !property(ctx, item, "action", JS_NewString(ctx, pu_shortcut_specs[i].id)) ||
            !property(ctx, item, "label", JS_NewString(ctx, pu_shortcut_specs[i].label)) ||
            !property(ctx, item, "modifiers", JS_NewUint32(ctx, bindings[i].modifiers)) ||
            !property(ctx, item, "key", JS_NewString(ctx, key))) {
            JS_FreeValue(ctx, item); JS_FreeValue(ctx, result); return JS_EXCEPTION;
        }
        if (JS_SetPropertyUint32(ctx, result, i, item) < 0) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    }
    return result;
}

static JSValue set_bindings(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!argc || !JS_IsArray(argv[0])) return JS_ThrowTypeError(ctx, "Shortcut bindings must be an array");
    if (!ensure(ctx)) return JS_EXCEPTION;
    JSValue length_value = JS_GetPropertyStr(ctx, argv[0], "length");
    if (JS_IsException(length_value)) return length_value;
    uint32_t count;
    int ok = JS_ToUint32(ctx, &count, length_value);
    JS_FreeValue(ctx, length_value);
    if (ok < 0) return JS_EXCEPTION;
    if (count != PU_SHORTCUT_COUNT) return JS_ThrowTypeError(ctx, "Provide every shortcut action exactly once");
    struct PuShortcutBinding bindings[PU_SHORTCUT_COUNT] = {0};
    uint32_t mask = 0;
    for (uint32_t i = 0; i < count; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, argv[0], i);
        if (JS_IsException(item)) return item;
        if (!JS_IsObject(item)) { JS_FreeValue(ctx, item); return JS_ThrowTypeError(ctx, "Shortcut binding must be an object"); }
        JSValue action = JS_GetPropertyStr(ctx, item, "action");
        if (JS_IsException(action)) { JS_FreeValue(ctx, item); return action; }
        JSValue modifiers = JS_GetPropertyStr(ctx, item, "modifiers");
        if (JS_IsException(modifiers)) { JS_FreeValue(ctx, action); JS_FreeValue(ctx, item); return modifiers; }
        JSValue key_value = JS_GetPropertyStr(ctx, item, "key");
        if (JS_IsException(key_value)) {
            JS_FreeValue(ctx, modifiers); JS_FreeValue(ctx, action); JS_FreeValue(ctx, item); return key_value;
        }
        const char *name = NULL, *key = NULL;
        size_t name_length = 0, key_length = 0;
        double mods = -1;
        int found = -1;
        if (JS_IsString(action) && JS_IsString(key_value) && JS_IsNumber(modifiers)) {
            name = JS_ToCStringLen(ctx, &name_length, action);
            key = JS_ToCStringLen(ctx, &key_length, key_value);
            if (JS_ToFloat64(ctx, &mods, modifiers) < 0) mods = -1;
        }
        if (name && key && !memchr(name, 0, name_length) && !memchr(key, 0, key_length) && key_length < 128)
            for (int j = 0; j < PU_SHORTCUT_COUNT; j++) if (!strcmp(name, pu_shortcut_specs[j].id)) found = j;
        bool valid = found >= 0 && !(mask & (1u << found)) &&
            mods >= 0 && mods <= 15 && mods == (uint32_t)mods && pu_shortcut_key(key, &bindings[found].key);
        if (valid) { mask |= 1u << found; bindings[found].modifiers = (uint32_t)mods; }
        JS_FreeCString(ctx, name); JS_FreeCString(ctx, key);
        JS_FreeValue(ctx, action); JS_FreeValue(ctx, modifiers); JS_FreeValue(ctx, key_value); JS_FreeValue(ctx, item);
        if (!valid) return JS_ThrowTypeError(ctx, "Invalid, duplicate or unknown shortcut binding");
    }
    const char *error = pu_shortcut_validate(bindings);
    if (error) return JS_ThrowTypeError(ctx, "%s", error);
    for (uint32_t i = 0; i < count; i++) {
        char key[128] = "";
        if (bindings[i].key) xkb_keysym_get_name(bindings[i].key, key, sizeof(key));
        polly_shortcuts_v1_set_binding(client.proxy, i, bindings[i].modifiers, key);
    }
    if (++client.next_serial == 0) client.next_serial++;
    polly_shortcuts_v1_commit(client.proxy, client.next_serial);
    if (!pu_desktop_windows_roundtrip() || client.result_serial != client.next_serial || client.failed)
        return JS_ThrowInternalError(ctx, "Shortcut configuration was not acknowledged");
    if (client.result_error && *client.result_error) return JS_ThrowTypeError(ctx, "%s", client.result_error);
    return JS_UNDEFINED;
}

static JSValue flush(JSContext *ctx)
{
    if (wl_display_flush(client.display) < 0 && errno != EAGAIN && errno != EINTR)
        return JS_ThrowInternalError(ctx, "Cannot send shortcut control request");
    return JS_UNDEFINED;
}

static JSValue control_flag(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int kind)
{
    (void)self;
    if (kind < 2 && (!argc || !JS_IsBool(argv[0]))) return JS_ThrowTypeError(ctx, "A boolean is required");
    int enabled = kind < 2 ? JS_ToBool(ctx, argv[0]) : 0;
    if ((enabled || !client.proxy) && !ensure(ctx)) return JS_EXCEPTION;
    if (kind == 0) polly_shortcuts_v1_presenter(client.proxy, enabled);
    else if (kind == 1) polly_shortcuts_v1_recording(client.proxy, enabled);
    else polly_shortcuts_v1_cancel(client.proxy);
    if (kind == 1 && !pu_desktop_windows_roundtrip())
        return JS_ThrowInternalError(ctx, "Shortcut recording was not acknowledged");
    return flush(ctx);
}

static JSValue get_picker(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ensure(ctx)) return JS_EXCEPTION;
    JSValue result = JS_NewObject(ctx), items = JS_NewArray(ctx);
    if (JS_IsException(result) || JS_IsException(items)) {
        JS_FreeValue(ctx, result); JS_FreeValue(ctx, items); return JS_EXCEPTION;
    }
    if (!property(ctx, result, "active", JS_NewBool(ctx, client.picker.active)) ||
        !property(ctx, result, "serial", JS_NewUint32(ctx, client.picker.serial)) ||
        !property(ctx, result, "selected", JS_NewUint32(ctx, client.picker.selected)) ||
        !property(ctx, result, "previewConfigured", JS_NewBool(ctx, client.preview_configured)) ||
        !property(ctx, result, "previewProjection", JS_NewBool(ctx, client.preview_projection)) ||
        !property(ctx, result, "previewMask", JS_NewUint32(ctx, client.preview_mask)) ||
        !property(ctx, result, "previewRequest", JS_NewUint32(ctx, client.preview_request)) ||
        !property(ctx, result, "previewError", JS_NewString(ctx, client.preview_error))) goto failed;
    for (uint32_t i = 0; i < client.picker.count; i++) {
        JSValue item = JS_NewObject(ctx);
        if (JS_IsException(item) ||
            !property(ctx, item, "title", JS_NewString(ctx, client.picker.items[i].title)) ||
            !property(ctx, item, "appId", JS_NewString(ctx, client.picker.items[i].app_id))) {
            JS_FreeValue(ctx, item); goto failed;
        }
        if (JS_SetPropertyUint32(ctx, items, i, item) < 0) goto failed;
    }
    if (!property(ctx, result, "items", items)) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    return result;
failed:
    JS_FreeValue(ctx, items); JS_FreeValue(ctx, result); return JS_EXCEPTION;
}

static JSValue accept_picker(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc < 2 || !JS_IsNumber(argv[0]) || !JS_IsNumber(argv[1]))
        return JS_ThrowTypeError(ctx, "Switcher serial and selection are required");
    if (!ensure(ctx)) return JS_EXCEPTION;
    double serial, index;
    if (JS_ToFloat64(ctx, &serial, argv[0]) < 0 || JS_ToFloat64(ctx, &index, argv[1]) < 0) return JS_EXCEPTION;
    if (!client.picker.active || serial != client.picker.serial ||
        !(index >= 0 && index < client.picker.count) || index != (uint32_t)index)
        return JS_ThrowRangeError(ctx, "Window switcher selection is stale");
    polly_shortcuts_v1_accept(client.proxy, (uint32_t)serial, (uint32_t)index);
    return flush(ctx);
}

static bool preview_integer(JSContext *ctx, JSValueConst value, uint32_t *number)
{
    double raw;
    if (!JS_IsNumber(value) || JS_ToFloat64(ctx, &raw, value) < 0 ||
        !isfinite(raw) || raw < 0 || raw > UINT32_MAX || floor(raw) != raw) return false;
    *number = (uint32_t)raw;
    return true;
}
static struct wl_surface *preview_surface(JSContext *ctx, JSValueConst handle)
{
    PuWindow *window = pu_gui_window_from_value(ctx, handle);
    struct wl_surface *surface = window ? pu_window_layer_surface_peek(window) : NULL;
    if (!surface && !JS_HasException(ctx))
        JS_ThrowTypeError(ctx, "Window previews require a live owned layer Window");
    return surface;
}
static JSValue preview_supported(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ensure(ctx)) return JS_EXCEPTION;
    return JS_NewBool(ctx, client.preview_supported);
}
static JSValue projection_supported(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ensure(ctx)) return JS_EXCEPTION;
    return JS_NewBool(ctx, client.projection_supported);
}
static JSValue configure_previews(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int projected)
{
    (void)self;
    if (!ensure(ctx)) return JS_EXCEPTION;
    if (client.preview_waiting)
        return JS_ThrowInternalError(ctx, "A window preview request is already pending");
    if (!client.preview_supported || polly_shortcuts_v1_get_version(client.proxy) < 3)
        return JS_ThrowTypeError(ctx, "Native window previews require a supported paired shortcut v3 renderer");
    if (projected && (!client.projection_supported || polly_shortcuts_v1_get_version(client.proxy) < 4))
        return JS_ThrowTypeError(ctx, "Native 3D previews require a supported GLES graphics session and shortcut v4");
    uint32_t serial, background, count = 0, words[9][5];
    if (argc != (projected ? 5 : 4) || !preview_integer(ctx, argv[0], &serial) ||
        !preview_integer(ctx, argv[3], &background) || background > 0xffffff || !JS_IsArray(argv[2]) ||
        (projected && !JS_IsBool(argv[4])))
        return JS_ThrowTypeError(ctx, "Window preview serial, owned Window, rectangles and RGB are required");
    JSValue handle = JS_DupValue(ctx, argv[1]);
    JSValue length = JS_GetPropertyStr(ctx, argv[2], "length");
    bool valid = !JS_IsException(length) && preview_integer(ctx, length, &count) &&
        (projected ? count == 4 : count >= 1 && count <= 9);
    JS_FreeValue(ctx, length);
    if (valid && projected) {
        words[0][0] = JS_ToBool(ctx, argv[4]);
        for (uint32_t field = 0; valid && field < 4; field++) {
            JSValue value = JS_GetPropertyUint32(ctx, argv[2], field);
            valid = !JS_IsException(value) && preview_integer(ctx, value, &words[0][field + 1]);
            JS_FreeValue(ctx, value);
        }
        valid = valid && words[0][3] >= 1 && words[0][3] <= 4096 &&
            words[0][4] >= 1 && words[0][4] <= 768;
        count = 1;
    }
    for (uint32_t index = 0; valid && !projected && index < count; index++) {
        JSValue row = JS_GetPropertyUint32(ctx, argv[2], index);
        if (JS_IsException(row)) { valid = false; break; }
        length = JS_GetPropertyStr(ctx, row, "length");
        uint32_t size = 0;
        valid = !JS_IsException(row) && JS_IsArray(row) && !JS_IsException(length) &&
            preview_integer(ctx, length, &size) && size == 5;
        JS_FreeValue(ctx, length);
        for (uint32_t field = 0; valid && field < 5; field++) {
            JSValue value = JS_GetPropertyUint32(ctx, row, field);
            valid = !JS_IsException(value) && preview_integer(ctx, value, &words[index][field]);
            JS_FreeValue(ctx, value);
        }
        JS_FreeValue(ctx, row);
        if (valid) valid = words[index][3] >= 1 && words[index][3] <= 512 &&
            words[index][4] >= 1 && words[index][4] <= 320;
    }
    if (!valid || !client.picker.active || serial != client.picker.serial) {
        JS_FreeValue(ctx, handle);
        return JS_HasException(ctx) ? JS_EXCEPTION : JS_ThrowRangeError(ctx, "Invalid or stale window preview rectangles");
    }
    struct wl_surface *surface = preview_surface(ctx, handle);
    if (!surface || client.preview_next == UINT32_MAX) {
        JS_FreeValue(ctx, handle);
        return JS_HasException(ctx) ? JS_EXCEPTION : JS_ThrowInternalError(ctx, "Window preview serials exhausted");
    }
    uint32_t request = ++client.preview_next;
    client.preview_waiting = request;
    client.preview_reply = 0;
    struct wl_array rectangles = {.size = count * sizeof(words[0]), .data = words};
    if (projected)
        polly_shortcuts_v1_configure_projection(client.proxy, serial, request, surface, background, &rectangles);
    else
        polly_shortcuts_v1_configure_previews(client.proxy, serial, request, surface, background, &rectangles);
    if (!pu_desktop_windows_roundtrip() || client.preview_reply != request) {
        client.preview_waiting = 0;
        JS_FreeValue(ctx, handle);
        return JS_ThrowInternalError(ctx, "Window preview request outcome is unknown; do not retry automatically");
    }
    client.preview_waiting = 0;
    if (!client.preview_reply_accepted) {
        JS_FreeValue(ctx, handle);
        return JS_ThrowInternalError(ctx, "%s", client.preview_reply_error);
    }
    if (client.preview_reply_mask >> count) {
        JS_FreeValue(ctx, handle);
        return JS_ThrowInternalError(ctx, "Invalid window preview ready mask");
    }
    valid = preview_surface(ctx, handle) != NULL && client.picker.active && client.picker.serial == serial;
    JS_FreeValue(ctx, handle);
    if (!valid) return JS_HasException(ctx) ? JS_EXCEPTION : JS_ThrowRangeError(ctx, "Window preview target retired");
    client.preview_request = request;
    client.preview_serial = serial;
    client.preview_mask = client.preview_reply_mask;
    client.preview_configured = 1;
    client.preview_projection = projected != 0;
    client.preview_count = count;
    snprintf(client.preview_error, sizeof(client.preview_error), "%s", client.preview_reply_error);
    client.picker_changed = 1;
    return JS_NewBool(ctx, true);
}

static JSValue pick_projection(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    uint32_t serial, x, y;
    if (argc != 3 || !preview_integer(ctx, argv[0], &serial) ||
        !preview_integer(ctx, argv[1], &x) || !preview_integer(ctx, argv[2], &y) ||
        x > INT32_MAX || y > INT32_MAX)
        return JS_ThrowTypeError(ctx, "A current 3D selector serial and logical viewport point are required");
    if (!ensure(ctx)) return JS_EXCEPTION;
    if (!client.projection_supported || !client.picker.active || serial != client.picker.serial ||
        !client.preview_projection || !client.preview_configured || client.preview_mask != 1)
        return JS_ThrowRangeError(ctx, "Native 3D window selection is stale or unavailable");
    if (client.projection_probe_waiting || client.projection_probe_next == UINT32_MAX)
        return JS_ThrowInternalError(ctx, "Native 3D hit-test capacity or identifiers exhausted");
    uint32_t probe = ++client.projection_probe_next;
    client.projection_probe_waiting = probe;
    client.projection_probe_reply = 0;
    polly_shortcuts_v1_pick_projection(client.proxy, serial, probe, (int32_t)x, (int32_t)y);
    bool replied = pu_desktop_windows_roundtrip() && client.projection_probe_reply == probe;
    client.projection_probe_waiting = 0;
    if (!replied) return JS_ThrowInternalError(ctx, "Native 3D hit-test outcome is unknown");
    if (client.projection_probe_error[0])
        return JS_ThrowRangeError(ctx, "%s", client.projection_probe_error);
    if (!client.picker.active || client.picker.serial != serial)
        return JS_ThrowRangeError(ctx, "Native 3D window selector retired during hit testing");
    return client.projection_probe_index == UINT32_MAX ? JS_NULL :
        JS_NewUint32(ctx, client.projection_probe_index);
}

static JSValue get_cube(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ensure(ctx)) return JS_EXCEPTION;
    JSValue result = JS_NewObject(ctx);
    if (JS_IsException(result)) return result;
    if (!property(ctx, result, "available", JS_NewBool(ctx, client.cube_supported)) ||
        !property(ctx, result, "enabled", JS_NewBool(ctx, client.cube_enabled)) ||
        !property(ctx, result, "motion", JS_NewBool(ctx, client.cube_motion)) ||
        !property(ctx, result, "active", JS_NewBool(ctx, client.cube_active)) ||
        !property(ctx, result, "selected", JS_NewUint32(ctx, client.cube_selected)) ||
        !property(ctx, result, "error", JS_NewString(ctx, client.cube_error))) {
        JS_FreeValue(ctx, result); return JS_EXCEPTION;
    }
    return result;
}
static JSValue configure_cube(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    if (argc != 2 || !JS_IsBool(argv[0]) || !JS_IsBool(argv[1]))
        return JS_ThrowTypeError(ctx, "Cube policy requires boolean enabled and motion");
    if (!ensure(ctx)) return JS_EXCEPTION;
    if (polly_shortcuts_v1_get_version(client.proxy) < 5)
        return JS_ThrowTypeError(ctx, "Workspace cube requires shortcuts protocol version 5");
    if (client.cube_waiting || client.cube_next == UINT32_MAX)
        return JS_ThrowInternalError(ctx, "Cube configuration is in progress or identifiers are exhausted");
    client.cube_waiting = ++client.cube_next;
    client.cube_reply = 0;
    polly_shortcuts_v1_configure_cube(client.proxy, client.cube_waiting,
        JS_ToBool(ctx, argv[0]), JS_ToBool(ctx, argv[1]));
    bool replied = pu_desktop_windows_roundtrip() && client.cube_reply == client.cube_waiting;
    client.cube_waiting = 0;
    if (!replied) return JS_ThrowInternalError(ctx, "Cube configuration outcome is unknown; do not retry automatically");
    if (client.cube_reply_error[0]) return JS_ThrowRangeError(ctx, "%s", client.cube_reply_error);
    return get_cube(ctx, self, 0, NULL);
}

int pu_shortcut_client_install(JSContext *ctx, JSValueConst api)
{
    client.ctx = ctx; client.api = JS_DupValue(ctx, api);
    return property(ctx, api, "shortcuts", JS_NewCFunctionMagic(ctx, get_bindings, "shortcuts", 0, JS_CFUNC_generic_magic, 0)) &&
        property(ctx, api, "shortcutDefaults", JS_NewCFunctionMagic(ctx, get_bindings, "shortcutDefaults", 0, JS_CFUNC_generic_magic, 1)) &&
        property(ctx, api, "setShortcuts", JS_NewCFunction(ctx, set_bindings, "setShortcuts", 1)) &&
        property(ctx, api, "enableWindowSwitcher", JS_NewCFunctionMagic(ctx, control_flag, "enableWindowSwitcher", 1, JS_CFUNC_generic_magic, 0)) &&
        property(ctx, api, "captureShortcuts", JS_NewCFunctionMagic(ctx, control_flag, "captureShortcuts", 1, JS_CFUNC_generic_magic, 1)) &&
        property(ctx, api, "cancelWindowSwitch", JS_NewCFunctionMagic(ctx, control_flag, "cancelWindowSwitch", 0, JS_CFUNC_generic_magic, 2)) &&
        property(ctx, api, "windowSwitcher", JS_NewCFunction(ctx, get_picker, "windowSwitcher", 0)) &&
        property(ctx, api, "acceptWindowSwitch", JS_NewCFunction(ctx, accept_picker, "acceptWindowSwitch", 2)) &&
        property(ctx, api, "windowPreviewCapability", JS_NewCFunction(ctx, preview_supported, "windowPreviewCapability", 0)) &&
        property(ctx, api, "configureWindowPreviews", JS_NewCFunctionMagic(ctx, configure_previews,
            "configureWindowPreviews", 4, JS_CFUNC_generic_magic, 0)) &&
        property(ctx, api, "configureWindowProjection", JS_NewCFunctionMagic(ctx, configure_previews,
            "configureWindowProjection", 5, JS_CFUNC_generic_magic, 1)) &&
        property(ctx, api, "windowProjectionCapability",
            JS_NewCFunction(ctx, projection_supported, "windowProjectionCapability", 0)) &&
        property(ctx, api, "pickWindowProjection",
            JS_NewCFunction(ctx, pick_projection, "pickWindowProjection", 3)) &&
        property(ctx, api, "workspaceCubeState", JS_NewCFunction(ctx, get_cube, "workspaceCubeState", 0)) &&
        property(ctx, api, "configureWorkspaceCube", JS_NewCFunction(ctx, configure_cube, "configureWorkspaceCube", 2)) &&
        property(ctx, api, "onWorkspaceCubeChanged", JS_NULL) &&
        property(ctx, api, "onShortcutsChanged", JS_NULL) && property(ctx, api, "onWindowSwitcherChanged", JS_NULL);
}

static void notify(const char *name)
{
    JSValue callback = JS_GetPropertyStr(client.ctx, client.api, name), result = JS_UNDEFINED;
    if (JS_IsException(callback)) result = JS_EXCEPTION;
    else if (JS_IsFunction(client.ctx, callback)) result = JS_Call(client.ctx, callback, client.api, 0, NULL);
    if (JS_IsException(result)) {
        JSValue error = JS_GetException(client.ctx);
        const char *text = JS_ToCString(client.ctx, error);
        SDL_Log("%s failed: %s", name, text ? text : "error");
        JS_FreeCString(client.ctx, text); JS_FreeValue(client.ctx, error);
    }
    JS_FreeValue(client.ctx, callback); JS_FreeValue(client.ctx, result);
}

int pu_shortcut_client_pump(void)
{
    if (!client.ctx || (!client.changed && !client.picker_changed && !client.cube_changed)) return 0;
    int bindings = client.changed, picker = client.picker_changed, cube = client.cube_changed;
    client.changed = client.picker_changed = client.cube_changed = 0;
    if (bindings) notify("onShortcutsChanged");
    if (picker) notify("onWindowSwitcherChanged");
    if (cube) notify("onWorkspaceCubeChanged");
    return 1;
}

void pu_shortcut_client_shutdown(void)
{
    if (client.proxy) polly_shortcuts_v1_destroy(client.proxy);
    free_picker(&client.picker); free_picker(&client.pending_picker);
    free(client.result_error);
    if (client.ctx) JS_FreeValue(client.ctx, client.api);
    memset(&client, 0, sizeof(client));
}
