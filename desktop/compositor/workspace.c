#include "workspace.h"
#include "server.h"
#include "decoration.h"
#include "ext-workspace-server.h"
#include "polly-workspace-toplevel-server.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wlr/types/wlr_foreign_toplevel_management_v1.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_layer_shell_v1.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>

struct Binding;
struct WorkspaceRef {
    struct wl_list link;
    struct Binding *binding;
    struct PuWorkspace *workspace;
    struct wl_resource *resource;
};
enum Operation { CREATE, ACTIVATE, REMOVE, MOVE, RENAME, REORDER };
struct Pending {
    struct wl_list link;
    enum Operation kind;
    uint32_t workspace;
    uint64_t window;
    struct PuWorkspace *created;
    char *name;
    uint32_t position;
};
struct Binding {
    struct wl_list link, refs, pending;
    struct PuWorkspaces *state;
    struct wl_resource *manager, *group;
    struct wl_resource *restore_reply;
    struct wl_listener restore_destroy;
    uint32_t restore_serial, restore_active;
    size_t restore_bytes;
    const char *restore_error;
};
struct Tracked {
    struct wl_list link;
    struct PuWorkspaces *state;
    struct Binding *binding;
    struct wl_resource *resource, *last_workspace;
    struct wl_resource *toplevel_manager;
    uint64_t window;
    bool sent;
    struct wlr_surface *menu;
    struct PuWorkspace *menu_workspace;
    struct wlr_output *menu_output;
    bool layout_menu;
    uint32_t menu_epoch, last_serial;
    uint32_t placement, pending, capabilities;
    bool placement_sent;
    char placement_message[128];
};
struct Output {
    struct wl_list link;
    struct PuWorkspaces *state;
    struct wlr_output *output;
    struct wl_listener bind, destroy;
};
struct PuWorkspaces {
    struct PuDesktop *desktop;
    struct wl_global *manager, *toplevel_manager;
    struct wl_list workspaces, bindings, tracked, outputs;
    uint32_t next_workspace;
    uint64_t next_window;
    uint32_t next_menu_epoch;
    struct wl_resource *picker_manager;
    struct wl_event_source *picker_timer;
    struct wl_listener picker_keyboard_grab, picker_pointer_grab;
    enum { PICKER_IDLE, PICKER_WAITING, PICKER_OFFERED, PICKER_REGISTERED } picker_phase;
    struct Tracked *picker_target;
    uint64_t picker_window, hover_window;
    struct PuWorkspace *picker_workspace;
    struct wlr_output *picker_output;
    struct wl_resource *picker_view;
    struct wlr_box picker_anchor, picker_bounds;
    uint32_t picker_token, next_picker_token, picker_revision;
    struct wl_resource *system_menu_manager;
    struct Tracked *system_menu_target;
    uint64_t system_menu_window;
    struct PuWorkspace *system_menu_workspace;
    struct wlr_output *system_menu_output;
    struct wlr_box system_menu_anchor, system_menu_bounds, system_menu_box;
    uint32_t system_menu_serial, next_system_menu_serial, system_menu_origin;
    bool system_menu_armed;
    bool used;
};

static const struct ext_workspace_manager_v1_interface manager_impl;
static const struct ext_workspace_handle_v1_interface workspace_impl;
static void broadcast(struct PuWorkspaces *state, struct wl_list *removed);

bool pu_workspace_current(struct PuDesktopView *view)
{ return view->workspace == view->desktop->active_workspace; }

struct PuWorkspace *pu_workspace_at(struct PuDesktop *desktop, uint32_t index)
{
    struct PuWorkspace *workspace;
    wl_list_for_each(workspace, &desktop->workspaces->workspaces, link)
        if (!index--) return workspace;
    return NULL;
}

static struct PuWorkspace *lookup(struct PuWorkspaces *state, uint32_t id)
{
    struct PuWorkspace *workspace;
    wl_list_for_each(workspace, &state->workspaces, link) if (workspace->id == id) return workspace;
    return NULL;
}

static struct PuDesktopView *window_for(struct PuWorkspaces *state, uint64_t id)
{
    struct PuDesktopView *view;
    if (!id) return NULL;
    wl_list_for_each(view, &state->desktop->views, link) if (view->workspace_window == id) return view;
    return NULL;
}

void pu_workspaces_system_menu_cancel(struct PuDesktop *desktop)
{
    struct PuWorkspaces *state = desktop->workspaces;
    if (!state) return;
    if (state->system_menu_target && state->system_menu_serial)
        polly_workspace_toplevel_v1_send_system_menu_cancelled(
            state->system_menu_target->resource, state->system_menu_serial);
    state->system_menu_target = NULL;
    state->system_menu_window = 0;
    state->system_menu_workspace = NULL;
    state->system_menu_output = NULL;
    state->system_menu_serial = 0;
    state->system_menu_armed = false;
}

static struct Tracked *system_menu_target(struct PuDesktopView *view)
{
    struct PuWorkspaces *state = view->desktop->workspaces;
    if (!state || !state->system_menu_manager) return NULL;
    struct Tracked *tracked;
    wl_list_for_each(tracked, &state->tracked, link)
        if (tracked->window == view->workspace_window && tracked->binding && tracked->binding->manager &&
            tracked->toplevel_manager == state->system_menu_manager &&
            wl_resource_get_version(tracked->resource) >= 7) return tracked;
    return NULL;
}

static bool system_menu_current(struct PuWorkspaces *state, bool require_pointer)
{
    struct PuDesktopView *view = window_for(state, state->system_menu_window);
    if (!view || system_menu_target(view) != state->system_menu_target ||
        view->workspace != state->system_menu_workspace) return false;
    struct wlr_box actual = view->presented_box;
    actual.x = view->tree->node.x; actual.y = view->tree->node.y;
    if (!wlr_box_equal(&actual, &state->system_menu_box)) return false;
    struct wlr_box anchor, bounds;
    bool pointer = state->system_menu_origin == POLLY_WORKSPACE_TOPLEVEL_V1_MENU_ORIGIN_TITLE;
    /* The release point is immutable after an offer; later pointer motion is
     * not authority to select a different output or window. */
    struct wlr_output *head = pu_desktop_system_menu_anchor(view, pointer && require_pointer, &anchor, &bounds);
    if (pointer && !require_pointer) {
        struct Output *output;
        head = NULL;
        wl_list_for_each(output, &state->outputs, link)
            if (output->output == state->system_menu_output) {
                head = output->output->enabled ? output->output : NULL;
                if (!head) break;
                wlr_output_layout_get_box(state->desktop->layout, head, &bounds);
                break;
            }
        struct wlr_box ignored_anchor, ignored_bounds;
        if (!pu_desktop_system_menu_anchor(view, false, &ignored_anchor, &ignored_bounds)) return false;
    }
    return head == state->system_menu_output && head &&
        wlr_box_equal(&bounds, &state->system_menu_bounds);
}

void pu_workspaces_system_menu_validate(struct PuDesktop *desktop)
{
    struct PuWorkspaces *state = desktop->workspaces;
    if (state && state->system_menu_target &&
        !system_menu_current(state, state->system_menu_armed))
        pu_workspaces_system_menu_cancel(desktop);
}

static bool prepare_system_menu(struct PuDesktopView *view, bool pointer)
{
    struct PuWorkspaces *state = view->desktop->workspaces;
    if (!state || state->next_system_menu_serial == UINT32_MAX) return false;
    struct Tracked *tracked = system_menu_target(view);
    struct wlr_box anchor, bounds;
    struct wlr_output *head = tracked ? pu_desktop_system_menu_anchor(view, pointer, &anchor, &bounds) : NULL;
    if (!head) return false;
    pu_workspaces_system_menu_cancel(view->desktop);
    state->system_menu_target = tracked;
    state->system_menu_window = view->workspace_window;
    state->system_menu_workspace = view->workspace;
    state->system_menu_output = head;
    state->system_menu_anchor = anchor;
    state->system_menu_bounds = bounds;
    state->system_menu_box = view->presented_box;
    state->system_menu_box.x = view->tree->node.x;
    state->system_menu_box.y = view->tree->node.y;
    state->system_menu_origin = pointer ? POLLY_WORKSPACE_TOPLEVEL_V1_MENU_ORIGIN_TITLE :
        POLLY_WORKSPACE_TOPLEVEL_V1_MENU_ORIGIN_KEYBOARD;
    return true;
}

static void offer_system_menu(struct PuWorkspaces *state)
{
    state->system_menu_serial = ++state->next_system_menu_serial;
    struct wlr_box anchor = state->system_menu_anchor, bounds = state->system_menu_bounds;
    polly_workspace_toplevel_v1_send_system_menu_requested(state->system_menu_target->resource,
        state->system_menu_serial, state->system_menu_origin, anchor.x - bounds.x, anchor.y - bounds.y,
        anchor.width, anchor.height, state->system_menu_output->name,
        bounds.x, bounds.y, bounds.width, bounds.height);
}

bool pu_workspaces_system_menu_arm(struct PuDesktopView *view)
{
    if (!prepare_system_menu(view, true)) return false;
    view->desktop->workspaces->system_menu_armed = true;
    return true;
}

void pu_workspaces_system_menu_release(struct PuDesktop *desktop, struct PuDesktopView *hit)
{
    struct PuWorkspaces *state = desktop->workspaces;
    if (!state || !state->system_menu_armed) return;
    if (!hit || hit->workspace_window != state->system_menu_window || !system_menu_current(state, true)) {
        pu_workspaces_system_menu_cancel(desktop);
        return;
    }
    struct wlr_box anchor, bounds;
    if (pu_desktop_system_menu_anchor(hit, true, &anchor, &bounds) != state->system_menu_output) {
        pu_workspaces_system_menu_cancel(desktop);
        return;
    }
    state->system_menu_anchor = anchor;
    state->system_menu_armed = false;
    offer_system_menu(state);
}

bool pu_workspaces_system_menu_key(struct PuDesktopView *view)
{
    if (!view || !prepare_system_menu(view, false)) return false;
    offer_system_menu(view->desktop->workspaces);
    return true;
}

void pu_workspaces_picker_cancel(struct PuDesktop *desktop)
{
    struct PuWorkspaces *state = desktop->workspaces;
    if (!state) return;
    if (state->picker_phase != PICKER_IDLE)
        wlr_log(WLR_DEBUG, "Retiring native picker phase=%u window=%llu token=%u",
            state->picker_phase, (unsigned long long)state->picker_window, state->picker_token);
    if (state->picker_timer) wl_event_source_remove(state->picker_timer);
    state->picker_timer = NULL;
    struct Tracked *tracked = state->picker_target;
    if (tracked && state->picker_token) {
        polly_workspace_toplevel_v1_send_layout_dismissed(tracked->resource, state->picker_token);
        if (state->picker_phase == PICKER_REGISTERED) {
            tracked->menu = NULL; tracked->menu_workspace = NULL; tracked->menu_epoch = 0;
        }
    }
    state->picker_target = NULL;
    state->picker_window = 0; state->picker_token = 0;
    state->picker_view = NULL; state->picker_output = NULL; state->picker_workspace = NULL;
    state->picker_phase = PICKER_IDLE;
}

static struct PuDesktopView *picker_view(struct PuWorkspaces *state)
{
    struct PuDesktopView *view = window_for(state, state->picker_window);
    return view && view->toplevel->resource == state->picker_view &&
        view->workspace == state->picker_workspace &&
        view->workspace == state->desktop->active_workspace ? view : NULL;
}

void pu_workspaces_picker_validate(struct PuDesktop *desktop)
{
    struct PuWorkspaces *state = desktop->workspaces;
    if (!state || state->picker_phase == PICKER_IDLE) return;
    struct PuDesktopView *view = picker_view(state);
    if (!view || desktop->stopping || !desktop->shell_client ||
        (pu_desktop_placement_check(view, PU_TILE_LEFT) &&
         pu_desktop_placement_check(view, PU_TILE_RIGHT) &&
         pu_desktop_placement_check(view, PU_TILE_NONE))) {
        pu_workspaces_picker_cancel(desktop); return;
    }
    struct wlr_box anchor, bounds;
    if (state->picker_phase == PICKER_WAITING) {
        if (pu_desktop_picker_output(view, &bounds) != state->picker_output ||
            !wlr_box_equal(&bounds, &state->picker_bounds)) pu_workspaces_picker_cancel(desktop);
        return;
    }
    struct Tracked *tracked = state->picker_target;
    bool registered = state->picker_phase == PICKER_REGISTERED;
    if (!tracked || !tracked->binding || !tracked->binding->manager ||
        (registered && (!tracked->menu || !tracked->menu_epoch)) ||
        pu_desktop_picker_anchor(view, registered ? tracked->menu : NULL, false, &anchor, &bounds) != state->picker_output ||
        !wlr_box_equal(&anchor, &state->picker_anchor) || !wlr_box_equal(&bounds, &state->picker_bounds) ||
        (!registered && pu_decoration_presented_revision(view) != state->picker_revision))
        pu_workspaces_picker_cancel(desktop);
}

void pu_workspaces_picker_input(struct PuDesktop *desktop, struct wlr_surface *surface)
{
    struct PuWorkspaces *state = desktop->workspaces;
    if (!state || state->picker_phase == PICKER_IDLE) return;
    if (state->picker_phase == PICKER_REGISTERED && state->picker_target->menu == surface) {
        pu_workspaces_picker_validate(desktop);
        return;
    }
    pu_workspaces_picker_cancel(desktop);
}

static int picker_timeout(void *data)
{
    struct PuWorkspaces *state = data;
    wl_event_source_remove(state->picker_timer);
    state->picker_timer = NULL;
    struct PuDesktopView *view = picker_view(state);
    struct wlr_box anchor, bounds;
    struct Tracked *tracked = NULL, *item;
    if (state->picker_phase == PICKER_WAITING && state->picker_manager && view &&
        pu_desktop_picker_anchor(view, NULL, true, &anchor, &bounds) == state->picker_output &&
        state->picker_output && wlr_box_equal(&bounds, &state->picker_bounds))
        wl_list_for_each(item, &state->tracked, link) {
            if (item->window == state->picker_window && item->binding && item->binding->manager &&
                item->toplevel_manager == state->picker_manager &&
                wl_resource_get_version(item->resource) >= 4) { tracked = item; break; }
        }
    if (!tracked || state->next_picker_token == UINT32_MAX) {
        wlr_log(WLR_DEBUG, "Native picker hover ended without grant: live=%d currentFrame=%u tracked=%d",
            view != NULL, view ? pu_decoration_presented_revision(view) : 0, tracked != NULL);
        pu_workspaces_picker_cancel(state->desktop); return 0;
    }
    state->picker_target = tracked;
    state->picker_anchor = anchor; state->picker_bounds = bounds;
    state->picker_revision = pu_decoration_presented_revision(view);
    state->picker_token = ++state->next_picker_token;
    state->picker_phase = PICKER_OFFERED;
    wlr_log(WLR_DEBUG, "Offering native picker window=%llu token=%u revision=%u",
        (unsigned long long)state->picker_window, state->picker_token, state->picker_revision);
    polly_workspace_toplevel_v1_send_layout_offer(tracked->resource, state->picker_token,
        anchor.x - bounds.x, anchor.y - bounds.y, anchor.width, anchor.height,
        state->picker_output->name, bounds.x, bounds.y, bounds.width, bounds.height);
    return 0;
}

void pu_workspaces_picker_motion(struct PuDesktop *desktop, struct PuDesktopView *view, int part)
{
    struct PuWorkspaces *state = desktop->workspaces;
    if (!state) return;
    pu_workspaces_picker_validate(desktop);
    if (state->picker_phase == PICKER_REGISTERED) return;
    uint64_t window = view && part == PU_DECORATION_MAXIMIZE ? view->workspace_window : 0;
    if (window == state->hover_window) return;
    pu_workspaces_picker_cancel(desktop);
    state->hover_window = window;
    if (!window || !state->picker_manager || !view || !view->mapped || view->minimized ||
        !pu_workspace_current(view)) return;
    struct wlr_box bounds;
    struct wlr_output *head = pu_desktop_picker_output(view, &bounds);
    if (!head) return;
    state->picker_window = window; state->picker_view = view->toplevel->resource;
    state->picker_output = head; state->picker_workspace = view->workspace;
    state->picker_bounds = bounds;
    state->picker_phase = PICKER_WAITING;
    wlr_log(WLR_DEBUG, "Arming native picker window=%llu", (unsigned long long)window);
    state->picker_timer = wl_event_loop_add_timer(wl_display_get_event_loop(desktop->display), picker_timeout, state);
    if (!state->picker_timer || wl_event_source_timer_update(state->picker_timer, 500) < 0) {
        wlr_log(WLR_ERROR, "Cannot schedule native caption picker");
        pu_workspaces_picker_cancel(desktop);
    }
}

static struct PuDesktopView *parent_of(struct PuDesktopView *view)
{
    struct PuDesktopView *parent;
    wl_list_for_each(parent, &view->desktop->all_views, all_link)
        if (parent->toplevel == view->toplevel->parent) return parent;
    return NULL;
}

static bool descendant(struct PuDesktopView *view, struct PuDesktopView *root)
{
    int remaining = wl_list_length(&view->desktop->all_views);
    while (view && remaining-- > 0) {
        if (view == root) return true;
        view = parent_of(view);
    }
    return false;
}

static void move_family(struct PuDesktopView *view, struct PuWorkspace *workspace)
{
    int remaining = wl_list_length(&view->desktop->all_views);
    struct PuDesktopView *parent;
    while ((parent = parent_of(view)) && remaining-- > 0) view = parent;
    if (remaining < 0) { wlr_log(WLR_ERROR, "Ignoring cyclic transient workspace move"); return; }
    struct PuDesktopView *item;
    wl_list_for_each(item, &view->desktop->all_views, all_link)
        if (descendant(item, view)) item->workspace = workspace;
}

void pu_workspaces_adopt_parent(struct PuDesktopView *view)
{
    struct PuDesktopView *parent = parent_of(view);
    if (!parent || parent->workspace == view->workspace) return;
    struct PuDesktopView *item;
    wl_list_for_each(item, &view->desktop->all_views, all_link)
        if (descendant(item, view)) item->workspace = parent->workspace;
    pu_desktop_workspaces_changed(view->desktop, NULL);
    broadcast(view->desktop->workspaces, NULL);
}

static struct wl_resource *workspace_resource(struct Binding *binding, struct PuWorkspace *workspace)
{
    struct WorkspaceRef *ref;
    wl_list_for_each(ref, &binding->refs, link)
        if (ref->workspace == workspace) return ref->resource;
    return NULL;
}

void pu_workspaces_invalidate_menus(struct PuDesktop *desktop, struct wlr_surface *surface)
{
    if (!desktop->workspaces) return;
    struct PuWorkspaces *state = desktop->workspaces;
    if (!surface) pu_workspaces_system_menu_cancel(desktop);
    if (!surface || (state->picker_target && state->picker_target->menu == surface))
        pu_workspaces_picker_cancel(desktop);
    struct Tracked *tracked;
    wl_list_for_each(tracked, &desktop->workspaces->tracked, link) {
        if (surface && tracked->menu != surface) continue;
        tracked->menu = NULL;
        tracked->menu_workspace = NULL;
        tracked->menu_epoch = 0;
    }
}

static void placement_state(struct Tracked *tracked, struct PuDesktopView *view)
{
    if (wl_resource_get_version(tracked->resource) < 3) return;
    uint32_t placement = view->mode == PU_DESKTOP_TILED_LEFT ? PU_TILE_LEFT :
        view->mode == PU_DESKTOP_TILED_RIGHT ? PU_TILE_RIGHT : PU_TILE_NONE;
    uint32_t capabilities = 0;
    const char *message = "";
    for (enum PuDesktopTile tile = PU_TILE_NONE; tile <= PU_TILE_RIGHT; tile++) {
        const char *error = pu_desktop_placement_check(view, tile);
        if (!error) capabilities |= tile == PU_TILE_NONE ? 4 : tile == PU_TILE_LEFT ? 1 : 2;
        else if (tile == PU_TILE_LEFT) message = error;
    }
    uint32_t pending = view->geometry_pending || view->resize_pending;
    if (tracked->placement_sent && tracked->placement == placement && tracked->pending == pending &&
        tracked->capabilities == capabilities && !strcmp(tracked->placement_message, message)) return;
    tracked->placement = placement; tracked->pending = pending; tracked->capabilities = capabilities;
    tracked->placement_sent = true;
    snprintf(tracked->placement_message, sizeof(tracked->placement_message), "%s", message);
    polly_workspace_toplevel_v1_send_placement_state(tracked->resource, placement, pending, capabilities, message);
}

void pu_workspaces_placement_changed(struct PuDesktopView *view)
{
    if (!view->desktop->workspaces) return;
    struct Tracked *tracked;
    wl_list_for_each(tracked, &view->desktop->workspaces->tracked, link)
        if (tracked->window == view->workspace_window && tracked->binding && tracked->binding->manager)
            placement_state(tracked, view);
}

static void membership(struct Tracked *tracked)
{
    struct PuDesktopView *view = window_for(tracked->state, tracked->window);
    if (!tracked->binding || !tracked->binding->manager || !view) return;
    if (tracked->menu && tracked->menu_workspace != view->workspace) {
        tracked->menu = NULL; tracked->menu_workspace = NULL; tracked->menu_epoch = 0;
    }
    struct wl_resource *workspace = workspace_resource(tracked->binding, view->workspace);
    if (!tracked->sent || workspace != tracked->last_workspace) {
        polly_workspace_toplevel_v1_send_workspace(tracked->resource, workspace);
        tracked->last_workspace = workspace;
        tracked->sent = true;
    }
    placement_state(tracked, view);
}

static void close_tracked(struct Tracked *tracked)
{
    if (tracked->state->system_menu_target == tracked)
        pu_workspaces_system_menu_cancel(tracked->state->desktop);
    if (tracked->state->picker_window == tracked->window)
        pu_workspaces_picker_cancel(tracked->state->desktop);
    if (tracked->window) polly_workspace_toplevel_v1_send_closed(tracked->resource);
    tracked->window = 0;
    tracked->binding = NULL;
    tracked->last_workspace = NULL;
    tracked->menu = NULL; tracked->menu_workspace = NULL; tracked->menu_epoch = 0;
}

void pu_workspaces_view_map(struct PuDesktopView *view)
{
    struct PuWorkspaces *state = view->desktop->workspaces;
    if (wl_resource_get_client(view->toplevel->resource) != state->desktop->shell_client) state->used = true;
    if (state->next_window == UINT64_MAX) {
        wl_resource_post_no_memory(view->toplevel->resource);
        return;
    }
    view->workspace_window = ++state->next_window;
}

void pu_workspaces_view_unmap(struct PuDesktopView *view)
{
    if (view->desktop->workspaces->picker_window == view->workspace_window)
        pu_workspaces_picker_cancel(view->desktop);
    struct Tracked *tracked;
    wl_list_for_each(tracked, &view->desktop->workspaces->tracked, link)
        if (tracked->window == view->workspace_window) close_tracked(tracked);
    view->workspace_window = 0;
}

static void free_workspace(struct PuWorkspace *workspace)
{ free(workspace->name); free(workspace); }

static struct PuWorkspace *new_workspace(struct PuWorkspaces *state, const char *name)
{
    if (state->next_workspace == UINT32_MAX) return NULL;
    struct PuWorkspace *workspace = calloc(1, sizeof(*workspace));
    if (!workspace) return NULL;
    char generated[48];
    workspace->id = ++state->next_workspace;
    snprintf(generated, sizeof(generated), "Workspace %u", workspace->id);
    workspace->name = strdup(*name ? name : generated);
    if (!workspace->name) { free(workspace); return NULL; }
    wl_list_init(&workspace->link);
    return workspace;
}

static struct Pending *queue(struct Binding *binding, enum Operation kind, uint32_t workspace,
                  uint64_t window, struct PuWorkspace *created)
{
    if (!binding->manager) { if (created) free_workspace(created); return NULL; }
    struct Pending *pending = calloc(1, sizeof(*pending));
    if (!pending) {
        if (created) free_workspace(created);
        wl_resource_post_no_memory(binding->manager);
        return NULL;
    }
    pending->kind = kind; pending->workspace = workspace; pending->window = window;
    pending->created = created;
    wl_list_insert(binding->pending.prev, &pending->link);
    return pending;
}

static void clear_pending(struct Binding *binding)
{
    struct Pending *pending, *tmp;
    wl_list_for_each_safe(pending, tmp, &binding->pending, link) {
        wl_list_remove(&pending->link);
        if (pending->created) free_workspace(pending->created);
        free(pending->name);
        free(pending);
    }
    if (binding->restore_reply) wl_list_remove(&binding->restore_destroy.link);
    binding->restore_reply = NULL;
    binding->restore_bytes = 0;
    binding->restore_error = NULL;
}

static void maybe_free_binding(struct Binding *binding)
{
    if (binding->manager || binding->group || !wl_list_empty(&binding->refs)) return;
    clear_pending(binding);
    wl_list_remove(&binding->link);
    free(binding);
}

static void destroy_request(struct wl_client *client, struct wl_resource *resource)
{ (void)client; wl_resource_destroy(resource); }

static void workspace_destroyed(struct wl_resource *resource)
{
    struct WorkspaceRef *ref = wl_resource_get_user_data(resource);
    struct Binding *binding = ref->binding;
    wl_list_remove(&ref->link);
    struct Tracked *tracked;
    wl_list_for_each(tracked, &binding->state->tracked, link)
        if (tracked->binding == binding && tracked->last_workspace == resource) membership(tracked);
    if (binding->manager) ext_workspace_manager_v1_send_done(binding->manager);
    free(ref);
    maybe_free_binding(binding);
}

static void activate_request(struct wl_client *client, struct wl_resource *resource)
{
    (void)client;
    struct WorkspaceRef *ref = wl_resource_get_user_data(resource);
    if (ref->workspace) queue(ref->binding, ACTIVATE, ref->workspace->id, 0, NULL);
}

static void remove_request(struct wl_client *client, struct wl_resource *resource)
{
    (void)client;
    struct WorkspaceRef *ref = wl_resource_get_user_data(resource);
    if (ref->workspace) queue(ref->binding, REMOVE, ref->workspace->id, 0, NULL);
}

static void unsupported(struct wl_client *client, struct wl_resource *resource)
{ (void)client; (void)resource; wlr_log(WLR_DEBUG, "Ignoring unsupported workspace operation"); }
static void assign_request(struct wl_client *client, struct wl_resource *resource, struct wl_resource *group)
{ (void)group; unsupported(client, resource); }
static const struct ext_workspace_handle_v1_interface workspace_impl = {
    .destroy = destroy_request, .activate = activate_request, .deactivate = unsupported,
    .assign = assign_request, .remove = remove_request,
};

static void send_workspace(struct WorkspaceRef *ref, uint32_t index)
{
    struct PuWorkspaces *state = ref->binding->state;
    struct wl_array coordinates = { .size = sizeof(index), .alloc = 0, .data = &index };
    ext_workspace_handle_v1_send_name(ref->resource, ref->workspace->name);
    ext_workspace_handle_v1_send_coordinates(ref->resource, &coordinates);
    ext_workspace_handle_v1_send_state(ref->resource,
        ref->workspace == state->desktop->active_workspace ? EXT_WORKSPACE_HANDLE_V1_STATE_ACTIVE : 0);
    ext_workspace_handle_v1_send_capabilities(ref->resource,
        EXT_WORKSPACE_HANDLE_V1_WORKSPACE_CAPABILITIES_ACTIVATE |
        (wl_list_length(&state->workspaces) > 1 ? EXT_WORKSPACE_HANDLE_V1_WORKSPACE_CAPABILITIES_REMOVE : 0));
}

static bool create_ref(struct Binding *binding, struct PuWorkspace *workspace)
{
    struct WorkspaceRef *ref = calloc(1, sizeof(*ref));
    if (!ref) { wl_resource_post_no_memory(binding->manager); return false; }
    ref->resource = wl_resource_create(wl_resource_get_client(binding->manager),
        &ext_workspace_handle_v1_interface, 1, 0);
    if (!ref->resource) { free(ref); wl_resource_post_no_memory(binding->manager); return false; }
    ref->binding = binding; ref->workspace = workspace;
    wl_resource_set_implementation(ref->resource, &workspace_impl, ref, workspace_destroyed);
    wl_list_insert(binding->refs.prev, &ref->link);
    ext_workspace_manager_v1_send_workspace(binding->manager, ref->resource);
    ext_workspace_handle_v1_send_name(ref->resource, workspace->name);
    if (binding->group) ext_workspace_group_handle_v1_send_workspace_enter(binding->group, ref->resource);
    return true;
}

static void broadcast(struct PuWorkspaces *state, struct wl_list *removed)
{
    struct Binding *binding;
    struct PuWorkspace *workspace;
    wl_list_for_each(binding, &state->bindings, link) {
        if (!binding->manager) continue;
        wl_list_for_each(workspace, &state->workspaces, link)
            if (!workspace->announced && !create_ref(binding, workspace)) break;
        struct Tracked *tracked;
        wl_list_for_each(tracked, &state->tracked, link)
            if (tracked->binding == binding) membership(tracked);
        struct WorkspaceRef *ref;
        wl_list_for_each(ref, &binding->refs, link) {
            if (!ref->workspace) continue;
            if (lookup(state, ref->workspace->id) != ref->workspace) {
                if (binding->group) ext_workspace_group_handle_v1_send_workspace_leave(binding->group, ref->resource);
                ext_workspace_handle_v1_send_removed(ref->resource);
                ref->workspace = NULL;
                continue;
            }
            uint32_t index = 0;
            wl_list_for_each(workspace, &state->workspaces, link) {
                if (workspace == ref->workspace) { send_workspace(ref, index); break; }
                index++;
            }
        }
        ext_workspace_manager_v1_send_done(binding->manager);
    }
    wl_list_for_each(workspace, &state->workspaces, link) workspace->announced = true;
    if (removed) {
        struct PuWorkspace *tmp;
        wl_list_for_each_safe(workspace, tmp, removed, link) {
            wl_list_remove(&workspace->link);
            free_workspace(workspace);
        }
    }
}

void pu_workspace_activate(struct PuDesktop *desktop, struct PuWorkspace *workspace, struct PuDesktopView *preferred)
{
    if (!workspace || desktop->active_workspace == workspace) return;
    desktop->workspaces->used = true;
    desktop->active_workspace = workspace;
    pu_desktop_workspaces_changed(desktop, preferred);
    broadcast(desktop->workspaces, NULL);
}

void pu_workspace_step(struct PuDesktop *desktop, int direction)
{
    struct wl_list *link = direction < 0 ? desktop->active_workspace->link.prev : desktop->active_workspace->link.next;
    if (link == &desktop->workspaces->workspaces) return;
    struct PuWorkspace *workspace = wl_container_of(link, workspace, link);
    pu_workspace_activate(desktop, workspace, NULL);
}

static void commit_request(struct wl_client *client, struct wl_resource *resource)
{
    struct Binding *binding = wl_resource_get_user_data(resource);
    struct PuWorkspaces *state = binding->state;
    if (client != state->desktop->shell_client) {
        wl_client_post_implementation_error(client, "Workspace authorization was revoked");
        return;
    }
    struct wl_list removed;
    wl_list_init(&removed);
    struct Pending *pending;
    if (binding->restore_reply) {
        uint32_t count = 0, result = 0;
        const char *error = binding->restore_error;
        bool application_exists = false;
        struct PuDesktopView *view;
        wl_list_for_each(view, &state->desktop->all_views, all_link)
            if (wl_resource_get_client(view->toplevel->resource) != state->desktop->shell_client)
                application_exists = true;
        wl_list_for_each(pending, &binding->pending, link) {
            if (pending->kind != CREATE) error = "Restore transaction must contain only workspace creation";
            count++;
        }
        if (!count || binding->restore_active >= count) error = "Invalid restored active workspace";
        if (error) result = 2;
        else if (!state->used && !application_exists) {
            struct PuWorkspace *workspace, *next;
            wl_list_for_each_safe(workspace, next, &state->workspaces, link) {
                wl_list_remove(&workspace->link);
                wl_list_insert(removed.prev, &workspace->link);
            }
            uint32_t index = 0;
            wl_list_for_each(pending, &binding->pending, link) {
                wl_list_insert(state->workspaces.prev, &pending->created->link);
                if (index++ == binding->restore_active) state->desktop->active_workspace = pending->created;
                pending->created = NULL;
            }
            state->used = true;
            result = 1;
            /* SDL retires the trusted Shell's bootstrap toplevel after JS startup. */
            wl_list_for_each(view, &state->desktop->all_views, all_link)
                view->workspace = state->desktop->active_workspace;
            pu_desktop_workspaces_changed(state->desktop, NULL);
            broadcast(state, &removed);
        }
        polly_workspace_toplevel_manager_v1_send_restored(binding->restore_reply,
            binding->restore_serial, result, error ? error : "");
        clear_pending(binding);
        return;
    }
    if (!wl_list_empty(&binding->pending)) state->used = true;
    wl_list_for_each(pending, &binding->pending, link) {
        struct PuWorkspace *workspace = lookup(state, pending->workspace);
        if (pending->kind == CREATE) {
            wl_list_insert(state->workspaces.prev, &pending->created->link);
            pending->created = NULL;
        } else if (!workspace) {
            wlr_log(WLR_DEBUG, "Ignoring request for a removed workspace");
        } else if (pending->kind == ACTIVATE) {
            state->desktop->active_workspace = workspace;
        } else if (pending->kind == MOVE) {
            struct PuDesktopView *view = window_for(state, pending->window);
            if (view) move_family(view, workspace);
            else wlr_log(WLR_DEBUG, "Ignoring workspace move for a closed window");
        } else if (pending->kind == RENAME) {
            free(workspace->name);
            workspace->name = pending->name;
            pending->name = NULL;
        } else if (pending->kind == REORDER) {
            wl_list_remove(&workspace->link);
            struct wl_list *before = state->workspaces.next;
            uint32_t position = pending->position;
            while (position-- && before != &state->workspaces) before = before->next;
            wl_list_insert(before->prev, &workspace->link);
        } else if (wl_list_length(&state->workspaces) > 1) {
            struct wl_list *link = workspace->link.prev != &state->workspaces ?
                workspace->link.prev : workspace->link.next;
            struct PuWorkspace *target = wl_container_of(link, target, link);
            struct PuDesktopView *view;
            wl_list_for_each(view, &state->desktop->all_views, all_link)
                if (view->workspace == workspace) view->workspace = target;
            if (state->desktop->active_workspace == workspace) state->desktop->active_workspace = target;
            wl_list_remove(&workspace->link);
            wl_list_insert(removed.prev, &workspace->link);
        } else wlr_log(WLR_DEBUG, "Ignoring removal of the final workspace");
    }
    clear_pending(binding);
    pu_desktop_workspaces_changed(state->desktop, NULL);
    broadcast(state, &removed);
}

static void manager_destroyed(struct wl_resource *resource)
{
    struct Binding *binding = wl_resource_get_user_data(resource);
    binding->manager = NULL;
    clear_pending(binding);
    struct Tracked *tracked;
    wl_list_for_each(tracked, &binding->state->tracked, link)
        if (tracked->binding == binding) close_tracked(tracked);
    struct WorkspaceRef *ref;
    wl_list_for_each(ref, &binding->refs, link) ref->workspace = NULL;
    maybe_free_binding(binding);
}

static void stop_request(struct wl_client *client, struct wl_resource *resource)
{
    (void)client;
    ext_workspace_manager_v1_send_finished(resource);
    wl_resource_destroy(resource);
}
static const struct ext_workspace_manager_v1_interface manager_impl = { .commit = commit_request, .stop = stop_request };

static void group_destroyed(struct wl_resource *resource)
{
    struct Binding *binding = wl_resource_get_user_data(resource);
    binding->group = NULL;
    maybe_free_binding(binding);
}

static void create_request(struct wl_client *client, struct wl_resource *resource, const char *name)
{
    (void)client;
    struct Binding *binding = wl_resource_get_user_data(resource);
    if (!binding->manager) return;
    if (strlen(name) > 128 || (binding->restore_reply && !*name)) {
        if (binding->restore_reply) binding->restore_error = "Invalid restored workspace name";
        wlr_log(WLR_ERROR, "Invalid workspace name");
        return;
    }
    if (binding->restore_reply) {
        binding->restore_bytes += strlen(name) + 1;
        if (binding->restore_bytes > 1024 * 1024) {
            binding->restore_error = "Workspace restore exceeds 1 MiB";
            return;
        }
    }
    struct PuWorkspace *workspace = new_workspace(binding->state, name);
    if (!workspace) { wl_resource_post_no_memory(resource); return; }
    queue(binding, CREATE, 0, 0, workspace);
}
static const struct ext_workspace_group_handle_v1_interface group_impl = {
    .create_workspace = create_request, .destroy = destroy_request,
};

static void bind_manager(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
    struct PuWorkspaces *state = data;
    if (client != state->desktop->shell_client) {
        wl_client_post_implementation_error(client, "Workspace control requires the trusted Shell");
        return;
    }
    struct Binding *binding = calloc(1, sizeof(*binding));
    if (!binding) { wl_client_post_no_memory(client); return; }
    binding->state = state;
    wl_list_init(&binding->refs); wl_list_init(&binding->pending);
    binding->manager = wl_resource_create(client, &ext_workspace_manager_v1_interface, version, id);
    if (!binding->manager) { free(binding); wl_client_post_no_memory(client); return; }
    wl_list_insert(state->bindings.prev, &binding->link);
    wl_resource_set_implementation(binding->manager, &manager_impl, binding, manager_destroyed);
    binding->group = wl_resource_create(client, &ext_workspace_group_handle_v1_interface, 1, 0);
    if (!binding->group) { wl_resource_post_no_memory(binding->manager); return; }
    wl_resource_set_implementation(binding->group, &group_impl, binding, group_destroyed);
    ext_workspace_manager_v1_send_workspace_group(binding->manager, binding->group);
    ext_workspace_group_handle_v1_send_capabilities(binding->group,
        EXT_WORKSPACE_GROUP_HANDLE_V1_GROUP_CAPABILITIES_CREATE_WORKSPACE);
    struct Output *output;
    wl_list_for_each(output, &state->outputs, link) {
        struct wl_resource *resource;
        wl_resource_for_each(resource, &output->output->resources)
            if (wl_resource_get_client(resource) == client)
                ext_workspace_group_handle_v1_send_output_enter(binding->group, resource);
    }
    struct PuWorkspace *workspace;
    uint32_t index = 0;
    wl_list_for_each(workspace, &state->workspaces, link) {
        if (!create_ref(binding, workspace)) return;
        struct WorkspaceRef *ref = wl_container_of(binding->refs.prev, ref, link);
        send_workspace(ref, index++);
    }
    ext_workspace_manager_v1_send_done(binding->manager);
}

static void tracked_destroyed(struct wl_resource *resource)
{
    struct Tracked *tracked = wl_resource_get_user_data(resource);
    if (tracked->state->system_menu_target == tracked)
        pu_workspaces_system_menu_cancel(tracked->state->desktop);
    if (tracked->state->picker_target == tracked) pu_workspaces_picker_cancel(tracked->state->desktop);
    wl_list_remove(&tracked->link);
    free(tracked);
}

static void move_request(struct wl_client *client, struct wl_resource *resource, struct wl_resource *target)
{
    (void)client;
    struct Tracked *tracked = wl_resource_get_user_data(resource);
    if (!tracked->binding || !tracked->window) return;
    struct WorkspaceRef *ref = wl_resource_get_user_data(target);
    if (!wl_resource_instance_of(target, &ext_workspace_handle_v1_interface, &workspace_impl) ||
        ref->binding != tracked->binding) {
        wl_resource_post_error(resource, POLLY_WORKSPACE_TOPLEVEL_MANAGER_V1_ERROR_INVALID_WORKSPACE,
            "Workspace belongs to another manager binding");
        return;
    }
    if (ref->workspace) queue(tracked->binding, MOVE, ref->workspace->id, tracked->window, NULL);
    else wlr_log(WLR_DEBUG, "Ignoring move to a removed workspace");
}

static const char *menu_request(struct Tracked *tracked, struct wl_client *client, uint32_t serial)
{
    if (!tracked->window || !tracked->binding || !tracked->binding->manager ||
        client != tracked->state->desktop->shell_client) return "Window or trusted manager is closed";
    if (!serial || serial <= tracked->last_serial) return "Unknown or duplicate placement serial";
    tracked->last_serial = serial;
    return NULL;
}

static void open_menu(struct wl_client *client, struct wl_resource *resource,
    uint32_t serial, struct wl_resource *surface_resource)
{
    struct Tracked *tracked = wl_resource_get_user_data(resource);
    const char *error = menu_request(tracked, client, serial);
    if (!tracked->window) { wlr_log(WLR_DEBUG, "Ignoring menu request on a closed toplevel"); return; }
    struct PuDesktop *desktop = tracked->state->desktop;
    struct PuDesktopView *view = window_for(tracked->state, tracked->window);
    struct wlr_surface *surface = wlr_surface_from_resource(surface_resource);
    struct PuDesktopLayer *layer, *owned = NULL;
    wl_list_for_each(layer, &desktop->layers, link)
        if (layer->surface->surface == surface &&
            wl_resource_get_client(layer->surface->resource) == client) owned = layer;
    if (!error && (!view || !pu_workspace_current(view))) error = "Window is not in the current workspace";
    if (!error && (!owned || wl_resource_get_client(surface_resource) != client))
        error = "A live owned layer surface is required";
    if (!error && tracked->state->next_menu_epoch == UINT32_MAX) error = "Window menu epochs exhausted";
    uint32_t epoch = 0;
    if (!error) {
        pu_workspaces_invalidate_menus(desktop, NULL);
        tracked->menu = surface;
        tracked->menu_workspace = desktop->active_workspace;
        struct wlr_box bounds;
        tracked->menu_output = pu_desktop_picker_output(view, &bounds);
        tracked->layout_menu = false;
        epoch = tracked->menu_epoch = ++tracked->state->next_menu_epoch;
    }
    polly_workspace_toplevel_v1_send_result(resource, serial, epoch, !error, error ? error : "");
}

static void open_layout_picker(struct wl_client *client, struct wl_resource *resource,
    uint32_t serial, uint32_t token, struct wl_resource *surface_resource)
{
    struct Tracked *tracked = wl_resource_get_user_data(resource);
    struct PuWorkspaces *state = tracked->state;
    pu_workspaces_picker_validate(state->desktop);
    const char *error = menu_request(tracked, client, serial);
    struct PuDesktopView *view = picker_view(state);
    struct wlr_box anchor, bounds;
    if (!error && (state->picker_phase != PICKER_OFFERED || state->picker_target != tracked ||
        !token || token != state->picker_token || !view ||
        pu_desktop_picker_anchor(view, NULL, true, &anchor, &bounds) != state->picker_output ||
        pu_decoration_presented_revision(view) != state->picker_revision))
        error = "Native caption hover grant is closed, duplicate or stale";
    struct wlr_surface *surface = wlr_surface_from_resource(surface_resource);
    struct PuDesktopLayer *layer, *owned = NULL;
    wl_list_for_each(layer, &state->desktop->layers, link)
        if (layer->surface->surface == surface &&
            wl_resource_get_client(layer->surface->resource) == client) owned = layer;
    if (!error && (!owned || wl_resource_get_client(surface_resource) != client ||
        owned->surface->output != state->picker_output ||
        owned->surface->current.layer != ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY ||
        owned->surface->current.exclusive_zone != -1 ||
        owned->surface->current.keyboard_interactive != ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE))
        error = "The picker requires an exact owned layer on the granted output";
    if (!error && state->next_menu_epoch == UINT32_MAX) error = "Window menu epochs exhausted";
    if (error) {
        if (state->picker_target == tracked && token == state->picker_token)
            pu_workspaces_picker_cancel(state->desktop);
        polly_workspace_toplevel_v1_send_result(resource, serial, 0, 0, error);
        return;
    }
    /* Transition once: later focus/hover caption revisions are not a new grant. */
    struct Tracked *other;
    wl_list_for_each(other, &state->tracked, link) {
        other->menu = NULL; other->menu_workspace = NULL; other->menu_epoch = 0;
    }
    tracked->menu = surface; tracked->menu_workspace = state->picker_workspace;
    tracked->menu_output = state->picker_output; tracked->layout_menu = true;
    tracked->menu_epoch = ++state->next_menu_epoch;
    state->picker_phase = PICKER_REGISTERED;
    polly_workspace_toplevel_v1_send_result(resource, serial, tracked->menu_epoch, 1, "");
}

static void dismiss_layout_picker(struct wl_client *client, struct wl_resource *resource, uint32_t token)
{
    struct Tracked *tracked = wl_resource_get_user_data(resource);
    struct PuWorkspaces *state = tracked->state;
    if (client == state->desktop->shell_client && state->picker_target == tracked &&
        token && token == state->picker_token) pu_workspaces_picker_cancel(state->desktop);
}

static void close_menu(struct wl_client *client, struct wl_resource *resource, uint32_t epoch)
{
    struct Tracked *tracked = wl_resource_get_user_data(resource);
    if (client != tracked->state->desktop->shell_client || !epoch || epoch != tracked->menu_epoch) return;
    if (tracked->state->picker_target == tracked) pu_workspaces_picker_cancel(tracked->state->desktop);
    tracked->menu = NULL; tracked->menu_workspace = NULL; tracked->menu_epoch = 0;
}

static const char *menu_target(struct Tracked *tracked, uint32_t epoch, struct PuDesktopView **view)
{
    *view = window_for(tracked->state, tracked->window);
    if (!*view || !tracked->menu || !epoch || epoch != tracked->menu_epoch ||
        tracked->menu_workspace != tracked->state->desktop->active_workspace ||
        (*view)->workspace != tracked->menu_workspace) return "Window menu epoch is closed or stale";
    return NULL;
}

static void place_request(struct wl_client *client, struct wl_resource *resource,
    uint32_t serial, uint32_t epoch, uint32_t placement)
{
    struct Tracked *tracked = wl_resource_get_user_data(resource);
    pu_workspaces_picker_validate(tracked->state->desktop);
    const char *error = menu_request(tracked, client, serial);
    if (!tracked->window) { wlr_log(WLR_DEBUG, "Ignoring placement on a closed toplevel"); return; }
    struct PuDesktopView *view = NULL;
    if (!error) error = menu_target(tracked, epoch, &view);
    if (!error && placement > PU_TILE_RIGHT) error = "Unknown window placement";
    if (!error) error = pu_desktop_place_from_menu(view, tracked->menu, (enum PuDesktopTile)placement);
    if (!error) {
        tracked->menu = NULL; tracked->menu_workspace = NULL; tracked->menu_epoch = 0;
    }
    polly_workspace_toplevel_v1_send_result(resource, serial, epoch, !error, error ? error : "");
}

static void arrangement_request(struct wl_client *client, struct wl_resource *resource,
    uint32_t serial, uint32_t epoch, enum PuDesktopArrangement arrangement)
{
    struct Tracked *tracked = wl_resource_get_user_data(resource);
    const char *error = menu_request(tracked, client, serial);
    if (!tracked->window) { wlr_log(WLR_DEBUG, "Ignoring arrangement on a closed toplevel"); return; }
    struct PuDesktopView *view = NULL;
    if (!error) error = menu_target(tracked, epoch, &view);
    struct wlr_box bounds;
    if (!error && (tracked->layout_menu || !tracked->menu_output ||
        pu_desktop_picker_output(view, &bounds) != tracked->menu_output))
        error = "Window arrangement requires the ordinary window menu on its original live target display";
    if (!error) error = pu_desktop_arrange_from_menu(view, tracked->menu, arrangement);
    if (!error) {
        tracked->menu = NULL; tracked->menu_workspace = NULL; tracked->menu_epoch = 0;
    }
    polly_workspace_toplevel_v1_send_result(resource, serial, epoch, !error, error ? error : "");
}

static void cascade_request(struct wl_client *client, struct wl_resource *resource,
    uint32_t serial, uint32_t epoch)
{
    arrangement_request(client, resource, serial, epoch, PU_ARRANGE_CASCADE);
}

static void arrange_request(struct wl_client *client, struct wl_resource *resource,
    uint32_t serial, uint32_t epoch, uint32_t arrangement)
{
    /* Do not narrow an untrusted uint into an enum before checking its range. */
    enum PuDesktopArrangement kind = arrangement == POLLY_WORKSPACE_TOPLEVEL_V1_ARRANGEMENT_HORIZONTAL ?
        PU_ARRANGE_HORIZONTAL : arrangement == POLLY_WORKSPACE_TOPLEVEL_V1_ARRANGEMENT_VERTICAL ?
        PU_ARRANGE_VERTICAL : (enum PuDesktopArrangement)-1;
    arrangement_request(client, resource, serial, epoch, kind);
}

static void consume_system_menu(struct wl_client *client, struct wl_resource *resource, uint32_t serial)
{
    struct Tracked *tracked = wl_resource_get_user_data(resource);
    if (!tracked->window) {
        wlr_log(WLR_DEBUG, "Ignoring system-menu consumption on a closed toplevel");
        return;
    }
    struct PuWorkspaces *state = tracked->state;
    bool current = client == state->desktop->shell_client && serial &&
        state->system_menu_target == tracked && serial == state->system_menu_serial &&
        !state->system_menu_armed;
    bool accepted = current && system_menu_current(state, false);
    if (current) {
        if (accepted) state->system_menu_serial = 0;
        pu_workspaces_system_menu_cancel(state->desktop);
    }
    polly_workspace_toplevel_v1_send_system_menu_consumed(resource, serial, accepted);
}

static const struct polly_workspace_toplevel_v1_interface tracked_impl = {
    .destroy = destroy_request, .move_to = move_request,
    .open_menu = open_menu, .close_menu = close_menu, .place = place_request,
    .open_layout_picker = open_layout_picker, .dismiss_layout_picker = dismiss_layout_picker,
    .cascade = cascade_request,
    .arrange = arrange_request,
    .consume_system_menu = consume_system_menu,
};

static void get_toplevel(struct wl_client *client, struct wl_resource *resource, uint32_t id,
                         struct wl_resource *foreign, struct wl_resource *manager)
{
    struct PuWorkspaces *state = wl_resource_get_user_data(resource);
    if (client != state->desktop->shell_client ||
        !wl_resource_instance_of(manager, &ext_workspace_manager_v1_interface, &manager_impl)) {
        wl_resource_post_error(resource, POLLY_WORKSPACE_TOPLEVEL_MANAGER_V1_ERROR_INVALID_MANAGER,
            "Invalid workspace manager binding");
        return;
    }
    struct Binding *binding = wl_resource_get_user_data(manager);
    struct Tracked *tracked = calloc(1, sizeof(*tracked));
    if (!tracked) { wl_resource_post_no_memory(resource); return; }
    tracked->resource = wl_resource_create(client, &polly_workspace_toplevel_v1_interface,
        wl_resource_get_version(resource) >= 7 ? 7 : wl_resource_get_version(resource) >= 6 ? 6 :
        wl_resource_get_version(resource) >= 5 ? 5 : wl_resource_get_version(resource) >= 4 ? 4 :
        wl_resource_get_version(resource) >= 3 ? 3 : 1, id);
    if (!tracked->resource) { free(tracked); wl_resource_post_no_memory(resource); return; }
    tracked->state = state; tracked->binding = binding;
    tracked->toplevel_manager = resource;
    struct PuDesktopView *view;
    wl_list_for_each(view, &state->desktop->views, link) {
        if (!view->foreign) continue;
        struct wl_resource *candidate;
        wl_resource_for_each(candidate, &view->foreign->resources)
            if (candidate == foreign) tracked->window = view->workspace_window;
    }
    wl_list_insert(state->tracked.prev, &tracked->link);
    wl_resource_set_implementation(tracked->resource, &tracked_impl, tracked, tracked_destroyed);
    if (tracked->window) membership(tracked);
    else {
        polly_workspace_toplevel_v1_send_closed(tracked->resource);
        tracked->binding = NULL;
    }
    ext_workspace_manager_v1_send_done(manager);
}
static struct Binding *manager_binding(struct wl_client *client, struct wl_resource *resource,
                                      struct wl_resource *manager)
{
    struct PuWorkspaces *state = wl_resource_get_user_data(resource);
    if (client != state->desktop->shell_client ||
        !wl_resource_instance_of(manager, &ext_workspace_manager_v1_interface, &manager_impl)) {
        wl_resource_post_error(resource, POLLY_WORKSPACE_TOPLEVEL_MANAGER_V1_ERROR_INVALID_MANAGER,
            "Invalid workspace manager binding");
        return NULL;
    }
    return wl_resource_get_user_data(manager);
}

static struct WorkspaceRef *managed_workspace(struct wl_resource *resource,
                                              struct Binding *binding, struct wl_resource *workspace)
{
    struct WorkspaceRef *ref = wl_resource_get_user_data(workspace);
    if (!wl_resource_instance_of(workspace, &ext_workspace_handle_v1_interface, &workspace_impl) ||
        ref->binding != binding) {
        wl_resource_post_error(resource, POLLY_WORKSPACE_TOPLEVEL_MANAGER_V1_ERROR_INVALID_WORKSPACE,
            "Workspace belongs to another manager binding");
        return NULL;
    }
    return ref;
}

static void rename_request(struct wl_client *client, struct wl_resource *resource,
                           struct wl_resource *manager, struct wl_resource *workspace, const char *name)
{
    struct Binding *binding = manager_binding(client, resource, manager);
    if (!binding) return;
    struct WorkspaceRef *ref = managed_workspace(resource, binding, workspace);
    if (!ref || !ref->workspace) return;
    if (!*name || strlen(name) > 128) { wlr_log(WLR_ERROR, "Invalid workspace name"); return; }
    char *copy = strdup(name);
    if (!copy) { wl_resource_post_no_memory(resource); return; }
    struct Pending *pending = queue(binding, RENAME, ref->workspace->id, 0, NULL);
    if (pending) pending->name = copy;
    else free(copy);
}

static void reorder_request(struct wl_client *client, struct wl_resource *resource,
                            struct wl_resource *manager, struct wl_resource *workspace, uint32_t position)
{
    struct Binding *binding = manager_binding(client, resource, manager);
    if (!binding) return;
    struct WorkspaceRef *ref = managed_workspace(resource, binding, workspace);
    if (!ref || !ref->workspace) return;
    struct Pending *pending = queue(binding, REORDER, ref->workspace->id, 0, NULL);
    if (pending) pending->position = position;
}

static void restore_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct Binding *binding = wl_container_of(listener, binding, restore_destroy);
    clear_pending(binding);
}

static void restore_begin(struct wl_client *client, struct wl_resource *resource,
                          struct wl_resource *manager, uint32_t serial, uint32_t active)
{
    struct Binding *binding = manager_binding(client, resource, manager);
    if (!binding) return;
    clear_pending(binding);
    binding->restore_reply = resource;
    binding->restore_serial = serial;
    binding->restore_active = active;
    binding->restore_destroy.notify = restore_destroyed;
    wl_resource_add_destroy_listener(resource, &binding->restore_destroy);
}

static void enable_layout_picker(struct wl_client *client, struct wl_resource *resource, uint32_t enabled)
{
    struct PuWorkspaces *state = wl_resource_get_user_data(resource);
    if (client != state->desktop->shell_client || enabled > 1) {
        wl_client_post_implementation_error(client, "Invalid trusted caption picker opt-in"); return;
    }
    pu_workspaces_picker_cancel(state->desktop);
    state->picker_manager = enabled ? resource : NULL;
}

static void picker_manager_destroyed(struct wl_resource *resource)
{
    struct PuWorkspaces *state = wl_resource_get_user_data(resource);
    struct Tracked *tracked;
    wl_list_for_each(tracked, &state->tracked, link)
        if (tracked->toplevel_manager == resource) tracked->toplevel_manager = NULL;
    if (state->system_menu_manager == resource) {
        pu_workspaces_system_menu_cancel(state->desktop);
        state->system_menu_manager = NULL;
    }
    if (state->picker_manager != resource) return;
    pu_workspaces_picker_cancel(state->desktop);
    state->picker_manager = NULL;
}

static void enable_system_menu_requests(struct wl_client *client, struct wl_resource *resource, uint32_t enabled)
{
    struct PuWorkspaces *state = wl_resource_get_user_data(resource);
    if (client != state->desktop->shell_client || enabled > 1) {
        wl_client_post_implementation_error(client, "Invalid trusted system-menu opt-in"); return;
    }
    if (!enabled && state->system_menu_manager != resource) return;
    if (enabled && state->system_menu_manager == resource) return;
    pu_workspaces_system_menu_cancel(state->desktop);
    state->system_menu_manager = enabled ? resource : NULL;
}

static const struct polly_workspace_toplevel_manager_v1_interface toplevel_impl = {
    .destroy = destroy_request, .get_toplevel = get_toplevel,
    .rename = rename_request, .reorder = reorder_request, .restore_begin = restore_begin,
    .enable_layout_picker = enable_layout_picker,
    .enable_system_menu_requests = enable_system_menu_requests,
};

static void bind_toplevels(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
    struct PuWorkspaces *state = data;
    if (client != state->desktop->shell_client) {
        wl_client_post_implementation_error(client, "Workspace membership requires the trusted Shell");
        return;
    }
    struct wl_resource *resource = wl_resource_create(client, &polly_workspace_toplevel_manager_v1_interface, version, id);
    if (!resource) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(resource, &toplevel_impl, state, picker_manager_destroyed);
    if (version >= 4) polly_workspace_toplevel_manager_v1_send_layout_picker_capabilities(resource, 1);
    if (version >= 6) polly_workspace_toplevel_manager_v1_send_arrangement_capabilities(resource, 1);
    if (version >= 7) polly_workspace_toplevel_manager_v1_send_system_menu_capabilities(resource, 1);
}

static void output_bound(struct wl_listener *listener, void *data)
{
    struct Output *output = wl_container_of(listener, output, bind);
    struct wlr_output_event_bind *event = data;
    struct Binding *binding;
    wl_list_for_each(binding, &output->state->bindings, link) {
        if (!binding->manager || !binding->group ||
            wl_resource_get_client(binding->manager) != wl_resource_get_client(event->resource)) continue;
        ext_workspace_group_handle_v1_send_output_enter(binding->group, event->resource);
        ext_workspace_manager_v1_send_done(binding->manager);
    }
}

static void output_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct Output *output = wl_container_of(listener, output, destroy);
    if (output->state->system_menu_output == output->output)
        pu_workspaces_system_menu_cancel(output->state->desktop);
    if (output->state->picker_output == output->output)
        pu_workspaces_picker_cancel(output->state->desktop);
    struct Tracked *tracked;
    wl_list_for_each(tracked, &output->state->tracked, link)
        if (tracked->menu_output == output->output) {
            tracked->menu = NULL; tracked->menu_workspace = NULL; tracked->menu_epoch = 0;
            tracked->menu_output = NULL;
        }
    struct Binding *binding;
    wl_list_for_each(binding, &output->state->bindings, link) {
        if (!binding->manager || !binding->group) continue;
        struct wl_resource *resource;
        wl_resource_for_each(resource, &output->output->resources)
            if (wl_resource_get_client(resource) == wl_resource_get_client(binding->manager))
                ext_workspace_group_handle_v1_send_output_leave(binding->group, resource);
        ext_workspace_manager_v1_send_done(binding->manager);
    }
    wl_list_remove(&output->bind.link); wl_list_remove(&output->destroy.link);
    wl_list_remove(&output->link); free(output);
}

bool pu_workspaces_output_add(struct PuDesktop *desktop, struct wlr_output *output)
{
    struct Output *entry = calloc(1, sizeof(*entry));
    if (!entry) return false;
    entry->state = desktop->workspaces; entry->output = output;
    entry->bind.notify = output_bound; wl_signal_add(&output->events.bind, &entry->bind);
    entry->destroy.notify = output_destroyed; wl_signal_add(&output->events.destroy, &entry->destroy);
    wl_list_insert(entry->state->outputs.prev, &entry->link);
    return true;
}

static void picker_keyboard_grab(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuWorkspaces *state = wl_container_of(listener, state, picker_keyboard_grab);
    pu_workspaces_system_menu_cancel(state->desktop);
    pu_workspaces_picker_cancel(state->desktop);
}

static void picker_pointer_grab(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuWorkspaces *state = wl_container_of(listener, state, picker_pointer_grab);
    pu_workspaces_system_menu_cancel(state->desktop);
    pu_workspaces_picker_cancel(state->desktop);
}

bool pu_workspaces_init(struct PuDesktop *desktop)
{
    struct PuWorkspaces *state = calloc(1, sizeof(*state));
    if (!state) return false;
    desktop->workspaces = state; state->desktop = desktop;
    wl_list_init(&state->workspaces); wl_list_init(&state->bindings);
    wl_list_init(&state->tracked); wl_list_init(&state->outputs);
    for (int i = 0; i < 4; i++) {
        struct PuWorkspace *workspace = new_workspace(state, "");
        if (!workspace) return false;
        workspace->announced = true;
        wl_list_insert(state->workspaces.prev, &workspace->link);
        if (!desktop->active_workspace) desktop->active_workspace = workspace;
    }
    state->manager = wl_global_create(desktop->display, &ext_workspace_manager_v1_interface, 1, state, bind_manager);
    state->toplevel_manager = wl_global_create(desktop->display, &polly_workspace_toplevel_manager_v1_interface, 7, state, bind_toplevels);
    state->picker_keyboard_grab.notify = picker_keyboard_grab;
    wl_signal_add(&desktop->seat->events.keyboard_grab_begin, &state->picker_keyboard_grab);
    state->picker_pointer_grab.notify = picker_pointer_grab;
    wl_signal_add(&desktop->seat->events.pointer_grab_begin, &state->picker_pointer_grab);
    return state->manager && state->toplevel_manager;
}

void pu_workspaces_finish(struct PuDesktop *desktop)
{
    struct PuWorkspaces *state = desktop->workspaces;
    if (!state) return;
    pu_workspaces_system_menu_cancel(desktop);
    pu_workspaces_picker_cancel(desktop);
    if (state->picker_keyboard_grab.link.next) wl_list_remove(&state->picker_keyboard_grab.link);
    if (state->picker_pointer_grab.link.next) wl_list_remove(&state->picker_pointer_grab.link);
    if (state->manager) wl_global_destroy(state->manager);
    if (state->toplevel_manager) wl_global_destroy(state->toplevel_manager);
    struct Output *output, *next_output;
    wl_list_for_each_safe(output, next_output, &state->outputs, link) {
        wl_list_remove(&output->bind.link); wl_list_remove(&output->destroy.link);
        wl_list_remove(&output->link); free(output);
    }
    struct PuWorkspace *workspace, *next;
    wl_list_for_each_safe(workspace, next, &state->workspaces, link) {
        wl_list_remove(&workspace->link); free_workspace(workspace);
    }
    free(state); desktop->workspaces = NULL; desktop->active_workspace = NULL;
}
