#include "desktop/windows.h"
#include "foreign-toplevel-client.h"
#include "polly-appearance-client.h"
#include "decoration-themes.h"

#include <SDL3/SDL.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>

struct DesktopWindow {
    struct zwlr_foreign_toplevel_handle_v1 *handle;
    struct DesktopWindow *next;
    uint32_t id, state;
    char *title, *app_id;
    char *pending_title, *pending_app_id;
    uint32_t pending_state;
    int ready, state_changed;
};

static struct {
    JSContext *ctx;
    JSValue api;
    struct wl_display *display;
    struct zwlr_foreign_toplevel_manager_v1 *manager;
    struct wl_seat *seat;
    struct polly_appearance_v1 *appearance;
    struct DesktopWindow *windows;
    uint32_t next_id;
    int changed, failed, ready;
} control;

static void title(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle, const char *value)
{
    (void)handle;
    struct DesktopWindow *window = data;
    char *copy = strdup(value);
    if (!copy) { control.failed = control.changed = 1; return; }
    free(window->pending_title); window->pending_title = copy;
}
static void app_id(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle, const char *value)
{
    (void)handle;
    struct DesktopWindow *window = data;
    char *copy = strdup(value);
    if (!copy) { control.failed = control.changed = 1; return; }
    free(window->pending_app_id); window->pending_app_id = copy;
}
static void output(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle, struct wl_output *output)
{ (void)data; (void)handle; (void)output; }
static void state(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle, struct wl_array *states)
{
    (void)handle;
    struct DesktopWindow *window = data;
    window->pending_state = 0;
    window->state_changed = 1;
    uint32_t *value;
    wl_array_for_each(value, states) if (*value < 4) window->pending_state |= 1u << *value;
}
static void done(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle)
{
    (void)handle;
    struct DesktopWindow *window = data;
    if (window->pending_title) {
        free(window->title); window->title = window->pending_title; window->pending_title = NULL;
    }
    if (window->pending_app_id) {
        free(window->app_id); window->app_id = window->pending_app_id; window->pending_app_id = NULL;
    }
    if (window->state_changed) { window->state = window->pending_state; window->state_changed = 0; }
    window->ready = 1;
    control.changed = 1;
}
static void closed(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle)
{
    struct DesktopWindow *window = data;
    struct DesktopWindow **link = &control.windows;
    while (*link && *link != window) link = &(*link)->next;
    if (*link) *link = window->next;
    zwlr_foreign_toplevel_handle_v1_destroy(handle);
    free(window->title); free(window->app_id);
    free(window->pending_title); free(window->pending_app_id); free(window);
    control.changed = 1;
}
static void parent(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle,
                   struct zwlr_foreign_toplevel_handle_v1 *parent)
{ (void)data; (void)handle; (void)parent; }
static const struct zwlr_foreign_toplevel_handle_v1_listener window_listener = {
    title, app_id, output, output, state, done, closed, parent,
};
static void new_window(void *data, struct zwlr_foreign_toplevel_manager_v1 *manager,
                       struct zwlr_foreign_toplevel_handle_v1 *handle)
{
    (void)data; (void)manager;
    struct DesktopWindow *window = calloc(1, sizeof(*window));
    if (!window || control.next_id == UINT32_MAX) {
        free(window); control.failed = control.changed = 1;
        zwlr_foreign_toplevel_handle_v1_destroy(handle);
        return;
    }
    window->id = ++control.next_id;
    window->handle = handle;
    window->next = control.windows;
    control.windows = window;
    if (zwlr_foreign_toplevel_handle_v1_add_listener(handle, &window_listener, window) < 0)
        control.failed = control.changed = 1;
}
static void finished(void *data, struct zwlr_foreign_toplevel_manager_v1 *manager)
{
    (void)data;
    zwlr_foreign_toplevel_manager_v1_destroy(manager);
    control.manager = NULL;
    control.failed = control.changed = 1;
}
static const struct zwlr_foreign_toplevel_manager_v1_listener manager_listener = { new_window, finished };
static void capabilities(void *data, struct wl_seat *seat, uint32_t caps)
{ (void)data; (void)seat; (void)caps; }
static const struct wl_seat_listener seat_listener = { .capabilities = capabilities };
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version)
{
    (void)data;
    if (!control.manager && version >= 3 && !strcmp(interface, "zwlr_foreign_toplevel_manager_v1")) {
        control.manager = wl_registry_bind(registry, name, &zwlr_foreign_toplevel_manager_v1_interface, 3);
        if (!control.manager ||
            zwlr_foreign_toplevel_manager_v1_add_listener(control.manager, &manager_listener, NULL) < 0)
            control.failed = control.changed = 1;
    } else if (!control.appearance && !strcmp(interface, "polly_appearance_v1")) {
        control.appearance = wl_registry_bind(registry, name, &polly_appearance_v1_interface, 1);
        if (!control.appearance) control.failed = control.changed = 1;
    } else if (!control.seat && !strcmp(interface, "wl_seat")) {
        control.seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
        if (!control.seat || wl_seat_add_listener(control.seat, &seat_listener, NULL) < 0)
            control.failed = control.changed = 1;
    }
}
static void removed(void *data, struct wl_registry *registry, uint32_t name)
{ (void)data; (void)registry; (void)name; }
static const struct wl_registry_listener registry_listener = { global, removed };
static void synced(void *data, struct wl_callback *callback, uint32_t serial)
{ (void)callback; (void)serial; *(int *)data = 1; }
static const struct wl_callback_listener sync_listener = { .done = synced };

static int roundtrip(void)
{
    int complete = 0;
    struct wl_callback *callback = wl_display_sync(control.display);
    if (!callback) return 0;
    if (wl_callback_add_listener(callback, &sync_listener, &complete) < 0) {
        wl_callback_destroy(callback);
        return 0;
    }
    Uint64 start = SDL_GetTicks();
    while (!complete && !control.failed && SDL_GetTicks() - start < 3000) {
        if (wl_display_flush(control.display) < 0 && errno != EAGAIN && errno != EINTR) break;
        SDL_PumpEvents();
        if (wl_display_get_error(control.display)) break;
        if (!complete) SDL_Delay(1);
    }
    wl_callback_destroy(callback);
    return complete && !control.failed;
}

static void disconnect_control(void)
{
    while (control.windows) closed(control.windows, control.windows->handle);
    if (control.manager) {
        zwlr_foreign_toplevel_manager_v1_stop(control.manager);
        zwlr_foreign_toplevel_manager_v1_destroy(control.manager);
    }
    if (control.seat) wl_seat_destroy(control.seat);
    if (control.appearance) polly_appearance_v1_destroy(control.appearance);
    control.appearance = NULL;
    control.manager = NULL; control.seat = NULL; control.display = NULL;
    control.ready = control.changed = 0;
}

static int ensure_control(JSContext *ctx)
{
    if (control.ready) {
        if (!control.failed && !wl_display_get_error(control.display)) return 1;
        control.failed = 1;
    }
    if (control.failed) { JS_ThrowInternalError(ctx, "Window-management connection failed"); return 0; }
    control.display = SDL_GetPointerProperty(SDL_GetGlobalProperties(),
        SDL_PROP_GLOBAL_VIDEO_WAYLAND_WL_DISPLAY_POINTER, NULL);
    if (!control.display) { JS_ThrowTypeError(ctx, "Window management requires Wayland"); return 0; }
    struct wl_registry *registry = wl_display_get_registry(control.display);
    if (!registry) { JS_ThrowOutOfMemory(ctx); return 0; }
    int ok = wl_registry_add_listener(registry, &registry_listener, NULL) >= 0 &&
        roundtrip() && control.manager && control.seat && roundtrip();
    wl_registry_destroy(registry);
    if (!ok) {
        disconnect_control();
        JS_ThrowTypeError(ctx, "Foreign-toplevel management is unavailable or this connection is unauthorized");
        return 0;
    }
    control.ready = 1;
    return 1;
}

static int property(JSContext *ctx, JSValueConst object, const char *name, JSValue value)
{
    return !JS_IsException(value) && JS_SetPropertyStr(ctx, object, name, value) >= 0;
}

static JSValue windows(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ensure_control(ctx)) return JS_EXCEPTION;
    JSValue array = JS_NewArray(ctx);
    if (JS_IsException(array)) return array;
    uint32_t index = 0;
    for (struct DesktopWindow *window = control.windows; window; window = window->next) {
        if (!window->ready) continue;
        JSValue item = JS_NewObject(ctx);
        if (JS_IsException(item)) { JS_FreeValue(ctx, array); return item; }
        if (!property(ctx, item, "id", JS_NewUint32(ctx, window->id)) ||
            !property(ctx, item, "title", JS_NewString(ctx, window->title ? window->title : "")) ||
            !property(ctx, item, "appId", JS_NewString(ctx, window->app_id ? window->app_id : "")) ||
            !property(ctx, item, "maximized", JS_NewBool(ctx, window->state & 1)) ||
            !property(ctx, item, "minimized", JS_NewBool(ctx, window->state & 2)) ||
            !property(ctx, item, "active", JS_NewBool(ctx, window->state & 4)) ||
            !property(ctx, item, "fullscreen", JS_NewBool(ctx, window->state & 8))) {
            JS_FreeValue(ctx, item); JS_FreeValue(ctx, array); return JS_EXCEPTION;
        }
        if (JS_SetPropertyUint32(ctx, array, index++, item) < 0) {
            JS_FreeValue(ctx, array); return JS_EXCEPTION;
        }
    }
    return array;
}

static JSValue action(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int command)
{
    (void)self;
    if (!argc || !JS_IsNumber(argv[0])) return JS_ThrowTypeError(ctx, "A live window ID is required");
    double id;
    if (JS_ToFloat64(ctx, &id, argv[0]) < 0) return JS_EXCEPTION;
    if (!(id > 0 && id <= UINT32_MAX) || id != (uint32_t)id) return JS_ThrowTypeError(ctx, "Invalid window ID");
    if (!ensure_control(ctx)) return JS_EXCEPTION;
    struct DesktopWindow *window = control.windows;
    while (window && window->id != (uint32_t)id) window = window->next;
    if (!window || !window->ready) return JS_ThrowTypeError(ctx, "Window no longer exists");
    if (command == 0) zwlr_foreign_toplevel_handle_v1_activate(window->handle, control.seat);
    else if (command == 1) zwlr_foreign_toplevel_handle_v1_set_minimized(window->handle);
    else if (command == 2) zwlr_foreign_toplevel_handle_v1_unset_minimized(window->handle);
    else if (command == 3) zwlr_foreign_toplevel_handle_v1_close(window->handle);
    else if (command == 4) zwlr_foreign_toplevel_handle_v1_set_maximized(window->handle);
    else if (command == 5) zwlr_foreign_toplevel_handle_v1_unset_maximized(window->handle);
    else if (command == 6) zwlr_foreign_toplevel_handle_v1_set_fullscreen(window->handle, NULL);
    else zwlr_foreign_toplevel_handle_v1_unset_fullscreen(window->handle);
    if (wl_display_flush(control.display) < 0 && errno != EAGAIN && errno != EINTR)
        return JS_ThrowInternalError(ctx, "Cannot send window-management request");
    return JS_UNDEFINED;
}

static JSValue set_appearance(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!argc || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "An appearance ID is required");
    size_t length;
    const char *name = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!name) return JS_EXCEPTION;
    const char *selected = NULL;
    for (size_t i = 0; i < PU_DECORATION_THEME_COUNT; i++)
        if (strlen(pu_decoration_themes[i].id) == length && !strcmp(name, pu_decoration_themes[i].id))
            selected = pu_decoration_themes[i].id;
    JS_FreeCString(ctx, name);
    if (!selected) return JS_ThrowRangeError(ctx, "Unknown decoration appearance");
    if (!ensure_control(ctx)) return JS_EXCEPTION;
    if (!control.appearance) return JS_ThrowTypeError(ctx, "Appearance selection requires a trusted PollyWM connection");
    polly_appearance_v1_set_theme(control.appearance, selected);
    if (wl_display_flush(control.display) < 0 && errno != EAGAIN && errno != EINTR)
        return JS_ThrowInternalError(ctx, "Cannot send decoration appearance");
    return JS_UNDEFINED;
}

int pu_desktop_windows_install(JSContext *ctx, JSValueConst api)
{
    control.ctx = ctx;
    control.api = JS_DupValue(ctx, api);
    if (!property(ctx, api, "windows", JS_NewCFunction(ctx, windows, "windows", 0))) return 0;
    if (!property(ctx, api, "setAppearance", JS_NewCFunction(ctx, set_appearance, "setAppearance", 1))) return 0;
    const char *names[] = { "activateWindow", "minimizeWindow", "restoreWindow", "closeWindow",
        "maximizeWindow", "unmaximizeWindow", "fullscreenWindow", "unfullscreenWindow" };
    for (int i = 0; i < 8; i++)
        if (!property(ctx, api, names[i], JS_NewCFunctionMagic(ctx, action, names[i], 1, JS_CFUNC_generic_magic, i)))
            return 0;
    return property(ctx, api, "onWindowsChanged", JS_NULL);
}

int pu_desktop_windows_pump(void)
{
    if (!control.ctx || !control.changed) return 0;
    control.changed = 0;
    JSValue callback = JS_GetPropertyStr(control.ctx, control.api, "onWindowsChanged");
    JSValue value = JS_UNDEFINED;
    if (JS_IsException(callback)) value = JS_EXCEPTION;
    else if (JS_IsFunction(control.ctx, callback)) value = JS_Call(control.ctx, callback, control.api, 0, NULL);
    if (JS_IsException(value)) {
        JSValue exception = JS_GetException(control.ctx);
        const char *message = JS_ToCString(control.ctx, exception);
        SDL_Log("Window-list callback failed: %s", message ? message : "error");
        JS_FreeCString(control.ctx, message); JS_FreeValue(control.ctx, exception);
    }
    JS_FreeValue(control.ctx, value); JS_FreeValue(control.ctx, callback);
    return 1;
}

void pu_desktop_windows_shutdown(void)
{
    disconnect_control();
    if (control.ctx) JS_FreeValue(control.ctx, control.api);
    memset(&control, 0, sizeof(control));
}
