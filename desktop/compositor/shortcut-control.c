#include "shortcut-control.h"
#include "server.h"
#include "workspace.h"
#include "polly-shortcuts-server.h"

#include <stdlib.h>
#include <string.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>
#include <xkbcommon/xkbcommon-keysyms.h>

struct Binding {
    struct wl_list link;
    struct PuShortcuts *state;
    struct wl_resource *resource;
    struct PuShortcutBinding pending[PU_SHORTCUT_COUNT];
    bool staged, recording;
    const char *error;
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
};

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
    struct PuShortcuts *state = desktop->shortcuts;
    if (!state || !state->active) return;
    state->active = false;
    if (state->presenter) polly_shortcuts_v1_send_switcher_closed(state->presenter->resource);
    free(state->candidates); state->candidates = NULL;
    state->keyboard = NULL; state->count = 0;
}

bool pu_shortcuts_switching(struct PuDesktop *desktop)
{ return desktop->shortcuts && desktop->shortcuts->active; }

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
    if (state->active && key == XKB_KEY_Escape) { pu_shortcuts_cancel(desktop); return true; }
    uint32_t mods = modifiers(keyboard);
    if ((mods & PU_SHORTCUT_ALT) && key == XKB_KEY_Escape) {
        wl_display_terminate(desktop->display);
        return true;
    }
    if (desktop->focused_layer) return false;
    int action = pu_shortcut_match(state->current, key, mods);
    if (action < 0) return false;
    if (desktop->grab != PU_DESKTOP_PASSTHROUGH &&
        action != PU_SHORTCUT_WORKSPACE_PREVIOUS && action != PU_SHORTCUT_WORKSPACE_NEXT) return false;
    bool reverse = (mods & PU_SHORTCUT_SHIFT) != 0;
    if (action == PU_SHORTCUT_SWITCH && switch_window(state, keyboard, reverse)) return true;
    pu_shortcuts_cancel(desktop);
    pu_desktop_shortcut_action(desktop, action, reverse);
    return true;
}

void pu_shortcuts_modifiers(struct PuDesktop *desktop, struct wlr_keyboard *keyboard)
{
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
    if (desktop->shortcuts && desktop->shortcuts->keyboard == keyboard) pu_shortcuts_cancel(desktop);
}

void pu_shortcuts_unmap(struct PuDesktopView *view)
{
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
        if (state->presenter && state->presenter != binding)
            polly_shortcuts_v1_send_switcher_closed(state->presenter->resource);
        state->presenter = binding;
        send_switcher(state);
    } else if (state->presenter == binding) {
        pu_shortcuts_cancel(state->desktop);
        state->presenter = NULL;
    }
}

static void recording(struct wl_client *client, struct wl_resource *resource, uint32_t enabled)
{
    (void)client;
    struct Binding *binding = wl_resource_get_user_data(resource);
    binding->recording = enabled != 0;
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

static const struct polly_shortcuts_v1_interface implementation = {
    .destroy = destroy_request, .set_binding = set_binding, .commit = commit, .presenter = presenter,
    .recording = recording, .accept = accept_request, .cancel = cancel_request,
};

static void destroyed(struct wl_resource *resource)
{
    struct Binding *binding = wl_resource_get_user_data(resource);
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
    struct Binding *binding = calloc(1, sizeof(*binding));
    if (!binding) { wl_client_post_no_memory(client); return; }
    binding->resource = wl_resource_create(client, &polly_shortcuts_v1_interface, version, id);
    if (!binding->resource) { free(binding); wl_client_post_no_memory(client); return; }
    binding->state = state;
    wl_list_insert(state->bindings.prev, &binding->link);
    wl_resource_set_implementation(binding->resource, &implementation, binding, destroyed);
    send_bindings(binding);
}

bool pu_shortcuts_init(struct PuDesktop *desktop)
{
    struct PuShortcuts *state = calloc(1, sizeof(*state));
    if (!state) return false;
    desktop->shortcuts = state; state->desktop = desktop;
    wl_list_init(&state->bindings);
    pu_shortcut_defaults(state->current);
    state->global = wl_global_create(desktop->display, &polly_shortcuts_v1_interface, 1, state, bind_control);
    return state->global != NULL;
}

void pu_shortcuts_finish(struct PuDesktop *desktop)
{
    struct PuShortcuts *state = desktop->shortcuts;
    if (!state) return;
    pu_shortcuts_cancel(desktop);
    if (state->global) wl_global_destroy(state->global);
    free(state); desktop->shortcuts = NULL;
}
