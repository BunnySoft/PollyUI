#include "input-method-client.h"
#include "engine.h"
#include "input-method-v2-client.h"
#include "virtual-keyboard-v1-client.h"
#include "text-input-v3-client.h"
#include <SDL3/SDL.h>
#include <errno.h>
#include <inttypes.h>
#include <linux/input-event-codes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>

static struct {
    JSContext *ctx;
    JSValue api;
    struct wl_display *display;
    struct wl_seat *seat;
    struct zwp_input_method_manager_v2 *manager;
    struct zwp_virtual_keyboard_manager_v1 *virtual_manager;
    struct zwp_input_method_v2 *method;
    struct zwp_virtual_keyboard_v1 *keyboard;
    struct zwp_input_method_keyboard_grab_v2 *grab;
    struct xkb_context *xkb_context;
    struct xkb_keymap *keymap;
    struct xkb_state *xkb;
    struct PuImeEngine *engine;
    struct PuImeSnapshot snapshot;
    uint32_t serial, purpose, hint, depressed, latched, locked, group;
    bool pending_active, active, reset, changed;
    bool forced_ascii, saved_ascii;
    unsigned char keys[KEY_CNT];
    int repeat_key, repeat_rate, repeat_delay;
    Uint64 repeat_at;
    char error[256];
} client;

static void failure(const char *message)
{ if (!client.error[0]) snprintf(client.error, sizeof(client.error), "%s", message); }
static void changed(void) { client.changed = true; }
static int engine_ok(bool ok)
{ if (!ok) failure(pu_ime_error(client.engine)); else changed(); return ok; }
static void send_output(void)
{
    struct PuImeSnapshot *state = &client.snapshot;
    if (strlen(state->preedit) > 4000 || strlen(state->commit) > 4000) {
        failure("Input-method output exceeds the Wayland text limit"); return;
    }
    zwp_input_method_v2_set_preedit_string(client.method, state->preedit, (int32_t)state->cursor, (int32_t)state->cursor);
    if (state->commit[0]) zwp_input_method_v2_commit_string(client.method, state->commit);
    zwp_input_method_v2_commit(client.method, client.serial);
}
static unsigned modifiers(void)
{
    return (xkb_state_mod_name_is_active(client.xkb, XKB_MOD_NAME_SHIFT, XKB_STATE_MODS_EFFECTIVE) > 0 ? PU_IME_SHIFT : 0) |
        (xkb_state_mod_name_is_active(client.xkb, XKB_MOD_NAME_CTRL, XKB_STATE_MODS_EFFECTIVE) > 0 ? PU_IME_CTRL : 0) |
        (xkb_state_mod_name_is_active(client.xkb, XKB_MOD_NAME_ALT, XKB_STATE_MODS_EFFECTIVE) > 0 ? PU_IME_ALT : 0) |
        (xkb_state_mod_name_is_active(client.xkb, XKB_MOD_NAME_LOGO, XKB_STATE_MODS_EFFECTIVE) > 0 ? PU_IME_SUPER : 0) |
        (xkb_state_mod_name_is_active(client.xkb, XKB_MOD_NAME_CAPS, XKB_STATE_MODS_EFFECTIVE) > 0 ? PU_IME_CAPS : 0);
}
static void process_key(uint32_t time, uint32_t key, uint32_t state, bool repeat)
{
    if (!client.active || !client.xkb || client.error[0]) return;
    if (key >= KEY_CNT) { failure("Input-method key code is out of range"); return; }
    bool release = state == WL_KEYBOARD_KEY_STATE_RELEASED;
    xkb_keysym_t symbol = xkb_state_key_get_one_sym(client.xkb, key + 8);
    int handled = pu_ime_key(client.engine, symbol, modifiers(), release, &client.snapshot);
    if (!engine_ok(handled >= 0)) return;
    if (client.forced_ascii && !client.snapshot.ascii &&
        !engine_ok(pu_ime_set_ascii(client.engine, true, &client.snapshot))) return;
    send_output();
    if (client.error[0]) return;
    bool forward = release && client.keys[key] ? client.keys[key] == 2 : !handled;
    if (forward) {
        zwp_virtual_keyboard_v1_modifiers(client.keyboard, client.depressed, client.latched, client.locked, client.group);
        zwp_virtual_keyboard_v1_key(client.keyboard, time, key, state);
    }
    if (release) {
        client.keys[key] = 0;
        if (client.repeat_key == (int)key) client.repeat_key = -1;
    } else {
        client.keys[key] = forward ? 2 : 1;
        if (!repeat && handled && client.repeat_rate > 0 && xkb_keymap_key_repeats(client.keymap, key + 8)) {
            client.repeat_key = (int)key;
            client.repeat_at = SDL_GetTicks() + (Uint64)client.repeat_delay;
        }
    }
}
static void activated(void *data, struct zwp_input_method_v2 *method)
{ (void)data; (void)method; client.pending_active = true; client.reset = true; }
static void deactivated(void *data, struct zwp_input_method_v2 *method)
{ (void)data; (void)method; client.pending_active = false; client.reset = true; }
static void surrounding(void *data, struct zwp_input_method_v2 *method, const char *text, uint32_t cursor, uint32_t anchor)
{ (void)data; (void)method; (void)text; (void)cursor; (void)anchor; }
static void text_cause(void *data, struct zwp_input_method_v2 *method, uint32_t cause)
{ (void)data; (void)method; (void)cause; }
static void content(void *data, struct zwp_input_method_v2 *method, uint32_t hint, uint32_t purpose)
{ (void)data; (void)method; client.hint = hint; client.purpose = purpose; }
static void done(void *data, struct zwp_input_method_v2 *method)
{
    (void)data; (void)method;
    client.serial++;
    client.active = client.pending_active;
    if (client.reset && client.engine) {
        client.reset = false; client.repeat_key = -1;
        memset(client.keys, 0, sizeof(client.keys));
        engine_ok(pu_ime_reset(client.engine, &client.snapshot));
    }
    bool numeric = client.purpose == ZWP_TEXT_INPUT_V3_CONTENT_PURPOSE_DIGITS ||
        client.purpose == ZWP_TEXT_INPUT_V3_CONTENT_PURPOSE_NUMBER ||
        client.purpose == ZWP_TEXT_INPUT_V3_CONTENT_PURPOSE_PHONE;
    if (client.active && numeric != client.forced_ascii && client.engine) {
        if (numeric) client.saved_ascii = client.snapshot.ascii;
        if (engine_ok(pu_ime_set_ascii(client.engine, numeric || client.saved_ascii, &client.snapshot)))
            client.forced_ascii = numeric;
    }
    changed();
}
static void unavailable(void *data, struct zwp_input_method_v2 *method)
{ (void)data; (void)method; failure("Another input method owns this seat"); }
static const struct zwp_input_method_v2_listener method_listener = {
    .activate = activated, .deactivate = deactivated, .surrounding_text = surrounding,
    .text_change_cause = text_cause, .content_type = content, .done = done, .unavailable = unavailable,
};
static void keymap(void *data, struct zwp_input_method_keyboard_grab_v2 *grab, uint32_t format, int fd, uint32_t size)
{
    (void)data; (void)grab;
    if (format != WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1 || !size || size > 1024 * 1024) {
        close(fd); failure("Unsupported input-method keymap"); return;
    }
    char *map = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
    struct xkb_keymap *keymap = map != MAP_FAILED && map[size - 1] == 0 ?
        xkb_keymap_new_from_string(client.xkb_context, map, XKB_KEYMAP_FORMAT_TEXT_V1, XKB_KEYMAP_COMPILE_NO_FLAGS) : NULL;
    if (map != MAP_FAILED) munmap(map, size);
    if (!keymap) { close(fd); failure("Cannot parse input-method keymap"); return; }
    struct xkb_state *state = xkb_state_new(keymap);
    if (!state) { xkb_keymap_unref(keymap); close(fd); failure("Cannot allocate input-method key state"); return; }
    zwp_virtual_keyboard_v1_keymap(client.keyboard, format, fd, size);
    close(fd);
    xkb_state_unref(client.xkb); xkb_keymap_unref(client.keymap);
    client.xkb = state; client.keymap = keymap;
    xkb_state_update_mask(state, client.depressed, client.latched, client.locked, 0, 0, client.group);
}
static void key(void *data, struct zwp_input_method_keyboard_grab_v2 *grab, uint32_t serial,
    uint32_t time, uint32_t key, uint32_t state)
{ (void)data; (void)grab; (void)serial; process_key(time, key, state, false); }
static void key_modifiers(void *data, struct zwp_input_method_keyboard_grab_v2 *grab, uint32_t serial,
    uint32_t depressed, uint32_t latched, uint32_t locked, uint32_t group)
{
    (void)data; (void)grab; (void)serial;
    client.depressed = depressed; client.latched = latched; client.locked = locked; client.group = group;
    if (client.xkb) xkb_state_update_mask(client.xkb, depressed, latched, locked, 0, 0, group);
}
static void repeat_info(void *data, struct zwp_input_method_keyboard_grab_v2 *grab, int32_t rate, int32_t delay)
{
    (void)data; (void)grab;
    if (rate < 0 || rate > 1000 || delay < 0 || delay > 60000) { failure("Invalid input-method repeat settings"); return; }
    client.repeat_rate = rate; client.repeat_delay = delay;
    if (!rate) client.repeat_key = -1;
}
static const struct zwp_input_method_keyboard_grab_v2_listener grab_listener = {
    .keymap = keymap, .key = key, .modifiers = key_modifiers, .repeat_info = repeat_info,
};
static void rectangle(void *data, struct zwp_input_popup_surface_v2 *popup,
    int32_t x, int32_t y, int32_t width, int32_t height)
{ (void)data; (void)popup; (void)x; (void)y; (void)width; (void)height; }
static const struct zwp_input_popup_surface_v2_listener popup_listener = { .text_input_rectangle = rectangle };
struct zwp_input_popup_surface_v2 *pu_input_client_popup(struct wl_surface *surface)
{
    if (!client.method || client.error[0]) { SDL_SetError("Input-method service is not running"); return NULL; }
    struct zwp_input_popup_surface_v2 *popup = zwp_input_method_v2_get_input_popup_surface(client.method, surface);
    if (!popup) { SDL_SetError("Cannot allocate input-method popup"); return NULL; }
    zwp_input_popup_surface_v2_add_listener(popup, &popup_listener, NULL);
    return popup;
}
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version)
{
    (void)data; (void)version;
    if (!client.manager && !strcmp(interface, zwp_input_method_manager_v2_interface.name))
        client.manager = wl_registry_bind(registry, name, &zwp_input_method_manager_v2_interface, 1);
    else if (!client.virtual_manager && !strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name))
        client.virtual_manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
    else if (!client.seat && !strcmp(interface, wl_seat_interface.name))
        client.seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
}
static void global_removed(void *data, struct wl_registry *registry, uint32_t name)
{ (void)data; (void)registry; (void)name; }
static const struct wl_registry_listener registry_listener = { .global = global, .global_remove = global_removed };
static void synced(void *data, struct wl_callback *callback, uint32_t serial)
{ (void)callback; (void)serial; *(bool *)data = true; }
static const struct wl_callback_listener sync_listener = { .done = synced };
static bool synchronize(void)
{
    bool complete = false;
    struct wl_callback *sync = wl_display_sync(client.display);
    if (!sync) { failure("Cannot allocate input-method discovery sync"); return false; }
    wl_callback_add_listener(sync, &sync_listener, &complete);
    Uint64 start = SDL_GetTicks();
    while (!complete && !client.error[0]) {
        if (wl_display_flush(client.display) < 0 && errno != EAGAIN && errno != EINTR) failure("Cannot flush input-method requests");
        SDL_PumpEvents();
        if (wl_display_get_error(client.display)) failure("Input-method Wayland connection failed");
        if (SDL_GetTicks() - start >= 3000) failure("Input-method discovery timed out");
        if (!complete) SDL_Delay(1);
    }
    wl_callback_destroy(sync);
    return complete && !client.error[0];
}
static void release_resources(void)
{
    client.active = false;
    if (client.grab) zwp_input_method_keyboard_grab_v2_release(client.grab);
    if (client.method) zwp_input_method_v2_destroy(client.method);
    if (client.keyboard) zwp_virtual_keyboard_v1_destroy(client.keyboard);
    if (client.manager) zwp_input_method_manager_v2_destroy(client.manager);
    if (client.virtual_manager) zwp_virtual_keyboard_manager_v1_destroy(client.virtual_manager);
    if (client.seat) wl_seat_destroy(client.seat);
    xkb_state_unref(client.xkb); xkb_keymap_unref(client.keymap); xkb_context_unref(client.xkb_context);
    pu_ime_close(client.engine);
    client.grab = NULL; client.method = NULL; client.keyboard = NULL; client.manager = NULL;
    client.virtual_manager = NULL; client.seat = NULL; client.xkb = NULL; client.keymap = NULL;
    client.xkb_context = NULL; client.engine = NULL;
}
static JSValue start(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (client.engine || client.method) return JS_ThrowTypeError(ctx, "Input method is already started");
    if (argc != 3) return JS_ThrowTypeError(ctx, "start requires shared data, user data and schema strings");
    const char *args[3] = {0};
    for (int i = 0; i < 3; i++) {
        size_t length = 0;
        if (!JS_IsString(argv[i])) { JS_ThrowTypeError(ctx, "Input-method arguments must be strings"); goto invalid; }
        args[i] = JS_ToCStringLen(ctx, &length, argv[i]);
        if (!args[i]) goto invalid;
        if (memchr(args[i], 0, length)) { JS_ThrowTypeError(ctx, "Input-method arguments cannot contain NUL"); goto invalid; }
    }
    client.error[0] = 0; client.serial = 0; client.repeat_key = -1;
    client.display = SDL_GetPointerProperty(SDL_GetGlobalProperties(), SDL_PROP_GLOBAL_VIDEO_WAYLAND_WL_DISPLAY_POINTER, NULL);
    if (!client.display) { failure("Input methods require the Wayland video driver"); goto failed; }
    struct wl_registry *registry = wl_display_get_registry(client.display);
    if (!registry) { failure("Cannot create input-method registry"); goto failed; }
    wl_registry_add_listener(registry, &registry_listener, NULL);
    bool ready = synchronize();
    wl_registry_destroy(registry);
    if (!ready || !client.manager || !client.virtual_manager || !client.seat) {
        failure("Input-method and virtual-keyboard privileges are unavailable"); goto failed;
    }
    client.engine = pu_ime_open(args[0], args[1], args[2], client.error, sizeof(client.error));
    if (!client.engine) goto failed;
    client.xkb_context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    if (!client.xkb_context) { failure("Cannot allocate input-method XKB context"); goto failed; }
    client.keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(client.virtual_manager, client.seat);
    client.method = zwp_input_method_manager_v2_get_input_method(client.manager, client.seat);
    if (!client.keyboard || !client.method) { failure("Cannot allocate input-method protocol objects"); goto failed; }
    zwp_input_method_v2_add_listener(client.method, &method_listener, NULL);
    client.grab = zwp_input_method_v2_grab_keyboard(client.method);
    if (!client.grab) { failure("Cannot allocate input-method keyboard grab"); goto failed; }
    zwp_input_method_keyboard_grab_v2_add_listener(client.grab, &grab_listener, NULL);
    if (!synchronize() || !engine_ok(pu_ime_reset(client.engine, &client.snapshot))) goto failed;
    for (int i = 0; i < 3; i++) JS_FreeCString(ctx, args[i]);
    return JS_UNDEFINED;
failed:
    JS_ThrowInternalError(ctx, "%s", client.error);
    release_resources();
invalid:
    for (int i = 0; i < 3; i++) JS_FreeCString(ctx, args[i]);
    return JS_EXCEPTION;
}
static JSValue state(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!client.engine || client.error[0]) return JS_ThrowInternalError(ctx, "%s", client.error[0] ? client.error : "Input method is not started");
    JSValue result = JS_NewObject(ctx), items = JS_NewArray(ctx);
    if (JS_IsException(result) || JS_IsException(items)) {
        JS_FreeValue(ctx, result); JS_FreeValue(ctx, items); return JS_EXCEPTION;
    }
    char revision[32];
    snprintf(revision, sizeof(revision), "%" PRIu64, client.snapshot.revision);
    JS_SetPropertyStr(ctx, result, "active", JS_NewBool(ctx, client.active));
    JS_SetPropertyStr(ctx, result, "ascii", JS_NewBool(ctx, client.snapshot.ascii));
    JS_SetPropertyStr(ctx, result, "preedit", JS_NewString(ctx, client.snapshot.preedit));
    JS_SetPropertyStr(ctx, result, "revision", JS_NewString(ctx, revision));
    JS_SetPropertyStr(ctx, result, "selected", JS_NewInt32(ctx, (int)client.snapshot.selected));
    JS_SetPropertyStr(ctx, result, "lastPage", JS_NewBool(ctx, client.snapshot.last_page));
    for (size_t i = 0; i < client.snapshot.count && !JS_HasException(ctx); i++) {
        JSValue item = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, item, "text", JS_NewString(ctx, client.snapshot.candidates[i]));
        JS_SetPropertyStr(ctx, item, "comment", JS_NewString(ctx, client.snapshot.comments[i]));
        JS_SetPropertyUint32(ctx, items, (uint32_t)i, item);
    }
    JS_SetPropertyStr(ctx, result, "candidates", items);
    if (JS_HasException(ctx)) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    return result;
}
static JSValue choose(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!client.engine || !client.active || client.error[0]) return JS_ThrowTypeError(ctx, "Input method is not active");
    if (argc != 2 || !JS_IsString(argv[0]) || !JS_IsNumber(argv[1])) return JS_ThrowTypeError(ctx, "choose requires revision and index");
    size_t length;
    const char *revision = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!revision) return JS_EXCEPTION;
    char *end;
    errno = 0;
    uint64_t value = strtoull(revision, &end, 10);
    bool valid = length && revision[0] >= '0' && revision[0] <= '9' && end == revision + length && !errno;
    JS_FreeCString(ctx, revision);
    double index;
    if (!valid) return JS_ThrowTypeError(ctx, "Invalid input-method revision");
    if (JS_ToFloat64(ctx, &index, argv[1]) < 0) return JS_EXCEPTION;
    if (!isfinite(index) || floor(index) != index || index < 0 || index >= PU_IME_CANDIDATES)
        return JS_ThrowTypeError(ctx, "Invalid input-method candidate index");
    if (!pu_ime_choose(client.engine, value, (size_t)index, &client.snapshot))
        return JS_ThrowTypeError(ctx, "%s", pu_ime_error(client.engine));
    client.repeat_key = -1;
    changed(); send_output();
    if (client.error[0]) return JS_ThrowInternalError(ctx, "%s", client.error);
    return JS_UNDEFINED;
}
int pu_input_client_install(JSContext *ctx)
{
    memset(&client, 0, sizeof(client)); client.ctx = ctx; client.repeat_key = -1;
    client.api = JS_NewObject(ctx);
    if (JS_IsException(client.api)) return 0;
    JS_SetPropertyStr(ctx, client.api, "start", JS_NewCFunction(ctx, start, "start", 3));
    JS_SetPropertyStr(ctx, client.api, "state", JS_NewCFunction(ctx, state, "state", 0));
    JS_SetPropertyStr(ctx, client.api, "choose", JS_NewCFunction(ctx, choose, "choose", 2));
    JS_SetPropertyStr(ctx, client.api, "onchange", JS_NULL);
    JSValue global = JS_GetGlobalObject(ctx);
    int ok = !JS_HasException(ctx) && JS_SetPropertyStr(ctx, global, "inputMethod", JS_DupValue(ctx, client.api)) >= 0;
    JS_FreeValue(ctx, global);
    return ok;
}
int pu_input_client_pump(void)
{
    if (!client.ctx) return 0;
    if (client.display && wl_display_get_error(client.display)) failure("Input-method connection closed");
    if (client.error[0]) { fprintf(stderr, "[ime] %s\n", client.error); return -1; }
    Uint64 now = SDL_GetTicks();
    if (client.repeat_key >= 0 && client.active && client.repeat_rate > 0 && now >= client.repeat_at) {
        process_key((uint32_t)now, (uint32_t)client.repeat_key, WL_KEYBOARD_KEY_STATE_PRESSED, true);
        client.repeat_at = now + 1000u / (unsigned)client.repeat_rate;
    }
    if (!client.changed) return 0;
    client.changed = false;
    JSContext *ctx = client.ctx;
    JSValue callback = JS_GetPropertyStr(ctx, client.api, "onchange"), result = JS_UNDEFINED;
    if (JS_IsException(callback)) result = JS_EXCEPTION;
    else if (JS_IsFunction(ctx, callback)) result = JS_Call(ctx, callback, client.api, 0, NULL);
    else if (!JS_IsNull(callback) && !JS_IsUndefined(callback)) result = JS_ThrowTypeError(ctx, "inputMethod.onchange must be a function");
    JS_FreeValue(ctx, callback);
    if (JS_IsException(result)) {
        JSValue error = JS_GetException(ctx);
        const char *message = JS_ToCString(ctx, error);
        fprintf(stderr, "[ime] %s\n", message ? message : "Callback failed");
        JS_FreeCString(ctx, message); JS_FreeValue(ctx, error); return -1;
    }
    JS_FreeValue(ctx, result);
    return 1;
}
void pu_input_client_shutdown(void)
{
    if (!client.ctx) return;
    release_resources();
    JS_FreeValue(client.ctx, client.api);
    memset(&client, 0, sizeof(client));
}
