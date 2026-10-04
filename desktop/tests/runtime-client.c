#include "server.h"
#include "decoration.h"
#include "decoration-themes.h"
#include "workspace.h"

#include <stdio.h>
#include <stdlib.h>
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

static bool window_suite(char *executable, char *script, char *mode)
{
    char *args[] = { executable, "--desktop", "--app-id", "org.pollyui.window-shell",
        script, mode, executable, script, NULL };
    CHECK(pu_desktop_spawn_shell(&desktop, args));
    bool success = false;
    for (int i = 0; i < 16000 && desktop.shell_pid; i++) {
        CHECK(pump());
        struct PuDesktopLayer *marker, *tmp;
        wl_list_for_each_safe(marker, tmp, &desktop.layers, link) {
            if (!marker->surface->surface->mapped) continue;
            const char *name = marker->surface->namespace;
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
            unsigned serial, button;
            int x, y;
            char target[96];
            if (sscanf(name, "fixture-click %u %d %d %u %95s", &serial, &x, &y, &button, target) != 5)
                continue;
            struct PuDesktopLayer *layer;
            bool clicked = false;
            wl_list_for_each(layer, &desktop.layers, link) {
                if (strcmp(layer->surface->namespace, target) || !layer->surface->surface->mapped ||
                    !layer->presented) continue;
                int sx, sy;
                CHECK(wlr_scene_node_coords(&layer->tree->node, &sx, &sy));
                struct wlr_box all;
                wlr_output_layout_get_box(desktop.layout, NULL, &all);
                struct wlr_pointer_motion_absolute_event motion = {
                    .pointer = &pointer, .time_msec = serial * 3,
                    .x = (double)(sx + x - all.x) / all.width,
                    .y = (double)(sy + y - all.y) / all.height,
                };
                wl_signal_emit_mutable(&pointer.events.motion_absolute, &motion);
                /* SDL applies buffered motion at the end of its pointer frame. */
                wl_signal_emit_mutable(&pointer.events.frame, NULL);
                struct wlr_pointer_button_event click = {
                    .pointer = &pointer, .time_msec = serial * 3 + 1,
                    .button = button == 2 ? BTN_RIGHT : BTN_LEFT,
                    .state = WL_POINTER_BUTTON_STATE_PRESSED,
                };
                wlr_pointer_notify_button(&pointer, &click);
                click.time_msec++; click.state = WL_POINTER_BUTTON_STATE_RELEASED;
                wlr_pointer_notify_button(&pointer, &click);
                wl_signal_emit_mutable(&pointer.events.frame, NULL);
                clicked = true;
                break;
            }
            CHECK(clicked);
            wlr_layer_surface_v1_destroy(marker->surface);
        }
    }
    CHECK(success && !desktop.shell_pid && desktop.shell_exited &&
        WIFEXITED(desktop.shell_status) && WEXITSTATUS(desktop.shell_status) == 0);
    return true;
}

int main(int argc, char **argv)
{
    if (argc != 3 && argc != 4) return 2;
    wlr_log_init(WLR_INFO, NULL);
    bool ready = pu_desktop_init(&desktop, "runtime-client");
    if (ready) {
        input_listener = desktop.new_input.notify;
        desktop.new_input.notify = synthetic_input;
        ready = pu_desktop_start(&desktop);
    }
    bool passed = false;
    if (ready) {
        wlr_keyboard_init(&keyboard, &keyboard_impl, "runtime-fixture-keyboard");
        wlr_pointer_init(&pointer, &pointer_impl, "runtime-fixture-pointer");
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &keyboard.base);
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &pointer.base);
        passed = argc == 4 ? window_suite(argv[1], argv[2], "initial") &&
            window_suite(argv[1], argv[2], "reload") : suite(argv[1], argv[2]);
        wlr_pointer_finish(&pointer);
        wlr_keyboard_finish(&keyboard);
    }
    pu_desktop_finish(&desktop);
    if (passed) puts(argc == 4 ? "PASS: native Shell window/workspace controls and reconnect" :
        "PASS: actual PollyUI layers, input, two outputs, fractional scale, rotation, removal and close");
    return passed ? 0 : 1;
}
