#include "server.h"
#include "decoration.h"
#include "decoration-themes.h"
#include "workspace.h"
#include "data-device.h"
#include "input-method.h"

#include <stdio.h>
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
#include <sys/wait.h>
#include <string.h>
#include <drm_fourcc.h>
#include <linux/input-event-codes.h>
#include <wlr/backend.h>
#include <wlr/interfaces/wlr_keyboard.h>
#include <wlr/interfaces/wlr_pointer.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_input_device.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_pointer.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_data_device.h>
#include <wlr/types/wlr_input_method_v2.h>
#include <wlr/types/wlr_layer_shell_v1.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/util/log.h>

#define CHECK(condition) do { \
    if (!(condition)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #condition); return false; } \
} while (0)

static struct PuDesktop desktop;
static struct wlr_keyboard keyboard;
static struct wlr_pointer pointer;
static const struct wlr_keyboard_impl keyboard_impl = { .name = "runtime-fixture-keyboard" };
static const struct wlr_pointer_impl pointer_impl = { .name = "runtime-fixture-pointer" };
static wl_notify_func_t input_listener;
static wl_notify_func_t output_listener;
static bool missing_display_identity;

static void identified_output(struct wl_listener *listener, void *data)
{
    struct wlr_output *output = data;
    free(output->make); free(output->model); free(output->serial);
    output->make = strdup("Polly fixture");
    output->model = strdup("Virtual display");
    output->serial = strdup(missing_display_identity ? "" : output->name);
    if (!output->make || !output->model || !output->serial) { desktop.failed = true; return; }
    output_listener(listener, data);
}

static void synthetic_input(struct wl_listener *listener, void *data)
{
    struct wlr_input_device *device = data;
    if (device->name && !strncmp(device->name, "runtime-fixture-", 16)) input_listener(listener, data);
}

static bool pump(void)
{
    wl_display_flush_clients(desktop.display);
    return wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 5) >= 0 &&
        !desktop.failed;
}

static bool dimensions_ready(struct wlr_output *target)
{
    int count = 0;
    struct wlr_box full;
    wlr_output_layout_get_box(desktop.layout, target, &full);
    struct PuDesktopLayer *layer;
    wl_list_for_each(layer, &desktop.layers, link) {
        if (layer->surface->output != target) continue;
        struct wlr_surface_state *state = &layer->surface->surface->current;
        int height = layer->surface->current.layer == ZWLR_LAYER_SHELL_V1_LAYER_BACKGROUND ? full.height : 28;
        if (!layer->surface->surface->mapped || state->width != full.width || state->height != height ||
            state->buffer_width != (int)(full.width * target->scale + 0.5f) ||
            state->buffer_height != (int)(height * target->scale + 0.5f)) return false;
        count++;
    }
    return count == 2;
}

static bool wait_dimensions(struct wlr_output *target)
{
    for (int i = 0; i < 2000; i++) {
        CHECK(pump());
        if (dimensions_ready(target)) return true;
        CHECK(desktop.shell_pid);
    }
    fprintf(stderr, "Layer client failed to settle output %s at scale %.2f\n", target->name, target->scale);
    struct PuDesktopLayer *layer;
    wl_list_for_each(layer, &desktop.layers, link) {
        struct wlr_surface_state *state = &layer->surface->surface->current;
        fprintf(stderr, "%s output=%s mapped=%d logical=%dx%d buffer=%dx%d scale=%d\n",
            layer->surface->namespace, layer->surface->output->name,
            layer->surface->surface->mapped, state->width, state->height,
            state->buffer_width, state->buffer_height, state->scale);
    }
    return false;
}

static bool pixel_is(struct wlr_output *target, uint32_t expected)
{
    struct wlr_buffer *buffer = NULL;
    struct PuDesktopLayer *layer;
    wl_list_for_each(layer, &desktop.layers, link) {
        if (layer->surface->output == target &&
            layer->surface->current.layer == ZWLR_LAYER_SHELL_V1_LAYER_TOP &&
            layer->surface->surface->buffer)
            buffer = layer->surface->surface->buffer->source;
    }
    void *pixels = NULL;
    uint32_t format = 0, actual = 0;
    size_t stride = 0;
    bool ok = buffer && wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ,
                                                        &pixels, &format, &stride);
    if (ok) {
        memcpy(&actual, (char *)pixels + 5 * stride + 5 * 4, sizeof(actual));
        wlr_buffer_end_data_ptr_access(buffer);
    }
    return ok && (format == DRM_FORMAT_XRGB8888 || format == DRM_FORMAT_ARGB8888) &&
        (actual & 0xffffff) == expected;
}

static bool wait_pixel(struct wlr_output *output, uint32_t color)
{
    for (int i = 0; i < 500; i++) {
        CHECK(pump());
        if (pixel_is(output, color)) return true;
    }
    fprintf(stderr, "Native layer did not handle input/render expected color %06x\n", color);
    return false;
}

static bool transparent_corner(struct wlr_output *output)
{
    struct PuDesktopLayer *layer;
    wl_list_for_each(layer, &desktop.layers, link) {
        struct wlr_surface *surface = layer->surface->surface;
        if (layer->surface->output != output ||
            layer->surface->current.layer != ZWLR_LAYER_SHELL_V1_LAYER_TOP) continue;
        CHECK(!pixman_region32_contains_point(&surface->opaque_region, 0, 0, NULL));
        void *pixels;
        uint32_t format, value;
        size_t stride;
        CHECK(surface->buffer && surface->buffer->source);
        CHECK(wlr_buffer_begin_data_ptr_access(surface->buffer->source, WLR_BUFFER_DATA_PTR_ACCESS_READ,
                                                &pixels, &format, &stride));
        memcpy(&value, pixels, sizeof(value));
        wlr_buffer_end_data_ptr_access(surface->buffer->source);
        CHECK(format == DRM_FORMAT_ARGB8888 && (value >> 24) == 0);
        return true;
    }
    CHECK(false);
}

static bool suite(char *executable, char *script)
{
    char *args[] = { executable, "--app-id", "org.pollyui.layer-fixture", script, NULL };
    CHECK(pu_desktop_spawn_shell(&desktop, args));
    CHECK(wl_list_length(&desktop.layout->outputs) == 2);
    struct wlr_output_layout_output *first = wl_container_of(desktop.layout->outputs.next, first, link);
    struct wlr_output_layout_output *second = wl_container_of(desktop.layout->outputs.prev, second, link);
    struct wlr_output *output = first->output, *survivor = second->output;
    CHECK(wait_dimensions(output) && wait_dimensions(survivor));
    for (int i = 0; i < 1000 && wl_list_length(&desktop.views) != 1; i++) CHECK(pump());
    CHECK(wl_list_length(&desktop.layers) == 4 && wl_list_length(&desktop.views) == 1);
    CHECK(transparent_corner(output) && transparent_corner(survivor));
    struct wlr_box all, target;
    wlr_output_layout_get_box(desktop.layout, NULL, &all);
    wlr_output_layout_get_box(desktop.layout, output, &target);
    struct wlr_pointer_motion_absolute_event motion = {
        .pointer = &pointer, .time_msec = 1,
        .x = (double)(target.x + 10 - all.x) / all.width,
        .y = (double)(target.y + 10 - all.y) / all.height,
    };
    wl_signal_emit_mutable(&pointer.events.motion_absolute, &motion);
    struct wlr_pointer_button_event button = {
        .pointer = &pointer, .time_msec = 2, .button = BTN_LEFT, .state = WL_POINTER_BUTTON_STATE_PRESSED,
    };
    wlr_pointer_notify_button(&pointer, &button);
    button.time_msec = 3; button.state = WL_POINTER_BUTTON_STATE_RELEASED;
    wlr_pointer_notify_button(&pointer, &button);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
    CHECK(wait_pixel(output, 0xc04020));
    struct wlr_keyboard_key_event key = {
        .time_msec = 4, .keycode = KEY_A, .update_state = true, .state = WL_KEYBOARD_KEY_STATE_PRESSED,
    };
    wlr_keyboard_notify_key(&keyboard, &key);
    key.time_msec = 5; key.state = WL_KEYBOARD_KEY_STATE_RELEASED;
    wlr_keyboard_notify_key(&keyboard, &key);
    CHECK(wait_pixel(output, 0x20c040));
    struct PuDesktopView *view = wl_container_of(desktop.views.next, view, link);
    motion.time_msec = 6;
    motion.x = (double)(view->tree->node.x + 50 - all.x) / all.width;
    motion.y = (double)(view->tree->node.y + 80 - all.y) / all.height;
    wl_signal_emit_mutable(&pointer.events.motion_absolute, &motion);
    button.time_msec = 7; button.state = WL_POINTER_BUTTON_STATE_PRESSED;
    wlr_pointer_notify_button(&pointer, &button);
    button.time_msec = 8; button.state = WL_POINTER_BUTTON_STATE_RELEASED;
    wlr_pointer_notify_button(&pointer, &button);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
    CHECK(desktop.focused == view && !desktop.focused_layer);
    key.time_msec = 9; key.keycode = KEY_LEFTALT; key.state = WL_KEYBOARD_KEY_STATE_PRESSED;
    wlr_keyboard_notify_key(&keyboard, &key);
    key.time_msec = 10; key.keycode = KEY_F9;
    wlr_keyboard_notify_key(&keyboard, &key);
    key.time_msec = 11; key.state = WL_KEYBOARD_KEY_STATE_RELEASED;
    wlr_keyboard_notify_key(&keyboard, &key);
    CHECK(view->minimized && !view->tree->node.enabled && !desktop.focused);
    key.time_msec = 12; key.keycode = KEY_TAB; key.state = WL_KEYBOARD_KEY_STATE_PRESSED;
    wlr_keyboard_notify_key(&keyboard, &key);
    key.time_msec = 13; key.state = WL_KEYBOARD_KEY_STATE_RELEASED;
    wlr_keyboard_notify_key(&keyboard, &key);
    key.time_msec = 14; key.keycode = KEY_LEFTALT;
    wlr_keyboard_notify_key(&keyboard, &key);
    CHECK(!view->minimized && view->tree->node.enabled && desktop.focused == view);
    key.time_msec = 15; key.keycode = KEY_LEFTALT; key.state = WL_KEYBOARD_KEY_STATE_PRESSED;
    wlr_keyboard_notify_key(&keyboard, &key);
    key.time_msec = 16; key.keycode = KEY_F11;
    wlr_keyboard_notify_key(&keyboard, &key);
    key.time_msec = 17; key.state = WL_KEYBOARD_KEY_STATE_RELEASED;
    wlr_keyboard_notify_key(&keyboard, &key);
    key.time_msec = 18; key.keycode = KEY_LEFTALT;
    wlr_keyboard_notify_key(&keyboard, &key);
    for (int i = 0; i < 1000 && view->mode != PU_DESKTOP_FULLSCREEN; i++) CHECK(pump());
    CHECK(view->mode == PU_DESKTOP_FULLSCREEN);
    wlr_xdg_toplevel_send_close(view->toplevel);
    for (int i = 0; i < 1000 && !wl_list_empty(&desktop.views); i++) CHECK(pump());
    CHECK(wl_list_empty(&desktop.views) && desktop.shell_pid);

    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_scale(&state, 1.25f);
    CHECK(wlr_output_commit_state(output, &state));
    wlr_output_state_finish(&state);
    CHECK(wait_dimensions(output));
    wlr_output_state_init(&state);
    wlr_output_state_set_scale(&state, 2);
    CHECK(wlr_output_commit_state(output, &state));
    wlr_output_state_finish(&state);
    CHECK(wait_dimensions(output));
    wlr_output_state_init(&state);
    wlr_output_state_set_custom_mode(&state, 1600, 900, 60000);
    CHECK(wlr_output_commit_state(output, &state));
    wlr_output_state_finish(&state);
    CHECK(wait_dimensions(output));
    wlr_output_state_init(&state);
    wlr_output_state_set_transform(&state, WL_OUTPUT_TRANSFORM_90);
    CHECK(wlr_output_commit_state(output, &state));
    wlr_output_state_finish(&state);
    CHECK(wait_dimensions(output));
    wlr_output_destroy(output);
    for (int i = 0; i < 2000 && wl_list_length(&desktop.layers) != 2; i++) CHECK(pump());
    CHECK(wl_list_length(&desktop.layers) == 2 && desktop.shell_pid);
    CHECK(wait_dimensions(survivor));
    struct PuDesktopLayer *layer, *tmp;
    wl_list_for_each_safe(layer, tmp, &desktop.layers, link)
        wlr_layer_surface_v1_destroy(layer->surface);
    for (int i = 0; i < 2000 && desktop.shell_pid; i++) CHECK(pump());
    CHECK(!desktop.shell_pid && desktop.shell_exited &&
        WIFEXITED(desktop.shell_status) && WEXITSTATUS(desktop.shell_status) == 0);
    CHECK(wl_list_empty(&desktop.layers));
    return true;
}

static void remove_fixture_output(void *data) { wlr_output_destroy(data); }

struct FixtureSource {
    struct wlr_data_source base;
    const char *payload;
};
static unsigned destroyed_sources;
static void source_send(struct wlr_data_source *base, const char *mime, int32_t fd)
{
    (void)mime;
    struct FixtureSource *source = wl_container_of(base, source, base);
    size_t offset = 0, size = strlen(source->payload);
    while (offset < size) {
        ssize_t count = write(fd, source->payload + offset, size - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { fprintf(stderr, "FAIL: fixture drag pipe write\n"); desktop.failed = true; break; }
        offset += (size_t)count;
    }
    close(fd);
}
static void source_destroy(struct wlr_data_source *base)
{
    struct FixtureSource *source = wl_container_of(base, source, base);
    destroyed_sources++;
    free(source);
}
static void source_finished(struct wlr_data_source *base) { (void)base; }
static const struct wlr_data_source_impl source_impl = {
    .send = source_send, .destroy = source_destroy, .dnd_finish = source_finished,
};

static void move_pointer(int x, int y)
{
    struct wlr_box all;
    wlr_output_layout_get_box(desktop.layout, NULL, &all);
    struct wlr_pointer_motion_absolute_event motion = { .pointer = &pointer, .time_msec = 50000,
        .x = (double)(x - all.x) / all.width, .y = (double)(y - all.y) / all.height };
    wl_signal_emit_mutable(&pointer.events.motion_absolute, &motion);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
}

static bool data_drag(const char *mode)
{
    struct PuDesktopView *source = NULL, *target = NULL, *view;
    wl_list_for_each(view, &desktop.views, link) {
        if (view->toplevel->title && !strcmp(view->toplevel->title, "Data source")) source = view;
        if (view->toplevel->title && !strcmp(view->toplevel->title, "Data receiver")) target = view;
    }
    CHECK(source && target && !desktop.seat->drag);
    wlr_scene_node_set_position(&source->tree->node, 30, 60);
    wlr_scene_node_set_position(&target->tree->node, 400, 60);
    move_pointer(60, 100);
    struct wlr_pointer_button_event button = { .pointer = &pointer, .time_msec = 50001,
        .button = BTN_LEFT, .state = WL_POINTER_BUTTON_STATE_PRESSED };
    wlr_pointer_notify_button(&pointer, &button);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
    struct wlr_surface *origin = source->toplevel->base->surface;
    CHECK(desktop.seat->pointer_state.focused_surface == origin);
    unsigned before = destroyed_sources;
    struct FixtureSource *payload = NULL;
    if (strcmp(mode, "source-less")) {
        payload = calloc(1, sizeof(*payload));
        CHECK(payload);
        wlr_data_source_init(&payload->base, &source_impl);
        char **mime = wl_array_add(&payload->base.mime_types, sizeof(*mime));
        CHECK(mime);
        bool files = !strcmp(mode, "files");
        *mime = strdup(files ? "text/uri-list" : "text/plain;charset=utf-8");
        CHECK(*mime);
        payload->payload = files ? "file:///tmp/polly-one.txt\r\nfile:///tmp/polly%20two.txt\r\n" :
            "Dropped \xe4\xb8\xad\xe6\x96\x87";
        payload->base.actions = WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY;
    }
    struct wlr_drag *drag = wlr_drag_create(wlr_seat_client_for_wl_client(desktop.seat,
        wl_resource_get_client(origin->resource)), payload ? &payload->base : NULL, NULL);
    CHECK(drag);
    wlr_seat_request_start_drag(desktop.seat, drag, origin,
        !strcmp(mode, "invalid") ? 0 : desktop.seat->pointer_state.grab_serial);
    if (!strcmp(mode, "invalid")) CHECK(!desktop.seat->drag && destroyed_sources == before + 1);
    else {
        CHECK(pu_data_device_drag_active(&desktop) && desktop.seat->drag == drag);
        CHECK(!desktop.seat->keyboard_state.focused_surface);
        if (!strcmp(mode, "escape") || !strcmp(mode, "source-less")) {
            struct wlr_keyboard_key_event key = { .time_msec = 50002, .keycode = KEY_ESC,
                .update_state = true, .state = WL_KEYBOARD_KEY_STATE_PRESSED };
            wlr_keyboard_notify_key(&keyboard, &key);
            key.state = WL_KEYBOARD_KEY_STATE_RELEASED; wlr_keyboard_notify_key(&keyboard, &key);
            CHECK(!desktop.seat->drag && !pu_data_device_drag_active(&desktop));
        } else if (!strcmp(mode, "source-loss")) {
            wlr_data_source_destroy(&payload->base);
            CHECK(!desktop.seat->drag && destroyed_sources == before + 1);
        } else {
            move_pointer(430, 100);
            for (int i = 0; i < 1000 && desktop.seat->drag &&
                (!drag->source->accepted || !drag->source->current_dnd_action); i++) CHECK(pump());
            CHECK(desktop.seat->drag == drag && drag->focus == target->toplevel->base->surface &&
                drag->source->accepted && drag->source->current_dnd_action == WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY);
        }
    }
    button.time_msec = 50003; button.state = WL_POINTER_BUTTON_STATE_RELEASED;
    wlr_pointer_notify_button(&pointer, &button);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
    CHECK(!desktop.seat->drag && !pu_data_device_drag_active(&desktop));
    CHECK(!wlr_seat_keyboard_has_grab(desktop.seat) && !wlr_seat_pointer_has_grab(desktop.seat));
    CHECK(desktop.seat->keyboard_state.focused_surface == origin);
    return true;
}

struct ImePopup {
    struct wlr_surface *surface;
    int x, y;
};
static void find_ime_popup(struct wlr_scene_buffer *buffer, int x, int y, void *data)
{
    struct ImePopup *result = data;
    struct wlr_scene_surface *scene = wlr_scene_surface_try_from_buffer(buffer);
    if (scene && wlr_input_popup_surface_v2_try_from_wlr_surface(scene->surface)) {
        result->surface = scene->surface; result->x = x; result->y = y;
    }
}
static bool ime_popup_ready(struct ImePopup *popup)
{
    if (!popup->surface || !popup->surface->buffer) return false;
    struct wlr_buffer *buffer = popup->surface->buffer->source;
    void *pixels;
    uint32_t format, pixel;
    size_t stride;
    if (!wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &pixels, &format, &stride))
        return false;
    memcpy(&pixel, pixels, sizeof(pixel));
    wlr_buffer_end_data_ptr_access(buffer);
    return (format == DRM_FORMAT_XRGB8888 || format == DRM_FORMAT_ARGB8888) && (pixel & 0xffffff) == 0x20cc40;
}

static struct PuDesktopView *settings_view(void)
{
    struct PuDesktopView *view;
    wl_list_for_each(view, &desktop.views, link) {
        if (view->mapped && !view->geometry_pending && view->toplevel->title &&
            !strcmp(view->toplevel->title, "Settings") &&
            wl_resource_get_client(view->toplevel->base->resource) == desktop.shell_client) return view;
    }
    return NULL;
}

static void acknowledge_settings_marker(const char *name)
{
    struct PuDesktopLayer *layer;
    wl_list_for_each(layer, &desktop.layers, link) {
        if (!strcmp(layer->surface->namespace, name)) {
            wlr_layer_surface_v1_destroy(layer->surface);
            return;
        }
    }
}

static void fixture_pointer_motion(int x, int y, uint32_t time)
{
    struct wlr_box all;
    wlr_output_layout_get_box(desktop.layout, NULL, &all);
    struct wlr_pointer_motion_absolute_event motion = { .pointer = &pointer, .time_msec = time,
        .x = (double)(x - all.x) / all.width, .y = (double)(y - all.y) / all.height };
    wl_signal_emit_mutable(&pointer.events.motion_absolute, &motion);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
}

static void fixture_pointer_click(int x, int y, uint32_t time, unsigned button)
{
    fixture_pointer_motion(x, y, time);
    struct wlr_pointer_button_event click = { .pointer = &pointer, .time_msec = time + 1,
        .button = button == 2 ? BTN_RIGHT : button == 1 ? BTN_MIDDLE : BTN_LEFT,
        .state = WL_POINTER_BUTTON_STATE_PRESSED };
    wlr_pointer_notify_button(&pointer, &click);
    click.time_msec++; click.state = WL_POINTER_BUTTON_STATE_RELEASED;
    wlr_pointer_notify_button(&pointer, &click);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
}

static void fixture_keyboard(unsigned code, unsigned modifiers, uint32_t *time)
{
    const unsigned modifier_keys[] = { KEY_LEFTSHIFT, KEY_LEFTCTRL, KEY_LEFTALT, KEY_LEFTMETA };
    struct wlr_keyboard_key_event event = { .update_state = true };
    for (unsigned bit = 0; bit < 4; bit++) if (modifiers & (1u << bit)) {
        event.time_msec = ++*time; event.keycode = modifier_keys[bit]; event.state = WL_KEYBOARD_KEY_STATE_PRESSED;
        wlr_keyboard_notify_key(&keyboard, &event);
    }
    event.time_msec = ++*time; event.keycode = code; event.state = WL_KEYBOARD_KEY_STATE_PRESSED;
    wlr_keyboard_notify_key(&keyboard, &event);
    event.time_msec = ++*time; event.state = WL_KEYBOARD_KEY_STATE_RELEASED;
    wlr_keyboard_notify_key(&keyboard, &event);
    for (int bit = 3; bit >= 0; bit--) if (modifiers & (1u << bit)) {
        event.time_msec = ++*time; event.keycode = modifier_keys[bit];
        wlr_keyboard_notify_key(&keyboard, &event);
    }
}

static struct PuDesktopView *ordinary_fixture_view(struct wl_client *client, const char *app_id, const char *title)
{
    struct PuDesktopView *view;
    wl_list_for_each(view, &desktop.views, link) {
        if (view->mapped && !view->geometry_pending && view->toplevel->title &&
            !strcmp(view->toplevel->title, title) && view->toplevel->app_id &&
            !strcmp(view->toplevel->app_id, app_id) &&
            wl_resource_get_client(view->toplevel->base->resource) == client) return view;
    }
    return NULL;
}

static void acknowledge_ordinary_fixture_marker(pid_t owner, const char *app_id, const char *title)
{
    struct PuDesktopView *view;
    wl_list_for_each(view, &desktop.views, link) {
        if (!view->toplevel->title || strcmp(view->toplevel->title, title) || !view->toplevel->app_id ||
            strcmp(view->toplevel->app_id, app_id)) continue;
        pid_t pid;
        wl_client_get_credentials(wl_resource_get_client(view->toplevel->base->resource), &pid, NULL, NULL);
        if (pid == owner) { wlr_xdg_toplevel_send_close(view->toplevel); return; }
    }
}

static bool ordinary_fixture_requests(const char *app_id, const char *title, const char *prefix,
    int focus_x, int focus_y, unsigned *last, uint32_t *time)
{
    size_t prefix_length = strlen(prefix);
    struct PuDesktopView *marker, *next;
    wl_list_for_each_safe(marker, next, &desktop.views, link) {
        if (!marker->mapped || !marker->toplevel->title || !marker->toplevel->app_id ||
            strcmp(marker->toplevel->app_id, app_id) ||
            strncmp(marker->toplevel->title, prefix, prefix_length)) continue;
        char request[256];
        CHECK(strlen(marker->toplevel->title) < sizeof(request));
        strcpy(request, marker->toplevel->title);
        const char *digits = request + prefix_length;
        CHECK(*digits >= '0' && *digits <= '9');
        char *end;
        errno = 0;
        unsigned long parsed = strtoul(digits, &end, 10);
        CHECK(!errno && parsed > 0 && parsed <= UINT_MAX && *end == '.');
        unsigned sequence = (unsigned)parsed;
        if (sequence <= *last) continue;
        const char *action = end + 1;
        struct wl_client *client = wl_resource_get_client(marker->toplevel->base->resource);
        pid_t pid; uid_t uid;
        wl_client_get_credentials(client, &pid, &uid, NULL);
        CHECK(client != desktop.shell_client && pid > 0 && uid == 1000);
        struct PuDesktopView *view = ordinary_fixture_view(client, app_id, title);
        CHECK(view && view != marker);
        wlr_scene_node_set_enabled(&marker->tree->node, false);
        int sx, sy;
        CHECK(wlr_scene_node_coords(&view->tree->node, &sx, &sy));
        if (strcmp(action, "close") && (desktop.focused != view || desktop.focused_layer)) {
            // Each fixture declares a root padding/mask point with no business or dismissal handler.
            fixture_pointer_click(sx + focus_x, sy + focus_y, *time += 3, 0);
            continue; // No pointer is retained across the next event-loop settle.
        }
        int x, y, delta, used = 0;
        if (sscanf(action, "click %d %d%n", &x, &y, &used) == 2 && !action[used]) {
            CHECK(x >= 0 && y >= 0 && x < view->toplevel->base->geometry.width &&
                y < view->toplevel->base->geometry.height);
            *last = sequence;
            fixture_pointer_motion(sx + x, sy + y, ++*time);
            CHECK(desktop.seat->pointer_state.focused_surface == view->toplevel->base->surface);
            fixture_pointer_click(sx + x, sy + y, *time += 3, 0);
        } else if (sscanf(action, "wheel %d %d %d%n", &x, &y, &delta, &used) == 3 && !action[used]) {
            CHECK(x >= 0 && y >= 0 && x < view->toplevel->base->geometry.width &&
                y < view->toplevel->base->geometry.height && delta >= -10000 && delta <= 10000);
            *last = sequence;
            fixture_pointer_motion(sx + x, sy + y, ++*time);
            CHECK(desktop.seat->pointer_state.focused_surface == view->toplevel->base->surface);
            struct wlr_pointer_axis_event event = { .pointer = &pointer, .time_msec = ++*time,
                .source = WL_POINTER_AXIS_SOURCE_WHEEL, .orientation = WL_POINTER_AXIS_VERTICAL_SCROLL,
                .delta = delta, .delta_discrete = delta > 0 ? 120 : delta < 0 ? -120 : 0 };
            wl_signal_emit_mutable(&pointer.events.axis, &event);
            wl_signal_emit_mutable(&pointer.events.frame, NULL);
        } else if (!strncmp(action, "key ", 4)) {
            unsigned code, modifiers = 0;
            if (!strcmp(action + 4, "enter")) code = KEY_ENTER;
            else if (!strcmp(action + 4, "escape")) code = KEY_ESC;
            else if (!strcmp(action + 4, "tab")) code = KEY_TAB;
            else if (!strcmp(action + 4, "shift-tab")) { code = KEY_TAB; modifiers = 1; }
            else CHECK(false);
            CHECK(desktop.seat->keyboard_state.focused_surface == view->toplevel->base->surface);
            *last = sequence;
            fixture_keyboard(code, modifiers, time);
        } else if (!strcmp(action, "close")) {
            *last = sequence;
            wlr_xdg_toplevel_send_close(view->toplevel);
        } else CHECK(false);
        // Native actions can retire either window; resolve the copied marker title again.
        acknowledge_ordinary_fixture_marker(pid, app_id, request);
    }
    return true;
}

static bool window_suite(char *executable, char *script, char *mode)
{
    char *args[] = { executable, "--desktop", "--app-id", "org.pollyui.window-shell",
        script, mode, executable, script, NULL };
    CHECK(pu_desktop_spawn_shell(&desktop, args));
    bool success = false, crashed = false;
    unsigned settings_sequence = 0;
    unsigned file_dialog_sequence = 0;
    unsigned files_sequence = 0;
    uint32_t settings_time = 70000;
    for (int i = 0; i < 16000 && desktop.shell_pid; i++) {
        CHECK(pump());
        CHECK(ordinary_fixture_requests("org.pollyui.file-dialog-window", "PollyUI.FileText",
            "FileDialogFixture.", 10, 10, &file_dialog_sequence, &settings_time));
        CHECK(ordinary_fixture_requests("org.pollyui.files-window-fixture", "Files",
            "FilesFixture.", 6, 6, &files_sequence, &settings_time));
        struct PuDesktopLayer *marker, *tmp;
        wl_list_for_each_safe(marker, tmp, &desktop.layers, link) {
            if (!marker->surface->surface->mapped) continue;
            const char *name = marker->surface->namespace;
            if (!strcmp(name, "fixture-ime-start")) {
                const char *data = getenv("POLLY_IME_TEST_DATA");
                CHECK(data && data[0] == '/');
                char *ime_args[] = { executable, "--input-method", "--app-id", "org.pollyui.ime-fixture",
                    "desktop/tests/ime-service.mjs", (char *)data, "polly_test", NULL };
                CHECK(pu_input_method_spawn(&desktop, ime_args));
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (!strcmp(name, "fixture-ime-ready") || !strcmp(name, "fixture-ime-idle") ||
                !strcmp(name, "fixture-ime-gone")) {
                bool ready = !strcmp(name, "fixture-ime-ready") ? pu_input_method_active(&desktop) :
                    !strcmp(name, "fixture-ime-idle") ? pu_input_method_ready(&desktop) && !pu_input_method_active(&desktop) :
                    !pu_input_method_ready(&desktop);
                if (ready) wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            int ime_x, ime_y;
            bool ime_click = sscanf(name, "fixture-ime-click %d %d", &ime_x, &ime_y) == 2;
            if (ime_click || !strcmp(name, "fixture-ime-popup") || !strcmp(name, "fixture-ime-no-popup")) {
                struct ImePopup popup = {0};
                wlr_scene_node_for_each_buffer(&desktop.scene->tree.node, find_ime_popup, &popup);
                if (!strcmp(name, "fixture-ime-no-popup")) {
                    if (!popup.surface) wlr_layer_surface_v1_destroy(marker->surface);
                    continue;
                }
                if (!ime_popup_ready(&popup)) continue;
                if (ime_click) {
                    struct wlr_surface *focus = desktop.seat->keyboard_state.focused_surface;
                    move_pointer(popup.x + ime_x, popup.y + ime_y);
                    struct wlr_pointer_button_event button = { .pointer = &pointer, .time_msec = 61000,
                        .button = BTN_LEFT, .state = WL_POINTER_BUTTON_STATE_PRESSED };
                    wlr_pointer_notify_button(&pointer, &button);
                    button.state = WL_POINTER_BUTTON_STATE_RELEASED;
                    wlr_pointer_notify_button(&pointer, &button);
                    wl_signal_emit_mutable(&pointer.events.frame, NULL);
                    CHECK(desktop.seat->keyboard_state.focused_surface == focus);
                }
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (!strncmp(name, "fixture-data-drag ", 18)) {
                CHECK(data_drag(name + 18));
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            char output_name[96];
            if (sscanf(name, "fixture-output-remove %95s", output_name) == 1) {
                struct wlr_output_layout_output *entry;
                struct wlr_output *target = NULL;
                wl_list_for_each(entry, &desktop.layout->outputs, link)
                    if (!strcmp(entry->output->name, output_name)) target = entry->output;
                CHECK(target && wl_list_length(&desktop.layout->outputs) > 1);
                CHECK(wl_event_loop_add_idle(wl_display_get_event_loop(desktop.display), remove_fixture_output, target));
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (!strcmp(name, "fixture-output-crash")) {
                success = crashed = true;
                CHECK(kill(desktop.shell_pid, SIGKILL) == 0);
                break;
            }
            unsigned keycode, key_down;
            if (sscanf(name, "fixture-key %u %u", &keycode, &key_down) == 2) {
                CHECK(keycode <= KEY_MAX && key_down <= 1);
                static uint32_t key_time = 30000;
                struct wlr_keyboard_key_event event = { .time_msec = ++key_time, .keycode = keycode,
                    .update_state = true, .state = key_down ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED };
                wlr_keyboard_notify_key(&keyboard, &event);
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            unsigned workspace_index, visible_count;
            if (sscanf(name, "fixture-workspace-state %u %u", &workspace_index, &visible_count) == 2) {
                CHECK(desktop.active_workspace == pu_workspace_at(&desktop, workspace_index));
                unsigned count = 0;
                struct PuDesktopView *view;
                wl_list_for_each(view, &desktop.views, link) {
                    if (!view->toplevel->app_id || strcmp(view->toplevel->app_id, "org.pollyui.workspace-fixture")) continue;
                    CHECK(view->mapped && view->toplevel->base->surface->mapped && view->foreign);
                    CHECK(view->tree->node.enabled == (!view->minimized && pu_workspace_current(view)));
                    if (view->tree->node.enabled) count++;
                }
                CHECK(count == visible_count);
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (!strcmp(name, "fixture-workspace-left") || !strcmp(name, "fixture-workspace-right")) {
                if (desktop.focused_layer) continue;
                struct wlr_keyboard_key_event key = { .time_msec = 10000, .update_state = true,
                    .keycode = KEY_LEFTCTRL, .state = WL_KEYBOARD_KEY_STATE_PRESSED };
                wlr_keyboard_notify_key(&keyboard, &key);
                key.time_msec++; key.keycode = KEY_LEFTMETA; wlr_keyboard_notify_key(&keyboard, &key);
                key.time_msec++; key.keycode = !strcmp(name, "fixture-workspace-left") ? KEY_LEFT : KEY_RIGHT;
                wlr_keyboard_notify_key(&keyboard, &key);
                key.time_msec++; key.state = WL_KEYBOARD_KEY_STATE_RELEASED; wlr_keyboard_notify_key(&keyboard, &key);
                key.time_msec++; key.keycode = KEY_LEFTMETA; wlr_keyboard_notify_key(&keyboard, &key);
                key.time_msec++; key.keycode = KEY_LEFTCTRL; wlr_keyboard_notify_key(&keyboard, &key);
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            int expected_border, expected_title;
            unsigned expected_color;
            int control_size, control_gap, control_inset;
            if (sscanf(name, "fixture-frame-controls %d %d %d", &control_size, &control_gap, &control_inset) == 3) {
                bool ready = false;
                struct PuDesktopView *view;
                wl_list_for_each(view, &desktop.views, link) {
                    if (!view->toplevel->app_id || strcmp(view->toplevel->app_id, "org.pollyui.window-fixture") ||
                        view->geometry_pending) continue;
                    struct wlr_box close, minimize, maximize, inset = { .width = 1280, .height = 720 };
                    pu_decoration_inset(view, &inset, false);
                    CHECK(pu_decoration_button_box(view, PU_DECORATION_CLOSE, &close));
                    CHECK(pu_decoration_button_box(view, PU_DECORATION_MINIMIZE, &minimize));
                    CHECK(pu_decoration_button_box(view, PU_DECORATION_MAXIMIZE, &maximize));
                    CHECK(close.width == control_size && close.height == control_size);
                    CHECK(close.x == control_inset - inset.x);
                    CHECK(minimize.x - close.x == control_size + control_gap);
                    CHECK(maximize.x - minimize.x == control_size + control_gap);
                    ready = true;
                }
                if (ready) wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (sscanf(name, "fixture-frame-style %d %d %x", &expected_border, &expected_title, &expected_color) == 3) {
                bool ready = false;
                struct PuDesktopView *view;
                wl_list_for_each(view, &desktop.views, link) {
                    if (!view->toplevel->app_id || strcmp(view->toplevel->app_id, "org.pollyui.window-fixture") ||
                        view->geometry_pending) continue;
                    struct wlr_box inset = { .width = 1280, .height = 720 };
                    pu_decoration_inset(view, &inset, false);
                    CHECK(inset.x == expected_border && inset.y == expected_title);
                    int vx, vy;
                    CHECK(wlr_scene_node_coords(&view->tree->node, &vx, &vy));
                    double sx, sy;
                    struct wlr_scene_node *hit = wlr_scene_node_at(&desktop.scene->tree.node,
                        vx + view->toplevel->base->geometry.width / 2, vy - expected_title + expected_border + 1, &sx, &sy);
                    CHECK(hit && hit->type == WLR_SCENE_NODE_BUFFER);
                    struct wlr_scene_buffer *scene = wlr_scene_buffer_from_node(hit);
                    struct wlr_buffer *buffer = scene->buffer;
                    void *pixels; uint32_t format, pixel; size_t stride;
                    CHECK(buffer && wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ,
                        &pixels, &format, &stride));
                    int x = (int)(sx * buffer->width / (view->toplevel->base->geometry.width + 2 * expected_border));
                    int y = (int)(sy * buffer->height / expected_title);
                    CHECK(x >= 0 && y >= 0 && x < buffer->width && y < buffer->height);
                    memcpy(&pixel, (char *)pixels + (size_t)y * stride + (size_t)x * 4, sizeof(pixel));
                    wlr_buffer_end_data_ptr_access(buffer);
                    CHECK((pixel & 0xffffff) == expected_color);
                    ready = true;
                }
                if (ready) wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (!strncmp(name, "fixture-frame-theme ", 20)) {
                struct PuDesktopView *view;
                bool ready = false;
                wl_list_for_each(view, &desktop.views, link) {
                    if (!view->toplevel->app_id || strcmp(view->toplevel->app_id, "org.pollyui.window-fixture") ||
                        view->geometry_pending) continue;
                    for (unsigned theme = 0; theme < PU_DECORATION_THEME_COUNT; theme++) {
                        if (strcmp(name + 20, pu_decoration_themes[theme].id)) continue;
                        struct wlr_box inset = { .width = 1280, .height = 720 }, button;
                        pu_decoration_inset(view, &inset, false);
                        CHECK(inset.y == pu_decoration_themes[theme].title_height &&
                              inset.x == pu_decoration_themes[theme].border_width);
                        CHECK(pu_decoration_button_box(view, PU_DECORATION_CLOSE, &button));
                        ready = true;
                    }
                }
                if (ready) wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (!strcmp(name, "fixture-success")) {
                success = true;
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            unsigned settings_open, sequence;
            if (sscanf(name, "fixture-settings-state %u %u", &sequence, &settings_open) == 2) {
                CHECK(settings_open <= 1 && desktop.shell_pid);
                bool found_settings = false, found_survivor = false;
                struct PuDesktopView *view;
                wl_list_for_each(view, &desktop.views, link) {
                    if (!view->mapped || view->geometry_pending) continue;
                    struct wl_client *client = wl_resource_get_client(view->toplevel->base->resource);
                    if (client == desktop.shell_client && view->toplevel->title &&
                        !strcmp(view->toplevel->title, "Settings")) found_settings = true;
                    if (view->toplevel->app_id && !strcmp(view->toplevel->app_id, "org.pollyui.settings-survivor")) {
                        pid_t pid;
                        wl_client_get_credentials(client, &pid, NULL, NULL);
                        CHECK(client != desktop.shell_client && pid > 0 && kill(pid, 0) == 0);
                        found_survivor = true;
                    }
                }
                if (found_survivor && found_settings == (settings_open != 0))
                    wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (sscanf(name, "fixture-settings-close %u", &sequence) == 1) {
                struct PuDesktopView *view = settings_view();
                if (view && sequence > settings_sequence) {
                    char request[96];
                    CHECK(strlen(name) < sizeof(request));
                    strcpy(request, name);
                    settings_sequence = sequence;
                    wlr_xdg_toplevel_send_close(view->toplevel);
                    acknowledge_settings_marker(request);
                }
                continue;
            }
            unsigned code, modifiers;
            if (sscanf(name, "fixture-settings-key %u %u %u", &sequence, &code, &modifiers) == 3) {
                struct PuDesktopView *view = settings_view();
                CHECK(code <= KEY_MAX && modifiers <= 15);
                if (!view || sequence <= settings_sequence) continue;
                CHECK(desktop.seat->keyboard_state.focused_surface == view->toplevel->base->surface);
                char request[96];
                CHECK(strlen(name) < sizeof(request)); strcpy(request, name);
                settings_sequence = sequence;
                fixture_keyboard(code, modifiers, &settings_time);
                acknowledge_settings_marker(request);
                continue;
            }
            unsigned serial, button;
            int x, y;
            char target[96];
            if (sscanf(name, "fixture-tray-pixel %d %d %95s", &x, &y, target) == 3 ||
                sscanf(name, "fixture-bitmap-pixel %d %d %95s", &x, &y, target) == 3) {
                bool found = false;
                struct PuDesktopLayer *layer;
                wl_list_for_each(layer, &desktop.layers, link) {
                    struct wlr_surface *surface = layer->surface->surface;
                    if (strcmp(layer->surface->namespace, target) || !surface->mapped || !surface->buffer) continue;
                    void *pixels; uint32_t format, pixel; size_t stride;
                    struct wlr_buffer *buffer = surface->buffer->source;
                    CHECK(x >= 0 && y >= 0 && x < buffer->width && y < buffer->height);
                    CHECK(wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &pixels, &format, &stride));
                    memcpy(&pixel, (char *)pixels + (size_t)y * stride + (size_t)x * 4, sizeof(pixel));
                    wlr_buffer_end_data_ptr_access(buffer);
                    CHECK((pixel & 0xffffff) == 0x2090e0);
                    found = true;
                }
                CHECK(found);
                wlr_layer_surface_v1_destroy(marker->surface); continue;
            }
            bool ordinary = sscanf(name, "fixture-xdg-click %u %d %d %u %95s", &serial, &x, &y, &button, target) == 5;
            if (!ordinary && sscanf(name, "fixture-click %u %d %d %u %95s", &serial, &x, &y, &button, target) != 5)
                continue;
            struct PuDesktopLayer *layer;
            struct wlr_scene_tree *tree = NULL;
            if (ordinary) {
                CHECK(!strcmp(target, "Settings"));
                struct PuDesktopView *view = settings_view();
                if (!view || serial <= settings_sequence) continue;
                tree = view->tree;
                if (desktop.focused != view || desktop.focused_layer) {
                    int sx, sy;
                    CHECK(wlr_scene_node_coords(&tree->node, &sx, &sy));
                    // Settings's header spacer at (140,10) has no business/close action.
                    fixture_pointer_click(sx + 140, sy + 10, settings_time += 3, 0);
                    continue; // Settle client focus, then look up both view and marker again.
                }
                CHECK(desktop.seat->keyboard_state.focused_surface == view->toplevel->base->surface);
            } else {
                wl_list_for_each(layer, &desktop.layers, link) {
                    if (strcmp(layer->surface->namespace, target) || !layer->surface->surface->mapped ||
                        !layer->presented) continue;
                    tree = layer->tree;
                    break;
                }
            }
            if (ordinary && !tree) continue;
            CHECK(tree);
            char request[256];
            CHECK(strlen(name) < sizeof(request)); strcpy(request, name);
            {
                int sx, sy;
                CHECK(wlr_scene_node_coords(&tree->node, &sx, &sy));
                if (ordinary) settings_sequence = serial;
                fixture_pointer_click(sx + x, sy + y, ordinary ? settings_time += 3 : serial * 3, button);
            }
            acknowledge_settings_marker(request);
        }
    }
    CHECK(success && !desktop.shell_pid && desktop.shell_exited &&
        (crashed ? WIFSIGNALED(desktop.shell_status) && WTERMSIG(desktop.shell_status) == SIGKILL :
        WIFEXITED(desktop.shell_status) && WEXITSTATUS(desktop.shell_status) == 0));
    return true;
}

int main(int argc, char **argv)
{
    if (argc != 3 && argc != 4 && argc != 5) return 2;
    missing_display_identity = argc == 5 && !strcmp(argv[4], "unknown");
    wlr_log_init(WLR_INFO, NULL);
    bool ready = pu_desktop_init(&desktop, "runtime-client");
    if (ready) {
        input_listener = desktop.new_input.notify;
        desktop.new_input.notify = synthetic_input;
        output_listener = desktop.new_output.notify;
        desktop.new_output.notify = identified_output;
        ready = pu_desktop_start(&desktop);
    }
    bool passed = false;
    if (ready) {
        wlr_keyboard_init(&keyboard, &keyboard_impl, "runtime-fixture-keyboard");
        wlr_pointer_init(&pointer, &pointer_impl, "runtime-fixture-pointer");
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &keyboard.base);
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &pointer.base);
        passed = argc == 5 ? window_suite(argv[1], argv[2], argv[4]) : argc == 4 ? window_suite(argv[1], argv[2], "initial") &&
            window_suite(argv[1], argv[2], "reload") : suite(argv[1], argv[2]);
        wlr_pointer_finish(&pointer);
        wlr_keyboard_finish(&keyboard);
    }
    pu_desktop_finish(&desktop);
    if (passed) puts(argc >= 4 ? "PASS: native Shell window/workspace controls and reconnect" :
        "PASS: actual PollyUI layers, input, two outputs, fractional scale, rotation, removal and close");
    return passed ? 0 : 1;
}
