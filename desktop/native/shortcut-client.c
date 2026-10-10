#include "native/shortcut-client.h"
#include "native/windows.h"
#include "polly-shortcuts-client.h"
#include "shortcuts.h"

#include <SDL3/SDL.h>
#include <errno.h>
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
    if (action >= PU_SHORTCUT_COUNT || !pu_shortcut_key(name, &client.pending[action].key)) {
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
    free_picker(&client.picker);
    client.picker = client.pending_picker;
    memset(&client.pending_picker, 0, sizeof(client.pending_picker));
    client.picker_changed = 1;
}

static void picker_closed(void *data, struct polly_shortcuts_v1 *proxy)
{
    (void)data; (void)proxy;
    free_picker(&client.picker); free_picker(&client.pending_picker);
    client.picker_changed = 1;
}
static const struct polly_shortcuts_v1_listener listener = {
    .binding = binding, .bindings_done = bindings_done, .configured = configured,
    .switcher_begin = picker_begin, .switcher_item = picker_item,
    .switcher_done = picker_done, .switcher_closed = picker_closed,
};

int pu_shortcut_client_bind(struct wl_display *display, struct wl_registry *registry, uint32_t name, const char *interface)
{
    if (strcmp(interface, "polly_shortcuts_v1")) return 0;
    if (client.proxy) return 1;
    client.display = display;
    client.proxy = wl_registry_bind(registry, name, &polly_shortcuts_v1_interface, 1);
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
        !property(ctx, result, "selected", JS_NewUint32(ctx, client.picker.selected))) goto failed;
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
    if (!client.ctx || (!client.changed && !client.picker_changed)) return 0;
    int bindings = client.changed, picker = client.picker_changed;
    client.changed = client.picker_changed = 0;
    if (bindings) notify("onShortcutsChanged");
    if (picker) notify("onWindowSwitcherChanged");
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
