#include "data-device.h"
#include "server.h"
#include "shortcut-control.h"
#include <stdlib.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_cursor.h>
#include <wlr/types/wlr_data_device.h>
#include <wlr/types/wlr_primary_selection.h>
#include <wlr/types/wlr_primary_selection_v1.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/util/log.h>

struct Drag {
    struct PuDataDevice *state;
    struct wlr_drag *drag;
    struct wlr_surface *origin;
    struct wlr_scene_tree *tree;
    struct wl_listener destroy, origin_destroy;
};
struct PuDataDevice {
    struct PuDesktop *desktop;
    struct wlr_scene_tree *icons;
    struct wlr_surface *pending_origin;
    struct Drag *drag;
    struct wl_listener request_drag, start_drag, primary;
};

static void cancel_drag(struct wlr_drag *drag)
{
    if (drag->source) wlr_data_source_destroy(drag->source);
    else {
        /* wlroots 0.19 exposes cancellation through its public grab interface,
         * but has no public wlr_drag_destroy for source-less drags. */
        drag->keyboard_grab.interface->cancel(&drag->keyboard_grab);
    }
}

void pu_data_device_cancel_drag(struct PuDesktop *desktop)
{
    if (desktop->data_device && desktop->data_device->drag)
        cancel_drag(desktop->data_device->drag->drag);
}
bool pu_data_device_drag_active(struct PuDesktop *desktop)
{ return desktop->data_device && desktop->data_device->drag; }

static bool ignore_input(struct wlr_scene_buffer *buffer, double *sx, double *sy)
{ (void)buffer; (void)sx; (void)sy; return false; }
static void icon_buffer(struct wlr_scene_buffer *buffer, int x, int y, void *data)
{ (void)x; (void)y; (void)data; buffer->point_accepts_input = ignore_input; }

void pu_data_device_motion(struct PuDesktop *desktop)
{
    struct PuDataDevice *state = desktop->data_device;
    if (!state || !state->drag) return;
    if (!pu_desktop_surface_visible(desktop, state->drag->origin)) {
        pu_data_device_cancel_drag(desktop);
        return;
    }
    wlr_scene_node_set_position(&state->drag->tree->node, (int)desktop->cursor->x, (int)desktop->cursor->y);
    wlr_scene_node_for_each_buffer(&state->drag->tree->node, icon_buffer, NULL);
}

static void drag_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct Drag *drag = wl_container_of(listener, drag, destroy);
    struct PuDesktop *desktop = drag->state->desktop;
    drag->state->drag = NULL;
    wl_list_remove(&drag->destroy.link);
    wl_list_remove(&drag->origin_destroy.link);
    wlr_scene_node_destroy(&drag->tree->node);
    free(drag);
    pu_desktop_restore_input(desktop);
}
static void origin_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct Drag *drag = wl_container_of(listener, drag, origin_destroy);
    cancel_drag(drag->drag);
}

static void started(struct wl_listener *listener, void *data)
{
    struct PuDataDevice *state = wl_container_of(listener, state, start_drag);
    struct wlr_drag *source = data;
    struct Drag *drag = calloc(1, sizeof(*drag));
    if (!drag) {
        wlr_log(WLR_ERROR, "Cannot allocate drag state"); cancel_drag(source);
        pu_desktop_restore_input(state->desktop); return;
    }
    drag->state = state; drag->drag = source; drag->origin = state->pending_origin;
    drag->tree = wlr_scene_tree_create(state->icons);
    if (!drag->origin || !drag->tree || (source->icon && !wlr_scene_drag_icon_create(drag->tree, source->icon))) {
        if (drag->tree) wlr_scene_node_destroy(&drag->tree->node);
        free(drag); wlr_log(WLR_ERROR, "Cannot create drag icon scene"); cancel_drag(source);
        pu_desktop_restore_input(state->desktop); return;
    }
    state->drag = drag;
    drag->destroy.notify = drag_destroyed; wl_signal_add(&source->events.destroy, &drag->destroy);
    drag->origin_destroy.notify = origin_destroyed; wl_signal_add(&drag->origin->events.destroy, &drag->origin_destroy);
    pu_data_device_motion(state->desktop);
}

static void request_drag(struct wl_listener *listener, void *data)
{
    struct PuDataDevice *state = wl_container_of(listener, state, request_drag);
    struct wlr_seat_request_start_drag_event *event = data;
    struct PuDesktop *desktop = state->desktop;
    if (desktop->grab != PU_DESKTOP_PASSTHROUGH || wlr_seat_keyboard_has_grab(desktop->seat) ||
        !pu_desktop_surface_visible(desktop, event->origin) ||
        !wlr_seat_validate_pointer_grab_serial(desktop->seat, event->origin, event->serial)) {
        wlr_log(WLR_DEBUG, "Ignoring drag without a visible origin and valid pointer grab");
        cancel_drag(event->drag);
        return;
    }
    pu_shortcuts_cancel(desktop);
    wlr_seat_keyboard_notify_clear_focus(desktop->seat);
    state->pending_origin = event->origin;
    wlr_seat_start_pointer_drag(desktop->seat, event->drag, event->serial);
    state->pending_origin = NULL;
}

static void primary_selection(struct wl_listener *listener, void *data)
{
    struct PuDataDevice *state = wl_container_of(listener, state, primary);
    struct wlr_seat_request_set_primary_selection_event *event = data;
    wlr_seat_set_primary_selection(state->desktop->seat, event->source, event->serial);
}

bool pu_data_device_init(struct PuDesktop *desktop)
{
    struct PuDataDevice *state = calloc(1, sizeof(*state));
    if (!state) return false;
    desktop->data_device = state; state->desktop = desktop;
    state->icons = wlr_scene_tree_create(&desktop->scene->tree);
    if (!state->icons || !wlr_primary_selection_v1_device_manager_create(desktop->display)) return false;
    state->request_drag.notify = request_drag; wl_signal_add(&desktop->seat->events.request_start_drag, &state->request_drag);
    state->start_drag.notify = started; wl_signal_add(&desktop->seat->events.start_drag, &state->start_drag);
    state->primary.notify = primary_selection; wl_signal_add(&desktop->seat->events.request_set_primary_selection, &state->primary);
    return true;
}
void pu_data_device_finish(struct PuDesktop *desktop)
{
    struct PuDataDevice *state = desktop->data_device;
    if (!state) return;
    pu_data_device_cancel_drag(desktop);
    if (state->request_drag.link.next) wl_list_remove(&state->request_drag.link);
    if (state->start_drag.link.next) wl_list_remove(&state->start_drag.link);
    if (state->primary.link.next) wl_list_remove(&state->primary.link);
    if (state->icons) wlr_scene_node_destroy(&state->icons->node);
    free(state); desktop->data_device = NULL;
}
