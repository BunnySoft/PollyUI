#define _POSIX_C_SOURCE 200809L
#include "theme-client.h"
#include "windows.h"
#include "appearance-config.h"
#include "appearance-document.h"
#include "polly-appearance-client.h"
#include <SDL3/SDL.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wayland-client.h>

static struct {
    JSContext *ctx;
    JSValue api;
    struct wl_display *display;
    struct wl_registry *registry;
    struct polly_theme_manager_v1 *manager;
    uint32_t name, revision;
    char *document;
    bool dirty, waiting, changed, failed;
    char error[160];
    Uint64 deadline;
} theme;

static void failed(const char *message)
{
    snprintf(theme.error, sizeof(theme.error), "%s", message);
    theme.failed = theme.changed = true;
    fprintf(stderr, "[theme] %s\n", message);
}
static void theme_changed(void *data, struct polly_theme_manager_v1 *manager, uint32_t revision)
{
    (void)data; (void)manager; (void)revision;
    theme.dirty = true;
}
static void theme_snapshot(void *data, struct polly_theme_manager_v1 *manager, uint32_t revision,
                           int32_t document, uint32_t length)
{
    (void)data; (void)manager;
    theme.waiting = false;
    char *copy = pu_appearance_document_read(document, length);
    close(document);
    if (!copy) { failed("Cannot read immutable desktop theme snapshot"); return; }
    free(theme.document); theme.document = copy;
    theme.revision = revision; theme.changed = true;
}
static void theme_unavailable(void *data, struct polly_theme_manager_v1 *manager, uint32_t revision)
{
    (void)data; (void)manager;
    theme.waiting = false;
    free(theme.document); theme.document = NULL;
    theme.revision = revision; theme.changed = true;
}
static const struct polly_theme_manager_v1_listener listener = {
    .changed = theme_changed, .snapshot = theme_snapshot, .unavailable = theme_unavailable,
};
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version)
{
    (void)data; (void)version;
    if (theme.manager || strcmp(interface, "polly_theme_manager_v1")) return;
    theme.name = name;
    theme.manager = wl_registry_bind(registry, name, &polly_theme_manager_v1_interface, 1);
    if (!theme.manager || polly_theme_manager_v1_add_listener(theme.manager, &listener, NULL) < 0)
        failed("Cannot subscribe to compositor theme data");
}
static void removed(void *data, struct wl_registry *registry, uint32_t name)
{
    (void)data; (void)registry;
    if (name == theme.name) failed("Desktop theme provider disappeared");
}
static const struct wl_registry_listener registry_listener = { .global = global, .global_remove = removed };
static void request_snapshot(void)
{
    if (!theme.manager || theme.failed || !theme.dirty || theme.waiting) return;
    theme.dirty = false; theme.waiting = true;
    theme.deadline = SDL_GetTicks() + 5000;
    polly_theme_manager_v1_get_snapshot(theme.manager);
    if (wl_display_flush(theme.display) < 0 && errno != EAGAIN && errno != EINTR)
        failed("Cannot request desktop theme snapshot");
}
static void stop(void)
{
    if (theme.manager) polly_theme_manager_v1_destroy(theme.manager);
    if (theme.registry) wl_registry_destroy(theme.registry);
    theme.manager = NULL; theme.registry = NULL; theme.display = NULL;
    free(theme.document); theme.document = NULL;
    theme.name = theme.revision = 0;
    theme.dirty = theme.waiting = theme.failed = false; theme.changed = true;
    theme.error[0] = 0;
}
static JSValue start_subscription(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (theme.manager && !theme.failed) return JS_UNDEFINED;
    stop();
    theme.display = SDL_GetPointerProperty(SDL_GetGlobalProperties(), SDL_PROP_GLOBAL_VIDEO_WAYLAND_WL_DISPLAY_POINTER, NULL);
    if (!theme.display) return JS_ThrowTypeError(ctx, "Desktop theme subscription requires Wayland");
    theme.registry = wl_display_get_registry(theme.display);
    if (!theme.registry || wl_registry_add_listener(theme.registry, &registry_listener, NULL) < 0 ||
        !pu_desktop_wayland_roundtrip(theme.display) || !theme.manager || theme.failed) {
        stop(); return JS_ThrowTypeError(ctx, "This compositor does not provide desktop theme subscriptions");
    }
    if (!pu_desktop_wayland_roundtrip(theme.display)) {
        stop(); return JS_ThrowInternalError(ctx, "Cannot read initial theme notification");
    }
    request_snapshot();
    if (!pu_desktop_wayland_roundtrip(theme.display) || theme.waiting || theme.failed) {
        stop(); return JS_ThrowInternalError(ctx, "Cannot read initial desktop theme snapshot");
    }
    return JS_UNDEFINED;
}
static JSValue stop_subscription(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{ (void)ctx; (void)self; (void)argc; (void)argv; stop(); return JS_UNDEFINED; }
static JSValue snapshot(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    JSValue value = JS_NewObject(ctx);
    if (JS_IsException(value)) return value;
    if (JS_SetPropertyStr(ctx, value, "available", JS_NewBool(ctx, theme.manager && !theme.failed)) < 0 ||
        JS_SetPropertyStr(ctx, value, "ready", JS_NewBool(ctx, theme.document && !theme.failed)) < 0 ||
        JS_SetPropertyStr(ctx, value, "revision", JS_NewUint32(ctx, theme.revision)) < 0 ||
        JS_SetPropertyStr(ctx, value, "document", theme.document ? JS_NewString(ctx, theme.document) : JS_NULL) < 0 ||
        JS_SetPropertyStr(ctx, value, "error", JS_NewString(ctx, theme.error)) < 0) {
        JS_FreeValue(ctx, value); return JS_EXCEPTION;
    }
    return value;
}
int pu_theme_client_install(JSContext *ctx, JSValueConst api)
{
    theme.ctx = ctx; theme.api = JS_DupValue(ctx, api);
    return JS_SetPropertyStr(ctx, api, "startThemeSubscription", JS_NewCFunction(ctx, start_subscription, "startThemeSubscription", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "stopThemeSubscription", JS_NewCFunction(ctx, stop_subscription, "stopThemeSubscription", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "desktopThemeState", JS_NewCFunction(ctx, snapshot, "desktopThemeState", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "onDesktopThemeChanged", JS_NULL) >= 0;
}
int pu_theme_client_pump(void)
{
    if (!theme.ctx) return 0;
    if (theme.display && !theme.failed && wl_display_get_error(theme.display)) failed("Desktop theme connection failed");
    if (theme.waiting && !theme.failed && SDL_GetTicks() >= theme.deadline) failed("Desktop theme snapshot timed out");
    request_snapshot();
    if (!theme.changed) return 0;
    theme.changed = false;
    JSValue callback = JS_GetPropertyStr(theme.ctx, theme.api, "onDesktopThemeChanged"), result = JS_UNDEFINED;
    if (JS_IsException(callback)) result = JS_EXCEPTION;
    else if (JS_IsFunction(theme.ctx, callback)) result = JS_Call(theme.ctx, callback, theme.api, 0, NULL);
    else if (!JS_IsNull(callback) && !JS_IsUndefined(callback))
        result = JS_ThrowTypeError(theme.ctx, "Desktop theme callback must be a function");
    JS_FreeValue(theme.ctx, callback);
    if (JS_IsException(result)) {
        JSValue error = JS_GetException(theme.ctx);
        const char *message = JS_ToCString(theme.ctx, error);
        fprintf(stderr, "[theme] Callback failed: %s\n", message ? message : "unknown");
        JS_FreeCString(theme.ctx, message); JS_FreeValue(theme.ctx, error);
    } else JS_FreeValue(theme.ctx, result);
    return 1;
}
void pu_theme_client_shutdown(void)
{
    stop();
    if (theme.ctx) JS_FreeValue(theme.ctx, theme.api);
    memset(&theme, 0, sizeof(theme));
}
