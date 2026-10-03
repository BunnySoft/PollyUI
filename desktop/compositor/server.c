/* Wayland lifecycle patterns informed by wlroots tinywl; see ../LICENSE.wlroots. */
#include "server.h"

#include <linux/input-event-codes.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wlr/backend.h>
#include <wlr/render/allocator.h>
#include <wlr/render/wlr_renderer.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_cursor.h>
#include <wlr/types/wlr_data_device.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_pointer.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_subcompositor.h>
#include <wlr/types/wlr_xcursor_manager.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/edges.h>
#include <wlr/util/log.h>
#include <xkbcommon/xkbcommon.h>

struct PuDesktopOutput {
    struct PuDesktop *desktop;
    struct wlr_output *output;
    struct wl_listener frame, request_state, commit, destroy;
};

struct PuDesktopKeyboard {
    struct PuDesktop *desktop;
    struct wlr_keyboard *keyboard;
    struct wl_list link;
    bool consumed[KEY_CNT];
    struct wl_listener key, modifiers, destroy;
};

struct PuDesktopPointer {
    struct PuDesktop *desktop;
    struct wl_list link;
    struct wl_listener destroy;
};

struct PuDesktopPopup {
    struct PuDesktop *desktop;
    struct wlr_xdg_popup *popup;
    struct wlr_scene_tree *tree;
    struct wl_listener commit, destroy, tree_destroy, reposition;
};

static void end_grab(struct PuDesktop *desktop);
static void set_view_state(struct PuDesktopView *view, bool maximized, bool fullscreen,
                           struct wlr_output *preferred);
static void constrain_popups(struct PuDesktopView *view);
static void popup_reposition(struct wl_listener *listener, void *data);
static void process_motion(struct PuDesktop *desktop, uint32_t time);

static void refresh_pointer(struct PuDesktop *desktop)
{
    if (desktop->stopping || desktop->grab != PU_DESKTOP_PASSTHROUGH) return;
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    process_motion(desktop, (uint32_t)((uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000));
}

static void listen(struct wl_signal *signal, struct wl_listener *listener,
                   wl_notify_func_t notify)
{
    listener->notify = notify;
    wl_signal_add(signal, listener);
}

static void unlisten(struct wl_listener *listener)
{
    if (listener->link.next) {
        wl_list_remove(&listener->link);
        wl_list_init(&listener->link);
    }
}

static void fail(struct PuDesktop *desktop, const char *message)
{
    wlr_log(WLR_ERROR, "%s", message);
    desktop->failed = true;
    if (desktop->display) wl_display_terminate(desktop->display);
}

static void enter_keyboard(struct PuDesktop *desktop)
{
    if (!desktop->focused) return;
    struct wlr_keyboard *keyboard = wlr_seat_get_keyboard(desktop->seat);
    if (!keyboard) return;
    struct PuDesktopKeyboard *entry;
    uint32_t keys[WLR_KEYBOARD_KEYS_CAP];
    size_t count = 0;
    wl_list_for_each(entry, &desktop->keyboards, link) {
        if (entry->keyboard != keyboard) continue;
        for (size_t i = 0; i < keyboard->num_keycodes; i++) {
            uint32_t key = keyboard->keycodes[i];
            if (key >= KEY_CNT || !entry->consumed[key]) keys[count++] = key;
        }
        break;
    }
    wlr_seat_keyboard_notify_enter(desktop->seat,
        desktop->focused->toplevel->base->surface, keys, count, &keyboard->modifiers);
}

static void focus_view(struct PuDesktop *desktop, struct PuDesktopView *view)
{
    if (view && !view->mapped) return;
    if (desktop->focused != view) {
        if (desktop->focused)
            wlr_xdg_toplevel_set_activated(desktop->focused->toplevel, false);
        desktop->focused = view;
    }
    if (!view) {
        wlr_seat_keyboard_notify_clear_focus(desktop->seat);
        return;
    }
    wlr_scene_node_raise_to_top(&view->tree->node);
    wl_list_remove(&view->link);
    wl_list_insert(&desktop->views, &view->link);
    wlr_xdg_toplevel_set_activated(view->toplevel, true);
    enter_keyboard(desktop);
}

static void update_capabilities(struct PuDesktop *desktop)
{
    uint32_t caps = 0;
    if (!wl_list_empty(&desktop->pointers)) caps |= WL_SEAT_CAPABILITY_POINTER;
    if (!wl_list_empty(&desktop->keyboards)) caps |= WL_SEAT_CAPABILITY_KEYBOARD;
    wlr_seat_set_capabilities(desktop->seat, caps);
}

static void keyboard_modifiers(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopKeyboard *entry = wl_container_of(listener, entry, modifiers);
    wlr_seat_set_keyboard(entry->desktop->seat, entry->keyboard);
    wlr_seat_keyboard_notify_modifiers(entry->desktop->seat, &entry->keyboard->modifiers);
}

static bool keybinding(struct PuDesktop *desktop, xkb_keysym_t sym)
{
    switch (sym) {
    case XKB_KEY_Escape:
        wl_display_terminate(desktop->display);
        return true;
    case XKB_KEY_Tab:
        if (wl_list_length(&desktop->views) > 1) {
            struct PuDesktopView *next =
                wl_container_of(desktop->views.prev, next, link);
            focus_view(desktop, next);
        }
        return true;
    case XKB_KEY_F4:
        if (desktop->focused) wlr_xdg_toplevel_send_close(desktop->focused->toplevel);
        return true;
    case XKB_KEY_F10:
        if (desktop->focused) {
            struct PuDesktopView *view = desktop->focused;
            set_view_state(view, !view->maximized, view->fullscreen, NULL);
        }
        return true;
    case XKB_KEY_F11:
        if (desktop->focused) {
            struct PuDesktopView *view = desktop->focused;
            set_view_state(view, view->maximized, !view->fullscreen, NULL);
        }
        return true;
    default:
        return false;
    }
}

static void keyboard_key(struct wl_listener *listener, void *data)
{
    struct PuDesktopKeyboard *entry = wl_container_of(listener, entry, key);
    struct wlr_keyboard_key_event *event = data;
    struct PuDesktop *desktop = entry->desktop;
    wlr_seat_set_keyboard(desktop->seat, entry->keyboard);
    bool handled = event->keycode < KEY_CNT && entry->consumed[event->keycode];
    if (event->state == WL_KEYBOARD_KEY_STATE_RELEASED) {
        if (event->keycode < KEY_CNT) entry->consumed[event->keycode] = false;
    } else if (!handled && desktop->grab == PU_DESKTOP_PASSTHROUGH &&
               !wlr_seat_keyboard_has_grab(desktop->seat) &&
               (wlr_keyboard_get_modifiers(entry->keyboard) & WLR_MODIFIER_ALT)) {
        const xkb_keysym_t *syms;
        int count = xkb_state_key_get_syms(entry->keyboard->xkb_state,
                                          event->keycode + 8, &syms);
        for (int i = 0; i < count && !handled; i++) {
            /* Mark before changing focus so keyboard.enter excludes the shortcut. */
            if (event->keycode < KEY_CNT) entry->consumed[event->keycode] = true;
            handled = keybinding(desktop, syms[i]);
            if (event->keycode < KEY_CNT) entry->consumed[event->keycode] = handled;
        }
    }
    if (!handled)
        wlr_seat_keyboard_notify_key(desktop->seat, event->time_msec,
                                     event->keycode, event->state);
}

static void keyboard_destroy(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopKeyboard *entry = wl_container_of(listener, entry, destroy);
    struct PuDesktop *desktop = entry->desktop;
    bool active = wlr_seat_get_keyboard(desktop->seat) == entry->keyboard;
    wl_list_remove(&entry->key.link);
    wl_list_remove(&entry->modifiers.link);
    wl_list_remove(&entry->destroy.link);
    wl_list_remove(&entry->link);
    free(entry);
    if (active) {
        struct wlr_keyboard *replacement = NULL;
        if (!wl_list_empty(&desktop->keyboards)) {
            struct PuDesktopKeyboard *first =
                wl_container_of(desktop->keyboards.next, first, link);
            replacement = first->keyboard;
        }
        wlr_seat_set_keyboard(desktop->seat, replacement);
        if (!desktop->stopping) enter_keyboard(desktop);
    }
    update_capabilities(desktop);
}

static void add_keyboard(struct PuDesktop *desktop, struct wlr_input_device *device)
{
    struct PuDesktopKeyboard *entry = calloc(1, sizeof(*entry));
    if (!entry) { fail(desktop, "Cannot allocate keyboard state"); return; }
    entry->desktop = desktop;
    entry->keyboard = wlr_keyboard_from_input_device(device);
    struct xkb_context *context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    struct xkb_keymap *keymap = context ?
        xkb_keymap_new_from_names(context, NULL, XKB_KEYMAP_COMPILE_NO_FLAGS) : NULL;
    bool ok = keymap && wlr_keyboard_set_keymap(entry->keyboard, keymap);
    xkb_keymap_unref(keymap);
    xkb_context_unref(context);
    if (!ok) {
        free(entry);
        fail(desktop, "Cannot initialize XKB keymap (install xkeyboard-config)");
        return;
    }
    wlr_keyboard_set_repeat_info(entry->keyboard, 25, 600);
    listen(&entry->keyboard->events.key, &entry->key, keyboard_key);
    listen(&entry->keyboard->events.modifiers, &entry->modifiers, keyboard_modifiers);
    listen(&device->events.destroy, &entry->destroy, keyboard_destroy);
    wl_list_insert(&desktop->keyboards, &entry->link);
    wlr_seat_set_keyboard(desktop->seat, entry->keyboard);
    enter_keyboard(desktop);
}

static void end_grab(struct PuDesktop *desktop)
{
    if (desktop->grab == PU_DESKTOP_RESIZE && desktop->grabbed)
        wlr_xdg_toplevel_set_resizing(desktop->grabbed->toplevel, false);
    desktop->grab = PU_DESKTOP_PASSTHROUGH;
    desktop->grabbed = NULL;
}

static void pointer_destroy(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopPointer *entry = wl_container_of(listener, entry, destroy);
    struct PuDesktop *desktop = entry->desktop;
    wl_list_remove(&entry->link);
    wl_list_remove(&entry->destroy.link);
    free(entry);
    if (wl_list_empty(&desktop->pointers)) {
        end_grab(desktop);
        desktop->suppressed_button = 0;
        wlr_seat_pointer_notify_clear_focus(desktop->seat);
    }
    update_capabilities(desktop);
}

static void new_input(struct wl_listener *listener, void *data)
{
    struct PuDesktop *desktop = wl_container_of(listener, desktop, new_input);
    struct wlr_input_device *device = data;
    if (device->type == WLR_INPUT_DEVICE_KEYBOARD) {
        add_keyboard(desktop, device);
    } else if (device->type == WLR_INPUT_DEVICE_POINTER) {
        struct PuDesktopPointer *entry = calloc(1, sizeof(*entry));
        if (!entry) { fail(desktop, "Cannot allocate pointer state"); return; }
        entry->desktop = desktop;
        listen(&device->events.destroy, &entry->destroy, pointer_destroy);
        wl_list_insert(&desktop->pointers, &entry->link);
        wlr_cursor_attach_input_device(desktop->cursor, device);
    }
    update_capabilities(desktop);
}

static struct PuDesktopView *view_at(struct PuDesktop *desktop,
    double x, double y, struct wlr_surface **surface, double *sx, double *sy)
{
    struct wlr_scene_node *node =
        wlr_scene_node_at(&desktop->scene->tree.node, x, y, sx, sy);
    *surface = NULL;
    if (!node) return NULL;
    if (node->type == WLR_SCENE_NODE_BUFFER) {
        struct wlr_scene_surface *scene_surface =
            wlr_scene_surface_try_from_buffer(wlr_scene_buffer_from_node(node));
        if (!scene_surface) return NULL;
        *surface = scene_surface->surface;
    }
    for (struct wlr_scene_tree *tree = node->parent; tree; tree = tree->node.parent)
        if (tree->node.data) return tree->node.data;
    return NULL;
}

static int clamp_size(int size, int minimum, int maximum)
{
    if (minimum < 1) minimum = 1;
    if (size < minimum) size = minimum;
    if (maximum >= minimum && size > maximum) size = maximum;
    return size;
}

static bool output_box(struct PuDesktop *desktop, struct wlr_output *output,
                       struct wlr_box *box)
{
    /* Compare against live layout entries before dereferencing a remembered output. */
    struct wlr_output_layout_output *entry;
    wl_list_for_each(entry, &desktop->layout->outputs, link) {
        if (entry->output == output && output->enabled) {
            wlr_output_layout_get_box(desktop->layout, output, box);
            return !wlr_box_empty(box);
        }
    }
    return false;
}

static struct wlr_box view_box(struct PuDesktopView *view)
{
    struct wlr_box box = view->toplevel->base->geometry;
    box.x = view->tree->node.x;
    box.y = view->tree->node.y;
    return box;
}

static struct wlr_output *output_for_box(struct PuDesktop *desktop, const struct wlr_box *box)
{
    struct wlr_output *best = NULL;
    int64_t best_area = -1;
    double best_distance = 0;
    struct wlr_output_layout_output *entry;
    wl_list_for_each(entry, &desktop->layout->outputs, link) {
        struct wlr_box bounds, overlap;
        if (!output_box(desktop, entry->output, &bounds)) continue;
        int64_t area = wlr_box_intersection(&overlap, box, &bounds) ?
            (int64_t)overlap.width * overlap.height : 0;
        double x = box->x + box->width / 2.0, y = box->y + box->height / 2.0;
        double cx, cy;
        wlr_box_closest_point(&bounds, x, y, &cx, &cy);
        double distance = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (area > best_area || (area == best_area && distance < best_distance)) {
            best = entry->output;
            best_area = area;
            best_distance = distance;
        }
    }
    return best;
}

static struct wlr_output *initial_output(struct PuDesktop *desktop)
{
    struct wlr_box point = { .x = (int)desktop->cursor->x, .y = (int)desktop->cursor->y,
                            .width = 1, .height = 1 };
    return output_for_box(desktop, &point);
}

static void keep_visible(struct wlr_box *box, const struct wlr_box *bounds)
{
    int right = bounds->x + (bounds->width > box->width ? bounds->width - box->width : 0);
    int bottom = bounds->y + (bounds->height > box->height ? bounds->height - box->height : 0);
    if (box->x > right) box->x = right;
    if (box->y > bottom) box->y = bottom;
    if (box->x < bounds->x) box->x = bounds->x;
    if (box->y < bounds->y) box->y = bounds->y;
}

static void fit_floating(struct PuDesktopView *view, struct wlr_box *box,
                         const struct wlr_box *bounds)
{
    struct wlr_xdg_toplevel_state *state = &view->toplevel->current;
    if (box->width > 0)
        box->width = clamp_size(box->width < bounds->width ? box->width : bounds->width,
                               state->min_width, state->max_width);
    if (box->height > 0)
        box->height = clamp_size(box->height < bounds->height ? box->height : bounds->height,
                                state->min_height, state->max_height);
    keep_visible(box, bounds);
}

static void configure_view(struct PuDesktopView *view, struct wlr_box box,
                           const struct wlr_box *bounds)
{
    if (view->desktop->grabbed == view) end_grab(view->desktop);
    view->resize_pending = false;
    view->pending_box = box;
    wlr_xdg_toplevel_set_bounds(view->toplevel, bounds->width, bounds->height);
    wlr_xdg_toplevel_set_maximized(view->toplevel, view->maximized);
    wlr_xdg_toplevel_set_fullscreen(view->toplevel, view->fullscreen);
    wlr_xdg_toplevel_set_resizing(view->toplevel, false);
    view->geometry_serial = wlr_xdg_toplevel_set_size(view->toplevel, box.width, box.height);
    view->geometry_pending = true;
}

static void set_view_state(struct PuDesktopView *view, bool maximized, bool fullscreen,
                           struct wlr_output *preferred)
{
    if (!view->toplevel->base->initialized) return;
    struct PuDesktop *desktop = view->desktop;
    struct wlr_box box = view->geometry_pending ? view->pending_box : view_box(view);
    struct wlr_box bounds;
    struct wlr_output *output = preferred;
    if (!maximized && !fullscreen && (view->maximized || view->fullscreen))
        output = output_for_box(desktop, &view->restore_box);
    if (!output_box(desktop, output, &bounds)) {
        output = view->output;
        if ((!view->maximized && !view->fullscreen) || !output_box(desktop, output, &bounds))
            output = view->mapped ? output_for_box(desktop, &box) : initial_output(desktop);
    }
    if (!output_box(desktop, output, &bounds)) {
        wlr_log(WLR_ERROR, "Cannot change window state without an enabled output");
        wlr_xdg_surface_schedule_configure(view->toplevel->base);
        return;
    }
    if ((maximized || fullscreen) && !view->maximized && !view->fullscreen)
        view->restore_box = box;
    if (maximized || fullscreen) {
        box = bounds;
    } else if (view->maximized || view->fullscreen) {
        box = view->restore_box;
    }
    view->output = output;
    view->maximized = maximized;
    view->fullscreen = fullscreen;
    if (!maximized && !fullscreen) fit_floating(view, &box, &bounds);
    configure_view(view, box, &bounds);
}

static void present_view(struct PuDesktopView *view)
{
    if (view->geometry_pending) {
        /* A buffer for an older configure must not acquire the latest position. */
        uint32_t serial = view->toplevel->base->current.configure_serial;
        if ((int32_t)(serial - view->geometry_serial) < 0) return;
        view->geometry_pending = false;
        view->mode = view->fullscreen ? PU_DESKTOP_FULLSCREEN :
                     view->maximized ? PU_DESKTOP_MAXIMIZED : PU_DESKTOP_FLOATING;
        view->presented_box = view->pending_box;
        struct wlr_box box = view->pending_box;
        if (view->mode == PU_DESKTOP_FLOATING) {
            box.width = view->toplevel->base->geometry.width;
            box.height = view->toplevel->base->geometry.height;
            struct wlr_box bounds;
            if (output_box(view->desktop, view->output, &bounds)) keep_visible(&box, &bounds);
        }
        wlr_scene_node_set_position(&view->tree->node, box.x, box.y);
    }
    struct wlr_box geometry = view->toplevel->base->geometry;
    bool fullscreen = view->mode == PU_DESKTOP_FULLSCREEN;
    int x = fullscreen ? (view->presented_box.width - geometry.width) / 2 : 0;
    int y = fullscreen ? (view->presented_box.height - geometry.height) / 2 : 0;
    wlr_scene_node_set_position(&view->content->node, x, y);
    wlr_scene_node_set_position(&view->popups->node, x, y);
    wlr_scene_node_set_enabled(&view->backdrop->node, fullscreen);
    if (fullscreen)
        wlr_scene_rect_set_size(view->backdrop, view->presented_box.width, view->presented_box.height);
    struct wlr_box clip = {
        .x = geometry.x - x, .y = geometry.y - y,
        .width = view->presented_box.width, .height = view->presented_box.height,
    };
    wlr_scene_subsurface_tree_set_clip(&view->content->node,
        view->mode != PU_DESKTOP_FLOATING ? &clip : NULL);
}

static void layout_changed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktop *desktop = wl_container_of(listener, desktop, layout_change);
    if (desktop->stopping) return;
    struct PuDesktopView *view;
    wl_list_for_each(view, &desktop->all_views, all_link) {
        if (!view->toplevel->base->initialized) continue;
        struct wlr_box box = view->geometry_pending ? view->pending_box : view_box(view);
        struct wlr_box bounds;
        struct wlr_output *output = view->output;
        if ((!view->fullscreen && !view->maximized) || !output_box(desktop, output, &bounds))
            output = output_for_box(desktop, &box);
        view->output = output;
        if (!output_box(desktop, output, &bounds)) continue;
        if (view->fullscreen || view->maximized) box = bounds;
        else fit_floating(view, &box, &bounds);
        configure_view(view, box, &bounds);
    }
}

struct SurfacePosition {
    struct wlr_surface *surface;
    int x, y;
    bool found;
};

static void find_surface_position(struct wlr_scene_buffer *buffer, int x, int y, void *data)
{
    struct SurfacePosition *position = data;
    struct wlr_scene_surface *surface = wlr_scene_surface_try_from_buffer(buffer);
    if (surface && surface->surface == position->surface) {
        position->x = x;
        position->y = y;
        position->found = true;
    }
}

static void process_motion(struct PuDesktop *desktop, uint32_t time)
{
    struct PuDesktopView *view = desktop->grabbed;
    if (view && desktop->grab == PU_DESKTOP_MOVE) {
        wlr_scene_node_set_position(&view->tree->node,
            (int)(desktop->cursor->x - desktop->grab_x),
            (int)(desktop->cursor->y - desktop->grab_y));
        constrain_popups(view);
        return;
    }
    if (view && desktop->grab == PU_DESKTOP_RESIZE) {
        int dx = (int)(desktop->cursor->x - desktop->grab_x);
        int dy = (int)(desktop->cursor->y - desktop->grab_y);
        int width = desktop->grab_box.width, height = desktop->grab_box.height;
        if (desktop->grab_edges & WLR_EDGE_LEFT) width -= dx;
        if (desktop->grab_edges & WLR_EDGE_RIGHT) width += dx;
        if (desktop->grab_edges & WLR_EDGE_TOP) height -= dy;
        if (desktop->grab_edges & WLR_EDGE_BOTTOM) height += dy;
        struct wlr_xdg_toplevel_state *state = &view->toplevel->current;
        width = clamp_size(width, state->min_width, state->max_width);
        height = clamp_size(height, state->min_height, state->max_height);
        wlr_xdg_toplevel_set_size(view->toplevel, width, height);
        return;
    }
    /* Normal button drags retain their surface even outside its input region.
     * wlroots' default pointer grab does not implement this policy for us. */
    if (desktop->seat->pointer_state.button_count &&
        !wlr_seat_pointer_has_grab(desktop->seat)) {
        struct SurfacePosition position = {
            .surface = desktop->seat->pointer_state.focused_surface,
        };
        wlr_scene_node_for_each_buffer(&desktop->scene->tree.node,
                                       find_surface_position, &position);
        if (position.found) {
            wlr_seat_pointer_notify_motion(desktop->seat, time,
                desktop->cursor->x - position.x, desktop->cursor->y - position.y);
            return;
        }
        wlr_seat_pointer_notify_clear_focus(desktop->seat);
    }
    double sx = 0, sy = 0;
    struct wlr_surface *surface;
    view_at(desktop, desktop->cursor->x, desktop->cursor->y, &surface, &sx, &sy);
    if (surface) {
        wlr_seat_pointer_notify_enter(desktop->seat, surface, sx, sy);
        wlr_seat_pointer_notify_motion(desktop->seat, time, sx, sy);
    } else {
        wlr_cursor_set_xcursor(desktop->cursor, desktop->cursor_theme, "default");
        wlr_seat_pointer_notify_clear_focus(desktop->seat);
    }
}

static void cursor_motion(struct wl_listener *listener, void *data)
{
    struct PuDesktop *desktop = wl_container_of(listener, desktop, motion);
    struct wlr_pointer_motion_event *event = data;
    wlr_cursor_move(desktop->cursor, &event->pointer->base, event->delta_x, event->delta_y);
    process_motion(desktop, event->time_msec);
}

static void cursor_absolute(struct wl_listener *listener, void *data)
{
    struct PuDesktop *desktop = wl_container_of(listener, desktop, motion_absolute);
    struct wlr_pointer_motion_absolute_event *event = data;
    wlr_cursor_warp_absolute(desktop->cursor, &event->pointer->base, event->x, event->y);
    process_motion(desktop, event->time_msec);
}

static void begin_grab(struct PuDesktopView *view, enum PuDesktopGrab mode,
                       uint32_t edges, uint32_t button)
{
    struct PuDesktop *desktop = view->desktop;
    if (!view->mapped || desktop->grab != PU_DESKTOP_PASSTHROUGH ||
        view->geometry_pending || view->mode != PU_DESKTOP_FLOATING) return;
    desktop->grab = mode;
    desktop->grabbed = view;
    desktop->grab_edges = edges;
    desktop->grab_button = button;
    desktop->grab_x = desktop->cursor->x;
    desktop->grab_y = desktop->cursor->y;
    if (mode == PU_DESKTOP_MOVE) {
        view->resize_pending = false;
        desktop->grab_x -= view->tree->node.x;
        desktop->grab_y -= view->tree->node.y;
    } else {
        /* Scene xdg trees are positioned at window geometry, not buffer origin. */
        desktop->grab_box = view->toplevel->base->geometry;
        desktop->grab_box.x = view->tree->node.x;
        desktop->grab_box.y = view->tree->node.y;
        view->resize_anchor = desktop->grab_box;
        view->resize_edges = edges;
        view->resize_pending = true;
        wlr_xdg_toplevel_set_resizing(view->toplevel, true);
    }
}

static void cursor_button(struct wl_listener *listener, void *data)
{
    struct PuDesktop *desktop = wl_container_of(listener, desktop, button);
    struct wlr_pointer_button_event *event = data;
    bool pressed = event->state == WL_POINTER_BUTTON_STATE_PRESSED;
    if (!pressed && desktop->suppressed_button == event->button) {
        desktop->suppressed_button = 0;
        end_grab(desktop);
        process_motion(desktop, event->time_msec);
        return;
    }
    if (pressed && desktop->grab == PU_DESKTOP_PASSTHROUGH &&
        !wlr_seat_pointer_has_grab(desktop->seat) &&
        desktop->seat->pointer_state.button_count == 0) {
        double sx = 0, sy = 0;
        struct wlr_surface *surface;
        struct PuDesktopView *view = view_at(desktop, desktop->cursor->x,
                                             desktop->cursor->y, &surface, &sx, &sy);
        focus_view(desktop, view);
        refresh_pointer(desktop);
        struct wlr_keyboard *keyboard = wlr_seat_get_keyboard(desktop->seat);
        bool alt = keyboard && (wlr_keyboard_get_modifiers(keyboard) & WLR_MODIFIER_ALT);
        if (view && alt && !view->geometry_pending && view->mode == PU_DESKTOP_FLOATING &&
            desktop->seat->pointer_state.button_count == 0 &&
            (event->button == BTN_LEFT || event->button == BTN_RIGHT)) {
            desktop->suppressed_button = event->button;
            begin_grab(view, event->button == BTN_LEFT ? PU_DESKTOP_MOVE : PU_DESKTOP_RESIZE,
                       WLR_EDGE_BOTTOM | WLR_EDGE_RIGHT, event->button);
            return;
        }
    }
    wlr_seat_pointer_notify_button(desktop->seat, event->time_msec,
                                  event->button, event->state);
    if (!pressed && event->button == desktop->grab_button) {
        end_grab(desktop);
    }
    if (!pressed && desktop->seat->pointer_state.button_count == 0) {
        process_motion(desktop, event->time_msec);
    }
}

static void cursor_axis(struct wl_listener *listener, void *data)
{
    struct PuDesktop *desktop = wl_container_of(listener, desktop, axis);
    struct wlr_pointer_axis_event *event = data;
    if (desktop->grab != PU_DESKTOP_PASSTHROUGH) return;
    wlr_seat_pointer_notify_axis(desktop->seat, event->time_msec, event->orientation,
        event->delta, event->delta_discrete, event->source, event->relative_direction);
}

static void cursor_frame(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktop *desktop = wl_container_of(listener, desktop, frame);
    wlr_seat_pointer_notify_frame(desktop->seat);
}

static void request_cursor(struct wl_listener *listener, void *data)
{
    struct PuDesktop *desktop = wl_container_of(listener, desktop, request_cursor);
    struct wlr_seat_pointer_request_set_cursor_event *event = data;
    if (desktop->grab == PU_DESKTOP_PASSTHROUGH &&
        event->seat_client == desktop->seat->pointer_state.focused_client)
        wlr_cursor_set_surface(desktop->cursor, event->surface,
                               event->hotspot_x, event->hotspot_y);
}

static void request_selection(struct wl_listener *listener, void *data)
{
    struct PuDesktop *desktop = wl_container_of(listener, desktop, request_selection);
    struct wlr_seat_request_set_selection_event *event = data;
    wlr_seat_set_selection(desktop->seat, event->source, event->serial);
}

static void output_frame(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopOutput *entry = wl_container_of(listener, entry, frame);
    if (!entry->output->enabled) return;
    struct wlr_scene_output *output =
        wlr_scene_get_scene_output(entry->desktop->scene, entry->output);
    if (!output || !wlr_scene_output_commit(output, NULL)) {
        fail(entry->desktop, "Cannot commit output frame");
        return;
    }
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    wlr_scene_output_send_frame_done(output, &now);
}

static void output_request_state(struct wl_listener *listener, void *data)
{
    struct PuDesktopOutput *entry = wl_container_of(listener, entry, request_state);
    struct wlr_output_event_request_state *event = data;
    if (!wlr_output_commit_state(entry->output, event->state))
        fail(entry->desktop, "Cannot apply requested output state");
}

static void attach_output(struct PuDesktopOutput *entry)
{
    struct PuDesktop *desktop = entry->desktop;
    struct wlr_output_layout_output *layout_output =
        wlr_output_layout_add_auto(desktop->layout, entry->output);
    struct wlr_scene_output *scene_output = wlr_scene_get_scene_output(desktop->scene, entry->output);
    if (!scene_output) scene_output = wlr_scene_output_create(desktop->scene, entry->output);
    if (!layout_output || !scene_output) {
        fail(desktop, "Cannot attach output to scene"); return;
    }
    wlr_scene_output_layout_add_output(desktop->scene_layout, layout_output, scene_output);
}

static void output_commit(struct wl_listener *listener, void *data)
{
    struct PuDesktopOutput *entry = wl_container_of(listener, entry, commit);
    struct wlr_output_event_commit *event = data;
    if (entry->desktop->stopping || !(event->state->committed & WLR_OUTPUT_STATE_ENABLED)) return;
    if (entry->output->enabled) {
        if (!wlr_output_layout_get(entry->desktop->layout, entry->output)) attach_output(entry);
    } else {
        wlr_output_layout_remove(entry->desktop->layout, entry->output);
    }
}

static void output_destroy(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopOutput *entry = wl_container_of(listener, entry, destroy);
    wl_list_remove(&entry->frame.link);
    wl_list_remove(&entry->request_state.link);
    wl_list_remove(&entry->commit.link);
    wl_list_remove(&entry->destroy.link);
    wlr_output_layout_remove(entry->desktop->layout, entry->output);
    entry->desktop->output_count--;
    if (!entry->desktop->stopping && entry->desktop->output_count == 0)
        wl_display_terminate(entry->desktop->display);
    free(entry);
}

static void new_output(struct wl_listener *listener, void *data)
{
    struct PuDesktop *desktop = wl_container_of(listener, desktop, new_output);
    struct wlr_output *output = data;
    if (!wlr_output_init_render(output, desktop->allocator, desktop->renderer)) {
        fail(desktop, "Cannot initialize output rendering"); return;
    }
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_enabled(&state, true);
    struct wlr_output_mode *mode = wlr_output_preferred_mode(output);
    if (mode) wlr_output_state_set_mode(&state, mode);
    bool ok = wlr_output_commit_state(output, &state);
    wlr_output_state_finish(&state);
    if (!ok) { fail(desktop, "Cannot enable output"); return; }

    struct PuDesktopOutput *entry = calloc(1, sizeof(*entry));
    if (!entry) { fail(desktop, "Cannot allocate output state"); return; }
    entry->desktop = desktop;
    entry->output = output;
    listen(&output->events.frame, &entry->frame, output_frame);
    listen(&output->events.request_state, &entry->request_state, output_request_state);
    listen(&output->events.commit, &entry->commit, output_commit);
    listen(&output->events.destroy, &entry->destroy, output_destroy);
    desktop->output_count++;
    attach_output(entry);
    wlr_log(WLR_INFO, "Output %s: %dx%d", output->name, output->width, output->height);
}

static void view_map(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopView *view = wl_container_of(listener, view, map);
    struct PuDesktop *desktop = view->desktop;
    view->mapped = true;
    view->resize_pending = false;
    present_view(view);
    wlr_scene_node_set_enabled(&view->tree->node, true);
    wl_list_insert(&desktop->views, &view->link);
    focus_view(desktop, view);
    wlr_log(WLR_INFO, "Mapped %s", view->toplevel->app_id ? view->toplevel->app_id : "(unnamed)");
}

static void view_unmap(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopView *view = wl_container_of(listener, view, unmap);
    struct PuDesktop *desktop = view->desktop;
    if (desktop->grabbed == view) end_grab(desktop);
    view->resize_pending = false;
    view->mapped = false;
    view->geometry_pending = view->maximized = view->fullscreen = false;
    view->mode = PU_DESKTOP_FLOATING;
    view->output = NULL;
    view->restore_box = (struct wlr_box){0};
    wlr_scene_node_set_enabled(&view->tree->node, false);
    wl_list_remove(&view->link);
    wl_list_init(&view->link);
    if (desktop->focused == view) {
        focus_view(desktop, NULL);
        if (!desktop->stopping && !wl_list_empty(&desktop->views)) {
            struct PuDesktopView *next = wl_container_of(desktop->views.next, next, link);
            focus_view(desktop, next);
        }
    }
    refresh_pointer(desktop);
}

static void view_commit(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopView *view = wl_container_of(listener, view, commit);
    if (view->toplevel->base->initial_commit) {
        view->output = initial_output(view->desktop);
        struct wlr_box bounds;
        if (!output_box(view->desktop, view->output, &bounds)) {
            fail(view->desktop, "Cannot place a new window without an enabled output");
            return;
        }
        int offset = 32 + 32 * (wl_list_length(&view->desktop->views) % 8);
        view->pending_box = (struct wlr_box){ .x = bounds.x + offset, .y = bounds.y + offset };
        view->geometry_pending = true;
        wlr_xdg_toplevel_set_wm_capabilities(view->toplevel,
            WLR_XDG_TOPLEVEL_WM_CAPABILITIES_MAXIMIZE | WLR_XDG_TOPLEVEL_WM_CAPABILITIES_FULLSCREEN);
        set_view_state(view, view->toplevel->requested.maximized, view->toplevel->requested.fullscreen,
            view->toplevel->requested.fullscreen ? view->toplevel->requested.fullscreen_output : view->output);
    }
    if (!view->mapped) return;
    present_view(view);
    if (view->resize_pending) {
        /* Anchor the opposite edge using the size actually committed by the client. */
        struct wlr_box geometry = view->toplevel->base->geometry;
        int x = view->resize_anchor.x, y = view->resize_anchor.y;
        if (view->resize_edges & WLR_EDGE_LEFT)
            x += view->resize_anchor.width - geometry.width;
        if (view->resize_edges & WLR_EDGE_TOP)
            y += view->resize_anchor.height - geometry.height;
        wlr_scene_node_set_position(&view->tree->node, x, y);
        if (!view->toplevel->current.resizing &&
            view->desktop->grabbed != view) view->resize_pending = false;
    }
    constrain_popups(view);
    refresh_pointer(view->desktop);
}

static void view_destroy(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopView *view = wl_container_of(listener, view, destroy);
    if (view->mapped) view_unmap(&view->unmap, NULL);
    view->toplevel->base->data = NULL;
    view->tree->node.data = NULL;
    wlr_scene_node_destroy(&view->tree->node);
    wl_list_remove(&view->map.link);
    wl_list_remove(&view->unmap.link);
    wl_list_remove(&view->commit.link);
    wl_list_remove(&view->destroy.link);
    wl_list_remove(&view->move.link);
    wl_list_remove(&view->resize.link);
    wl_list_remove(&view->maximize.link);
    wl_list_remove(&view->request_fullscreen.link);
    wl_list_remove(&view->all_link);
    free(view);
}

static bool valid_grab(struct PuDesktopView *view, struct wlr_seat_client *client, uint32_t serial)
{
    struct PuDesktop *desktop = view->desktop;
    struct wlr_surface *surface = view->toplevel->base->surface;
    bool valid = view->mapped && client && client->seat == desktop->seat &&
        client->client == wl_resource_get_client(surface->resource) &&
        wlr_seat_validate_pointer_grab_serial(desktop->seat, surface, serial);
    if (!valid) wlr_log(WLR_DEBUG, "Ignoring move/resize without a matching pointer grab");
    return valid;
}

static void view_move(struct wl_listener *listener, void *data)
{
    struct PuDesktopView *view = wl_container_of(listener, view, move);
    struct wlr_xdg_toplevel_move_event *event = data;
    if (valid_grab(view, event->seat, event->serial))
        begin_grab(view, PU_DESKTOP_MOVE, 0, view->desktop->seat->pointer_state.grab_button);
}

static void view_resize(struct wl_listener *listener, void *data)
{
    struct PuDesktopView *view = wl_container_of(listener, view, resize);
    struct wlr_xdg_toplevel_resize_event *event = data;
    if (valid_grab(view, event->seat, event->serial))
        begin_grab(view, PU_DESKTOP_RESIZE, event->edges,
                   view->desktop->seat->pointer_state.grab_button);
}

static void view_maximize(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopView *view = wl_container_of(listener, view, maximize);
    set_view_state(view, view->toplevel->requested.maximized, view->fullscreen, NULL);
}

static void view_fullscreen(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopView *view = wl_container_of(listener, view, request_fullscreen);
    set_view_state(view, view->maximized, view->toplevel->requested.fullscreen,
        view->toplevel->requested.fullscreen ? view->toplevel->requested.fullscreen_output : NULL);
}

static void new_toplevel(struct wl_listener *listener, void *data)
{
    struct PuDesktop *desktop = wl_container_of(listener, desktop, new_toplevel);
    struct wlr_xdg_toplevel *toplevel = data;
    struct PuDesktopView *view = calloc(1, sizeof(*view));
    if (!view) { wl_resource_post_no_memory(toplevel->resource); return; }
    view->desktop = desktop;
    view->toplevel = toplevel;
    view->tree = wlr_scene_tree_create(&desktop->scene->tree);
    if (!view->tree) {
        free(view);
        wl_resource_post_no_memory(toplevel->resource);
        return;
    }
    view->backdrop = wlr_scene_rect_create(view->tree, 1, 1, (float[4]){0, 0, 0, 1});
    view->content = wlr_scene_xdg_surface_create(view->tree, toplevel->base);
    view->popups = wlr_scene_tree_create(view->tree);
    if (!view->backdrop || !view->content || !view->popups) {
        wlr_scene_node_destroy(&view->tree->node);
        free(view);
        wl_resource_post_no_memory(toplevel->resource);
        return;
    }
    wlr_scene_node_set_enabled(&view->backdrop->node, false);
    wl_list_init(&view->link);
    wl_list_insert(&desktop->all_views, &view->all_link);
    view->tree->node.data = view;
    toplevel->base->data = view->popups;
    wlr_scene_node_set_enabled(&view->tree->node, false);
    listen(&toplevel->base->surface->events.map, &view->map, view_map);
    listen(&toplevel->base->surface->events.unmap, &view->unmap, view_unmap);
    listen(&toplevel->base->surface->events.commit, &view->commit, view_commit);
    listen(&toplevel->events.destroy, &view->destroy, view_destroy);
    listen(&toplevel->events.request_move, &view->move, view_move);
    listen(&toplevel->events.request_resize, &view->resize, view_resize);
    listen(&toplevel->events.request_maximize, &view->maximize, view_maximize);
    listen(&toplevel->events.request_fullscreen, &view->request_fullscreen, view_fullscreen);
}

static void constrain_popup(struct PuDesktopPopup *entry)
{
    if (!entry->tree || !entry->popup->base->initialized) return;
    struct wlr_scene_tree *tree = entry->tree;
    while (tree && !tree->node.data) tree = tree->node.parent;
    if (!tree) return;
    struct PuDesktopView *view = tree->node.data;
    struct wlr_box box = view_box(view), bounds;
    struct wlr_output *output = view->mode != PU_DESKTOP_FLOATING ? view->output : NULL;
    if (!output_box(entry->desktop, output, &bounds)) output = output_for_box(entry->desktop, &box);
    if (!output_box(entry->desktop, output, &bounds)) return;
    /* The wlroots helper expects the root surface's coordinates, including
     * its window-geometry offset, even for a popup nested below another popup. */
    bounds.x -= view->tree->node.x + view->popups->node.x - view->toplevel->base->geometry.x;
    bounds.y -= view->tree->node.y + view->popups->node.y - view->toplevel->base->geometry.y;
    struct wlr_box old = entry->popup->scheduled.geometry;
    struct wlr_box adjusted = old;
    int sx, sy;
    wlr_xdg_popup_get_toplevel_coords(entry->popup, 0, 0, &sx, &sy);
    struct wlr_box constraint = bounds;
    constraint.x -= sx;
    constraint.y -= sy;
    wlr_xdg_positioner_rules_unconstrain_box(&entry->popup->scheduled.rules, &constraint, &adjusted);
    if (old.x != adjusted.x || old.y != adjusted.y ||
        old.width != adjusted.width || old.height != adjusted.height)
        wlr_xdg_popup_unconstrain_from_box(entry->popup, &bounds);
}

static void constrain_popup_tree(struct wlr_xdg_surface *parent)
{
    struct wlr_xdg_popup *popup;
    wl_list_for_each(popup, &parent->popups, link) {
        /* Popup entries are owned independently of their parent scene tree. */
        struct wl_listener *listener =
            wl_signal_get(&popup->events.reposition, popup_reposition);
        if (listener && popup->scheduled.rules.reactive) {
            struct PuDesktopPopup *entry = wl_container_of(listener, entry, reposition);
            constrain_popup(entry);
        }
        constrain_popup_tree(popup->base);
    }
}

static void constrain_popups(struct PuDesktopView *view)
{
    constrain_popup_tree(view->toplevel->base);
}

static void popup_commit(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopPopup *entry = wl_container_of(listener, entry, commit);
    if (entry->popup->base->initial_commit) {
        constrain_popup(entry);
        wlr_xdg_surface_schedule_configure(entry->popup->base);
    }
    constrain_popup_tree(entry->popup->base);
}

static void popup_reposition(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopPopup *entry = wl_container_of(listener, entry, reposition);
    constrain_popup(entry);
}

static void popup_destroy(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopPopup *entry = wl_container_of(listener, entry, destroy);
    wl_list_remove(&entry->commit.link);
    wl_list_remove(&entry->destroy.link);
    wl_list_remove(&entry->reposition.link);
    if (entry->tree) wlr_scene_node_destroy(&entry->tree->node);
    free(entry);
}

static void popup_tree_destroy(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktopPopup *entry = wl_container_of(listener, entry, tree_destroy);
    entry->popup->base->data = NULL;
    entry->tree = NULL;
    wl_list_remove(&entry->tree_destroy.link);
}

static void new_popup(struct wl_listener *listener, void *data)
{
    struct PuDesktop *desktop = wl_container_of(listener, desktop, new_popup);
    struct wlr_xdg_popup *popup = data;
    struct wlr_xdg_surface *parent = popup->parent ?
        wlr_xdg_surface_try_from_wlr_surface(popup->parent) : NULL;
    if (!parent || !parent->data) {
        wlr_log(WLR_DEBUG, "Dismissing popup without a managed xdg parent");
        wlr_xdg_popup_destroy(popup);
        return;
    }
    struct PuDesktopPopup *entry = calloc(1, sizeof(*entry));
    if (!entry) { wl_resource_post_no_memory(popup->resource); return; }
    struct wlr_scene_tree *tree = wlr_scene_xdg_surface_create(parent->data, popup->base);
    if (!tree) {
        free(entry);
        wl_resource_post_no_memory(popup->resource);
        return;
    }
    popup->base->data = tree;
    entry->popup = popup;
    entry->desktop = desktop;
    entry->tree = tree;
    listen(&tree->node.events.destroy, &entry->tree_destroy, popup_tree_destroy);
    listen(&popup->base->surface->events.commit, &entry->commit, popup_commit);
    listen(&popup->events.destroy, &entry->destroy, popup_destroy);
    listen(&popup->events.reposition, &entry->reposition, popup_reposition);
}

static int stop_signal(int signal_number, void *data)
{
    (void)signal_number;
    struct PuDesktop *desktop = data;
    wl_display_terminate(desktop->display);
    return 0;
}

bool pu_desktop_init(struct PuDesktop *desktop, const char *socket_name)
{
    memset(desktop, 0, sizeof(*desktop));
    wl_list_init(&desktop->views);
    wl_list_init(&desktop->all_views);
    wl_list_init(&desktop->keyboards);
    wl_list_init(&desktop->pointers);
    desktop->display = wl_display_create();
    if (!desktop->display) { fail(desktop, "Cannot create Wayland display"); return false; }
    wl_display_set_global_filter(desktop->display, pu_desktop_global_filter, desktop);
    struct wl_event_loop *loop = wl_display_get_event_loop(desktop->display);
    desktop->backend = wlr_backend_autocreate(loop, NULL);
    if (!desktop->backend) { fail(desktop, "Cannot create wlroots backend"); return false; }
    desktop->renderer = wlr_renderer_autocreate(desktop->backend);
    if (!desktop->renderer ||
        !wlr_renderer_init_wl_display(desktop->renderer, desktop->display)) {
        fail(desktop, "Cannot initialize renderer"); return false;
    }
    desktop->allocator = wlr_allocator_autocreate(desktop->backend, desktop->renderer);
    if (!desktop->allocator) { fail(desktop, "Cannot create buffer allocator"); return false; }
    if (!wlr_compositor_create(desktop->display, 5, desktop->renderer) ||
        !wlr_subcompositor_create(desktop->display) ||
        !wlr_data_device_manager_create(desktop->display)) {
        fail(desktop, "Cannot create core Wayland globals"); return false;
    }
    desktop->layout = wlr_output_layout_create(desktop->display);
    desktop->scene = wlr_scene_create();
    if (!desktop->layout || !desktop->scene) {
        fail(desktop, "Cannot create output layout or scene"); return false;
    }
    desktop->scene_layout = wlr_scene_attach_output_layout(desktop->scene, desktop->layout);
    desktop->cursor = wlr_cursor_create();
    desktop->cursor_theme = wlr_xcursor_manager_create(NULL, 24);
    desktop->seat = wlr_seat_create(desktop->display, "seat0");
    desktop->shell = wlr_xdg_shell_create(desktop->display, 5);
    if (!desktop->scene_layout || !desktop->cursor || !desktop->cursor_theme ||
        !desktop->seat || !desktop->shell) {
        fail(desktop, "Cannot create cursor, seat or xdg-shell"); return false;
    }
    wlr_cursor_attach_output_layout(desktop->cursor, desktop->layout);
    if (!wlr_xcursor_manager_load(desktop->cursor_theme, 1)) {
        fail(desktop, "Cannot load cursor theme"); return false;
    }
    listen(&desktop->backend->events.new_output, &desktop->new_output, new_output);
    listen(&desktop->backend->events.new_input, &desktop->new_input, new_input);
    listen(&desktop->shell->events.new_toplevel, &desktop->new_toplevel, new_toplevel);
    listen(&desktop->shell->events.new_popup, &desktop->new_popup, new_popup);
    listen(&desktop->cursor->events.motion, &desktop->motion, cursor_motion);
    listen(&desktop->cursor->events.motion_absolute, &desktop->motion_absolute, cursor_absolute);
    listen(&desktop->cursor->events.button, &desktop->button, cursor_button);
    listen(&desktop->cursor->events.axis, &desktop->axis, cursor_axis);
    listen(&desktop->cursor->events.frame, &desktop->frame, cursor_frame);
    listen(&desktop->seat->events.request_set_cursor, &desktop->request_cursor, request_cursor);
    listen(&desktop->seat->events.request_set_selection, &desktop->request_selection, request_selection);
    listen(&desktop->layout->events.change, &desktop->layout_change, layout_changed);

    desktop->sigint = wl_event_loop_add_signal(loop, SIGINT, stop_signal, desktop);
    desktop->sigterm = wl_event_loop_add_signal(loop, SIGTERM, stop_signal, desktop);
    if (!desktop->sigint || !desktop->sigterm) {
        fail(desktop, "Cannot register signal handlers"); return false;
    }
    if (socket_name) {
        if (wl_display_add_socket(desktop->display, socket_name) < 0) {
            fail(desktop, "Cannot bind requested Wayland socket"); return false;
        }
        desktop->socket_name = socket_name;
    } else {
        desktop->socket_name = wl_display_add_socket_auto(desktop->display);
        if (!desktop->socket_name) { fail(desktop, "Cannot allocate Wayland socket"); return false; }
    }
    return true;
}

bool pu_desktop_start(struct PuDesktop *desktop)
{
    /* Backend selection must see the parent WAYLAND_DISPLAY, not our new socket. */
    if (!wlr_backend_start(desktop->backend) || desktop->failed) {
        fail(desktop, "Cannot start backend"); return false;
    }
    if (!desktop->output_count) { fail(desktop, "No usable outputs"); return false; }
    wlr_cursor_set_xcursor(desktop->cursor, desktop->cursor_theme, "default");
    wlr_log(WLR_INFO, "PollyWM ready: WAYLAND_DISPLAY=%s", desktop->socket_name);
    return true;
}

void pu_desktop_finish(struct PuDesktop *desktop)
{
    desktop->stopping = true;
    pu_desktop_stop_shell(desktop);
    if (desktop->display) wl_display_destroy_clients(desktop->display);
    if (desktop->sigint) wl_event_source_remove(desktop->sigint);
    if (desktop->sigterm) wl_event_source_remove(desktop->sigterm);
    unlisten(&desktop->new_input);
    unlisten(&desktop->new_output);
    unlisten(&desktop->new_toplevel);
    unlisten(&desktop->new_popup);
    unlisten(&desktop->motion);
    unlisten(&desktop->motion_absolute);
    unlisten(&desktop->button);
    unlisten(&desktop->axis);
    unlisten(&desktop->frame);
    unlisten(&desktop->request_cursor);
    unlisten(&desktop->request_selection);
    unlisten(&desktop->layout_change);
    /* Release imported buffers before disconnecting the nested Wayland backend. */
    if (desktop->scene) wlr_scene_node_destroy(&desktop->scene->tree.node);
    if (desktop->cursor_theme) wlr_xcursor_manager_destroy(desktop->cursor_theme);
    if (desktop->cursor) wlr_cursor_destroy(desktop->cursor);
    if (desktop->allocator) wlr_allocator_destroy(desktop->allocator);
    if (desktop->renderer) wlr_renderer_destroy(desktop->renderer);
    if (desktop->backend) wlr_backend_destroy(desktop->backend);
    if (desktop->display) wl_display_destroy(desktop->display);
    memset(desktop, 0, sizeof(*desktop));
}
