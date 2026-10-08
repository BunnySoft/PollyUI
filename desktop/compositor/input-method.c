#include "input-method.h"
#include "private-process.h"
#include "server.h"
#include "data-device.h"
#include "session-lock.h"
#include "text-input-v3-server.h"
#include "polly-session-status-server.h"
#include <errno.h>
#include <linux/input-event-codes.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/interfaces/wlr_keyboard.h>
#include <wlr/types/wlr_input_method_v2.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_text_input_v3.h>
#include <wlr/types/wlr_virtual_keyboard_v1.h>
#include <wlr/util/log.h>

struct TextInput {
    struct PuInputMethod *state;
    struct wlr_text_input_v3 *input;
    uint32_t focus_serial;
    struct wl_list link;
    struct wl_listener enable, commit, disable, destroy;
};
struct InputPopup {
    struct PuInputMethod *state;
    struct wlr_input_popup_surface_v2 *popup;
    struct wlr_scene_tree *tree;
    struct wlr_box rectangle;
    bool rectangle_sent;
    struct wl_list link;
    struct wl_listener map, unmap, commit, destroy;
};
struct VirtualKeyboard {
    struct PuInputMethod *state;
    struct wlr_virtual_keyboard_v1 *keyboard;
    struct wl_listener key, modifiers, destroy;
    struct wl_list link;
    struct wlr_surface *focus;
    bool forwarded[KEY_CNT], releasing;
};
struct PuInputMethod {
    struct PuDesktop *desktop;
    struct wl_client *client;
    struct wl_global *status_global;
    bool requested, initialized, initialization_lost;
    pid_t pid;
    struct wl_event_source *exit;
    struct wl_listener client_destroy, new_input, new_method, new_keyboard, focus;
    struct wl_listener method_commit, method_destroy, popup, grab, initialized_grab_destroy;
    struct wl_list inputs, popups, keyboards;
    struct TextInput *active;
    struct wlr_input_method_v2 *method;
    struct wlr_scene_tree *tree;
    uint32_t epoch, forward_epoch;
};

static void listen(struct wl_signal *signal, struct wl_listener *listener, wl_notify_func_t callback)
{ listener->notify = callback; wl_signal_add(signal, listener); }
static void unlisten(struct wl_listener *listener)
{ if (listener->link.next) { wl_list_remove(&listener->link); wl_list_init(&listener->link); } }
static int clamp(int value, int minimum, int maximum)
{ return value < minimum ? minimum : value > maximum ? maximum : value; }
static bool boundary(const char *text, uint32_t offset)
{ return offset <= strlen(text) && (((unsigned char)text[offset] & 0xc0) != 0x80); }

static void release_keys(struct VirtualKeyboard *entry, bool finishing)
{
    struct PuDesktop *desktop = entry->state->desktop;
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    uint32_t time = (uint32_t)((uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000);
    entry->releasing = true;
    for (uint32_t key = 0; key < KEY_CNT; key++) {
        if (!entry->forwarded[key]) continue;
        entry->forwarded[key] = false;
        if (finishing) {
            if (!desktop->stopping && entry->focus && entry->focus == desktop->seat->keyboard_state.focused_surface)
                wlr_seat_keyboard_notify_key(desktop->seat, time, key, WL_KEYBOARD_KEY_STATE_RELEASED);
        } else {
            struct wlr_keyboard_key_event event = { .time_msec = time, .keycode = key,
                .state = WL_KEYBOARD_KEY_STATE_RELEASED, .update_state = false };
            wlr_keyboard_notify_key(&entry->keyboard->keyboard, &event);
        }
    }
    entry->releasing = false; entry->focus = NULL;
}
static void release_forwarded(struct PuInputMethod *state)
{
    struct VirtualKeyboard *entry;
    wl_list_for_each(entry, &state->keyboards, link) release_keys(entry, false);
}

bool pu_input_method_allowed(const struct PuDesktop *desktop, const struct wl_client *client)
{ return desktop->input_method && desktop->input_method->client && desktop->input_method->client == client; }
uint32_t pu_input_method_epoch(struct PuDesktop *desktop)
{ return desktop->input_method ? desktop->input_method->epoch : 0; }

static bool eligible(struct TextInput *entry)
{
    struct wlr_text_input_v3 *input = entry->input;
    struct PuDesktop *desktop = entry->state->desktop;
    if (!input->current_enabled || input->current_serial == entry->focus_serial || !input->focused_surface ||
        input->focused_surface != desktop->seat->keyboard_state.focused_surface ||
        !pu_desktop_surface_visible(desktop, input->focused_surface)) return false;
    if (input->current.content_type.purpose == ZWP_TEXT_INPUT_V3_CONTENT_PURPOSE_PASSWORD ||
            input->current.content_type.purpose == ZWP_TEXT_INPUT_V3_CONTENT_PURPOSE_PIN ||
            (input->current.content_type.hint & (ZWP_TEXT_INPUT_V3_CONTENT_HINT_HIDDEN_TEXT |
                ZWP_TEXT_INPUT_V3_CONTENT_HINT_SENSITIVE_DATA))) return false;
    const char *text = input->current.surrounding.text ? input->current.surrounding.text : "";
    if (strlen(text) > 4000 || !boundary(text, input->current.surrounding.cursor) ||
        !boundary(text, input->current.surrounding.anchor)) {
        wlr_log(WLR_ERROR, "Ignoring invalid IME surrounding-text state");
        return false;
    }
    return true;
}

void pu_input_method_reposition(struct PuDesktop *desktop)
{
    struct PuInputMethod *state = desktop->input_method;
    if (!state) return;
    struct wlr_box surface = {0}, caret = {0}, output;
    struct PuDesktopOwner *owner = NULL;
    bool visible = state->active && state->method && state->method->active && eligible(state->active) &&
        pu_desktop_surface_box(desktop, state->active->input->focused_surface, &surface, &owner);
    if (visible) {
        if (state->active->input->active_features & WLR_TEXT_INPUT_V3_FEATURE_CURSOR_RECTANGLE)
            caret = state->active->input->current.cursor_rectangle;
        caret.x = clamp(caret.x, 0, surface.width);
        caret.y = clamp(caret.y, 0, surface.height);
        caret.width = clamp(caret.width, 0, surface.width - caret.x);
        caret.height = clamp(caret.height, 0, surface.height - caret.y);
        struct wlr_output *target = wlr_output_layout_output_at(desktop->layout,
            surface.x + caret.x, surface.y + caret.y);
        wlr_output_layout_get_box(desktop->layout, target, &output);
    }
    struct InputPopup *entry;
    wl_list_for_each(entry, &state->popups, link) {
        wlr_scene_node_set_enabled(&entry->tree->node, visible && entry->popup->surface->mapped);
        entry->tree->node.data = visible ? owner : NULL;
        if (!visible) { entry->rectangle_sent = false; continue; }
        int width = entry->popup->surface->current.width, height = entry->popup->surface->current.height;
        int x = surface.x + caret.x, y = surface.y + caret.y + caret.height;
        if (y > output.y + output.height - height) y = surface.y + caret.y - height;
        x = clamp(x, output.x, output.x + (output.width > width ? output.width - width : 0));
        y = clamp(y, output.y, output.y + (output.height > height ? output.height - height : 0));
        wlr_scene_node_set_position(&entry->tree->node, x, y);
        struct wlr_box rectangle = { .x = surface.x + caret.x - x, .y = surface.y + caret.y - y,
            .width = caret.width, .height = caret.height };
        if (!entry->rectangle_sent || memcmp(&entry->rectangle, &rectangle, sizeof(rectangle))) {
            entry->rectangle = rectangle; entry->rectangle_sent = true;
            wlr_input_popup_surface_v2_send_text_input_rectangle(entry->popup, &rectangle);
        }
    }
}

static void done(struct PuInputMethod *state)
{
    wlr_input_method_v2_send_done(state->method);
}
static void clear_preedit(struct TextInput *entry)
{
    if (!entry || !entry->input->focused_surface || entry->state->desktop->stopping) return;
    wlr_text_input_v3_send_preedit_string(entry->input, "", 0, 0);
    wlr_text_input_v3_send_done(entry->input);
}
static void synchronize(struct PuInputMethod *state, struct TextInput *preferred)
{
    struct TextInput *target = preferred && eligible(preferred) ? preferred :
        state->active && eligible(state->active) ? state->active : NULL;
    if (!target) {
        struct TextInput *entry;
        wl_list_for_each(entry, &state->inputs, link) if (eligible(entry)) { target = entry; break; }
    }
    if (state->active != target) {
        release_forwarded(state);
        clear_preedit(state->active);
        if (state->method && state->method->active) {
            wlr_input_method_v2_send_deactivate(state->method);
            done(state);
        }
        state->active = target;
        state->epoch++;
    }
    if (target && state->method) {
        struct wlr_text_input_v3 *input = target->input;
        if (!state->method->active) wlr_input_method_v2_send_activate(state->method);
        wlr_input_method_v2_send_surrounding_text(state->method,
            input->current.surrounding.text ? input->current.surrounding.text : "",
            input->current.surrounding.cursor, input->current.surrounding.anchor);
        wlr_input_method_v2_send_content_type(state->method, input->current.content_type.hint,
            input->current.content_type.purpose);
        wlr_input_method_v2_send_text_change_cause(state->method, input->current.text_change_cause);
        done(state);
    }
    pu_input_method_reposition(state->desktop);
}
static void text_enabled(struct wl_listener *listener, void *data)
{
    (void)data;
    struct TextInput *entry = wl_container_of(listener, entry, enable);
    if (eligible(entry)) synchronize(entry->state, entry);
}
static void text_committed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct TextInput *entry = wl_container_of(listener, entry, commit);
    if (entry->state->active == entry || eligible(entry)) synchronize(entry->state, NULL);
}
static void text_disabled(struct wl_listener *listener, void *data)
{
    (void)data;
    struct TextInput *entry = wl_container_of(listener, entry, disable);
    if (entry->state->active == entry) synchronize(entry->state, NULL);
}
static void text_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct TextInput *entry = wl_container_of(listener, entry, destroy);
    struct PuInputMethod *state = entry->state;
    bool active = state->active == entry;
    if (active) {
        release_forwarded(state);
        clear_preedit(entry);
        if (state->method && state->method->active) { wlr_input_method_v2_send_deactivate(state->method); done(state); }
        state->active = NULL; state->epoch++;
    }
    unlisten(&entry->enable); unlisten(&entry->commit); unlisten(&entry->disable); unlisten(&entry->destroy);
    wl_list_remove(&entry->link); free(entry);
    if (active && !state->desktop->stopping) synchronize(state, NULL);
}
static void new_text_input(struct wl_listener *listener, void *data)
{
    struct PuInputMethod *state = wl_container_of(listener, state, new_input);
    struct wlr_text_input_v3 *input = data;
    if (input->seat != state->desktop->seat) return;
    struct TextInput *entry = calloc(1, sizeof(*entry));
    if (!entry) { wl_resource_post_no_memory(input->resource); return; }
    entry->state = state; entry->input = input;
    wl_list_insert(&state->inputs, &entry->link);
    listen(&input->events.enable, &entry->enable, text_enabled);
    listen(&input->events.commit, &entry->commit, text_committed);
    listen(&input->events.disable, &entry->disable, text_disabled);
    listen(&input->events.destroy, &entry->destroy, text_destroyed);
    struct wlr_surface *surface = state->desktop->seat->keyboard_state.focused_surface;
    entry->focus_serial = input->current_serial;
    if (surface && wl_resource_get_client(input->resource) == wl_resource_get_client(surface->resource))
        wlr_text_input_v3_send_enter(input, surface);
}
static void focus_changed(struct wl_listener *listener, void *data)
{
    struct PuInputMethod *state = wl_container_of(listener, state, focus);
    struct wlr_seat_keyboard_focus_change_event *event = data;
    struct TextInput *entry;
    wl_list_for_each(entry, &state->inputs, link) {
        if (entry->input->focused_surface == event->new_surface) continue;
        entry->focus_serial = entry->input->current_serial;
        if (entry->input->focused_surface) {
            clear_preedit(entry);
            wlr_text_input_v3_send_leave(entry->input);
        }
        if (event->new_surface && wl_resource_get_client(entry->input->resource) ==
            wl_resource_get_client(event->new_surface->resource))
            wlr_text_input_v3_send_enter(entry->input, event->new_surface);
    }
    synchronize(state, NULL);
}
static void method_committed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuInputMethod *state = wl_container_of(listener, state, method_commit);
    struct wlr_input_method_v2 *method = state->method;
    state->forward_epoch = 0;
    /* wlroots emits commit only after validating the protocol's done serial. */
    if (!state->active || !eligible(state->active) || !method->active) return;
    const char *preedit = method->current.preedit.text ? method->current.preedit.text : "";
    const char *commit = method->current.commit_text;
    int begin = method->current.preedit.cursor_begin, end = method->current.preedit.cursor_end;
    if (strlen(preedit) > 4000 || (commit && strlen(commit) > 4000) ||
        ((begin != -1 || end != -1) && (begin < 0 || end < 0 ||
        !boundary(preedit, (uint32_t)begin) || !boundary(preedit, (uint32_t)end)))) {
        wlr_log(WLR_ERROR, "Ignoring invalid input-method output"); return;
    }
    struct wlr_text_input_v3 *input = state->active->input;
    uint32_t before = method->current.delete.before_length, after = method->current.delete.after_length;
    const char *surrounding = input->current.surrounding.text ? input->current.surrounding.text : "";
    uint32_t cursor = input->current.surrounding.cursor;
    if (before > cursor || after > strlen(surrounding) - cursor ||
        !boundary(surrounding, cursor - before) || !boundary(surrounding, cursor + after)) {
        wlr_log(WLR_ERROR, "Ignoring invalid input-method deletion"); return;
    }
    wlr_text_input_v3_send_preedit_string(input, preedit, begin, end);
    if (commit) wlr_text_input_v3_send_commit_string(input, commit);
    if (before || after) wlr_text_input_v3_send_delete_surrounding_text(input, before, after);
    state->forward_epoch = state->epoch;
    wlr_text_input_v3_send_done(input);
}
static void popup_updated(struct wl_listener *listener, void *data)
{ (void)data; struct InputPopup *entry = wl_container_of(listener, entry, commit); pu_input_method_reposition(entry->state->desktop); }
static void popup_mapped(struct wl_listener *listener, void *data)
{ (void)data; struct InputPopup *entry = wl_container_of(listener, entry, map); pu_input_method_reposition(entry->state->desktop); }
static void popup_unmapped(struct wl_listener *listener, void *data)
{ (void)data; struct InputPopup *entry = wl_container_of(listener, entry, unmap); pu_input_method_reposition(entry->state->desktop); }
static void popup_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct InputPopup *entry = wl_container_of(listener, entry, destroy);
    unlisten(&entry->map); unlisten(&entry->unmap); unlisten(&entry->commit); unlisten(&entry->destroy);
    wl_list_remove(&entry->link);
    wlr_scene_node_destroy(&entry->tree->node); free(entry);
}
static void new_popup(struct wl_listener *listener, void *data)
{
    struct PuInputMethod *state = wl_container_of(listener, state, popup);
    struct wlr_input_popup_surface_v2 *popup = data;
    struct InputPopup *entry = calloc(1, sizeof(*entry));
    if (!entry) { wl_resource_post_no_memory(popup->resource); return; }
    entry->state = state; entry->popup = popup;
    entry->tree = wlr_scene_tree_create(state->tree);
    if (!entry->tree || !wlr_scene_subsurface_tree_create(entry->tree, popup->surface)) {
        if (entry->tree) wlr_scene_node_destroy(&entry->tree->node);
        free(entry); wl_resource_post_no_memory(popup->resource); return;
    }
    wl_list_insert(&state->popups, &entry->link);
    listen(&popup->surface->events.map, &entry->map, popup_mapped);
    listen(&popup->surface->events.unmap, &entry->unmap, popup_unmapped);
    listen(&popup->surface->events.commit, &entry->commit, popup_updated);
    listen(&popup->events.destroy, &entry->destroy, popup_destroyed);
    pu_input_method_reposition(state->desktop);
}
static void grabbed_keyboard(struct wl_listener *listener, void *data)
{
    struct PuInputMethod *state = wl_container_of(listener, state, grab);
    struct wlr_input_method_keyboard_grab_v2 *grab = data;
    struct wlr_keyboard *keyboard = wlr_seat_get_keyboard(state->desktop->seat);
    if (keyboard) wlr_input_method_keyboard_grab_v2_set_keyboard(grab, keyboard);
    wlr_log(WLR_INFO, "Input-method protocol ready");
}
static void method_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuInputMethod *state = wl_container_of(listener, state, method_destroy);
    if (state->initialized) state->initialization_lost = true;
    state->initialized = false;
    unlisten(&state->initialized_grab_destroy);
    release_forwarded(state);
    state->method = NULL; state->epoch++;
    clear_preedit(state->active);
    unlisten(&state->method_commit); unlisten(&state->method_destroy); unlisten(&state->popup); unlisten(&state->grab);
    pu_input_method_reposition(state->desktop);
}
static void new_method(struct wl_listener *listener, void *data)
{
    struct PuInputMethod *state = wl_container_of(listener, state, new_method);
    struct wlr_input_method_v2 *method = data;
    if (state->method || method->seat != state->desktop->seat ||
        !pu_input_method_allowed(state->desktop, wl_resource_get_client(method->resource))) {
        wlr_input_method_v2_send_unavailable(method); return;
    }
    state->method = method; state->epoch++;
    listen(&method->events.commit, &state->method_commit, method_committed);
    listen(&method->events.destroy, &state->method_destroy, method_destroyed);
    listen(&method->events.new_popup_surface, &state->popup, new_popup);
    listen(&method->events.grab_keyboard, &state->grab, grabbed_keyboard);
    synchronize(state, NULL);
}
static bool can_grab(struct PuInputMethod *state)
{
    return state && state->active && eligible(state->active) && state->method && state->method->active &&
        state->method->keyboard_grab && !wlr_seat_keyboard_has_grab(state->desktop->seat);
}
bool pu_input_method_ready(struct PuDesktop *desktop)
{ return desktop->input_method && desktop->input_method->method && desktop->input_method->method->keyboard_grab; }
static void inspect_status(struct wl_client *client, struct wl_resource *resource, uint32_t serial)
{
    struct PuInputMethod *state = wl_resource_get_user_data(resource);
    if (client != state->desktop->shell_client) {
        wl_client_post_implementation_error(client, "Session status requires the trusted Shell");
        return;
    }
    uint32_t status = POLLY_SESSION_STATUS_V1_SERVICE_STATE_DISABLED;
    if (state->requested) {
        if (!state->client || !state->pid || state->initialization_lost ||
            (state->initialized && !pu_input_method_ready(state->desktop)))
            status = POLLY_SESSION_STATUS_V1_SERVICE_STATE_FAILED;
        else status = state->initialized ? POLLY_SESSION_STATUS_V1_SERVICE_STATE_READY :
            POLLY_SESSION_STATUS_V1_SERVICE_STATE_STARTING;
    }
    polly_session_status_v1_send_status(resource, serial, status);
}
static void initialized_grab_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuInputMethod *state = wl_container_of(listener, state, initialized_grab_destroy);
    state->initialized = false;
    state->initialization_lost = true;
    unlisten(listener);
}
static void initialized(struct wl_client *client, struct wl_resource *resource)
{
    struct PuInputMethod *state = wl_resource_get_user_data(resource);
    if (!pu_input_method_allowed(state->desktop, client) || !state->pid || !pu_input_method_ready(state->desktop)) {
        wl_client_post_implementation_error(client, "Only the live trusted input method may report initialization");
        return;
    }
    if (!state->initialized) {
        state->initialized = true;
        state->initialization_lost = false;
        listen(&state->method->keyboard_grab->events.destroy, &state->initialized_grab_destroy, initialized_grab_destroyed);
        wlr_log(WLR_INFO, "Input-method engine and protocol initialized");
    }
}
static void destroy_status(struct wl_client *client, struct wl_resource *resource)
{ (void)client; wl_resource_destroy(resource); }
static void session_exit(struct wl_client *client, struct wl_resource *resource,
                         uint32_t serial, uint32_t operation)
{
    struct PuInputMethod *state = wl_resource_get_user_data(resource);
    uint32_t phase, pending;
    if (pu_desktop_session_exit(state->desktop, client, operation, &phase, &pending))
        pu_desktop_session_exit_windows(state->desktop, resource, serial);
    polly_session_status_v1_send_session_exit_status(resource, serial, phase, pending);
}
static const struct polly_session_status_v1_interface status_impl = {
    .destroy = destroy_status, .inspect = inspect_status, .input_method_initialized = initialized,
    .session_exit = session_exit,
};
static enum wl_iterator_result request_logout(struct wl_resource *resource, void *data)
{
    bool *sent = data;
    if (wl_resource_instance_of(resource, &polly_session_status_v1_interface, &status_impl) &&
        wl_resource_get_version(resource) >= 2) {
        polly_session_status_v1_send_logout_requested(resource);
        *sent = true;
    }
    return WL_ITERATOR_CONTINUE;
}
bool pu_desktop_request_logout(struct PuDesktop *desktop)
{
    bool sent = false;
    if (desktop->shell_client && getuid() == 1000 && geteuid() == 1000 &&
        !pu_session_lock_active(desktop))
        wl_client_for_each_resource(desktop->shell_client, request_logout, &sent);
    if (!sent) wlr_log(WLR_ERROR, "Logout confirmation is unavailable; retaining the session");
    return sent;
}
static void bind_status(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
    struct PuInputMethod *state = data;
    if (client != state->desktop->shell_client && !pu_input_method_allowed(state->desktop, client)) {
        wl_client_post_implementation_error(client, "Session status connection is not authorized");
        return;
    }
    struct wl_resource *resource = wl_resource_create(client, &polly_session_status_v1_interface, version, id);
    if (!resource) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(resource, &status_impl, state, NULL);
}
bool pu_input_method_active(struct PuDesktop *desktop) { return can_grab(desktop->input_method); }
bool pu_input_method_key(struct PuDesktop *desktop, struct wlr_keyboard *keyboard,
    const struct wlr_keyboard_key_event *event)
{
    struct PuInputMethod *state = desktop->input_method;
    if (!can_grab(state)) return false;
    wlr_input_method_keyboard_grab_v2_set_keyboard(state->method->keyboard_grab, keyboard);
    wlr_input_method_keyboard_grab_v2_send_key(state->method->keyboard_grab, event->time_msec, event->keycode, event->state);
    return true;
}
void pu_input_method_modifiers(struct PuDesktop *desktop, struct wlr_keyboard *keyboard)
{
    struct PuInputMethod *state = desktop->input_method;
    if (!can_grab(state)) return;
    wlr_input_method_keyboard_grab_v2_set_keyboard(state->method->keyboard_grab, keyboard);
    wlr_input_method_keyboard_grab_v2_send_modifiers(state->method->keyboard_grab, &keyboard->modifiers);
}
static bool can_forward(struct VirtualKeyboard *entry)
{
    struct PuInputMethod *state = entry->state;
    return can_grab(state) && state->forward_epoch == state->epoch && entry->keyboard->has_keymap &&
        pu_input_method_allowed(state->desktop, wl_resource_get_client(entry->keyboard->resource));
}
static void virtual_key(struct wl_listener *listener, void *data)
{
    struct VirtualKeyboard *entry = wl_container_of(listener, entry, key);
    struct wlr_keyboard_key_event *event = data;
    if (entry->releasing) {
        struct PuDesktop *desktop = entry->state->desktop;
        if (!desktop->stopping && entry->focus && entry->focus == desktop->seat->keyboard_state.focused_surface)
            wlr_seat_keyboard_notify_key(desktop->seat, event->time_msec, event->keycode, event->state);
        return;
    }
    if (!can_forward(entry)) return;
    if (event->keycode >= KEY_CNT || (event->state == WL_KEYBOARD_KEY_STATE_RELEASED &&
        !entry->forwarded[event->keycode])) return;
    struct wlr_seat *seat = entry->state->desktop->seat;
    entry->forwarded[event->keycode] = event->state == WL_KEYBOARD_KEY_STATE_PRESSED;
    entry->focus = seat->keyboard_state.focused_surface;
    struct wlr_keyboard *previous = wlr_seat_get_keyboard(seat);
    wlr_seat_set_keyboard(seat, &entry->keyboard->keyboard);
    wlr_seat_keyboard_notify_key(seat, event->time_msec, event->keycode, event->state);
    wlr_seat_set_keyboard(seat, previous);
}
static void virtual_modifiers(struct wl_listener *listener, void *data)
{
    (void)data;
    struct VirtualKeyboard *entry = wl_container_of(listener, entry, modifiers);
    if (can_forward(entry))
        wlr_seat_keyboard_notify_modifiers(entry->state->desktop->seat, &entry->keyboard->keyboard.modifiers);
}
static void virtual_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct VirtualKeyboard *entry = wl_container_of(listener, entry, destroy);
    release_keys(entry, true);
    unlisten(&entry->key); unlisten(&entry->modifiers); unlisten(&entry->destroy);
    wl_list_remove(&entry->link); free(entry);
}
static void new_virtual_keyboard(struct wl_listener *listener, void *data)
{
    struct PuInputMethod *state = wl_container_of(listener, state, new_keyboard);
    struct wlr_virtual_keyboard_v1 *keyboard = data;
    if (keyboard->seat != state->desktop->seat ||
        !pu_input_method_allowed(state->desktop, wl_resource_get_client(keyboard->resource))) {
        wl_resource_post_error(keyboard->resource, 0, "Virtual keyboard is not authorized"); return;
    }
    struct VirtualKeyboard *entry = calloc(1, sizeof(*entry));
    if (!entry) { wl_resource_post_no_memory(keyboard->resource); return; }
    entry->state = state; entry->keyboard = keyboard;
    wl_list_insert(&state->keyboards, &entry->link);
    listen(&keyboard->keyboard.events.key, &entry->key, virtual_key);
    listen(&keyboard->keyboard.events.modifiers, &entry->modifiers, virtual_modifiers);
    listen(&keyboard->keyboard.base.events.destroy, &entry->destroy, virtual_destroyed);
}
static void disconnected(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuInputMethod *state = wl_container_of(listener, state, client_destroy);
    state->client = NULL; state->epoch++;
    unlisten(listener);
    if (!state->desktop->stopping) wlr_log(WLR_INFO, "Input-method connection revoked");
}
static bool reap(struct PuInputMethod *state, int options)
{
    if (!state->pid) return true;
    int status;
    pid_t pid;
    do { pid = waitpid(state->pid, &status, options); } while (pid < 0 && errno == EINTR);
    if (!pid) return false;
    if (pid < 0 && errno != ECHILD) { wlr_log_errno(WLR_ERROR, "Cannot reap input method"); return false; }
    if (pid < 0) wlr_log_errno(WLR_ERROR, "Input-method child no longer exists");
    else if (!state->desktop->stopping)
        wlr_log(WIFEXITED(status) && !WEXITSTATUS(status) ? WLR_INFO : WLR_ERROR, "Input method exited (status %d)", status);
    state->pid = 0;
    if (state->client) wl_client_destroy(state->client);
    return true;
}
static int exited(int signal_number, void *data)
{ (void)signal_number; reap(data, WNOHANG); return 0; }
bool pu_input_method_spawn(struct PuDesktop *desktop, char *const argv[])
{
    struct PuInputMethod *state = desktop->input_method;
    if (!state) { wlr_log(WLR_ERROR, "Input-method relay is not initialized"); return false; }
    if (state->client || state->pid) {
        wlr_log(WLR_ERROR, "Input method is already running");
        return false;
    }
    state->requested = true;
    state->initialized = false;
    state->initialization_lost = false;
    if (!state->exit) state->exit = wl_event_loop_add_signal(wl_display_get_event_loop(desktop->display), SIGCHLD, exited, state);
    if (!state->exit) { wlr_log_errno(WLR_ERROR, "Cannot watch input-method process"); return false; }
    state->client_destroy.notify = disconnected;
    return pu_spawn_private(desktop, argv, "input method", &state->client, &state->pid, &state->client_destroy);
}
void pu_input_method_stop(struct PuDesktop *desktop)
{
    struct PuInputMethod *state = desktop->input_method;
    if (!state) return;
    if (reap(state, WNOHANG)) return;
    if (kill(state->pid, SIGTERM) < 0 && errno != ESRCH) wlr_log_errno(WLR_ERROR, "Cannot terminate input method");
    for (int i = 0; i < 100 && !reap(state, WNOHANG); i++) {
        /* Keep Wayland sync replies available while the service retires its surfaces. */
        wl_display_flush_clients(desktop->display);
        if (wl_event_loop_dispatch(wl_display_get_event_loop(desktop->display), 0) < 0) {
            wlr_log_errno(WLR_ERROR, "Cannot dispatch input-method shutdown");
            break;
        }
        struct timespec delay = { .tv_nsec = 10000000 }; nanosleep(&delay, NULL);
    }
    if (state->pid) {
        wlr_log(WLR_ERROR, "Input method did not exit; sending SIGKILL");
        if (kill(state->pid, SIGKILL) < 0 && errno != ESRCH) wlr_log_errno(WLR_ERROR, "Cannot kill input method");
        else reap(state, 0);
    }
    if (state->client) wl_client_destroy(state->client);
}
bool pu_input_method_init(struct PuDesktop *desktop)
{
    struct PuInputMethod *state = calloc(1, sizeof(*state));
    if (!state) return false;
    desktop->input_method = state; state->desktop = desktop; state->epoch = 1;
    wl_list_init(&state->inputs); wl_list_init(&state->popups); wl_list_init(&state->keyboards);
    state->tree = wlr_scene_tree_create(&desktop->scene->tree);
    struct wlr_text_input_manager_v3 *inputs = wlr_text_input_manager_v3_create(desktop->display);
    struct wlr_input_method_manager_v2 *methods = wlr_input_method_manager_v2_create(desktop->display);
    struct wlr_virtual_keyboard_manager_v1 *keyboards = wlr_virtual_keyboard_manager_v1_create(desktop->display);
    state->status_global = wl_global_create(desktop->display, &polly_session_status_v1_interface, 2, state, bind_status);
    if (!state->tree || !inputs || !methods || !keyboards || !state->status_global) return false;
    listen(&inputs->events.text_input, &state->new_input, new_text_input);
    listen(&methods->events.input_method, &state->new_method, new_method);
    listen(&keyboards->events.new_virtual_keyboard, &state->new_keyboard, new_virtual_keyboard);
    listen(&desktop->seat->keyboard_state.events.focus_change, &state->focus, focus_changed);
    return true;
}
void pu_input_method_finish(struct PuDesktop *desktop)
{
    struct PuInputMethod *state = desktop->input_method;
    if (!state) return;
    pu_input_method_stop(desktop);
    if (state->status_global) wl_global_destroy(state->status_global);
    if (state->exit) wl_event_source_remove(state->exit);
    unlisten(&state->new_input); unlisten(&state->new_method); unlisten(&state->new_keyboard); unlisten(&state->focus);
    if (state->tree) wlr_scene_node_destroy(&state->tree->node);
    free(state); desktop->input_method = NULL;
}
