#include "workspace.h"
#include "server.h"
#include "ext-workspace-server.h"
#include "polly-workspace-toplevel-server.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wlr/types/wlr_foreign_toplevel_management_v1.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>

struct Binding;
struct WorkspaceRef {
    struct wl_list link;
    struct Binding *binding;
    struct PuWorkspace *workspace;
    struct wl_resource *resource;
};
enum Operation { CREATE, ACTIVATE, REMOVE, MOVE };
struct Pending {
    struct wl_list link;
    enum Operation kind;
    uint32_t workspace;
    uint64_t window;
    struct PuWorkspace *created;
};
struct Binding {
    struct wl_list link, refs, pending;
    struct PuWorkspaces *state;
    struct wl_resource *manager, *group;
};
struct Tracked {
    struct wl_list link;
    struct PuWorkspaces *state;
    struct Binding *binding;
    struct wl_resource *resource, *last_workspace;
    uint64_t window;
    bool sent;
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

static void membership(struct Tracked *tracked)
{
    struct PuDesktopView *view = window_for(tracked->state, tracked->window);
    if (!tracked->binding || !tracked->binding->manager || !view) return;
    struct wl_resource *workspace = workspace_resource(tracked->binding, view->workspace);
    if (!tracked->sent || workspace != tracked->last_workspace) {
        polly_workspace_toplevel_v1_send_workspace(tracked->resource, workspace);
        tracked->last_workspace = workspace;
        tracked->sent = true;
    }
}

static void close_tracked(struct Tracked *tracked)
{
    if (tracked->window) polly_workspace_toplevel_v1_send_closed(tracked->resource);
    tracked->window = 0;
    tracked->binding = NULL;
    tracked->last_workspace = NULL;
}

void pu_workspaces_view_map(struct PuDesktopView *view)
{
    struct PuWorkspaces *state = view->desktop->workspaces;
    if (state->next_window == UINT64_MAX) {
        wl_resource_post_no_memory(view->toplevel->resource);
        return;
    }
    view->workspace_window = ++state->next_window;
}

void pu_workspaces_view_unmap(struct PuDesktopView *view)
{
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

static bool queue(struct Binding *binding, enum Operation kind, uint32_t workspace,
                  uint64_t window, struct PuWorkspace *created)
{
    if (!binding->manager) { if (created) free_workspace(created); return false; }
    struct Pending *pending = calloc(1, sizeof(*pending));
    if (!pending) {
        if (created) free_workspace(created);
        wl_resource_post_no_memory(binding->manager);
        return false;
    }
    pending->kind = kind; pending->workspace = workspace; pending->window = window;
    pending->created = created;
    wl_list_insert(binding->pending.prev, &pending->link);
    return true;
}

static void clear_pending(struct Binding *binding)
{
    struct Pending *pending, *tmp;
    wl_list_for_each_safe(pending, tmp, &binding->pending, link) {
        wl_list_remove(&pending->link);
        if (pending->created) free_workspace(pending->created);
        free(pending);
    }
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
    if (strlen(name) > 128) { wlr_log(WLR_ERROR, "Workspace name exceeds 128 bytes"); return; }
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
static const struct polly_workspace_toplevel_v1_interface tracked_impl = {
    .destroy = destroy_request, .move_to = move_request,
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
    tracked->resource = wl_resource_create(client, &polly_workspace_toplevel_v1_interface, 1, id);
    if (!tracked->resource) { free(tracked); wl_resource_post_no_memory(resource); return; }
    tracked->state = state; tracked->binding = binding;
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
static const struct polly_workspace_toplevel_manager_v1_interface toplevel_impl = {
    .destroy = destroy_request, .get_toplevel = get_toplevel,
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
    wl_resource_set_implementation(resource, &toplevel_impl, state, NULL);
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
    state->toplevel_manager = wl_global_create(desktop->display, &polly_workspace_toplevel_manager_v1_interface, 1, state, bind_toplevels);
    return state->manager && state->toplevel_manager;
}

void pu_workspaces_finish(struct PuDesktop *desktop)
{
    struct PuWorkspaces *state = desktop->workspaces;
    if (!state) return;
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
