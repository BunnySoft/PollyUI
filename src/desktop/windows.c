#include "desktop/windows.h"
#include "desktop/shortcut-client.h"
#include "desktop/output-client.h"
#include "foreign-toplevel-client.h"
#include "polly-appearance-client.h"
#include "decoration-themes.h"
#include "ext-workspace-client.h"
#include "polly-workspace-toplevel-client.h"

#include <SDL3/SDL.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
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
    struct wl_display *display;
    struct zwlr_foreign_toplevel_manager_v1 *manager;
    struct wl_seat *seat;
    struct polly_appearance_v1 *appearance;
    struct ext_workspace_manager_v1 *workspace_manager;
    struct ext_workspace_group_handle_v1 *workspace_group;
    struct polly_workspace_toplevel_manager_v1 *workspace_toplevels;
    struct DesktopWorkspace *workspaces;
    struct DesktopWindow *windows;
    uint32_t next_id;
    uint32_t next_workspace, workspace_capabilities;
    int workspaces_changed, workspaces_ready;
    int changed, failed, ready;
} control;

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
    if (!control.manager && version >= 3 && !strcmp(interface, "zwlr_foreign_toplevel_manager_v1")) {
        control.manager = wl_registry_bind(registry, name, &zwlr_foreign_toplevel_manager_v1_interface, 3);
        if (!control.manager ||
            zwlr_foreign_toplevel_manager_v1_add_listener(control.manager, &manager_listener, NULL) < 0)
            control.failed = control.changed = 1;
    } else if (!control.appearance && !strcmp(interface, "polly_appearance_v1")) {
        control.appearance = wl_registry_bind(registry, name, &polly_appearance_v1_interface, 1);
        if (!control.appearance) control.failed = control.changed = 1;
    } else if (!control.workspace_manager && !strcmp(interface, "ext_workspace_manager_v1")) {
        control.workspace_manager = wl_registry_bind(registry, name, &ext_workspace_manager_v1_interface, 1);
        if (!control.workspace_manager ||
            ext_workspace_manager_v1_add_listener(control.workspace_manager, &workspace_manager_listener, NULL) < 0)
            control.failed = control.changed = 1;
    } else if (!control.workspace_toplevels && !strcmp(interface, "polly_workspace_toplevel_manager_v1")) {
        control.workspace_toplevels = wl_registry_bind(registry, name, &polly_workspace_toplevel_manager_v1_interface, 1);
        if (!control.workspace_toplevels) control.failed = control.changed = 1;
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
    if (!pu_shortcut_client_install(ctx, api)) return 0;
    if (!pu_output_client_install(ctx, api)) return 0;
    if (!property(ctx, api, "windows", JS_NewCFunction(ctx, windows, "windows", 0))) return 0;
    if (!property(ctx, api, "setAppearance", JS_NewCFunction(ctx, set_appearance, "setAppearance", 1))) return 0;
    if (!property(ctx, api, "workspaces", JS_NewCFunction(ctx, workspaces, "workspaces", 0)) ||
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
    int worked = pu_shortcut_client_pump();
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
    pu_shortcut_client_shutdown();
    pu_output_client_shutdown();
    disconnect_control();
    if (control.ctx) JS_FreeValue(control.ctx, control.api);
    memset(&control, 0, sizeof(control));
}
