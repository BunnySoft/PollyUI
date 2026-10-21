#define _POSIX_C_SOURCE 200809L
#include "workspace-cube.h"
#include "server.h"
#include "workspace.h"
#include "window-previews.h"
#include "window-opacity.h"
#include "shortcut-control.h"
#include "decoration.h"
#include "session-lock.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_layer_shell_v1.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_subcompositor.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>
#include <xkbcommon/xkbcommon-keysyms.h>

struct CubeOutput {
    struct wlr_output *output;
    struct wlr_box bounds;
    struct wlr_scene_tree *tree;
    struct wlr_scene_buffer *node;
    struct wlr_buffer *faces[4], *cap;
    float scale;
};
struct CubeWatch {
    struct wl_list link;
    struct PuWorkspaceCube *state;
    struct wlr_surface *surface;
    struct wl_listener commit, destroy, subsurface;
};
struct PuWorkspaceCube {
    struct PuDesktop *desktop;
    struct wl_event_source *timer;
    struct wlr_keyboard *keyboard;
    struct CubeOutput outputs[8];
    struct PuWorkspace *workspaces[4];
    struct wl_list watches;
    struct wl_listener keyboard_grab, pointer_grab;
    unsigned watch_count;
    unsigned output_count, selected;
    uint32_t modifiers;
    bool enabled, motion, active, dirty, pending, animating, watch_failed;
    float pose, start, goal;
    uint64_t started;
    char error[192];
};

static uint64_t clock_ms(void)
{
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value)) return 0;
    return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}
static bool no_input(struct wlr_scene_buffer *buffer, double *x, double *y)
{
    (void)buffer; (void)x; (void)y;
    return false;
}
static void drop_sources(struct CubeOutput *output)
{
    for (unsigned face = 0; face < 4; face++) {
        if (output->faces[face]) wlr_buffer_drop(output->faces[face]);
        output->faces[face] = NULL;
    }
    if (output->cap) wlr_buffer_drop(output->cap);
    output->cap = NULL;
}
static void remove_watch(struct CubeWatch *watch)
{
    wl_list_remove(&watch->commit.link);
    wl_list_remove(&watch->destroy.link);
    wl_list_remove(&watch->subsurface.link);
    wl_list_remove(&watch->link);
    watch->state->watch_count--;
    free(watch);
}
void pu_workspace_cube_cancel(struct PuDesktop *desktop)
{
    struct PuWorkspaceCube *state = desktop->cube;
    if (!state) return;
    bool active = state->active;
    state->active = state->pending = state->dirty = state->animating = false;
    state->keyboard = NULL;
    if (state->timer) wl_event_source_timer_update(state->timer, 0);
    struct CubeWatch *watch, *next;
    wl_list_for_each_safe(watch, next, &state->watches, link) remove_watch(watch);
    for (unsigned index = 0; index < state->output_count; index++) {
        drop_sources(&state->outputs[index]);
        if (state->outputs[index].tree) wlr_scene_node_destroy(&state->outputs[index].tree->node);
    }
    memset(state->outputs, 0, sizeof(state->outputs));
    memset(state->workspaces, 0, sizeof(state->workspaces));
    state->output_count = 0;
    if (active) pu_shortcuts_cube_changed(desktop);
}
static bool failure(struct PuWorkspaceCube *state, const char *message)
{
    snprintf(state->error, sizeof(state->error), "%s", message);
    wlr_log(WLR_ERROR, "Workspace cube stopped: %s", message);
    pu_workspace_cube_cancel(state->desktop);
    pu_shortcuts_cube_changed(state->desktop);
    return false;
}
static bool watch_surface(struct PuWorkspaceCube *state, struct wlr_surface *surface);
static void watch_commit(struct wl_listener *listener, void *data)
{
    (void)data;
    struct CubeWatch *watch = wl_container_of(listener, watch, commit);
    pu_workspace_cube_damage(watch->state->desktop);
}
static void watch_destroy(struct wl_listener *listener, void *data)
{
    (void)data;
    struct CubeWatch *watch = wl_container_of(listener, watch, destroy);
    struct PuDesktop *desktop = watch->state->desktop;
    remove_watch(watch);
    pu_workspace_cube_damage(desktop);
}
static void watch_subsurface(struct wl_listener *listener, void *data)
{
    struct CubeWatch *watch = wl_container_of(listener, watch, subsurface);
    struct wlr_subsurface *subsurface = data;
    if (!watch_surface(watch->state, subsurface->surface))
        failure(watch->state, "Cube surface-watch capacity exhausted; selection cancelled");
}
static bool watch_surface(struct PuWorkspaceCube *state, struct wlr_surface *surface)
{
    struct CubeWatch *existing;
    wl_list_for_each(existing, &state->watches, link) if (existing->surface == surface) return true;
    if (state->watch_count >= 512) return false;
    struct CubeWatch *watch = calloc(1, sizeof(*watch));
    if (!watch) return false;
    watch->state = state; watch->surface = surface;
    watch->commit.notify = watch_commit;
    watch->destroy.notify = watch_destroy;
    watch->subsurface.notify = watch_subsurface;
    wl_signal_add(&surface->events.commit, &watch->commit);
    wl_signal_add(&surface->events.destroy, &watch->destroy);
    wl_signal_add(&surface->events.new_subsurface, &watch->subsurface);
    wl_list_insert(&state->watches, &watch->link);
    state->watch_count++;
    return true;
}
static void watch_iterator(struct wlr_surface *surface, int x, int y, void *data)
{
    (void)x; (void)y;
    struct PuWorkspaceCube *state = data;
    if (!watch_surface(state, surface)) state->watch_failed = true;
}
bool pu_workspace_cube_supported(struct PuDesktop *desktop)
{
    return desktop->cube && desktop->cube->timer && wlr_scene_projection_supported(desktop->renderer);
}
bool pu_workspace_cube_active(struct PuDesktop *desktop)
{
    return desktop->cube && desktop->cube->active;
}
void pu_workspace_cube_status(struct PuDesktop *desktop, bool *enabled, bool *motion,
    bool *active, uint32_t *selected, const char **message)
{
    struct PuWorkspaceCube *state = desktop->cube;
    *enabled = state && state->enabled;
    *motion = !state || state->motion;
    *active = state && state->active;
    *selected = state ? state->selected : 0;
    *message = state ? state->error : "Workspace cube is unavailable";
}
const char *pu_workspace_cube_configure(struct PuDesktop *desktop, bool enabled, bool motion)
{
    struct PuWorkspaceCube *state = desktop->cube;
    if (!state) return "Workspace cube is unavailable";
    if (enabled && !pu_workspace_cube_supported(desktop))
        return "Workspace cube requires a paired GLES graphics session; restart in GPU mode";
    if (enabled && (!pu_workspace_at(desktop, 3) || pu_workspace_at(desktop, 4)))
        return "Workspace cube requires exactly four workspaces";
    pu_workspace_cube_cancel(desktop);
    state->enabled = enabled;
    state->motion = motion;
    state->error[0] = 0;
    pu_shortcuts_cube_changed(desktop);
    return NULL;
}

static bool insert_frame(struct wlr_scene_tree *tree, struct wlr_buffer *frame,
    int x, int y, int width, int height, float opacity)
{
    if (!frame) return false;
    struct wlr_scene_buffer *node = wlr_scene_buffer_create(tree, frame);
    wlr_buffer_drop(frame);
    if (!node) return false;
    wlr_scene_node_set_position(&node->node, x, y);
    wlr_scene_buffer_set_dest_size(node, width, height);
    wlr_scene_buffer_set_opacity(node, opacity);
    return true;
}
static struct wlr_buffer *snapshot(struct wlr_scene_tree *tree, struct wlr_scene_output *output,
    const struct wlr_box *box, float radius, float scale)
{
    float fit = fminf(scale, fminf(1024.0f / box->width, 640.0f / box->height));
    return wlr_scene_tree_snapshot(tree, output, box, radius,
        (int)fmaxf(1, roundf(box->width * fit)), (int)fmaxf(1, roundf(box->height * fit)));
}
static struct wlr_buffer *background(struct PuWorkspaceCube *state, struct CubeOutput *target,
    struct wlr_scene_output *output, int width, int height)
{
    struct wlr_scene_tree *tree = wlr_scene_tree_create(&state->desktop->scene->tree);
    if (!tree) return NULL;
    wlr_scene_node_set_enabled(&tree->node, false);
    bool valid = wlr_scene_rect_create(tree, target->bounds.width, target->bounds.height,
        (float[4]){0.04f, 0.05f, 0.08f, 1}) != NULL;
    unsigned count = 0;
    struct PuDesktopLayer *layer;
    wl_list_for_each_reverse(layer, &state->desktop->layers, link) {
        if (!valid) break;
        if (layer->surface->output != target->output || !layer->surface->surface->mapped ||
            layer->surface->current.layer != ZWLR_LAYER_SHELL_V1_LAYER_BACKGROUND ||
            wl_resource_get_client(layer->surface->resource) != state->desktop->shell_client) continue;
        if (++count > 16) { valid = false; break; }
        struct wlr_box box = {target->bounds.x - layer->tree->node.x,
            target->bounds.y - layer->tree->node.y, target->bounds.width, target->bounds.height};
        valid = insert_frame(tree, snapshot(layer->tree, output, &box, 0,
            (float)width / target->bounds.width), 0, 0, target->bounds.width, target->bounds.height, 1);
    }
    struct wlr_box box = {0, 0, target->bounds.width, target->bounds.height};
    struct wlr_buffer *result = valid ? wlr_scene_tree_snapshot(tree, output, &box, 0, width, height) : NULL;
    wlr_scene_node_destroy(&tree->node);
    return result;
}
static bool capture_sources(struct PuWorkspaceCube *state, struct CubeOutput *target)
{
    struct wlr_scene_output *output = wlr_scene_get_scene_output(state->desktop->scene, target->output);
    if (!output) return false;
    float scale = fminf(target->scale, fminf(800.0f / target->bounds.width, 500.0f / target->bounds.height));
    int width = (int)fmaxf(1, roundf(target->bounds.width * scale));
    int height = (int)fmaxf(1, roundf(target->bounds.height * scale));
    struct wlr_buffer *base = background(state, target, output, width, height);
    if (!base) return false;
    struct wlr_buffer *frames[4] = {0}, *cap = NULL;
    bool valid = true;
    for (unsigned face = 0; face < 4 && valid; face++) {
        struct wlr_scene_tree *tree = wlr_scene_tree_create(&state->desktop->scene->tree);
        if (!tree) { valid = false; break; }
        wlr_scene_node_set_enabled(&tree->node, false);
        struct wlr_scene_buffer *back = wlr_scene_buffer_create(tree, base);
        valid = back != NULL;
        if (back) wlr_scene_buffer_set_dest_size(back, target->bounds.width, target->bounds.height);
        unsigned count = 0;
        struct wlr_scene_node *node;
        wl_list_for_each(node, &state->desktop->windows->children, link) {
            if (!valid) break;
            struct PuDesktopOwner *owner = node->data;
            struct PuDesktopView *view = owner ? owner->view : NULL;
            if (!view || !view->mapped || view->minimized || view->workspace != state->workspaces[face] ||
                wl_resource_get_client(view->toplevel->resource) == state->desktop->shell_client) continue;
            struct wlr_box box;
            float radius;
            if (!pu_decoration_preview_geometry(view, &box, &radius)) { valid = false; break; }
            int x = view->tree->node.x + box.x - target->bounds.x;
            int y = view->tree->node.y + box.y - target->bounds.y;
            if (x >= target->bounds.width || y >= target->bounds.height || x + box.width <= 0 || y + box.height <= 0)
                continue;
            if (++count > 64) { valid = false; break; }
            if (view->shadow->node.enabled) {
                struct wlr_scene_rect *shadow = wlr_scene_shadow_create(tree);
                if (!shadow || !wlr_scene_shadow_set_geometry(shadow, box.width, box.height, radius,
                    view->shadow->shadow_sigma, view->shadow->shadow_offset_x, view->shadow->shadow_offset_y)) {
                    valid = false; break;
                }
                wlr_scene_rect_set_color(shadow, view->shadow->color);
                wlr_scene_node_set_position(&shadow->node, view->tree->node.x + view->shadow->node.x - target->bounds.x,
                    view->tree->node.y + view->shadow->node.y - target->bounds.y);
            }
            valid = insert_frame(tree, snapshot(view->effects, output, &box, radius, scale),
                x, y, box.width, box.height, pu_window_opacity(view));
            if (valid && !wl_list_empty(&view->popups->children)) {
                struct wlr_box popup_box = {target->bounds.x - view->tree->node.x,
                    target->bounds.y - view->tree->node.y, target->bounds.width, target->bounds.height};
                valid = insert_frame(tree, snapshot(view->popups, output, &popup_box, 0, scale),
                    0, 0, target->bounds.width, target->bounds.height, pu_window_opacity(view));
            }
        }
        struct wlr_box box = {0, 0, target->bounds.width, target->bounds.height};
        frames[face] = valid ? wlr_scene_tree_snapshot(tree, output, &box, 0, width, height) : NULL;
        valid = valid && frames[face];
        wlr_scene_node_destroy(&tree->node);
    }
    if (valid) {
        struct wlr_scene_tree *tree = wlr_scene_tree_create(&state->desktop->scene->tree);
        if (tree) {
            wlr_scene_node_set_enabled(&tree->node, false);
            valid = wlr_scene_rect_create(tree, 1, 1, (float[4]){0.10f, 0.13f, 0.20f, 1}) != NULL;
            cap = valid ? wlr_scene_tree_snapshot(tree, output, &(struct wlr_box){0, 0, 1, 1}, 0, 1, 1) : NULL;
            wlr_scene_node_destroy(&tree->node);
        }
        valid = cap != NULL;
    }
    wlr_buffer_drop(base);
    if (valid) {
        drop_sources(target);
        memcpy(target->faces, frames, sizeof(frames));
        target->cap = cap;
    } else {
        for (unsigned face = 0; face < 4; face++) if (frames[face]) wlr_buffer_drop(frames[face]);
        if (cap) wlr_buffer_drop(cap);
    }
    return valid;
}
static bool valid_outputs(struct PuWorkspaceCube *state)
{
    if (pu_session_lock_active(state->desktop) || state->desktop->session_exit_pending ||
        wlr_seat_keyboard_has_grab(state->desktop->seat) || wlr_seat_pointer_has_grab(state->desktop->seat))
        return false;
    for (unsigned face = 0; face < 4; face++)
        if (state->workspaces[face] != pu_workspace_at(state->desktop, face)) return false;
    if (pu_workspace_at(state->desktop, 4)) return false;
    unsigned count = 0;
    struct wlr_output_layout_output *entry;
    wl_list_for_each(entry, &state->desktop->layout->outputs, link) {
        if (!entry->output->enabled) continue;
        bool found = false;
        struct wlr_box box;
        wlr_output_layout_get_box(state->desktop->layout, entry->output, &box);
        for (unsigned index = 0; index < state->output_count; index++)
            if (state->outputs[index].output == entry->output &&
                state->outputs[index].scale == entry->output->scale &&
                wlr_box_equal(&box, &state->outputs[index].bounds)) found = true;
        if (!found) return false;
        count++;
    }
    return count == state->output_count && count > 0;
}
static bool compose(struct PuWorkspaceCube *state, struct CubeOutput *target)
{
    struct wlr_scene_output *output = wlr_scene_get_scene_output(state->desktop->scene, target->output);
    if (!output) return false;
    float factor = fminf(target->scale, fminf(1280.0f / target->bounds.width, 800.0f / target->bounds.height));
    int width = (int)fmaxf(1, floorf(target->bounds.width * factor));
    int height = (int)fmaxf(1, floorf(target->bounds.height * factor));
    struct wlr_scene_projected_quad quads[6] = {0};
    for (unsigned face = 0; face < 6; face++) {
        quads[face].buffer = face < 4 ? target->faces[face] : target->cap;
        quads[face].opacity = 1;
        quads[face].background[3] = 1;
        if (!pu_workspace_cube_project_quad(face, state->pose, target->bounds.width, target->bounds.height,
            quads[face].vertices)) return false;
    }
    struct wlr_buffer *frame = wlr_scene_projected_snapshot(output, quads, 6, width, height,
        (float[4]){0.015f, 0.02f, 0.035f, 1});
    if (!frame) return false;
    wlr_scene_buffer_set_buffer(target->node, frame);
    wlr_buffer_drop(frame);
    return true;
}
static bool refresh(struct PuWorkspaceCube *state)
{
    if (!valid_outputs(state)) return failure(state, "Workspace, input or output layout changed; selection cancelled");
    if (state->animating) {
        uint64_t now = clock_ms();
        if (!now) return failure(state, "Cannot read the transition clock");
        float fraction = fminf(1, (float)(now - state->started) / 180);
        fraction = fraction * fraction * (3 - 2 * fraction);
        state->pose = state->start + (state->goal - state->start) * fraction;
        state->animating = fraction < 1;
    }
    for (unsigned index = 0; index < state->output_count; index++) {
        struct CubeOutput *output = &state->outputs[index];
        if (state->dirty && !capture_sources(state, output))
            return failure(state, "Workspace sources exceed the capture/resource budget or cannot be composed");
        if (!compose(state, output)) return failure(state, "Native cube projection failed; selection cancelled");
    }
    state->dirty = false;
    return true;
}
static bool schedule(struct PuWorkspaceCube *state)
{
    if (state->pending || !state->active) return true;
    if (wl_event_source_timer_update(state->timer, 33) < 0)
        return failure(state, "Cannot schedule the bounded workspace transition");
    state->pending = true;
    return true;
}
static int tick(void *data)
{
    struct PuWorkspaceCube *state = data;
    state->pending = false;
    if (state->active && refresh(state) && state->animating) schedule(state);
    return 0;
}
void pu_workspace_cube_damage(struct PuDesktop *desktop)
{
    struct PuWorkspaceCube *state = desktop->cube;
    if (!state || !state->active) return;
    state->dirty = true;
    schedule(state);
}
void pu_workspace_cube_prepare(struct PuDesktop *desktop, struct wlr_output *output)
{
    (void)output;
    struct PuWorkspaceCube *state = desktop->cube;
    if (state && state->active && !valid_outputs(state))
        failure(state, "Workspace or output layout changed; selection cancelled");
}
static void accept(struct PuWorkspaceCube *state)
{
    if (!valid_outputs(state)) {
        failure(state, "Workspace selection retired before acceptance");
        return;
    }
    struct PuWorkspace *selected = state->workspaces[state->selected];
    pu_workspace_cube_cancel(state->desktop);
    pu_workspace_activate(state->desktop, selected, NULL);
}
void pu_workspace_cube_pointer(struct PuDesktop *desktop, bool choose, double x, double y)
{
    struct PuWorkspaceCube *state = desktop->cube;
    if (!state || !state->active) return;
    if (!choose || !valid_outputs(state)) { pu_workspace_cube_cancel(desktop); return; }
    for (unsigned index = 0; index < state->output_count; index++) {
        struct wlr_box box = state->outputs[index].bounds;
        if (x < box.x || y < box.y || x >= box.x + box.width || y >= box.y + box.height) continue;
        float nearest = 2;
        unsigned picked = 6;
        for (unsigned face = 0; face < 6; face++) {
            float vertices[16], depth;
            if (!pu_workspace_cube_project_quad(face, state->pose, box.width, box.height, vertices)) return;
            if (pu_window_preview_hit_quad(vertices, 1, 1, (x - box.x) / box.width, (y - box.y) / box.height,
                &depth) && depth < nearest) { nearest = depth; picked = face; }
        }
        if (picked < 4) {
            state->selected = picked;
            accept(state);
        } else {
            pu_workspace_cube_cancel(desktop);
        }
        return;
    }
    pu_workspace_cube_cancel(desktop);
}
bool pu_workspace_cube_step(struct PuDesktop *desktop, struct wlr_keyboard *keyboard,
    uint32_t modifiers, int direction)
{
    struct PuWorkspaceCube *state = desktop->cube;
    if (!state || !state->enabled || !keyboard || !modifiers) return false;
    if (!state->active) {
        if (!pu_workspace_cube_supported(desktop) || !pu_workspace_at(desktop, 3) || pu_workspace_at(desktop, 4))
            return failure(state, "Cube requires paired GLES and exactly four workspaces; using immediate switching");
        state->error[0] = 0;
        for (unsigned face = 0; face < 4; face++) {
            state->workspaces[face] = pu_workspace_at(desktop, face);
            if (state->workspaces[face] == desktop->active_workspace) state->selected = face;
        }
        state->pose = (float)state->selected;
        state->keyboard = keyboard;
        state->modifiers = modifiers;
        state->active = true;
        state->watch_failed = false;
        struct PuDesktopView *view;
        wl_list_for_each(view, &desktop->views, link)
            if (!view->minimized && wl_resource_get_client(view->toplevel->resource) != desktop->shell_client)
                wlr_surface_for_each_surface(view->toplevel->base->surface, watch_iterator, state);
        if (state->watch_failed) return failure(state, "Cube surface-watch capacity exhausted; selection cancelled");
        struct wlr_output_layout_output *entry;
        wl_list_for_each(entry, &desktop->layout->outputs, link) {
            if (!entry->output->enabled) continue;
            if (state->output_count == 8) return failure(state, "Cube supports at most eight enabled outputs");
            struct CubeOutput *target = &state->outputs[state->output_count++];
            target->output = entry->output;
            target->scale = entry->output->scale;
            wlr_output_layout_get_box(desktop->layout, target->output, &target->bounds);
            if (target->bounds.width < 1 || target->bounds.height < 1 ||
                target->bounds.width > 32768 || target->bounds.height > 32768)
                return failure(state, "Cube output geometry exceeds its bound");
            target->tree = wlr_scene_tree_create(&desktop->scene->tree);
            target->node = target->tree ? wlr_scene_buffer_create(target->tree, NULL) : NULL;
            if (!target->node) return failure(state, "Cannot allocate native cube recipient");
            target->node->point_accepts_input = no_input;
            wlr_scene_node_set_position(&target->tree->node, target->bounds.x, target->bounds.y);
            wlr_scene_buffer_set_dest_size(target->node, target->bounds.width, target->bounds.height);
        }
        state->dirty = true;
        if (!refresh(state)) return false;
        wlr_seat_pointer_notify_clear_focus(desktop->seat);
    }
    if (state->keyboard != keyboard) return true;
    state->selected = (state->selected + (direction < 0 ? 3 : 1)) % 4;
    state->start = remainderf(state->pose, 4);
    state->goal = state->start + remainderf((float)state->selected - state->start, 4);
    state->started = clock_ms();
    if (!state->started) return failure(state, "Cannot start the workspace transition clock");
    state->animating = state->motion;
    if (!state->motion) state->pose = (float)state->selected;
    if (!refresh(state)) return false;
    pu_shortcuts_cube_changed(desktop);
    if (state->animating) schedule(state);
    return true;
}
bool pu_workspace_cube_key(struct PuDesktop *desktop, uint32_t key)
{
    struct PuWorkspaceCube *state = desktop->cube;
    if (!state || !state->active) return false;
    if (key == XKB_KEY_Escape) pu_workspace_cube_cancel(desktop);
    else if (key == XKB_KEY_Return || key == XKB_KEY_KP_Enter) accept(state);
    else if (key == XKB_KEY_Left || key == XKB_KEY_Right)
        pu_workspace_cube_step(desktop, state->keyboard, state->modifiers, key == XKB_KEY_Left ? -1 : 1);
    return true;
}
void pu_workspace_cube_modifiers(struct PuDesktop *desktop, struct wlr_keyboard *keyboard, uint32_t modifiers)
{
    struct PuWorkspaceCube *state = desktop->cube;
    if (state && state->active && state->keyboard == keyboard &&
        (modifiers & state->modifiers) != state->modifiers) accept(state);
}
static void keyboard_grab(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuWorkspaceCube *state = wl_container_of(listener, state, keyboard_grab);
    pu_workspace_cube_cancel(state->desktop);
}
static void pointer_grab(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuWorkspaceCube *state = wl_container_of(listener, state, pointer_grab);
    pu_workspace_cube_cancel(state->desktop);
}
bool pu_workspace_cube_init(struct PuDesktop *desktop)
{
    struct PuWorkspaceCube *state = calloc(1, sizeof(*state));
    if (!state) return false;
    desktop->cube = state; state->desktop = desktop; state->motion = true;
    wl_list_init(&state->watches);
    state->keyboard_grab.notify = keyboard_grab;
    state->pointer_grab.notify = pointer_grab;
    wl_signal_add(&desktop->seat->events.keyboard_grab_begin, &state->keyboard_grab);
    wl_signal_add(&desktop->seat->events.pointer_grab_begin, &state->pointer_grab);
    state->timer = wl_event_loop_add_timer(wl_display_get_event_loop(desktop->display), tick, state);
    return state->timer != NULL;
}
void pu_workspace_cube_finish(struct PuDesktop *desktop)
{
    if (!desktop->cube) return;
    pu_workspace_cube_cancel(desktop);
    wl_list_remove(&desktop->cube->keyboard_grab.link);
    wl_list_remove(&desktop->cube->pointer_grab.link);
    if (desktop->cube->timer) wl_event_source_remove(desktop->cube->timer);
    free(desktop->cube); desktop->cube = NULL;
}
