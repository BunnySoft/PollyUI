#include "shortcut-control.h"
#include "server.h"
#include "workspace.h"
#include "input-method.h"
#include "window-opacity.h"
#include "window-previews.h"
#include "workspace-cube.h"
#include "polly-shortcuts-server.h"

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
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_subcompositor.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>
#include <xkbcommon/xkbcommon-keysyms.h>

struct Binding {
    struct wl_list link;
    struct PuShortcuts *state;
    struct wl_resource *resource;
    struct PuShortcutBinding pending[PU_SHORTCUT_COUNT];
    bool staged, recording;
    uint32_t preview_request;
    const char *error;
};

struct PreviewSlot {
    uint32_t index;
    struct wlr_box box;
    struct wlr_scene_buffer *node;
    uint64_t revision;
    int width, height;
    bool attempted;
    float ordinal, start_ordinal;
};
struct ProjectionHit {
    uint32_t index;
    float vertices[16];
};
struct PreviewWatch {
    struct wl_list link;
    struct PuShortcuts *state;
    struct wlr_surface *surface;
    struct wl_listener commit, destroy, subsurface;
};

struct PuShortcuts {
    struct PuDesktop *desktop;
    struct wl_global *global;
    struct wl_list bindings;
    struct PuShortcutBinding current[PU_SHORTCUT_COUNT];
    struct Binding *presenter;
    struct wlr_keyboard *keyboard;
    uint64_t *candidates;
    uint32_t count, selected, modifiers, serial;
    bool active;
    struct wlr_scene_tree *preview_tree;
    struct wlr_surface *preview_surface;
    struct PuDesktopLayer *preview_layer;
    struct wl_listener preview_surface_destroy, preview_surface_unmap, preview_tree_destroy;
    struct wl_event_source *preview_timer;
    struct wl_list preview_watches;
    unsigned preview_watch_count, preview_count;
    uint32_t preview_serial, preview_request, preview_ready;
    bool preview_pending, preview_dirty, preview_watch_failed;
    float preview_scale;
    char preview_error[192];
    struct PreviewSlot previews[9];
    struct wlr_scene_buffer *projection_node;
    struct wlr_box projection_box;
    float projection_background[4];
    struct ProjectionHit projection_hits[9];
    unsigned projection_hit_count;
    uint32_t projection_selected;
    uint64_t projection_started;
    bool projected, projection_motion, projection_animating;
};

static struct PuDesktopView *candidate(struct PuShortcuts *state, uint32_t index);
static void preview_damage(struct PuShortcuts *state);
static void previews_refresh(struct PuShortcuts *state, bool notify);

static bool preview_supported(struct PuShortcuts *state)
{
    return state->preview_timer && pu_window_opacity_supported(state->desktop);
}

static void preview_status(struct PuShortcuts *state, bool accepted, const char *message)
{
    if (state->active && state->presenter &&
        wl_resource_get_version(state->presenter->resource) >= 3)
        polly_shortcuts_v1_send_previews_status(state->presenter->resource,
            state->preview_serial, state->preview_request, accepted, state->preview_ready, message);
}

static void watch_remove(struct PreviewWatch *watch)
{
    wl_list_remove(&watch->commit.link);
    wl_list_remove(&watch->destroy.link);
    wl_list_remove(&watch->subsurface.link);
    wl_list_remove(&watch->link);
    watch->state->preview_watch_count--;
    free(watch);
}

static void previews_clear(struct PuShortcuts *state)
{
    if (state->preview_timer) wl_event_source_timer_update(state->preview_timer, 0);
    state->preview_pending = state->preview_dirty = state->preview_watch_failed = false;
    struct PreviewWatch *watch, *tmp;
    wl_list_for_each_safe(watch, tmp, &state->preview_watches, link) watch_remove(watch);
    struct wlr_scene_tree *tree = state->preview_tree;
    if (state->preview_surface) {
        wl_list_remove(&state->preview_surface_destroy.link);
        wl_list_remove(&state->preview_surface_unmap.link);
    }
    if (tree) wl_list_remove(&state->preview_tree_destroy.link);
    state->preview_tree = NULL;
    state->preview_surface = NULL;
    state->preview_layer = NULL;
    state->preview_count = state->preview_ready = 0;
    state->projected = state->projection_motion = state->projection_animating = false;
    state->projection_node = NULL;
    state->projection_hit_count = 0;
    memset(state->previews, 0, sizeof(state->previews));
    state->preview_error[0] = '\0';
    if (tree) wlr_scene_node_destroy(&tree->node);
}

static void preview_surface_destroy(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuShortcuts *state = wl_container_of(listener, state, preview_surface_destroy);
    previews_clear(state);
    preview_status(state, false, "Window preview target retired");
}

static void preview_surface_unmap(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuShortcuts *state = wl_container_of(listener, state, preview_surface_unmap);
    previews_clear(state);
    preview_status(state, false, "Window preview target unmapped");
}

static void preview_tree_destroy(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuShortcuts *state = wl_container_of(listener, state, preview_tree_destroy);
    wl_list_remove(&state->preview_tree_destroy.link);
    state->preview_tree = NULL;
    previews_clear(state);
    preview_status(state, false, "Window preview output retired");
}

static bool watch_surface(struct PuShortcuts *state, struct wlr_surface *surface);
static void watch_commit(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PreviewWatch *watch = wl_container_of(listener, watch, commit);
    preview_damage(watch->state);
}
static void watch_destroy(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PreviewWatch *watch = wl_container_of(listener, watch, destroy);
    struct PuShortcuts *state = watch->state;
    watch_remove(watch);
    preview_damage(state);
}
static void watch_subsurface(struct wl_listener *listener, void *data)
{
    struct PreviewWatch *watch = wl_container_of(listener, watch, subsurface);
    struct wlr_subsurface *subsurface = data;
    if (!watch_surface(watch->state, subsurface->surface)) {
        watch->state->preview_watch_failed = true;
        snprintf(watch->state->preview_error, sizeof(watch->state->preview_error),
            "Live previews paused: surface-watch limit or allocation failure.");
        preview_status(watch->state, true, watch->state->preview_error);
    }
    preview_damage(watch->state);
}
static bool watch_surface(struct PuShortcuts *state, struct wlr_surface *surface)
{
    struct PreviewWatch *existing;
    wl_list_for_each(existing, &state->preview_watches, link)
        if (existing->surface == surface) return true;
    if (state->preview_watch_count >= 512) return false;
    struct PreviewWatch *watch = calloc(1, sizeof(*watch));
    if (!watch) return false;
    watch->state = state;
    watch->surface = surface;
    watch->commit.notify = watch_commit;
    watch->destroy.notify = watch_destroy;
    watch->subsurface.notify = watch_subsurface;
    wl_signal_add(&surface->events.commit, &watch->commit);
    wl_signal_add(&surface->events.destroy, &watch->destroy);
    wl_signal_add(&surface->events.new_subsurface, &watch->subsurface);
    wl_list_insert(state->preview_watches.prev, &watch->link);
    state->preview_watch_count++;
    return true;
}
static void watch_iterator(struct wlr_surface *surface, int x, int y, void *data)
{
    (void)x; (void)y;
    struct PuShortcuts *state = data;
    if (!watch_surface(state, surface)) state->preview_watch_failed = true;
}

static void preview_frame_done(struct wlr_surface *surface, int x, int y, void *data)
{
    (void)x; (void)y;
    wlr_surface_send_frame_done(surface, data);
}

static bool preview_capture_slot(struct PuShortcuts *state, struct PreviewSlot *slot,
    struct wlr_scene_output *output, int width, int height)
{
    struct PuDesktopView *view = candidate(state, slot->index);
    if (!view || !output) {
        wlr_scene_buffer_set_buffer(slot->node, NULL);
        return false;
    }
    uint64_t revision = pu_window_preview_revision(view);
    if (!slot->attempted || slot->revision != revision || slot->width != width || slot->height != height) {
        struct wlr_buffer *frame = pu_window_preview_frame(view, output, width, height);
        slot->attempted = true;
        slot->revision = revision;
        slot->width = width;
        slot->height = height;
        wlr_scene_buffer_set_buffer(slot->node, frame);
        if (frame) {
            wlr_buffer_drop(frame);
            if (!view->minimized) {
                struct timespec now;
                clock_gettime(CLOCK_MONOTONIC, &now);
                wlr_surface_for_each_surface(view->toplevel->base->surface, preview_frame_done, &now);
            }
        }
    }
    return slot->node->buffer != NULL;
}

static uint64_t projection_clock(void)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        wlr_log(WLR_ERROR, "Cannot read the 3D preview animation clock");
        return 0;
    }
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static void projection_select(struct PuShortcuts *state)
{
    if (!state->projected || state->projection_selected == state->selected) return;
    struct PreviewSlot next[9] = {0};
    int matches[9];
    bool used[9] = {0};
    for (unsigned index = 0; index < state->preview_count; index++) {
        matches[index] = -1;
        uint32_t candidate_index = (state->selected + index) % state->count;
        for (unsigned previous = 0; previous < state->preview_count; previous++) {
            if (state->previews[previous].index != candidate_index) continue;
            matches[index] = (int)previous;
            used[previous] = true;
            break;
        }
    }
    for (unsigned index = 0; index < state->preview_count; index++) {
        int previous = matches[index];
        if (previous < 0) {
            for (unsigned available = 0; available < state->preview_count; available++)
                if (!used[available]) { previous = (int)available; used[available] = true; break; }
        }
        next[index] = state->previews[previous];
        if (matches[index] < 0) {
            wlr_scene_buffer_set_buffer(next[index].node, NULL);
            next[index].attempted = false;
            next[index].ordinal = (float)index;
        }
        next[index].index = (state->selected + index) % state->count;
        next[index].start_ordinal = next[index].ordinal;
    }
    memcpy(state->previews, next, sizeof(next));
    struct PreviewWatch *watch, *tmp;
    wl_list_for_each_safe(watch, tmp, &state->preview_watches, link) watch_remove(watch);
    state->preview_watch_failed = false;
    for (unsigned index = 0; index < state->preview_count; index++) {
        struct PuDesktopView *view = candidate(state, state->previews[index].index);
        if (view) wlr_surface_for_each_surface(view->toplevel->base->surface, watch_iterator, state);
    }
    state->projection_selected = state->selected;
    state->projection_started = projection_clock();
    state->projection_animating = state->projection_motion && state->projection_started && !state->preview_watch_failed;
    previews_refresh(state, true);
}

static void projection_refresh(struct PuShortcuts *state, struct wlr_scene_output *output, bool notify)
{
    const char *message = state->preview_watch_failed ?
        "Live previews paused: surface-watch limit or allocation failure." : "";
    float scale = state->preview_layer->surface->output->scale;
    int source_width = (int)fminf(1024, fmaxf(256, roundf(state->projection_box.width * scale * 0.72f)));
    int source_height = source_width * 5 / 8;
    float factor = fminf(scale, fminf((float)WLR_SCENE_PROJECTION_MAX_WIDTH / state->projection_box.width,
        (float)WLR_SCENE_PROJECTION_MAX_HEIGHT / state->projection_box.height));
    int width = (int)fmaxf(1, floorf(state->projection_box.width * factor));
    int height = (int)fmaxf(1, floorf(state->projection_box.height * factor));
    float progress = 1;
    if (state->projection_animating) {
        uint64_t now = projection_clock();
        if (!now) {
            state->projection_animating = false;
            message = "3D transition clock unavailable; showing the final pose.";
        } else {
            progress = fminf(1, (float)(now - state->projection_started) / 180);
            progress = progress * progress * (3 - 2 * progress);
            if (progress >= 1) state->projection_animating = false;
        }
    }
    struct wlr_scene_projected_quad quads[9] = {0};
    struct ProjectionHit hits[9] = {0};
    unsigned count = 0;
    for (int index = (int)state->preview_count - 1; index >= 0; index--) {
        struct PreviewSlot *slot = &state->previews[index];
        if (!preview_capture_slot(state, slot, output, source_width, source_height)) {
            message = "Some 3D window previews are unavailable: source, scale or composition budget.";
            continue;
        }
        float ordinal = slot->start_ordinal + ((float)index - slot->start_ordinal) * progress;
        quads[count].buffer = slot->node->buffer;
        quads[count].opacity = 1;
        memcpy(quads[count].background, state->projection_background, sizeof(quads[count].background));
        if (!pu_window_preview_project_quad(ordinal, state->projection_box.width, state->projection_box.height,
            quads[count].vertices)) {
            message = "3D window preview geometry is unavailable.";
            continue;
        }
        slot->ordinal = ordinal;
        hits[count].index = slot->index;
        memcpy(hits[count].vertices, quads[count].vertices, sizeof(hits[count].vertices));
        count++;
    }
    struct wlr_buffer *frame = count ? wlr_scene_projected_snapshot(output, quads, count, width, height,
        state->projection_background) : NULL;
    wlr_scene_buffer_set_buffer(state->projection_node, frame);
    uint32_t ready = frame ? 1 : 0;
    state->projection_hit_count = frame ? count : 0;
    if (frame) {
        memcpy(state->projection_hits, hits, sizeof(hits));
        wlr_buffer_drop(frame);
    } else {
        state->projection_animating = false;
        message = "Native 3D composition failed; choose the title list or 2D previews.";
    }
    state->preview_scale = scale;
    if (state->preview_ready != ready || strcmp(state->preview_error, message)) {
        state->preview_ready = ready;
        snprintf(state->preview_error, sizeof(state->preview_error), "%s", message);
        if (notify) preview_status(state, true, state->preview_error);
    }
    if (state->projection_animating) preview_damage(state);
}

static void previews_refresh(struct PuShortcuts *state, bool notify)
{
    if (!state->active || !state->preview_tree || !state->preview_layer ||
        state->preview_serial != state->serial ||
        !state->preview_layer->surface->output->enabled) return;
    uint32_t ready = 0;
    const char *message = state->preview_watch_failed ? "Live previews paused: surface-watch limit or allocation failure." : "";
    float scale = state->preview_layer->surface->output->scale;
    struct wlr_scene_output *output = wlr_scene_get_scene_output(state->desktop->scene,
        state->preview_layer->surface->output);
    if (state->projected) {
        if (output) projection_refresh(state, output, notify);
        return;
    }
    for (unsigned index = 0; index < state->preview_count; index++) {
        struct PreviewSlot *slot = &state->previews[index];
        int width = (int)lroundf(slot->box.width * scale), height = (int)lroundf(slot->box.height * scale);
        if (preview_capture_slot(state, slot, output, width, height)) ready |= 1u << index;
        else message = "Some window previews are unavailable: source, scale or composition budget.";
    }
    state->preview_scale = scale;
    if (state->preview_ready != ready || strcmp(state->preview_error, message)) {
        state->preview_ready = ready;
        snprintf(state->preview_error, sizeof(state->preview_error), "%s", message);
        if (notify) preview_status(state, true, state->preview_error);
    }
}

static int preview_tick(void *data)
{
    struct PuShortcuts *state = data;
    state->preview_pending = false;
    if (!state->preview_dirty || state->preview_watch_failed) return 0;
    state->preview_dirty = false;
    previews_refresh(state, true);
    return 0;
}

static void preview_damage(struct PuShortcuts *state)
{
    if (!state->preview_tree || !state->active) return;
    state->preview_dirty = true;
    if (!state->preview_pending && state->preview_timer && !state->preview_watch_failed &&
        state->preview_layer->surface->output->enabled) {
        if (wl_event_source_timer_update(state->preview_timer, 33) < 0) {
            snprintf(state->preview_error, sizeof(state->preview_error), "Live preview scheduling failed.");
            preview_status(state, true, state->preview_error);
            wlr_log(WLR_ERROR, "%s", state->preview_error);
        } else state->preview_pending = true;
    }
}

static uint32_t modifiers(struct wlr_keyboard *keyboard)
{
    uint32_t mods = wlr_keyboard_get_modifiers(keyboard);
    return ((mods & WLR_MODIFIER_SHIFT) ? PU_SHORTCUT_SHIFT : 0) |
        ((mods & WLR_MODIFIER_CTRL) ? PU_SHORTCUT_CTRL : 0) |
        ((mods & WLR_MODIFIER_ALT) ? PU_SHORTCUT_ALT : 0) |
        ((mods & WLR_MODIFIER_LOGO) ? PU_SHORTCUT_SUPER : 0);
}

static struct PuDesktopView *candidate(struct PuShortcuts *state, uint32_t index)
{
    struct PuDesktopView *view;
    wl_list_for_each(view, &state->desktop->views, link)
        if (view->workspace_window == state->candidates[index] && pu_workspace_current(view)) return view;
    return NULL;
}

static void label(char *target, size_t size, const char *source)
{
    if (!source) source = "";
    size_t length = strlen(source);
    if (length >= size) {
        length = size - 1;
        while (length && ((unsigned char)source[length] & 0xc0) == 0x80) length--;
    }
    memcpy(target, source, length);
    target[length] = '\0';
}

static void send_switcher(struct PuShortcuts *state)
{
    if (!state->active || !state->presenter) return;
    if (state->preview_tree && state->preview_serial != state->serial) previews_clear(state);
    projection_select(state);
    struct wl_resource *resource = state->presenter->resource;
    polly_shortcuts_v1_send_switcher_begin(resource, state->serial, state->count, state->selected);
    for (uint32_t i = 0; i < state->count; i++) {
        struct PuDesktopView *view = candidate(state, i);
        if (!view) {
            wlr_log(WLR_ERROR, "Window switcher lost a mapped candidate");
            pu_shortcuts_cancel(state->desktop);
            return;
        }
        char title[256], app_id[128];
        label(title, sizeof(title), view->toplevel->title);
        label(app_id, sizeof(app_id), view->toplevel->app_id);
        polly_shortcuts_v1_send_switcher_item(resource, i, title, app_id);
    }
    polly_shortcuts_v1_send_switcher_done(resource);
}

void pu_shortcuts_cancel(struct PuDesktop *desktop)
{
    pu_workspace_cube_cancel(desktop);
    struct PuShortcuts *state = desktop->shortcuts;
    if (!state) return;
    previews_clear(state);
    if (!state->active) return;
    state->active = false;
    if (state->presenter) polly_shortcuts_v1_send_switcher_closed(state->presenter->resource);
    free(state->candidates); state->candidates = NULL;
    state->keyboard = NULL; state->count = 0;
}

bool pu_shortcuts_switching(struct PuDesktop *desktop)
{ return (desktop->shortcuts && desktop->shortcuts->active) || pu_workspace_cube_active(desktop); }

static void accept(struct PuShortcuts *state)
{
    if (!state->active) return;
    uint64_t id = state->candidates[state->selected];
    pu_shortcuts_cancel(state->desktop);
    pu_desktop_focus_mapped(state->desktop, id);
}

static bool switch_window(struct PuShortcuts *state, struct wlr_keyboard *keyboard, bool reverse)
{
    if (!state->presenter) return false;
    if (!state->active) {
        uint32_t count = 0;
        struct PuDesktopView *view;
        wl_list_for_each(view, &state->desktop->views, link) if (pu_workspace_current(view)) count++;
        if (!count) return true;
        if (count > PU_SHORTCUT_MAX_WINDOWS) {
            wlr_log(WLR_ERROR, "Visual switcher candidate limit exceeded; using immediate switching");
            return false;
        }
        state->candidates = calloc(count, sizeof(*state->candidates));
        if (!state->candidates) {
            wlr_log(WLR_ERROR, "Cannot allocate visual switcher; using immediate switching");
            return false;
        }
        uint32_t index = 0, focused = 0;
        bool has_focus = false;
        wl_list_for_each(view, &state->desktop->views, link) {
            if (!pu_workspace_current(view)) continue;
            if (view == state->desktop->focused) { focused = index; has_focus = true; }
            state->candidates[index++] = view->workspace_window;
        }
        state->count = count;
        if (++state->serial == 0) state->serial++;
        state->selected = has_focus ? (focused + (reverse ? count - 1 : 1)) % count : reverse ? count - 1 : 0;
        state->keyboard = keyboard;
        state->modifiers = state->current[PU_SHORTCUT_SWITCH].modifiers;
        state->active = true;
    } else {
        state->selected = (state->selected + (reverse ? state->count - 1 : 1)) % state->count;
    }
    send_switcher(state);
    return true;
}

bool pu_shortcuts_key(struct PuDesktop *desktop, struct wlr_keyboard *keyboard, xkb_keysym_t key)
{
    struct PuShortcuts *state = desktop->shortcuts;
    struct Binding *binding;
    wl_list_for_each(binding, &state->bindings, link)
        if (binding->recording && desktop->focused_layer) return false;
    if (pu_workspace_cube_active(desktop)) {
        uint32_t mods = modifiers(keyboard);
        int action = pu_shortcut_match(state->current, key, mods);
        if (action == PU_SHORTCUT_WORKSPACE_PREVIOUS || action == PU_SHORTCUT_WORKSPACE_NEXT)
            pu_workspace_cube_step(desktop, keyboard, state->current[action].modifiers,
                action == PU_SHORTCUT_WORKSPACE_PREVIOUS ? -1 : 1);
        else pu_workspace_cube_key(desktop, key);
        return true;
    }
    if (state->active && key == XKB_KEY_Escape) { pu_shortcuts_cancel(desktop); return true; }
    uint32_t mods = modifiers(keyboard);
    if ((mods & PU_SHORTCUT_ALT) && key == XKB_KEY_Escape) {
        pu_desktop_request_logout(desktop);
        return true;
    }
    if (desktop->focused_layer) return false;
    int action = pu_shortcut_match(state->current, key, mods);
    if (action < 0) return false;
    if (desktop->grab != PU_DESKTOP_PASSTHROUGH &&
        action != PU_SHORTCUT_WORKSPACE_PREVIOUS && action != PU_SHORTCUT_WORKSPACE_NEXT) return false;
    bool reverse = (mods & PU_SHORTCUT_SHIFT) != 0;
    if ((action == PU_SHORTCUT_WORKSPACE_PREVIOUS || action == PU_SHORTCUT_WORKSPACE_NEXT) &&
        desktop->grab == PU_DESKTOP_PASSTHROUGH &&
        pu_workspace_cube_step(desktop, keyboard, state->current[action].modifiers,
            action == PU_SHORTCUT_WORKSPACE_PREVIOUS ? -1 : 1)) return true;
    if (action == PU_SHORTCUT_SWITCH && switch_window(state, keyboard, reverse)) return true;
    pu_shortcuts_cancel(desktop);
    pu_desktop_shortcut_action(desktop, action, reverse);
    return true;
}

void pu_shortcuts_modifiers(struct PuDesktop *desktop, struct wlr_keyboard *keyboard)
{
    pu_workspace_cube_modifiers(desktop, keyboard, modifiers(keyboard));
    struct PuShortcuts *state = desktop->shortcuts;
    if (state && state->active && wlr_seat_keyboard_has_grab(desktop->seat)) {
        pu_shortcuts_cancel(desktop);
        return;
    }
    if (state && state->active && state->keyboard == keyboard &&
        (modifiers(keyboard) & state->modifiers) != state->modifiers) accept(state);
}

void pu_shortcuts_keyboard_removed(struct PuDesktop *desktop, struct wlr_keyboard *keyboard)
{
    pu_workspace_cube_cancel(desktop);
    if (desktop->shortcuts && desktop->shortcuts->keyboard == keyboard) pu_shortcuts_cancel(desktop);
}

void pu_shortcuts_unmap(struct PuDesktopView *view)
{
    pu_workspace_cube_damage(view->desktop);
    struct PuShortcuts *state = view->desktop->shortcuts;
    if (!state || !state->active) return;
    for (uint32_t i = 0; i < state->count; i++) {
        if (state->candidates[i] != view->workspace_window) continue;
        memmove(state->candidates + i, state->candidates + i + 1, (state->count - i - 1) * sizeof(uint64_t));
        state->count--;
        if (!state->count) { pu_shortcuts_cancel(view->desktop); return; }
        if (++state->serial == 0) state->serial++;
        if (i < state->selected) state->selected--;
        if (state->selected >= state->count) state->selected = 0;
        send_switcher(state);
        return;
    }
}

void pu_shortcuts_metadata(struct PuDesktopView *view)
{
    struct PuShortcuts *state = view->desktop->shortcuts;
    if (!state || !state->active) return;
    for (uint32_t i = 0; i < state->count; i++)
        if (state->candidates[i] == view->workspace_window) { send_switcher(state); return; }
}

static void send_bindings(struct Binding *binding)
{
    for (uint32_t i = 0; i < PU_SHORTCUT_COUNT; i++) {
        char key[128] = "";
        if (binding->state->current[i].key)
            xkb_keysym_get_name(binding->state->current[i].key, key, sizeof(key));
        polly_shortcuts_v1_send_binding(binding->resource, i, binding->state->current[i].modifiers, key);
    }
    polly_shortcuts_v1_send_bindings_done(binding->resource);
}

static void destroy_request(struct wl_client *client, struct wl_resource *resource)
{ (void)client; wl_resource_destroy(resource); }

static void set_binding(struct wl_client *client, struct wl_resource *resource,
                        uint32_t action, uint32_t mods, const char *name)
{
    (void)client;
    struct Binding *binding = wl_resource_get_user_data(resource);
    if (!binding->staged) {
        memcpy(binding->pending, binding->state->current, sizeof(binding->pending));
        binding->staged = true;
    }
    if (action >= PU_SHORTCUT_COUNT) { binding->error = "Unknown shortcut action"; return; }
    xkb_keysym_t key;
    if (!pu_shortcut_key(name, &key)) { binding->error = "Unknown shortcut key"; return; }
    binding->pending[action] = (struct PuShortcutBinding){ mods, key };
}

static void commit(struct wl_client *client, struct wl_resource *resource, uint32_t serial)
{
    struct Binding *binding = wl_resource_get_user_data(resource);
    if (client != binding->state->desktop->shell_client) {
        wl_client_post_implementation_error(client, "Shortcut authorization was revoked");
        return;
    }
    const char *error = binding->error;
    if (!error && binding->staged) error = pu_shortcut_validate(binding->pending);
    if (!error && binding->staged) {
        pu_shortcuts_cancel(binding->state->desktop);
        memcpy(binding->state->current, binding->pending, sizeof(binding->pending));
        struct Binding *peer;
        wl_list_for_each(peer, &binding->state->bindings, link) send_bindings(peer);
    }
    binding->staged = false; binding->error = NULL;
    polly_shortcuts_v1_send_configured(resource, serial, error ? error : "");
}

static void presenter(struct wl_client *client, struct wl_resource *resource, uint32_t enabled)
{
    (void)client;
    struct Binding *binding = wl_resource_get_user_data(resource);
    struct PuShortcuts *state = binding->state;
    if (enabled) {
        if (state->presenter && state->presenter != binding) {
            previews_clear(state);
            polly_shortcuts_v1_send_switcher_closed(state->presenter->resource);
        }
        state->presenter = binding;
        send_switcher(state);
    } else if (state->presenter == binding) {
        pu_shortcuts_cancel(state->desktop);
        state->presenter = NULL;
    }
}

bool pu_shortcuts_recording(struct PuDesktop *desktop)
{
    if (!desktop->shortcuts) return false;
    struct Binding *binding;
    wl_list_for_each(binding, &desktop->shortcuts->bindings, link)
        if (binding->recording) return true;
    return false;
}

static void recording(struct wl_client *client, struct wl_resource *resource, uint32_t enabled)
{
    (void)client;
    struct Binding *binding = wl_resource_get_user_data(resource);
    binding->recording = enabled != 0;
    if (enabled) pu_workspaces_system_menu_cancel(binding->state->desktop);
    if (enabled) pu_workspaces_picker_cancel(binding->state->desktop);
    if (enabled) pu_shortcuts_cancel(binding->state->desktop);
}

static void accept_request(struct wl_client *client, struct wl_resource *resource, uint32_t serial, uint32_t index)
{
    (void)client;
    struct Binding *binding = wl_resource_get_user_data(resource);
    struct PuShortcuts *state = binding->state;
    if (state->presenter != binding || !state->active || serial != state->serial || index >= state->count) {
        wlr_log(WLR_DEBUG, "Ignoring stale window-switcher acceptance");
        return;
    }
    state->selected = index;
    accept(state);
}

static void cancel_request(struct wl_client *client, struct wl_resource *resource)
{
    (void)client;
    struct Binding *binding = wl_resource_get_user_data(resource);
    if (binding->state->presenter == binding) pu_shortcuts_cancel(binding->state->desktop);
}

static void send_cube(struct Binding *binding)
{
    if (wl_resource_get_version(binding->resource) < 5) return;
    bool enabled, motion, active;
    uint32_t selected;
    const char *message;
    pu_workspace_cube_status(binding->state->desktop, &enabled, &motion, &active, &selected, &message);
    polly_shortcuts_v1_send_cube_status(binding->resource,
        pu_workspace_cube_supported(binding->state->desktop), enabled, motion, active, selected, message);
}
void pu_shortcuts_cube_changed(struct PuDesktop *desktop)
{
    if (!desktop->shortcuts) return;
    struct Binding *binding;
    wl_list_for_each(binding, &desktop->shortcuts->bindings, link) send_cube(binding);
}
static void configure_cube(struct wl_client *client, struct wl_resource *resource,
    uint32_t serial, uint32_t enabled, uint32_t motion)
{
    struct Binding *binding = wl_resource_get_user_data(resource);
    if (client != binding->state->desktop->shell_client) {
        wl_client_post_implementation_error(client, "Cube authorization was revoked");
        return;
    }
    const char *error = enabled > 1 || motion > 1 ? "Cube policy requires boolean enabled/motion" :
        pu_workspace_cube_configure(binding->state->desktop, enabled != 0, motion != 0);
    polly_shortcuts_v1_send_cube_configured(resource, serial, error ? error : "");
}

static bool preview_no_input(struct wlr_scene_buffer *buffer, double *x, double *y)
{
    (void)buffer; (void)x; (void)y;
    return false;
}

static struct PuDesktopLayer *preview_target(struct PuShortcuts *state, struct wlr_surface *surface)
{
    struct PuDesktopLayer *layer;
    wl_list_for_each(layer, &state->desktop->layers, link) {
        if (layer->surface->surface != surface) continue;
        struct wlr_layer_surface_v1 *role = layer->surface;
        if (wl_resource_get_client(surface->resource) != state->desktop->shell_client ||
            !layer->ready || !surface->mapped || !surface->buffer || !role->output || !role->output->enabled ||
            role->current.layer != ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY ||
            role->current.keyboard_interactive != ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE ||
            role->current.exclusive_zone != -1 || role->current.anchor ||
            !role->current.desired_width || !role->current.desired_height ||
            surface->current.width < 1 || surface->current.height < 1 ||
            surface->current.width > 4096 || surface->current.height > 768 ||
            surface->current.width != layer->pending_box.width || surface->current.height != layer->pending_box.height ||
            pixman_region32_not_empty(&surface->opaque_region))
            return NULL;
        return layer;
    }
    return NULL;
}

static void configure_preview_scene(struct wl_client *client, struct wl_resource *resource,
    uint32_t serial, uint32_t request, struct wl_resource *surface_resource,
    uint32_t background, struct wl_array *rectangles, bool projected)
{
    struct Binding *binding = wl_resource_get_user_data(resource);
    struct PuShortcuts *state = binding->state;
    const char *error = NULL;
    if (client != state->desktop->shell_client || state->presenter != binding || !state->active ||
        serial != state->serial) error = "Window preview selection is stale or unauthorized";
    else if (!request || request <= binding->preview_request) error = "Obsolete window preview request";
    else binding->preview_request = request;
    struct wlr_surface *surface = wlr_surface_from_resource(surface_resource);
    struct PuDesktopLayer *layer = !error ? preview_target(state, surface) : NULL;
    if (!error && (!preview_supported(state) || !layer))
        error = "Window previews require a supported renderer and a live owned selector";
    if (!error && projected && !wlr_scene_projection_supported(state->desktop->renderer))
        error = "3D window switching requires a supported GLES graphics session";
    if (!error && (background > 0xffffff || !rectangles->size ||
        rectangles->size % (5 * sizeof(uint32_t)) || rectangles->size > 9 * 5 * sizeof(uint32_t)))
        error = "Invalid bounded window preview rectangles";
    struct PreviewSlot slots[9] = {0};
    unsigned count = !error ? rectangles->size / (5 * sizeof(uint32_t)) : 0;
    struct wlr_box viewport = {0};
    bool animate = false;
    if (!error && projected) {
        uint32_t words[5];
        if (count != 1) error = "3D window switching requires one bounded viewport";
        else {
            memcpy(words, rectangles->data, sizeof(words));
            if (words[0] > 1 || !words[3] || !words[4] ||
                (uint64_t)words[1] + words[3] > (unsigned)surface->current.width ||
                (uint64_t)words[2] + words[4] > (unsigned)surface->current.height)
                error = "3D viewport is outside its current selector";
            else {
                animate = words[0] == 1;
                viewport = (struct wlr_box){(int)words[1], (int)words[2], (int)words[3], (int)words[4]};
                count = state->count < 9 ? state->count : 9;
                for (unsigned index = 0; index < count; index++) {
                    slots[index].index = (state->selected + index) % state->count;
                    slots[index].ordinal = slots[index].start_ordinal = (float)index;
                }
            }
        }
    }
    for (unsigned index = 0; !error && !projected && index < count; index++) {
        uint32_t words[5];
        memcpy(words, (char *)rectangles->data + index * sizeof(words), sizeof(words));
        if (words[0] >= state->count || !words[3] || !words[4] || words[3] > 512 || words[4] > 320 ||
            (uint64_t)words[1] + words[3] > (unsigned)surface->current.width ||
            (uint64_t)words[2] + words[4] > (unsigned)surface->current.height) {
            error = "Window preview rectangle is outside its current selector";
            break;
        }
        for (unsigned previous = 0; previous < index; previous++)
            if (slots[previous].index == words[0]) error = "Duplicate window preview candidate";
        slots[index].index = words[0];
        slots[index].box = (struct wlr_box){(int)words[1], (int)words[2], (int)words[3], (int)words[4]};
    }
    struct wlr_scene_tree *tree = !error ? wlr_scene_tree_create(layer->tree) : NULL;
    struct wlr_scene_buffer *projection_node = NULL;
    float color[] = {((background >> 16) & 255) / 255.0f,
        ((background >> 8) & 255) / 255.0f, (background & 255) / 255.0f, 1};
    if (!error && !tree) error = "Cannot allocate window preview scene";
    if (tree) {
        wlr_scene_node_lower_to_bottom(&tree->node);
        if (!wlr_scene_rect_create(tree, surface->current.width, surface->current.height, color))
            error = "Cannot allocate selector background";
        for (unsigned index = 0; !error && index < count; index++) {
            slots[index].node = wlr_scene_buffer_create(tree, NULL);
            if (!slots[index].node) { error = "Cannot allocate preview recipient"; break; }
            slots[index].node->point_accepts_input = preview_no_input;
            if (projected) wlr_scene_node_set_enabled(&slots[index].node->node, false);
            else {
                wlr_scene_node_set_position(&slots[index].node->node, slots[index].box.x, slots[index].box.y);
                wlr_scene_buffer_set_dest_size(slots[index].node, slots[index].box.width, slots[index].box.height);
            }
        }
        if (!error && projected) {
            projection_node = wlr_scene_buffer_create(tree, NULL);
            if (!projection_node) error = "Cannot allocate the native 3D viewport recipient";
            else {
                projection_node->point_accepts_input = preview_no_input;
                wlr_scene_node_set_position(&projection_node->node, viewport.x, viewport.y);
                wlr_scene_buffer_set_dest_size(projection_node, viewport.width, viewport.height);
            }
        }
    }
    if (error) {
        if (tree) wlr_scene_node_destroy(&tree->node);
        polly_shortcuts_v1_send_previews_status(resource, serial, request, 0, 0, error);
        return;
    }
    previews_clear(state);
    state->preview_tree = tree;
    state->preview_surface = surface;
    state->preview_layer = layer;
    state->preview_serial = serial;
    state->preview_request = request;
    state->preview_count = count;
    state->projected = projected;
    state->projection_motion = animate;
    state->projection_selected = state->selected;
    state->projection_node = projection_node;
    state->projection_box = viewport;
    memcpy(state->projection_background, color, sizeof(color));
    memcpy(state->previews, slots, sizeof(slots));
    state->preview_surface_destroy.notify = preview_surface_destroy;
    state->preview_surface_unmap.notify = preview_surface_unmap;
    state->preview_tree_destroy.notify = preview_tree_destroy;
    wl_signal_add(&surface->events.destroy, &state->preview_surface_destroy);
    wl_signal_add(&surface->events.unmap, &state->preview_surface_unmap);
    wl_signal_add(&tree->node.events.destroy, &state->preview_tree_destroy);
    for (unsigned index = 0; index < count; index++) {
        struct PuDesktopView *view = candidate(state, slots[index].index);
        if (view) wlr_surface_for_each_surface(view->toplevel->base->surface, watch_iterator, state);
    }
    previews_refresh(state, false);
    polly_shortcuts_v1_send_previews_status(resource, serial, request, 1, state->preview_ready, state->preview_error);
}

static void configure_previews(struct wl_client *client, struct wl_resource *resource,
    uint32_t serial, uint32_t request, struct wl_resource *surface,
    uint32_t background, struct wl_array *rectangles)
{
    configure_preview_scene(client, resource, serial, request, surface, background, rectangles, false);
}

static void configure_projection(struct wl_client *client, struct wl_resource *resource,
    uint32_t serial, uint32_t request, struct wl_resource *surface,
    uint32_t background, struct wl_array *viewport)
{
    configure_preview_scene(client, resource, serial, request, surface, background, viewport, true);
}

static void pick_projection(struct wl_client *client, struct wl_resource *resource,
    uint32_t serial, uint32_t probe, int32_t x, int32_t y)
{
    struct Binding *binding = wl_resource_get_user_data(resource);
    struct PuShortcuts *state = binding->state;
    const char *error = "";
    uint32_t selected = UINT32_MAX;
    float closest = 2;
    if (client != state->desktop->shell_client || state->presenter != binding || !state->active ||
        serial != state->serial || !state->projected || state->preview_serial != serial ||
        !state->preview_ready || !preview_target(state, state->preview_surface))
        error = "The native 3D window selector is stale or unavailable";
    else if (x < 0 || y < 0 || x >= state->projection_box.width || y >= state->projection_box.height)
        error = "The native 3D pointer is outside its viewport";
    else for (unsigned index = 0; index < state->projection_hit_count; index++) {
        const struct ProjectionHit *hit = &state->projection_hits[index];
        float depth;
        if (pu_window_preview_hit_quad(hit->vertices, state->projection_box.width, state->projection_box.height,
            x, y, &depth) && depth <= closest) {
            closest = depth;
            selected = hit->index;
        }
    }
    polly_shortcuts_v1_send_projection_hit(resource, serial, probe, selected, error);
}

void pu_shortcuts_preview_damage(struct PuDesktopView *view)
{
    pu_workspace_cube_damage(view->desktop);
    struct PuShortcuts *state = view->desktop->shortcuts;
    if (!state || !state->active || !state->preview_tree) return;
    for (unsigned index = 0; index < state->preview_count; index++) {
        struct PuDesktopView *source = candidate(state, state->previews[index].index);
        if (source == view) { preview_damage(state); return; }
    }
}

void pu_shortcuts_prepare_previews(struct PuDesktop *desktop, struct wlr_output *output)
{
    struct PuShortcuts *state = desktop->shortcuts;
    if (!state || !state->active || !state->preview_layer || state->preview_layer->surface->output != output) return;
    if (!preview_target(state, state->preview_surface)) {
        previews_clear(state);
        preview_status(state, false, "Window preview target geometry changed");
    } else if (state->preview_dirty || state->preview_scale != output->scale) preview_damage(state);
}

static const struct polly_shortcuts_v1_interface implementation = {
    .destroy = destroy_request, .set_binding = set_binding, .commit = commit, .presenter = presenter,
    .recording = recording, .accept = accept_request, .cancel = cancel_request,
    .configure_previews = configure_previews,
    .configure_projection = configure_projection, .pick_projection = pick_projection,
    .configure_cube = configure_cube,
};

static void destroyed(struct wl_resource *resource)
{
    struct Binding *binding = wl_resource_get_user_data(resource);
    pu_workspace_cube_configure(binding->state->desktop, false, true);
    if (binding->state->presenter == binding) {
        binding->state->presenter = NULL;
        pu_shortcuts_cancel(binding->state->desktop);
    }
    wl_list_remove(&binding->link);
    free(binding);
}

static void bind_control(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
    struct PuShortcuts *state = data;
    if (client != state->desktop->shell_client) {
        wl_client_post_implementation_error(client, "Shortcut control requires the trusted Shell");
        return;
    }
    if (version < 2 || version > 5) {
        wl_client_post_implementation_error(client, "Shortcut control requires the ten-action catalog");
        return;
    }
    struct Binding *binding = calloc(1, sizeof(*binding));
    if (!binding) { wl_client_post_no_memory(client); return; }
    binding->resource = wl_resource_create(client, &polly_shortcuts_v1_interface, version, id);
    if (!binding->resource) { free(binding); wl_client_post_no_memory(client); return; }
    binding->state = state;
    wl_list_insert(state->bindings.prev, &binding->link);
    wl_resource_set_implementation(binding->resource, &implementation, binding, destroyed);
    send_bindings(binding);
    if (version >= 3) polly_shortcuts_v1_send_preview_capability(binding->resource, preview_supported(state));
    if (version >= 4) polly_shortcuts_v1_send_projection_capability(binding->resource,
        preview_supported(state) && wlr_scene_projection_supported(state->desktop->renderer));
    send_cube(binding);
}

bool pu_shortcuts_init(struct PuDesktop *desktop)
{
    struct PuShortcuts *state = calloc(1, sizeof(*state));
    if (!state) return false;
    desktop->shortcuts = state; state->desktop = desktop;
    wl_list_init(&state->bindings);
    wl_list_init(&state->preview_watches);
    state->preview_timer = wl_event_loop_add_timer(wl_display_get_event_loop(desktop->display), preview_tick, state);
    if (!state->preview_timer) wlr_log(WLR_ERROR, "Cannot create the optional window preview scheduler");
    pu_shortcut_defaults(state->current);
    state->global = wl_global_create(desktop->display, &polly_shortcuts_v1_interface, 5, state, bind_control);
    return state->global != NULL && pu_workspace_cube_init(desktop);
}

void pu_shortcuts_finish(struct PuDesktop *desktop)
{
    struct PuShortcuts *state = desktop->shortcuts;
    if (!state) return;
    pu_shortcuts_cancel(desktop);
    pu_workspace_cube_finish(desktop);
    if (state->preview_timer) wl_event_source_remove(state->preview_timer);
    if (state->global) wl_global_destroy(state->global);
    free(state); desktop->shortcuts = NULL;
}
