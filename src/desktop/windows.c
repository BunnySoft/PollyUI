#include "desktop/windows.h"
#include "desktop/applications.h"
#include "desktop/shortcut-client.h"
#include "desktop/output-client.h"
#include "desktop/theme-files.h"
#include "desktop/theme-client.h"
#include "foreign-toplevel-client.h"
#include "polly-appearance-client.h"
#include "decoration-themes.h"
#include "appearance-document.h"
#include "ext-workspace-client.h"
#include "polly-workspace-toplevel-client.h"
#include "polly-session-status-client.h"

#include <SDL3/SDL.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <wayland-client.h>

struct DesktopWorkspace {
    struct DesktopWorkspace *next;
    struct ext_workspace_handle_v1 *handle;
    uint32_t id, state, capabilities, order;
    uint32_t pending_state, pending_capabilities, pending_order;
    char *name, *pending_name;
    int ready, removed;
};

struct DesktopWindow {
    struct zwlr_foreign_toplevel_handle_v1 *handle;
    struct DesktopWindow *next;
    uint32_t id, state;
    char *title, *app_id;
    char *pending_title, *pending_app_id;
    uint32_t pending_state;
    int ready, state_changed;
    struct polly_workspace_toplevel_v1 *workspace_handle;
    struct DesktopWorkspace *workspace, *pending_workspace;
    int workspace_ready, workspace_changed;
};

static struct {
    JSContext *ctx;
    JSValue api;
    JSValue exit_windows;
    uint32_t exit_window_count;
    struct wl_display *display;
    struct zwlr_foreign_toplevel_manager_v1 *manager;
    struct wl_seat *seat;
    struct polly_appearance_v1 *appearance;
    struct polly_session_status_v1 *session_status;
    uint32_t status_serial, status_reply, input_method_state;
    uint32_t exit_serial, exit_reply, exit_phase, exit_pending;
    bool logout_requested;
    struct ext_workspace_manager_v1 *workspace_manager;
    struct ext_workspace_group_handle_v1 *workspace_group;
    struct polly_workspace_toplevel_manager_v1 *workspace_toplevels;
    struct DesktopWorkspace *workspaces;
    struct DesktopWindow *windows;
    uint32_t next_id;
    uint32_t next_workspace, workspace_capabilities;
    int workspaces_changed, workspaces_ready;
    int changed, failed, ready;
    uint32_t appearance_serial, appearance_reply;
    int appearance_phase, appearance_accepted;
    char appearance_error[192];
    uint32_t restore_serial, restore_reply, restore_result;
    char restore_error[192];
} control;

static void session_status(void *data, struct polly_session_status_v1 *status, uint32_t serial, uint32_t input_method)
{
    (void)data; (void)status;
    if (serial != control.status_serial) return;
    control.status_reply = serial;
    control.input_method_state = input_method;
}
static void session_exit_status(void *data, struct polly_session_status_v1 *status,
                                uint32_t serial, uint32_t phase, uint32_t pending)
{
    (void)data; (void)status;
    if (serial != control.exit_serial) return;
    control.exit_reply = serial;
    control.exit_phase = phase;
    control.exit_pending = pending;
}
static void session_exit_window(void *data, struct polly_session_status_v1 *status,
                                uint32_t serial, const char *title, const char *app_id)
{
    (void)data; (void)status;
    if (serial != control.exit_serial) return;
    if (control.exit_window_count >= 256) { control.failed = 1; return; }
    JSValue item = JS_NewObject(control.ctx);
    if (JS_IsException(item)) { control.failed = 1; return; }
    if (JS_SetPropertyStr(control.ctx, item, "title", JS_NewString(control.ctx, title)) < 0 ||
        JS_SetPropertyStr(control.ctx, item, "appId", JS_NewString(control.ctx, app_id)) < 0) {
        JS_FreeValue(control.ctx, item); control.failed = 1; return;
    }
    if (JS_SetPropertyUint32(control.ctx, control.exit_windows, control.exit_window_count++, item) < 0)
        control.failed = 1;
}
static void logout_requested(void *data, struct polly_session_status_v1 *status)
{ (void)data; (void)status; control.logout_requested = true; }
static const struct polly_session_status_v1_listener session_status_listener = {
    .status = session_status, .session_exit_status = session_exit_status,
    .session_exit_window = session_exit_window,
    .logout_requested = logout_requested,
};

static void workspace_restored(void *data, struct polly_workspace_toplevel_manager_v1 *manager,
                               uint32_t serial, uint32_t result, const char *message)
{
    (void)data; (void)manager;
    if (serial != control.restore_serial) return;
    control.restore_reply = serial;
    control.restore_result = result;
    snprintf(control.restore_error, sizeof(control.restore_error), "%s", message);
}
static const struct polly_workspace_toplevel_manager_v1_listener workspace_control_listener = {
    .restored = workspace_restored,
};

static void appearance_prepared(void *data, struct polly_appearance_v1 *appearance,
                                uint32_t serial, uint32_t accepted, const char *message)
{
    (void)data; (void)appearance;
    if (serial != control.appearance_serial) return;
    control.appearance_reply = serial;
    control.appearance_phase = 1;
    control.appearance_accepted = accepted == 1;
    snprintf(control.appearance_error, sizeof(control.appearance_error), "%s", message);
}
static void appearance_applied(void *data, struct polly_appearance_v1 *appearance,
                               uint32_t serial, uint32_t accepted, const char *message)
{
    appearance_prepared(data, appearance, serial, accepted, message);
    if (serial == control.appearance_serial) control.appearance_phase = 2;
}
static const struct polly_appearance_v1_listener appearance_listener = {
    .prepared = appearance_prepared, .applied = appearance_applied,
};

static void workspace_membership(void *data, struct polly_workspace_toplevel_v1 *handle,
                                 struct ext_workspace_handle_v1 *workspace)
{
    (void)handle;
    struct DesktopWindow *window = data;
    window->pending_workspace = workspace ? ext_workspace_handle_v1_get_user_data(workspace) : NULL;
    window->workspace_changed = 1;
}

static void workspace_window_closed(void *data, struct polly_workspace_toplevel_v1 *handle)
{
    struct DesktopWindow *window = data;
    polly_workspace_toplevel_v1_destroy(handle);
    window->workspace_handle = NULL;
    window->workspace = window->pending_workspace = NULL;
    window->workspace_ready = window->workspace_changed = 0;
    control.changed = 1;
}

static const struct polly_workspace_toplevel_v1_listener membership_listener = {
    .workspace = workspace_membership, .closed = workspace_window_closed,
};

static void watch_workspace(struct DesktopWindow *window)
{
    if (window->workspace_handle || !control.workspace_manager || !control.workspace_toplevels) return;
    window->workspace_handle = polly_workspace_toplevel_manager_v1_get_toplevel(
        control.workspace_toplevels, window->handle, control.workspace_manager);
    if (!window->workspace_handle ||
        polly_workspace_toplevel_v1_add_listener(window->workspace_handle, &membership_listener, window) < 0)
        control.failed = control.changed = 1;
}

static void workspace_id(void *data, struct ext_workspace_handle_v1 *handle, const char *id)
{ (void)data; (void)handle; (void)id; }
static void workspace_name(void *data, struct ext_workspace_handle_v1 *handle, const char *name)
{
    (void)handle;
    struct DesktopWorkspace *workspace = data;
    char *copy = strdup(name);
    if (!copy) { control.failed = control.workspaces_changed = 1; return; }
    free(workspace->pending_name); workspace->pending_name = copy;
}
static void workspace_coordinates(void *data, struct ext_workspace_handle_v1 *handle, struct wl_array *coordinates)
{
    (void)handle;
    struct DesktopWorkspace *workspace = data;
    if (coordinates->size == sizeof(uint32_t)) memcpy(&workspace->pending_order, coordinates->data, sizeof(uint32_t));
    else { control.failed = control.workspaces_changed = 1; }
}
static void workspace_state(void *data, struct ext_workspace_handle_v1 *handle, uint32_t state)
{ (void)handle; ((struct DesktopWorkspace *)data)->pending_state = state; }
static void workspace_capabilities(void *data, struct ext_workspace_handle_v1 *handle, uint32_t capabilities)
{ (void)handle; ((struct DesktopWorkspace *)data)->pending_capabilities = capabilities; }
static void workspace_removed(void *data, struct ext_workspace_handle_v1 *handle)
{ (void)handle; ((struct DesktopWorkspace *)data)->removed = 1; }
static const struct ext_workspace_handle_v1_listener workspace_listener = {
    .id = workspace_id, .name = workspace_name, .coordinates = workspace_coordinates,
    .state = workspace_state, .capabilities = workspace_capabilities, .removed = workspace_removed,
};

static void new_workspace(void *data, struct ext_workspace_manager_v1 *manager, struct ext_workspace_handle_v1 *handle)
{
    (void)data; (void)manager;
    struct DesktopWorkspace *workspace = calloc(1, sizeof(*workspace));
    if (!workspace || control.next_workspace == UINT32_MAX) {
        free(workspace); ext_workspace_handle_v1_destroy(handle);
        control.failed = control.workspaces_changed = 1;
        return;
    }
    workspace->id = ++control.next_workspace;
    workspace->handle = handle;
    workspace->next = control.workspaces;
    control.workspaces = workspace;
    if (ext_workspace_handle_v1_add_listener(handle, &workspace_listener, workspace) < 0)
        control.failed = control.workspaces_changed = 1;
}

static void group_capabilities(void *data, struct ext_workspace_group_handle_v1 *group, uint32_t caps)
{ (void)data; (void)group; control.workspace_capabilities = caps; }
static void group_output(void *data, struct ext_workspace_group_handle_v1 *group, struct wl_output *output)
{ (void)data; (void)group; (void)output; }
static void group_workspace(void *data, struct ext_workspace_group_handle_v1 *group, struct ext_workspace_handle_v1 *workspace)
{ (void)data; (void)group; (void)workspace; }
static void group_removed(void *data, struct ext_workspace_group_handle_v1 *group)
{
    (void)data;
    ext_workspace_group_handle_v1_destroy(group);
    control.workspace_group = NULL;
    control.failed = control.workspaces_changed = 1;
}
static const struct ext_workspace_group_handle_v1_listener group_listener = {
    .capabilities = group_capabilities, .output_enter = group_output, .output_leave = group_output,
    .workspace_enter = group_workspace, .workspace_leave = group_workspace, .removed = group_removed,
};

static void workspace_group(void *data, struct ext_workspace_manager_v1 *manager, struct ext_workspace_group_handle_v1 *group)
{
    (void)data; (void)manager;
    if (control.workspace_group) {
        ext_workspace_group_handle_v1_destroy(group);
        control.failed = control.workspaces_changed = 1;
        return;
    }
    control.workspace_group = group;
    if (ext_workspace_group_handle_v1_add_listener(group, &group_listener, NULL) < 0)
        control.failed = control.workspaces_changed = 1;
}

static void free_workspace(struct DesktopWorkspace *workspace)
{
    ext_workspace_handle_v1_destroy(workspace->handle);
    free(workspace->name); free(workspace->pending_name); free(workspace);
}

static void workspaces_done(void *data, struct ext_workspace_manager_v1 *manager)
{
    (void)data; (void)manager;
    for (struct DesktopWindow *window = control.windows; window; window = window->next) {
        if (!window->workspace_changed) continue;
        window->workspace = window->pending_workspace;
        window->workspace_ready = 1;
        window->workspace_changed = 0;
    }
    struct DesktopWorkspace **link = &control.workspaces;
    while (*link) {
        struct DesktopWorkspace *workspace = *link;
        if (workspace->removed) {
            for (struct DesktopWindow *window = control.windows; window; window = window->next) {
                if (window->workspace == workspace) { window->workspace = NULL; window->workspace_ready = 0; }
                if (window->pending_workspace == workspace) window->pending_workspace = NULL;
            }
            *link = workspace->next;
            free_workspace(workspace);
            continue;
        }
        if (workspace->pending_name) {
            free(workspace->name); workspace->name = workspace->pending_name; workspace->pending_name = NULL;
        }
        workspace->state = workspace->pending_state;
        workspace->capabilities = workspace->pending_capabilities;
        workspace->order = workspace->pending_order;
        workspace->ready = 1;
        link = &workspace->next;
    }
    control.workspaces_ready = control.workspaces_changed = control.changed = 1;
}

static void workspaces_finished(void *data, struct ext_workspace_manager_v1 *manager)
{
    (void)data;
    ext_workspace_manager_v1_destroy(manager);
    control.workspace_manager = NULL;
    control.failed = control.workspaces_changed = 1;
}
static const struct ext_workspace_manager_v1_listener workspace_manager_listener = {
    .workspace_group = workspace_group, .workspace = new_workspace, .done = workspaces_done,
    .finished = workspaces_finished,
};

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
    if (window->workspace_handle) polly_workspace_toplevel_v1_destroy(window->workspace_handle);
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
    watch_workspace(window);
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
    if (pu_shortcut_client_bind(control.display, registry, name, interface)) return;
    if (pu_output_client_bind(control.display, registry, name, interface, version)) return;
    if (!control.session_status && !strcmp(interface, polly_session_status_v1_interface.name)) {
        control.session_status = wl_registry_bind(registry, name, &polly_session_status_v1_interface, version >= 2 ? 2 : 1);
        if (!control.session_status ||
            polly_session_status_v1_add_listener(control.session_status, &session_status_listener, NULL) < 0)
            control.failed = control.changed = 1;
        return;
    }
    if (!control.manager && version >= 3 && !strcmp(interface, "zwlr_foreign_toplevel_manager_v1")) {
        control.manager = wl_registry_bind(registry, name, &zwlr_foreign_toplevel_manager_v1_interface, 3);
        if (!control.manager ||
            zwlr_foreign_toplevel_manager_v1_add_listener(control.manager, &manager_listener, NULL) < 0)
            control.failed = control.changed = 1;
    } else if (!control.appearance && !strcmp(interface, "polly_appearance_v1")) {
        control.appearance = wl_registry_bind(registry, name, &polly_appearance_v1_interface, version < 2 ? version : 2);
        if (!control.appearance ||
            polly_appearance_v1_add_listener(control.appearance, &appearance_listener, NULL) < 0)
            control.failed = control.changed = 1;
    } else if (!control.workspace_manager && !strcmp(interface, "ext_workspace_manager_v1")) {
        control.workspace_manager = wl_registry_bind(registry, name, &ext_workspace_manager_v1_interface, 1);
        if (!control.workspace_manager ||
            ext_workspace_manager_v1_add_listener(control.workspace_manager, &workspace_manager_listener, NULL) < 0)
            control.failed = control.changed = 1;
    } else if (!control.workspace_toplevels && !strcmp(interface, "polly_workspace_toplevel_manager_v1")) {
        control.workspace_toplevels = wl_registry_bind(registry, name, &polly_workspace_toplevel_manager_v1_interface,
            version < 2 ? version : 2);
        if (!control.workspace_toplevels ||
            polly_workspace_toplevel_manager_v1_add_listener(control.workspace_toplevels,
                &workspace_control_listener, NULL) < 0) control.failed = control.changed = 1;
    } else if (!control.seat && !strcmp(interface, "wl_seat")) {
        control.seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
        if (!control.seat || wl_seat_add_listener(control.seat, &seat_listener, NULL) < 0)
            control.failed = control.changed = 1;
    }
    for (struct DesktopWindow *window = control.windows; window; window = window->next) watch_workspace(window);
}
static void removed(void *data, struct wl_registry *registry, uint32_t name)
{ (void)data; (void)registry; (void)name; }
static const struct wl_registry_listener registry_listener = { global, removed };
static void synced(void *data, struct wl_callback *callback, uint32_t serial)
{ (void)callback; (void)serial; *(int *)data = 1; }
static const struct wl_callback_listener sync_listener = { .done = synced };

int pu_desktop_wayland_roundtrip(struct wl_display *display)
{
    if (!display) return 0;
    int complete = 0;
    struct wl_callback *callback = wl_display_sync(display);
    if (!callback) return 0;
    if (wl_callback_add_listener(callback, &sync_listener, &complete) < 0) {
        wl_callback_destroy(callback);
        return 0;
    }
    Uint64 start = SDL_GetTicks();
    while (!complete && SDL_GetTicks() - start < 3000) {
        if (wl_display_flush(display) < 0 && errno != EAGAIN && errno != EINTR) break;
        SDL_PumpEvents();
        if (wl_display_get_error(display)) break;
        if (!complete) SDL_Delay(1);
    }
    wl_callback_destroy(callback);
    return complete && !wl_display_get_error(display);
}

static int roundtrip(void)
{ return pu_desktop_wayland_roundtrip(control.display) && !control.failed; }

static void disconnect_control(void)
{
    while (control.windows) closed(control.windows, control.windows->handle);
    while (control.workspaces) {
        struct DesktopWorkspace *next = control.workspaces->next;
        free_workspace(control.workspaces); control.workspaces = next;
    }
    if (control.workspace_group) ext_workspace_group_handle_v1_destroy(control.workspace_group);
    if (control.workspace_manager) {
        ext_workspace_manager_v1_stop(control.workspace_manager);
        ext_workspace_manager_v1_destroy(control.workspace_manager);
    }
    if (control.workspace_toplevels) polly_workspace_toplevel_manager_v1_destroy(control.workspace_toplevels);
    control.workspace_manager = NULL; control.workspace_group = NULL; control.workspace_toplevels = NULL;
    control.workspaces_ready = control.workspaces_changed = 0;
    if (control.manager) {
        zwlr_foreign_toplevel_manager_v1_stop(control.manager);
        zwlr_foreign_toplevel_manager_v1_destroy(control.manager);
    }
    if (control.seat) wl_seat_destroy(control.seat);
    if (control.appearance) polly_appearance_v1_destroy(control.appearance);
    if (control.session_status) polly_session_status_v1_destroy(control.session_status);
    control.session_status = NULL;
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

int pu_desktop_windows_ready(JSContext *ctx) { return ensure_control(ctx); }
int pu_desktop_windows_roundtrip(void) { return roundtrip(); }

static JSValue services(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ensure_control(ctx)) return JS_EXCEPTION;
    if (!control.session_status) return JS_ThrowTypeError(ctx, "Session status requires the trusted PollyWM connection");
    if (!++control.status_serial) ++control.status_serial;
    control.status_reply = 0;
    polly_session_status_v1_inspect(control.session_status, control.status_serial);
    if (!roundtrip() || control.status_reply != control.status_serial)
        return JS_ThrowInternalError(ctx, "Session status was not acknowledged");
    const char *states[] = { "disabled", "starting", "ready", "failed" };
    if (control.input_method_state >= sizeof(states) / sizeof(states[0]))
        return JS_ThrowInternalError(ctx, "Invalid session service state");
    JSValue result = JS_NewObject(ctx);
    if (JS_IsException(result)) return result;
    if (!property(ctx, result, "inputMethod", JS_NewString(ctx, states[control.input_method_state]))) {
        JS_FreeValue(ctx, result); return JS_EXCEPTION;
    }
    return result;
}

static int ensure_workspaces(JSContext *ctx)
{
    if (!ensure_control(ctx)) return 0;
    if (!control.workspace_manager || !control.workspace_group || !control.workspace_toplevels) {
        JS_ThrowTypeError(ctx, "Workspace management requires the trusted PollyWM connection");
        return 0;
    }
    if (!control.workspaces_ready && (!roundtrip() || !control.workspaces_ready)) {
        JS_ThrowInternalError(ctx, "Workspace discovery failed");
        return 0;
    }
    return 1;
}

static struct DesktopWorkspace *find_workspace(JSContext *ctx, JSValueConst value)
{
    double id;
    if (!JS_IsNumber(value)) { JS_ThrowTypeError(ctx, "A live workspace ID is required"); return NULL; }
    if (JS_ToFloat64(ctx, &id, value) < 0) return NULL;
    if (!(id > 0 && id <= UINT32_MAX) || id != (uint32_t)id) {
        JS_ThrowTypeError(ctx, "Invalid workspace ID"); return NULL;
    }
    for (struct DesktopWorkspace *workspace = control.workspaces; workspace; workspace = workspace->next)
        if (workspace->id == (uint32_t)id && workspace->ready && !workspace->removed) return workspace;
    JS_ThrowTypeError(ctx, "Workspace no longer exists");
    return NULL;
}

static JSValue workspace_commit(JSContext *ctx)
{
    ext_workspace_manager_v1_commit(control.workspace_manager);
    if (wl_display_flush(control.display) < 0 && errno != EAGAIN && errno != EINTR)
        return JS_ThrowInternalError(ctx, "Cannot send workspace request");
    return JS_UNDEFINED;
}

static JSValue workspaces(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ensure_workspaces(ctx)) return JS_EXCEPTION;
    JSValue result = JS_NewArray(ctx);
    if (JS_IsException(result)) return result;
    uint32_t index = 0;
    for (struct DesktopWorkspace *workspace = control.workspaces; workspace; workspace = workspace->next) {
        if (!workspace->ready) continue;
        JSValue item = JS_NewObject(ctx);
        if (JS_IsException(item)) { JS_FreeValue(ctx, result); return item; }
        if (!property(ctx, item, "id", JS_NewUint32(ctx, workspace->id)) ||
            !property(ctx, item, "name", JS_NewString(ctx, workspace->name ? workspace->name : "")) ||
            !property(ctx, item, "order", JS_NewUint32(ctx, workspace->order)) ||
            !property(ctx, item, "active", JS_NewBool(ctx, workspace->state & EXT_WORKSPACE_HANDLE_V1_STATE_ACTIVE)) ||
            !property(ctx, item, "canRemove", JS_NewBool(ctx,
                workspace->capabilities & EXT_WORKSPACE_HANDLE_V1_WORKSPACE_CAPABILITIES_REMOVE))) {
            JS_FreeValue(ctx, item); JS_FreeValue(ctx, result); return JS_EXCEPTION;
        }
        if (JS_SetPropertyUint32(ctx, result, index++, item) < 0) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    }
    return result;
}

static JSValue workspace_action(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int remove)
{
    (void)self;
    if (!ensure_workspaces(ctx)) return JS_EXCEPTION;
    struct DesktopWorkspace *workspace = find_workspace(ctx, argc ? argv[0] : JS_UNDEFINED);
    if (!workspace) return JS_EXCEPTION;
    uint32_t capability = remove ? EXT_WORKSPACE_HANDLE_V1_WORKSPACE_CAPABILITIES_REMOVE :
        EXT_WORKSPACE_HANDLE_V1_WORKSPACE_CAPABILITIES_ACTIVATE;
    if (!(workspace->capabilities & capability))
        return JS_ThrowTypeError(ctx, remove ? "Cannot remove the last workspace" : "Workspace cannot be activated");
    if (remove) ext_workspace_handle_v1_remove(workspace->handle);
    else ext_workspace_handle_v1_activate(workspace->handle);
    return workspace_commit(ctx);
}

static JSValue create_workspace(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!ensure_workspaces(ctx)) return JS_EXCEPTION;
    if (!(control.workspace_capabilities & EXT_WORKSPACE_GROUP_HANDLE_V1_GROUP_CAPABILITIES_CREATE_WORKSPACE))
        return JS_ThrowTypeError(ctx, "Workspace creation is unavailable");
    if (argc && !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "Workspace name must be a string");
    size_t length = 0;
    const char *name = argc ? JS_ToCStringLen(ctx, &length, argv[0]) : NULL;
    if (argc && !name) return JS_EXCEPTION;
    if (length > 128 || (name && memchr(name, 0, length))) {
        JS_FreeCString(ctx, name);
        return JS_ThrowRangeError(ctx, "Workspace name must be at most 128 UTF-8 bytes without NUL");
    }
    ext_workspace_group_handle_v1_create_workspace(control.workspace_group, name ? name : "");
    JS_FreeCString(ctx, name);
    return workspace_commit(ctx);
}

static int ensure_workspace_settings(JSContext *ctx)
{
    if (!ensure_workspaces(ctx)) return 0;
    if (polly_workspace_toplevel_manager_v1_get_version(control.workspace_toplevels) < 2) {
        JS_ThrowTypeError(ctx, "Workspace preferences require PollyWM workspace protocol version 2");
        return 0;
    }
    return 1;
}

static const char *workspace_setting_name(JSContext *ctx, JSValueConst value, size_t *length)
{
    if (!JS_IsString(value)) { JS_ThrowTypeError(ctx, "Workspace name must be a string"); return NULL; }
    const char *name = JS_ToCStringLen(ctx, length, value);
    if (!name) return NULL;
    if (!*length || *length > 128 || memchr(name, 0, *length)) {
        JS_FreeCString(ctx, name);
        JS_ThrowRangeError(ctx, "Workspace name must contain 1 to 128 UTF-8 bytes without NUL");
        return NULL;
    }
    return name;
}

static JSValue rename_workspace(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!ensure_workspace_settings(ctx)) return JS_EXCEPTION;
    if (argc != 2) return JS_ThrowTypeError(ctx, "Workspace ID and name are required");
    struct DesktopWorkspace *workspace = find_workspace(ctx, argv[0]);
    if (!workspace) return JS_EXCEPTION;
    size_t length;
    const char *name = workspace_setting_name(ctx, argv[1], &length);
    if (!name) return JS_EXCEPTION;
    polly_workspace_toplevel_manager_v1_rename(control.workspace_toplevels,
        control.workspace_manager, workspace->handle, name);
    JS_FreeCString(ctx, name);
    return workspace_commit(ctx);
}

static JSValue reorder_workspace(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!ensure_workspace_settings(ctx)) return JS_EXCEPTION;
    if (argc != 2) return JS_ThrowTypeError(ctx, "Workspace ID and position are required");
    struct DesktopWorkspace *workspace = find_workspace(ctx, argv[0]);
    if (!workspace) return JS_EXCEPTION;
    double position;
    if (!JS_IsNumber(argv[1]) || JS_ToFloat64(ctx, &position, argv[1]) < 0 ||
        !isfinite(position) || position < 0 || position > UINT32_MAX || position != (uint32_t)position)
        return JS_ThrowRangeError(ctx, "Workspace position must be a nonnegative integer");
    polly_workspace_toplevel_manager_v1_reorder(control.workspace_toplevels,
        control.workspace_manager, workspace->handle, (uint32_t)position);
    return workspace_commit(ctx);
}

static JSValue restore_workspaces(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!ensure_workspace_settings(ctx)) return JS_EXCEPTION;
    if (argc != 2 || !JS_IsArray(argv[0]) || !JS_IsNumber(argv[1]))
        return JS_ThrowTypeError(ctx, "Workspace names and active position are required");
    JSValue count_value = JS_GetPropertyStr(ctx, argv[0], "length");
    uint32_t count;
    int ok = !JS_IsException(count_value) && JS_ToUint32(ctx, &count, count_value) >= 0;
    JS_FreeValue(ctx, count_value);
    if (!ok) return JS_EXCEPTION;
    double active;
    if (!count || count > 1024 * 1024 / 2 ||
        JS_ToFloat64(ctx, &active, argv[1]) < 0 || !isfinite(active) ||
        active < 0 || active >= count || active != (uint32_t)active)
        return JS_ThrowRangeError(ctx, "Invalid workspace preference size or active position");
    const char **names = calloc(count, sizeof(*names));
    if (!names) return JS_ThrowOutOfMemory(ctx);
    size_t bytes = 0;
    uint32_t index = 0;
    for (; index < count; index++) {
        JSValue value = JS_GetPropertyUint32(ctx, argv[0], index);
        size_t length = 0;
        names[index] = JS_IsException(value) ? NULL : workspace_setting_name(ctx, value, &length);
        JS_FreeValue(ctx, value);
        if (!names[index]) break;
        bytes += length + 1;
        if (bytes > 1024 * 1024) {
            JS_ThrowRangeError(ctx, "Workspace restore exceeds 1 MiB");
            break;
        }
    }
    JSValue result = JS_EXCEPTION;
    if (index == count) {
        if (!++control.restore_serial) ++control.restore_serial;
        control.restore_reply = 0;
        polly_workspace_toplevel_manager_v1_restore_begin(control.workspace_toplevels,
            control.workspace_manager, control.restore_serial, (uint32_t)active);
        for (index = 0; index < count; index++)
            ext_workspace_group_handle_v1_create_workspace(control.workspace_group, names[index]);
        ext_workspace_manager_v1_commit(control.workspace_manager);
        if (!roundtrip() || control.restore_reply != control.restore_serial)
            result = JS_ThrowInternalError(ctx, "Workspace restore acknowledgment failed");
        else if (control.restore_result > 1)
            result = JS_ThrowTypeError(ctx, "Workspace restore rejected: %s", control.restore_error);
        else result = JS_NewBool(ctx, control.restore_result == 1);
    }
    for (index = 0; index < count; index++) JS_FreeCString(ctx, names[index]);
    free(names);
    return result;
}

static JSValue move_workspace(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc < 2 || !JS_IsNumber(argv[0])) return JS_ThrowTypeError(ctx, "Window and workspace IDs are required");
    if (!ensure_workspaces(ctx)) return JS_EXCEPTION;
    struct DesktopWorkspace *workspace = find_workspace(ctx, argv[1]);
    if (!workspace) return JS_EXCEPTION;
    double id;
    if (JS_ToFloat64(ctx, &id, argv[0]) < 0) return JS_EXCEPTION;
    if (!(id > 0 && id <= UINT32_MAX) || id != (uint32_t)id) return JS_ThrowTypeError(ctx, "Invalid window ID");
    struct DesktopWindow *window = control.windows;
    while (window && window->id != (uint32_t)id) window = window->next;
    if (!window || !window->ready || !window->workspace_ready || !window->workspace_handle)
        return JS_ThrowTypeError(ctx, "Window workspace is unavailable or closed");
    polly_workspace_toplevel_v1_move_to(window->workspace_handle, workspace->handle);
    return workspace_commit(ctx);
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
        if (control.workspace_manager && (!window->workspace_ready || !window->workspace)) continue;
        JSValue item = JS_NewObject(ctx);
        if (JS_IsException(item)) { JS_FreeValue(ctx, array); return item; }
        if (!property(ctx, item, "id", JS_NewUint32(ctx, window->id)) ||
            !property(ctx, item, "title", JS_NewString(ctx, window->title ? window->title : "")) ||
            !property(ctx, item, "appId", JS_NewString(ctx, window->app_id ? window->app_id : "")) ||
            !property(ctx, item, "workspaceId", JS_NewUint32(ctx, window->workspace ? window->workspace->id : 0)) ||
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

static int exit_request(JSContext *ctx, uint32_t operation)
{
    if (getuid() != 1000 || geteuid() != getuid() || getegid() != getgid() || !ensure_control(ctx)) {
        if (!JS_HasException(ctx)) JS_ThrowTypeError(ctx, "Session exit requires the ordinary trusted Shell");
        return 0;
    }
    if (!control.session_status || polly_session_status_v1_get_version(control.session_status) < 2) {
        JS_ThrowTypeError(ctx, "This compositor does not support save-before-session-exit"); return 0;
    }
    if (!++control.exit_serial) ++control.exit_serial;
    control.exit_reply = 0;
    JS_FreeValue(ctx, control.exit_windows);
    control.exit_windows = JS_NewArray(ctx);
    control.exit_window_count = 0;
    if (JS_IsException(control.exit_windows)) return 0;
    polly_session_status_v1_session_exit(control.session_status, control.exit_serial, operation);
    if (!roundtrip() || control.exit_reply != control.exit_serial) {
        JS_ThrowInternalError(ctx, "Session exit was not acknowledged; the current session is retained");
        return 0;
    }
    if (control.exit_phase >= POLLY_SESSION_STATUS_V1_EXIT_PHASE_DENIED) {
        JS_ThrowTypeError(ctx, "Session exit denied: use the current ordinary Shell, with no active lock or pending windows");
        return 0;
    }
    return 1;
}

static const char *session_profile(JSContext *ctx)
{
    int fd = open("/etc/polly-account-profile", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) {
        if (errno == ENOENT) return "development";
        JS_ThrowInternalError(ctx, "Cannot read the session profile"); return NULL;
    }
    struct stat info;
    char value[16] = {0};
    ssize_t length = read(fd, value, sizeof(value));
    int valid = !fstat(fd, &info) && S_ISREG(info.st_mode) && !info.st_uid &&
        !(info.st_mode & 022) && length > 0 && length < (ssize_t)sizeof(value);
    close(fd);
    if (valid && !strcmp(value, "installed\n")) return "installed";
    if (valid && !strcmp(value, "live\n")) return "live";
    JS_ThrowTypeError(ctx, "Session profile is not a trusted Live or installed profile");
    return NULL;
}

static JSValue session_exit(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int operation)
{
    (void)self; (void)argv;
    if (argc) return JS_ThrowTypeError(ctx, "Session exit operations take no user, session or process arguments");
    const char *profile = session_profile(ctx);
    if (!profile) return JS_EXCEPTION;
    if (operation == POLLY_SESSION_STATUS_V1_EXIT_OPERATION_SEAL && !pu_applications_exit_ready())
        return JS_ThrowTypeError(ctx, "Applications have not exited normally; retain the session and review them");
    if (operation == POLLY_SESSION_STATUS_V1_EXIT_OPERATION_BEGIN) {
        if (!exit_request(ctx, POLLY_SESSION_STATUS_V1_EXIT_OPERATION_INSPECT)) return JS_EXCEPTION;
        pu_applications_begin_exit();
    }
    if (!exit_request(ctx, (uint32_t)operation)) return JS_EXCEPTION;
    if (operation == POLLY_SESSION_STATUS_V1_EXIT_OPERATION_CANCEL) pu_applications_cancel_exit();
    const char *phases[] = { "idle", "waiting", "ready", "committed" };
    JSValue result = pu_applications_exit_snapshot(ctx);
    if (JS_IsException(result)) return result;
    JSValue list = JS_DupValue(ctx, control.exit_windows);
    uint32_t phase = control.exit_phase;
    if (phase == POLLY_SESSION_STATUS_V1_EXIT_PHASE_READY && !pu_applications_exit_ready())
        phase = POLLY_SESSION_STATUS_V1_EXIT_PHASE_WAITING;
    if (JS_IsException(list) || !property(ctx, result, "windows", JS_DupValue(ctx, list)) ||
        !property(ctx, result, "version", JS_NewInt32(ctx, 1)) ||
        !property(ctx, result, "phase", JS_NewString(ctx, phases[phase])) ||
        !property(ctx, result, "pendingWindows", JS_NewUint32(ctx, control.exit_pending)) ||
        !property(ctx, result, "profile", JS_NewString(ctx, profile))) {
        JS_FreeValue(ctx, list); JS_FreeValue(ctx, result); return JS_EXCEPTION;
    }
    JS_FreeValue(ctx, list);
    return result;
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

static int appearance_word(JSContext *ctx, JSValueConst window, const char *name, uint32_t *word,
                           int color, double minimum, double maximum, double scale)
{
    JSValue value = JS_GetPropertyStr(ctx, window, name);
    if (JS_IsException(value)) return 0;
    int valid = 0;
    if (color && JS_IsString(value)) {
        size_t length;
        const char *text = JS_ToCStringLen(ctx, &length, value);
        if (text && length == 7 && text[0] == '#') {
            valid = 1;
            for (size_t i = 1; i < length; i++)
                if (!((text[i] >= '0' && text[i] <= '9') || (text[i] >= 'a' && text[i] <= 'f') ||
                    (text[i] >= 'A' && text[i] <= 'F'))) valid = 0;
            if (valid) *word = 0xff000000u | (uint32_t)strtoul(text + 1, NULL, 16);
        }
        JS_FreeCString(ctx, text);
    } else if (!color && JS_IsNumber(value)) {
        double number;
        if (JS_ToFloat64(ctx, &number, value) == 0 && isfinite(number) && number >= minimum && number <= maximum &&
            fabs(number * scale - round(number * scale)) < 0.000001) {
            *word = (uint32_t)llround(number * scale); valid = 1;
        }
    }
    JS_FreeValue(ctx, value);
    if (!valid && !JS_HasException(ctx)) JS_ThrowTypeError(ctx, "Invalid decoration token: %s", name);
    return valid;
}

static int appearance_choice(JSContext *ctx, JSValueConst window, const char *name,
                             const char *const *choices, size_t count)
{
    JSValue value = JS_GetPropertyStr(ctx, window, name);
    if (JS_IsException(value)) return -1;
    const char *text = JS_IsString(value) ? JS_ToCString(ctx, value) : NULL;
    int result = -1;
    for (size_t i = 0; text && i < count; i++)
        if (!strcmp(text, choices[i])) { result = (int)i; break; }
    JS_FreeCString(ctx, text); JS_FreeValue(ctx, value);
    if (result < 0 && !JS_HasException(ctx)) JS_ThrowTypeError(ctx, "Invalid decoration option: %s", name);
    return result;
}

static int appearance_option(JSContext *ctx, JSValueConst window, const char *name, const char *yes, const char *no)
{
    const char *choices[] = {no, yes};
    return appearance_choice(ctx, window, name, choices, 2);
}

static JSValue configure_appearance(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc != 1 || !JS_IsObject(argv[0])) return JS_ThrowTypeError(ctx, "A validated theme object is required");
    JSValue id = JS_GetPropertyStr(ctx, argv[0], "id");
    JSValue window = JS_GetPropertyStr(ctx, argv[0], "window");
    JSValue serialized = JS_UNDEFINED, envelope = JS_UNDEFINED;
    const char *name = NULL, *document = NULL;
    int document_fd = -1;
    uint32_t words[PU_APPEARANCE_WORDS] = {1};
    if (JS_IsException(id) || JS_IsException(window)) goto invalid;
    size_t length;
    if (!JS_IsString(id) || !(name = JS_ToCStringLen(ctx, &length, id)) ||
        strlen(name) != length || !pu_appearance_identifier(name) || !JS_IsObject(window)) {
        JS_ThrowTypeError(ctx, "Invalid appearance identity or window tokens"); goto invalid;
    }
    int left = appearance_option(ctx, window, "controls", "left", "right");
    if (left < 0) goto invalid;
    int round = appearance_option(ctx, window, "controlShape", "round", "square");
    if (round < 0) goto invalid;
    int stripes = appearance_option(ctx, window, "texture", "pinstripe", "none");
    if (stripes < 0) goto invalid;
    int horizontal = appearance_option(ctx, window, "gradientDir", "horizontal", "vertical");
    if (horizontal < 0) goto invalid;
    const char *families[] = {"sans-serif", "serif", "monospace"}, *alignments[] = {"left", "center", "right"};
    int family = appearance_choice(ctx, window, "fontFamily", families, 3);
    if (family < 0) goto invalid;
    int alignment = appearance_choice(ctx, window, "textAlign", alignments, 3);
    if (alignment < 0) goto invalid;
    JSValue hover = JS_GetPropertyStr(ctx, window, "glyphsOnHoverOnly");
    if (JS_IsException(hover)) goto invalid;
    if (!JS_IsBool(hover)) {
        JS_FreeValue(ctx, hover); JS_ThrowTypeError(ctx, "Glyph visibility requires a boolean"); goto invalid;
    }
    int glyphs_hover = JS_ToBool(ctx, hover);
    JS_FreeValue(ctx, hover);
    JSValue surface_style = JS_GetPropertyStr(ctx, window, "surfaceStyle");
    if (JS_IsException(surface_style)) goto invalid;
    bool has_surface_style = !JS_IsUndefined(surface_style);
    JS_FreeValue(ctx, surface_style);
    int luna = has_surface_style ? appearance_option(ctx, window, "surfaceStyle", "luna", "generic") : 0;
    if (luna < 0) goto invalid;
    words[0] = pu_appearance_schema(luna);
    words[1] = (uint32_t)(left | round << 1 | stripes << 2 | horizontal << 3 |
        family << 4 | glyphs_hover << 6 | alignment << 7 | luna << 9);
    unsigned index = 2;
#define PU_ENCODE_METRIC(type, field, token, minimum, maximum, scale) \
    if (!appearance_word(ctx, window, #token, &words[index++], 0, minimum, maximum, scale)) goto invalid;
    PU_APPEARANCE_METRICS(PU_ENCODE_METRIC)
#undef PU_ENCODE_METRIC
#define PU_ENCODE_COLOR(field) if (!appearance_word(ctx, window, #field, &words[index++], 1, 0, 0, 1)) goto invalid;
    PU_APPEARANCE_COLORS(PU_ENCODE_COLOR)
#undef PU_ENCODE_COLOR
    struct PuDecorationTheme decoded;
    if (!pu_appearance_decode(&decoded, words)) {
        JS_ThrowRangeError(ctx, "Decoration metrics exceed supported bounds"); goto invalid;
    }
    envelope = JS_NewObject(ctx);
    if (JS_IsException(envelope) || !property(ctx, envelope, "schemaVersion", JS_NewInt32(ctx, 1)) ||
        !property(ctx, envelope, "theme", JS_DupValue(ctx, argv[0]))) goto invalid;
    serialized = JS_JSONStringify(ctx, envelope, JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(serialized)) goto invalid;
    document = JS_ToCStringLen(ctx, &length, serialized);
    if (!document) goto invalid;
    if (!length || length > PU_APPEARANCE_DOCUMENT_LIMIT || strlen(document) != length) {
        JS_ThrowRangeError(ctx, "Appearance snapshot exceeds supported size"); goto invalid;
    }
    if (!ensure_control(ctx)) goto invalid;
    if (!control.appearance || polly_appearance_v1_get_version(control.appearance) < 2) {
        JS_ThrowTypeError(ctx, "Runtime themes require PollyWM appearance protocol v2"); goto invalid;
    }
    if (control.appearance_serial == UINT32_MAX) {
        JS_ThrowRangeError(ctx, "Appearance request sequence exhausted"); goto invalid;
    }
    document_fd = pu_appearance_document_create(document, length);
    if (document_fd < 0) {
        JS_ThrowInternalError(ctx, "Cannot create immutable theme snapshot: %s", strerror(errno));
        goto invalid;
    }
    uint32_t serial = ++control.appearance_serial;
    control.appearance_reply = 0; control.appearance_phase = 0;
    control.appearance_accepted = 0; control.appearance_error[0] = 0;
    struct wl_array configuration = { .size = sizeof(words), .alloc = sizeof(words), .data = words };
    polly_appearance_v1_prepare(control.appearance, serial, name, &configuration, document_fd, (uint32_t)length);
    close(document_fd); document_fd = -1;
    bool acknowledged = roundtrip() && control.appearance_reply == serial && control.appearance_phase == 1;
    if (!acknowledged || !control.appearance_accepted) {
        polly_appearance_v1_cancel(control.appearance, serial);
        int flushed = wl_display_flush(control.display);
        bool transport_ok = flushed >= 0 || errno == EAGAIN || errno == EINTR;
        JS_ThrowInternalError(ctx, "Appearance preparation failed: %s",
            *control.appearance_error ? control.appearance_error : "no compositor acknowledgment");
        if (pu_appearance_schema_rejected(words[0], acknowledged && transport_ok,
                                         control.appearance_accepted, control.appearance_error)) {
            JSValue failure = JS_GetException(ctx);
            if (!property(ctx, failure, "code", JS_NewString(ctx, "ERR_APPEARANCE_SCHEMA_REJECTED")) ||
                !property(ctx, failure, "appearanceSchema", JS_NewUint32(ctx, words[0])) ||
                !property(ctx, failure, "compositorMessage", JS_NewString(ctx, control.appearance_error))) {
                JS_FreeValue(ctx, failure);
                goto invalid;
            }
            JS_Throw(ctx, failure);
        }
        goto invalid;
    }
    control.appearance_phase = 0;
    polly_appearance_v1_commit(control.appearance, serial);
    if (!roundtrip() || control.appearance_reply != serial || control.appearance_phase != 2) {
        JS_ThrowInternalError(ctx, "Cannot confirm appearance commit; compositor state may have changed");
        goto invalid;
    }
    if (!control.appearance_accepted) {
        JS_ThrowInternalError(ctx, "Appearance commit rejected: %s", control.appearance_error);
        goto invalid;
    }
    JS_FreeCString(ctx, name); JS_FreeCString(ctx, document);
    JS_FreeValue(ctx, id); JS_FreeValue(ctx, window); JS_FreeValue(ctx, serialized); JS_FreeValue(ctx, envelope);
    return JS_UNDEFINED;
invalid:
    if (document_fd >= 0) close(document_fd);
    JS_FreeCString(ctx, name); JS_FreeCString(ctx, document);
    JS_FreeValue(ctx, id); JS_FreeValue(ctx, window); JS_FreeValue(ctx, serialized); JS_FreeValue(ctx, envelope);
    return JS_EXCEPTION;
}

int pu_desktop_windows_install(JSContext *ctx, JSValueConst api)
{
    control.ctx = ctx;
    control.exit_windows = JS_UNDEFINED;
    control.api = JS_DupValue(ctx, api);
    if (!pu_shortcut_client_install(ctx, api)) return 0;
    if (!pu_output_client_install(ctx, api)) return 0;
    if (!property(ctx, api, "sessionServices", JS_NewCFunction(ctx, services, "sessionServices", 0))) return 0;
    if (!property(ctx, api, "onSessionExitRequested", JS_NULL)) return 0;
    const char *exit_names[] = { "sessionExitState", "beginSessionExit", "cancelSessionExit", "sealSessionExit" };
    for (int i = 0; i < 4; i++)
        if (!property(ctx, api, exit_names[i], JS_NewCFunctionMagic(ctx, session_exit, exit_names[i],
            0, JS_CFUNC_generic_magic, i))) return 0;
    if (!pu_theme_files_install(ctx, api)) return 0;
    if (!pu_theme_client_install(ctx, api)) return 0;
    if (!property(ctx, api, "windows", JS_NewCFunction(ctx, windows, "windows", 0))) return 0;
    if (!property(ctx, api, "setAppearance", JS_NewCFunction(ctx, set_appearance, "setAppearance", 1))) return 0;
    if (!property(ctx, api, "configureAppearance", JS_NewCFunction(ctx, configure_appearance, "configureAppearance", 1))) return 0;
    if (!property(ctx, api, "workspaces", JS_NewCFunction(ctx, workspaces, "workspaces", 0)) ||
        !property(ctx, api, "restoreWorkspaces", JS_NewCFunction(ctx, restore_workspaces, "restoreWorkspaces", 2)) ||
        !property(ctx, api, "renameWorkspace", JS_NewCFunction(ctx, rename_workspace, "renameWorkspace", 2)) ||
        !property(ctx, api, "reorderWorkspace", JS_NewCFunction(ctx, reorder_workspace, "reorderWorkspace", 2)) ||
        !property(ctx, api, "createWorkspace", JS_NewCFunction(ctx, create_workspace, "createWorkspace", 0)) ||
        !property(ctx, api, "activateWorkspace", JS_NewCFunctionMagic(ctx, workspace_action, "activateWorkspace", 1, JS_CFUNC_generic_magic, 0)) ||
        !property(ctx, api, "removeWorkspace", JS_NewCFunctionMagic(ctx, workspace_action, "removeWorkspace", 1, JS_CFUNC_generic_magic, 1)) ||
        !property(ctx, api, "moveWindowToWorkspace", JS_NewCFunction(ctx, move_workspace, "moveWindowToWorkspace", 2)) ||
        !property(ctx, api, "onWorkspacesChanged", JS_NULL)) return 0;
    const char *names[] = { "activateWindow", "minimizeWindow", "restoreWindow", "closeWindow",
        "maximizeWindow", "unmaximizeWindow", "fullscreenWindow", "unfullscreenWindow" };
    for (int i = 0; i < 8; i++)
        if (!property(ctx, api, names[i], JS_NewCFunctionMagic(ctx, action, names[i], 1, JS_CFUNC_generic_magic, i)))
            return 0;
    return property(ctx, api, "onWindowsChanged", JS_NULL);
}

static void notify(const char *name)
{
    JSValue callback = JS_GetPropertyStr(control.ctx, control.api, name);
    JSValue value = JS_UNDEFINED;
    if (JS_IsException(callback)) value = JS_EXCEPTION;
    else if (JS_IsFunction(control.ctx, callback)) value = JS_Call(control.ctx, callback, control.api, 0, NULL);
    if (JS_IsException(value)) {
        JSValue exception = JS_GetException(control.ctx);
        const char *message = JS_ToCString(control.ctx, exception);
        SDL_Log("%s callback failed: %s", name, message ? message : "error");
        JS_FreeCString(control.ctx, message); JS_FreeValue(control.ctx, exception);
    }
    JS_FreeValue(control.ctx, value); JS_FreeValue(control.ctx, callback);
}

int pu_desktop_windows_pump(void)
{
    if (control.ctx && control.logout_requested) {
        control.logout_requested = false;
        notify("onSessionExitRequested");
    }
    int worked = pu_shortcut_client_pump();
    worked += pu_theme_client_pump();
    worked += pu_output_client_pump();
    if (!control.ctx || (!control.changed && !control.workspaces_changed)) return worked;
    int windows = control.changed, workspaces = control.workspaces_changed;
    control.changed = control.workspaces_changed = 0;
    if (workspaces) notify("onWorkspacesChanged");
    if (windows) notify("onWindowsChanged");
    return 1;
}

void pu_desktop_windows_shutdown(void)
{
    pu_theme_files_shutdown();
    pu_theme_client_shutdown();
    pu_shortcut_client_shutdown();
    pu_output_client_shutdown();
    disconnect_control();
    if (control.ctx) {
        JS_FreeValue(control.ctx, control.exit_windows);
        JS_FreeValue(control.ctx, control.api);
    }
    memset(&control, 0, sizeof(control));
}
