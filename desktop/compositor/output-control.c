#include "output-control.h"
#include "server.h"
#include "session-lock.h"
#include "polly-output-guard-server.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wlr/backend.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_output_management_v1.h>
#include <wlr/util/log.h>

#define CONFIRM_MILLISECONDS 15000
struct Output {
    struct wl_list link;
    struct PuOutputControl *state;
    struct wlr_output *output;
    int x, y;
    int width, height, refresh, transform, adaptive;
    float scale;
    bool enabled;
    struct wlr_output_mode *mode;
    struct wl_listener commit, destroy;
};
struct Guard {
    struct wl_list link;
    struct PuOutputControl *state;
    struct wl_resource *resource;
};
struct PuOutputControl {
    struct PuDesktop *desktop;
    struct wlr_output_manager_v1 *manager;
    struct wl_global *guard;
    struct wl_list outputs, guards;
    struct wl_listener apply, test, owner_destroy;
    struct wl_event_source *idle, *timer;
    struct wl_client *owner;
    struct wlr_output_configuration_v1 *saved;
    uint32_t token, sequence, outcome;
    uint64_t deadline;
    bool applying, startup_claimed;
    const char *rollback_reason, *message;
};

static uint64_t now_ms(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void send_guard(struct Guard *guard)
{
    struct PuOutputControl *state = guard->state;
    uint64_t now = now_ms();
    polly_output_guard_v1_send_state(guard->resource, state->saved ? state->token : 0,
        state->saved && state->deadline > now ? (uint32_t)(state->deadline - now) : 0,
        state->outcome,
        state->message ? state->message : "");
}

static void notify(struct PuOutputControl *state)
{
    struct Guard *guard;
    wl_list_for_each(guard, &state->guards, link) send_guard(guard);
}

static struct wlr_output_configuration_v1 *snapshot(struct PuOutputControl *state, bool durable_modes)
{
    struct wlr_output_configuration_v1 *config = wlr_output_configuration_v1_create();
    if (!config) return NULL;
    struct Output *output;
    wl_list_for_each(output, &state->outputs, link) {
        struct wlr_output_configuration_head_v1 *head = wlr_output_configuration_head_v1_create(config, output->output);
        if (!head) { wlr_output_configuration_v1_destroy(config); return NULL; }
        struct wlr_output_layout_output *layout = wlr_output_layout_get(state->desktop->layout, output->output);
        if (layout) { output->x = layout->x; output->y = layout->y; }
        head->state.x = output->x; head->state.y = output->y;
        if (durable_modes) {
            head->state.mode = NULL;
            head->state.custom_mode.width = output->output->width;
            head->state.custom_mode.height = output->output->height;
            head->state.custom_mode.refresh = output->output->refresh;
        }
    }
    return config;
}

static void publish(struct PuOutputControl *state)
{
    struct wlr_output_configuration_v1 *config = snapshot(state, false);
    if (!config) {
        wlr_log(WLR_ERROR, "Cannot publish display configuration");
        struct wl_resource *resource;
        wl_resource_for_each(resource, &state->manager->resources) wl_resource_post_no_memory(resource);
        return;
    }
    wlr_output_manager_v1_set_configuration(state->manager, config);
}

static bool validate(struct PuOutputControl *state, struct wlr_output_configuration_v1 *config)
{
    if (wl_list_length(&config->heads) != wl_list_length(&state->outputs)) return false;
    bool enabled = false;
    struct wlr_output_configuration_head_v1 *head;
    wl_list_for_each(head, &config->heads, link) {
        bool known = false;
        struct Output *output;
        wl_list_for_each(output, &state->outputs, link) if (output->output == head->state.output) known = true;
        if (!known) return false;
        if (!head->state.enabled) continue;
        enabled = true;
        int width = head->state.mode ? head->state.mode->width : head->state.custom_mode.width;
        int height = head->state.mode ? head->state.mode->height : head->state.custom_mode.height;
        int refresh = head->state.mode ? head->state.mode->refresh : head->state.custom_mode.refresh;
        float scale = head->state.scale;
        if (width < 1 || height < 1 || width > 16384 || height > 16384 ||
            (uint64_t)width * height > 32u * 1024u * 1024u ||
            refresh < 0 || refresh > 1000000 || !isfinite(scale) || scale < 0.25f || scale > 4 ||
            width / scale > 32700 || height / scale > 32700 ||
            head->state.transform < WL_OUTPUT_TRANSFORM_NORMAL || head->state.transform > WL_OUTPUT_TRANSFORM_FLIPPED_270 ||
            head->state.x < -32768 || head->state.x > 32768 || head->state.y < -32768 || head->state.y > 32768) return false;
    }
    return enabled;
}

static bool apply_config(struct PuOutputControl *state, struct wlr_output_configuration_v1 *config, bool test_only)
{
    size_t count;
    struct wlr_backend_output_state *states = wlr_output_configuration_v1_build_state(config, &count);
    if (!states) return false;
    bool ok = wlr_backend_test(state->desktop->backend, states, count);
    if (ok && !test_only) {
        state->startup_claimed = true;
        state->applying = true;
        ok = wlr_backend_commit(state->desktop->backend, states, count);
        if (ok) {
            struct wlr_output_configuration_head_v1 *head;
            wl_list_for_each(head, &config->heads, link) {
                struct Output *entry;
                wl_list_for_each(entry, &state->outputs, link)
                    if (entry->output == head->state.output) { entry->x = head->state.x; entry->y = head->state.y; }
                if (head->state.enabled &&
                    !wlr_output_layout_add(state->desktop->layout, head->state.output, head->state.x, head->state.y))
                    ok = false;
            }
        }
        state->applying = false;
    }
    for (size_t i = 0; i < count; i++) wlr_output_state_finish(&states[i].base);
    free(states);
    return ok;
}

static void forget_owner(struct PuOutputControl *state)
{
    if (state->owner) {
        wl_list_remove(&state->owner_destroy.link);
        wl_list_init(&state->owner_destroy.link);
        state->owner = NULL;
    }
    wl_event_source_timer_update(state->timer, 0);
}

static void rollback(struct PuOutputControl *state, const char *reason)
{
    if (!state->saved) return;
    struct wlr_output_configuration_v1 *saved = state->saved;
    state->saved = NULL;
    state->rollback_reason = NULL;
    forget_owner(state);
    bool any_enabled = false;
    struct wlr_output_configuration_head_v1 *head;
    wl_list_for_each(head, &saved->heads, link) {
        struct wlr_output_mode *mode;
        wl_list_for_each(mode, &head->state.output->modes, link)
            if (mode->width == head->state.custom_mode.width && mode->height == head->state.custom_mode.height &&
                mode->refresh == head->state.custom_mode.refresh) { head->state.mode = mode; break; }
        if (head->state.enabled) any_enabled = true;
    }
    struct Output *output;
    wl_list_for_each(output, &state->outputs, link) {
        bool covered = false;
        wl_list_for_each(head, &saved->heads, link)
            if (head->state.output == output->output) covered = true;
        if (!covered && output->output->enabled) any_enabled = true;
    }
    if (!any_enabled && !wl_list_empty(&saved->heads)) {
        head = wl_container_of(saved->heads.next, head, link);
        head->state.enabled = true;
        wlr_log(WLR_ERROR, "Display rollback must enable a remaining output after topology changed");
    }
    bool ok = wl_list_empty(&saved->heads) || apply_config(state, saved, false);
    wlr_output_configuration_v1_destroy(saved);
    state->message = ok ? reason : "Could not fully restore the previous display configuration";
    state->outcome = ok ? 2 : 3;
    if (!ok) wlr_log(WLR_ERROR, "%s", state->message);
    publish(state);
    notify(state);
}

static void idle(void *data)
{
    struct PuOutputControl *state = data;
    state->idle = NULL;
    const char *reason = state->rollback_reason;
    state->rollback_reason = NULL;
    if (reason && state->saved) rollback(state, reason);
    else publish(state);
}

static void schedule(struct PuOutputControl *state, const char *reason)
{
    if (state->applying) return;
    if (reason && state->saved) state->rollback_reason = reason;
    if (!state->idle) state->idle = wl_event_loop_add_idle(wl_display_get_event_loop(state->desktop->display), idle, state);
    if (!state->idle) {
        wlr_log(WLR_ERROR, "Cannot queue display configuration refresh");
        wl_event_source_timer_update(state->timer, 1);
    }
}

static int expired(void *data)
{
    struct PuOutputControl *state = data;
    if (state->saved) rollback(state, "Display changes reverted because they were not confirmed");
    else publish(state);
    return 0;
}

static void owner_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuOutputControl *state = wl_container_of(listener, state, owner_destroy);
    wl_list_remove(&state->owner_destroy.link);
    wl_list_init(&state->owner_destroy.link);
    state->owner = NULL;
    schedule(state, "Display changes reverted after the Shell disconnected");
}

static void requested(struct PuOutputControl *state, struct wlr_output_configuration_v1 *config, bool test_only)
{
    bool authorized = config->resource &&
        wl_resource_get_client(config->resource) == state->desktop->shell_client;
    bool ok = authorized && !pu_session_lock_active(state->desktop) && !state->saved && validate(state, config);
    struct wlr_output_configuration_v1 *saved = ok && !test_only ? snapshot(state, true) : NULL;
    if (ok && !test_only && !saved) ok = false;
    if (ok) ok = apply_config(state, config, test_only);
    if (ok && !test_only) {
        state->saved = saved;
        state->rollback_reason = NULL;
        state->owner = wl_resource_get_client(config->resource);
        state->owner_destroy.notify = owner_destroyed;
        wl_client_add_destroy_listener(state->owner, &state->owner_destroy);
        if (++state->sequence == 0) state->sequence++;
        state->token = state->sequence;
        state->deadline = now_ms() + CONFIRM_MILLISECONDS;
        state->message = "";
        state->outcome = 0;
        if (wl_event_source_timer_update(state->timer, CONFIRM_MILLISECONDS) < 0) {
            rollback(state, "Display changes reverted because confirmation could not be scheduled");
            ok = false;
        } else { publish(state); notify(state); }
    } else if (saved) {
        state->saved = saved;
        rollback(state, "Display changes failed; previous settings restored");
    }
    if (ok) wlr_output_configuration_v1_send_succeeded(config);
    else {
        wlr_log(WLR_ERROR, "Rejected display configuration: unsupported, stale, busy or unsafe");
        wlr_output_configuration_v1_send_failed(config);
    }
    wlr_output_configuration_v1_destroy(config);
}

static void apply_request(struct wl_listener *listener, void *data)
{
    struct PuOutputControl *state = wl_container_of(listener, state, apply);
    requested(state, data, false);
}
static void test_request(struct wl_listener *listener, void *data)
{
    struct PuOutputControl *state = wl_container_of(listener, state, test);
    requested(state, data, true);
}

static void destroy_guard(struct wl_client *client, struct wl_resource *resource)
{ (void)client; wl_resource_destroy(resource); }
static void confirm(struct wl_client *client, struct wl_resource *resource, uint32_t token)
{
    struct Guard *guard = wl_resource_get_user_data(resource);
    struct PuOutputControl *state = guard->state;
    if (!state->saved || state->owner != client || state->token != token) {
        wlr_log(WLR_DEBUG, "Ignoring stale display confirmation"); return;
    }
    if (state->rollback_reason) {
        rollback(state, state->rollback_reason);
        return;
    }
    wlr_output_configuration_v1_destroy(state->saved); state->saved = NULL;
    state->rollback_reason = NULL;
    forget_owner(state);
    state->message = "";
    state->outcome = 1;
    notify(state);
}
static void revert(struct wl_client *client, struct wl_resource *resource, uint32_t token)
{
    struct Guard *guard = wl_resource_get_user_data(resource);
    struct PuOutputControl *state = guard->state;
    if (!state->saved || state->owner != client || state->token != token) {
        wlr_log(WLR_DEBUG, "Ignoring stale display rollback"); return;
    }
    rollback(state, "Display changes reverted");
}
static void claim_startup(struct wl_client *client, struct wl_resource *resource, uint32_t serial)
{
    struct Guard *guard = wl_resource_get_user_data(resource);
    struct PuOutputControl *state = guard->state;
    if (client != state->desktop->shell_client) {
        wl_client_post_implementation_error(client, "Display startup authorization was revoked");
        return;
    }
    bool accepted = !state->startup_claimed && !state->saved && !pu_session_lock_active(state->desktop);
    state->startup_claimed = true;
    polly_output_guard_v1_send_startup_claimed(resource, serial, accepted);
}
static const struct polly_output_guard_v1_interface guard_impl = {
    .destroy = destroy_guard, .confirm = confirm, .revert = revert, .claim_startup = claim_startup,
};
static void guard_destroyed(struct wl_resource *resource)
{
    struct Guard *guard = wl_resource_get_user_data(resource);
    wl_list_remove(&guard->link); free(guard);
}
static void bind_guard(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
    struct PuOutputControl *state = data;
    if (client != state->desktop->shell_client) {
        wl_client_post_implementation_error(client, "Display confirmation requires the trusted Shell"); return;
    }
    struct Guard *guard = calloc(1, sizeof(*guard));
    if (!guard) { wl_client_post_no_memory(client); return; }
    guard->resource = wl_resource_create(client, &polly_output_guard_v1_interface, version, id);
    if (!guard->resource) { free(guard); wl_client_post_no_memory(client); return; }
    guard->state = state;
    wl_list_insert(state->guards.prev, &guard->link);
    wl_resource_set_implementation(guard->resource, &guard_impl, guard, guard_destroyed);
    send_guard(guard);
}

static bool observe(struct Output *entry)
{
    struct wlr_output *output = entry->output;
    bool changed = entry->width != output->width || entry->height != output->height ||
        entry->refresh != output->refresh || entry->scale != output->scale ||
        entry->transform != (int)output->transform || entry->enabled != output->enabled ||
        entry->adaptive != (int)output->adaptive_sync_status || entry->mode != output->current_mode;
    entry->width = output->width; entry->height = output->height; entry->refresh = output->refresh;
    entry->scale = output->scale; entry->transform = output->transform; entry->enabled = output->enabled;
    entry->adaptive = output->adaptive_sync_status; entry->mode = output->current_mode;
    return changed;
}

static void output_commit(struct wl_listener *listener, void *data)
{
    struct Output *output = wl_container_of(listener, output, commit);
    struct wlr_output_event_commit *event = data;
    if ((event->state->committed & (WLR_OUTPUT_STATE_ENABLED | WLR_OUTPUT_STATE_MODE |
        WLR_OUTPUT_STATE_SCALE | WLR_OUTPUT_STATE_TRANSFORM | WLR_OUTPUT_STATE_ADAPTIVE_SYNC_ENABLED)) && observe(output))
        schedule(output->state, "Display changes reverted after output state changed");
}
static void output_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct Output *output = wl_container_of(listener, output, destroy);
    schedule(output->state, "Display changes reverted after an output was disconnected");
    wl_list_remove(&output->commit.link); wl_list_remove(&output->destroy.link);
    wl_list_remove(&output->link); free(output);
}
bool pu_output_control_add(struct PuDesktop *desktop, struct wlr_output *output)
{
    struct Output *entry = calloc(1, sizeof(*entry));
    if (!entry) return false;
    entry->state = desktop->output_control; entry->output = output;
    observe(entry);
    entry->commit.notify = output_commit; wl_signal_add(&output->events.commit, &entry->commit);
    entry->destroy.notify = output_destroyed; wl_signal_add(&output->events.destroy, &entry->destroy);
    wl_list_insert(entry->state->outputs.prev, &entry->link);
    schedule(entry->state, "Display changes reverted after an output was connected");
    return true;
}

void pu_output_control_changed(struct PuDesktop *desktop)
{
    if (desktop->output_control && !desktop->stopping)
        schedule(desktop->output_control, "Display changes reverted after output layout changed");
}

void pu_output_control_locking(struct PuDesktop *desktop)
{
    if (desktop->output_control && desktop->output_control->saved)
        rollback(desktop->output_control, "Unconfirmed display changes reverted before session lock");
}

bool pu_output_control_init(struct PuDesktop *desktop)
{
    struct PuOutputControl *state = calloc(1, sizeof(*state));
    if (!state) return false;
    desktop->output_control = state; state->desktop = desktop;
    wl_list_init(&state->outputs); wl_list_init(&state->guards); wl_list_init(&state->owner_destroy.link);
    state->manager = wlr_output_manager_v1_create(desktop->display);
    state->guard = wl_global_create(desktop->display, &polly_output_guard_v1_interface, 2, state, bind_guard);
    state->timer = wl_event_loop_add_timer(wl_display_get_event_loop(desktop->display), expired, state);
    if (!state->manager || !state->guard || !state->timer) return false;
    state->apply.notify = apply_request; wl_signal_add(&state->manager->events.apply, &state->apply);
    state->test.notify = test_request; wl_signal_add(&state->manager->events.test, &state->test);
    return true;
}

void pu_output_control_finish(struct PuDesktop *desktop)
{
    struct PuOutputControl *state = desktop->output_control;
    if (!state) return;
    if (state->saved) rollback(state, "Display changes reverted during shutdown");
    if (state->idle) wl_event_source_remove(state->idle);
    if (state->timer) wl_event_source_remove(state->timer);
    if (state->apply.link.next) wl_list_remove(&state->apply.link);
    if (state->test.link.next) wl_list_remove(&state->test.link);
    if (state->guard) wl_global_destroy(state->guard);
    struct Output *output, *tmp;
    wl_list_for_each_safe(output, tmp, &state->outputs, link) {
        wl_list_remove(&output->commit.link); wl_list_remove(&output->destroy.link);
        wl_list_remove(&output->link); free(output);
    }
    free(state); desktop->output_control = NULL;
}
