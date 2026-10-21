#include "server.h"
#include "workspace-cube.h"
#include "decorator-process.h"
#include "decoration.h"
#include "decoration-layout-fixtures.h"
#include "workspace.h"
#include "data-device.h"
#include "input-method.h"
#include "shortcut-control.h"
#include "session-lock.h"
#include "window-opacity.h"

#include <stdio.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
#include <sys/wait.h>
#include <string.h>
#include <time.h>
#include <drm_fourcc.h>
#include <linux/input-event-codes.h>
#include <wlr/backend.h>
#include <wlr/config.h>
#include <wlr/render/allocator.h>
#include <wlr/render/wlr_texture.h>
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

struct wlr_allocator *__real_wlr_allocator_autocreate(struct wlr_backend *backend, struct wlr_renderer *renderer);
struct wlr_allocator *__wrap_wlr_allocator_autocreate(struct wlr_backend *backend, struct wlr_renderer *renderer);
#if WLR_HAS_GBM_ALLOCATOR
struct wlr_allocator *wlr_gbm_allocator_create(int fd);
#endif
struct wlr_allocator *__wrap_wlr_allocator_autocreate(struct wlr_backend *backend, struct wlr_renderer *renderer)
{
    const char *device = getenv("POLLY_FIXTURE_DRM_ALLOCATOR");
    if (!device) return __real_wlr_allocator_autocreate(backend, renderer);
#if WLR_HAS_GBM_ALLOCATOR
    if (strncmp(device, "/dev/dri/card", 13) || !device[13] || strspn(device + 13, "0123456789") != strlen(device + 13)) {
        fputs("FAIL: fixture allocator requires an explicit DRM primary node\n", stderr);
        return NULL;
    }
    int fd = open(device, O_RDWR | O_CLOEXEC);
    if (fd < 0) { perror("fixture DRM allocator"); return NULL; }
    struct wlr_allocator *allocator = wlr_gbm_allocator_create(fd);
    if (!allocator) {
        fputs("FAIL: fixture GBM allocator unavailable\n", stderr);
        return NULL;
    }
    puts("FIXTURE: explicit DRM-backed GBM for headless native GLES acceptance, not KMS scanout");
    return allocator;
#else
    (void)backend; (void)renderer;
    fputs("FAIL: fixture SDK does not contain GBM\n", stderr);
    return NULL;
#endif
}

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
            view->toplevel->app_id && !strcmp(view->toplevel->app_id, "org.pollyui.settings")) return view;
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

static struct PuDesktopView *ordinary_fixture_view(struct wl_client *client, const char *app_id, const char *title);

static bool fixture_client_color(struct wl_client *client, int x, int y, uint32_t expected)
{
    struct PuDesktopView *view = ordinary_fixture_view(client, "org.pollyui.files-window-fixture", "Files");
    if (!view) return false;
    struct wlr_surface *surface = view->toplevel->base->surface;
    if (x < 0 || y < 0 || x >= surface->current.width || y >= surface->current.height ||
        surface->current.buffer_width != surface->current.width || !surface->buffer) return false;
    void *pixels; uint32_t format, color = 0; size_t stride;
    struct wlr_buffer *buffer = surface->buffer->source;
    if (!wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &pixels, &format, &stride))
        return false;
    memcpy(&color, (char *)pixels + y * stride + x * 4, sizeof(color));
    wlr_buffer_end_data_ptr_access(buffer);
    return (format == DRM_FORMAT_XRGB8888 || format == DRM_FORMAT_ARGB8888) &&
        (color & 0xffffff) == expected;
}

static bool wait_client_color(struct wl_client *client, int x, int y, uint32_t expected)
{
    for (int i = 0; i < 1000; i++) {
        CHECK(pump());
        if (fixture_client_color(client, x, y, expected)) return true;
    }
    fprintf(stderr, "Native pointer fixture did not render expected color %06x\n", expected);
    return false;
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
        char marker_title[256];
        strcpy(marker_title, request);
        const char *digits = request + prefix_length;
        CHECK(*digits >= '0' && *digits <= '9');
        char *end;
        errno = 0;
        unsigned long parsed = strtoul(digits, &end, 10);
        CHECK(!errno && parsed > 0 && parsed <= UINT_MAX && *end == '.');
        unsigned sequence = (unsigned)parsed;
        if (sequence <= *last) continue;
        char *action = end + 1;
        int restore_x = focus_x, restore_y = focus_y, restore_used = 0;
        char *restore = strstr(action, " focus ");
        if (restore) {
            CHECK(!strcmp(app_id, "org.pollyui.files-window-fixture"));
            CHECK(sscanf(restore, " focus %d %d%n", &restore_x, &restore_y, &restore_used) == 2 &&
                !restore[restore_used]);
            *restore = '\0';
        }
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
            CHECK(restore_x >= 0 && restore_y >= 0 && restore_x < view->toplevel->base->geometry.width &&
                restore_y < view->toplevel->base->geometry.height);
            // The app reports a real neutral padding point, including inside an open context menu.
            fixture_pointer_click(sx + restore_x, sy + restore_y, *time += 3, 0);
            continue; // No pointer is retained across the next event-loop settle.
        }
        int x, y, delta, used = 0, end_x, end_y, code = 0, modifiers = 0;
        bool context_click = sscanf(action, "context %d %d%n", &x, &y, &used) == 2 && !action[used];
        bool double_click = !strcmp(app_id, "org.pollyui.files-window-fixture") &&
            sscanf(action, "doubleclick %d %d%n", &x, &y, &used) == 2 && !action[used];
        bool gesture = !strcmp(app_id, "org.pollyui.files-window-fixture") &&
            sscanf(action, "gesture %d %d %d %d%n", &x, &y, &end_x, &end_y, &used) == 4 && !action[used];
        bool press = !strcmp(app_id, "org.pollyui.files-window-fixture") &&
            sscanf(action, "press %d %d%n", &x, &y, &used) == 2 && !action[used];
        bool press_key = !strcmp(app_id, "org.pollyui.files-window-fixture") &&
            sscanf(action, "presskey %d %d %d %d%n", &x, &y, &code, &modifiers, &used) == 4 && !action[used];
        bool press_focus = !strcmp(app_id, "org.pollyui.files-window-fixture") &&
            sscanf(action, "pressfocus %d %d%n", &x, &y, &used) == 2 && !action[used];
        bool press_close = !strcmp(app_id, "org.pollyui.files-window-fixture") &&
            sscanf(action, "pressclose %d %d%n", &x, &y, &used) == 2 && !action[used];
        if (gesture || press || press_key || press_focus || press_close) {
            int width = view->toplevel->base->geometry.width, height = view->toplevel->base->geometry.height;
            CHECK(x >= 0 && y >= 0 && x < width && y < height);
            if (gesture) CHECK(end_x >= -64 && end_y >= -64 && end_x <= width + 64 && end_y <= height + 64);
            *last = sequence;
            fixture_pointer_motion(sx + x, sy + y, ++*time);
            struct wlr_pointer_button_event button = { .pointer = &pointer, .time_msec = ++*time,
                .button = BTN_LEFT, .state = WL_POINTER_BUTTON_STATE_PRESSED };
            wlr_pointer_notify_button(&pointer, &button);
            wl_signal_emit_mutable(&pointer.events.frame, NULL);
            CHECK(wait_client_color(client, x, y, 0xc04020));
            if (gesture) {
                fixture_pointer_motion(sx + end_x, sy + end_y, ++*time);
                CHECK(wait_client_color(client, x, y, 0x20c040));
                button.time_msec = ++*time; button.state = WL_POINTER_BUTTON_STATE_RELEASED;
                wlr_pointer_notify_button(&pointer, &button);
                wl_signal_emit_mutable(&pointer.events.frame, NULL);
                CHECK(wait_client_color(client, x, y, 0x3060c0));
            } else if (press_key || press_focus) {
                if (press_key) {
                    CHECK(code > 0 && code <= KEY_MAX && modifiers >= 0 && modifiers <= 15);
                    fixture_keyboard((unsigned)code, (unsigned)modifiers, time);
                } else {
                    // Actual Wayland keyboard deactivation while the native button grab is live.
                    struct PuDesktopView *focus = ordinary_fixture_view(client, app_id, marker_title);
                    CHECK(focus && focus->workspace_window);
                    pu_desktop_focus_mapped(&desktop, focus->workspace_window);
                }
                CHECK(wait_client_color(client, x, y, 0x3060c0));
                button.time_msec = ++*time; button.state = WL_POINTER_BUTTON_STATE_RELEASED;
                wlr_pointer_notify_button(&pointer, &button);
                wl_signal_emit_mutable(&pointer.events.frame, NULL);
            } else if (press_close) {
                struct PuDesktopView *closing = ordinary_fixture_view(client, app_id, title);
                CHECK(closing);
                wlr_xdg_toplevel_send_close(closing->toplevel);
            }
        } else if (context_click || double_click || (sscanf(action, "click %d %d%n", &x, &y, &used) == 2 && !action[used])) {
            CHECK(x >= 0 && y >= 0 && x < view->toplevel->base->geometry.width &&
                y < view->toplevel->base->geometry.height);
            *last = sequence;
            fixture_pointer_motion(sx + x, sy + y, ++*time);
            CHECK(desktop.seat->pointer_state.focused_surface == view->toplevel->base->surface);
            fixture_pointer_click(sx + x, sy + y, *time += 3, context_click ? 2 : 0);
            if (double_click) fixture_pointer_click(sx + x, sy + y, *time += 3, 0);
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
            else if (!strcmp(app_id, "org.pollyui.files-window-fixture") &&
                !strcmp(action + 4, "backspace")) code = KEY_BACKSPACE;
            else if (!strcmp(app_id, "org.pollyui.files-window-fixture") &&
                !strcmp(action + 4, "f2")) code = KEY_F2;
            else if (!strcmp(app_id, "org.pollyui.files-window-fixture") &&
                !strcmp(action + 4, "f5")) code = KEY_F5;
            else CHECK(false);
            CHECK(desktop.seat->keyboard_state.focused_surface == view->toplevel->base->surface);
            *last = sequence;
            fixture_keyboard(code, modifiers, time);
        } else if (!strcmp(app_id, "org.pollyui.files-window-fixture") &&
            sscanf(action, "keycode %d %d%n", &x, &y, &used) == 2 && !action[used]) {
            CHECK(x > 0 && x <= KEY_MAX && y >= 0 && y <= 15);
            CHECK(desktop.seat->keyboard_state.focused_surface == view->toplevel->base->surface);
            *last = sequence;
            fixture_keyboard((unsigned)x, (unsigned)y, time);
        } else if (!strcmp(app_id, "org.pollyui.files-window-fixture") &&
            sscanf(action, "keys %d %d %d%n", &x, &y, &delta, &used) == 3 && !action[used]) {
            CHECK(x > 0 && x <= KEY_MAX && y >= 0 && y <= 15 && delta > 0 && delta <= 32);
            CHECK(desktop.seat->keyboard_state.focused_surface == view->toplevel->base->surface);
            *last = sequence;
            for (int at = 0; at < delta; at++) fixture_keyboard((unsigned)x, (unsigned)y, time);
        } else if (!strcmp(action, "close")) {
            *last = sequence;
            wlr_xdg_toplevel_send_close(view->toplevel);
        } else CHECK(false);
        // Native actions can retire either window; resolve the copied marker title again.
        acknowledge_ordinary_fixture_marker(pid, app_id, marker_title);
    }
    return true;
}

struct SettingsLifetimeState {
    bool settings_mapped, settings_ready, survivor_mapped_alive, survivor_geometry_pending;
};

static bool settings_lifetime_matches(bool open, struct SettingsLifetimeState state)
{
    // Pending geometry is diagnostic for an idle observer, not evidence that its process/window died.
    return state.survivor_mapped_alive &&
        (open ? state.settings_mapped && state.settings_ready : !state.settings_mapped);
}

static bool settings_lifetime_policy(void)
{
    CHECK(settings_lifetime_matches(false, (struct SettingsLifetimeState){ false, false, true, true }));
    CHECK(!settings_lifetime_matches(false, (struct SettingsLifetimeState){ true, false, true, true }));
    CHECK(settings_lifetime_matches(true, (struct SettingsLifetimeState){ true, true, true, true }));
    CHECK(!settings_lifetime_matches(true, (struct SettingsLifetimeState){ true, false, true, false }));
    CHECK(!settings_lifetime_matches(false, (struct SettingsLifetimeState){ false, false, false, false }));
    CHECK(!settings_lifetime_matches(true, (struct SettingsLifetimeState){ true, true, false, false }));
    CHECK(!settings_lifetime_matches(true, (struct SettingsLifetimeState){ false, true, true, false }));
    puts("PASS: Settings lifetime distinguishes mapped/alive observers from coordinate-ready input targets");
    return true;
}

static bool capture_caption_output(struct PuDesktopView *view)
{
    const char *path = getenv("POLLY_CAPTION_EVIDENCE");
    if (!path || !*path) return true;
    struct wlr_box output_box, inset = { .width = 1280, .height = 720 }, close;
    int vx, vy;
    wlr_output_layout_get_box(desktop.layout, view->output, &output_box);
    pu_decoration_inset(view, &inset, false);
    CHECK(wlr_scene_node_coords(&view->tree->node, &vx, &vy));
    CHECK(pu_decoration_button_box(view, PU_DECORATION_CLOSE, &close));
    printf("CAPTION_NATIVE_GEOMETRY {\"client\":[%d,%d,%d,%d],\"border\":%d,\"title\":%d,"
        "\"scale\":%.9g,\"close\":[%d,%d,%d,%d]}\n",
        vx - output_box.x, vy - output_box.y, view->toplevel->base->geometry.width,
        view->toplevel->base->geometry.height, inset.x, inset.y, view->output->scale,
        close.x, close.y, close.width, close.height);
    struct wlr_scene_output *output = wlr_scene_get_scene_output(desktop.scene, view->output);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_lock_attach_render(view->output, true);
    CHECK(wlr_scene_output_build_state(output, &state, NULL) && state.buffer);
    void *pixels; uint32_t format; size_t stride;
    CHECK(wlr_buffer_begin_data_ptr_access(state.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ,
        &pixels, &format, &stride));
    CHECK(format == DRM_FORMAT_ARGB8888 || format == DRM_FORMAT_XRGB8888);
    FILE *file = fopen(path, "wb");
    CHECK(file);
    bool written = fprintf(file, "P6\n%d %d\n255\n", state.buffer->width, state.buffer->height) > 0;
    for (int y = 0; y < state.buffer->height && written; y++)
        for (int x = 0; x < state.buffer->width && written; x++) {
            uint32_t pixel; unsigned char rgb[3];
            memcpy(&pixel, (char *)pixels + (size_t)y * stride + (size_t)x * 4, sizeof(pixel));
            rgb[0] = pixel >> 16; rgb[1] = pixel >> 8; rgb[2] = pixel;
            written = fwrite(rgb, 1, 3, file) == 3;
        }
    written = fclose(file) == 0 && written;
    wlr_buffer_end_data_ptr_access(state.buffer);
    wlr_output_state_finish(&state);
    wlr_output_lock_attach_render(view->output, false);
    CHECK(written);
    printf("CAPTION_NATIVE_OUTPUT: %s\n", path);
    return true;
}

static struct PuDesktopLayer *preview_layer(void)
{
    struct PuDesktopLayer *layer;
    wl_list_for_each(layer, &desktop.layers, link)
        if (layer->presented && layer->surface->surface->mapped &&
            !strncmp(layer->surface->namespace, "PollyShell.switcher.", 20)) return layer;
    return NULL;
}

static struct wlr_scene_tree *preview_tree(struct PuDesktopLayer *layer)
{
    if (!layer) return NULL;
    struct wlr_scene_node *node;
    wl_list_for_each(node, &layer->tree->children, link) {
        if (node->type != WLR_SCENE_NODE_TREE) continue;
        struct wlr_scene_tree *tree = wlr_scene_tree_from_node(node);
        if (tree != layer->content && tree != layer->popups) return tree;
    }
    return NULL;
}

static struct wlr_scene_buffer *preview_image(struct PuDesktopLayer *layer, unsigned index)
{
    struct wlr_scene_tree *tree = preview_tree(layer);
    if (!tree) return NULL;
    struct wlr_scene_node *node;
    wl_list_for_each(node, &tree->children, link) {
        if (node->type != WLR_SCENE_NODE_BUFFER) continue;
        if (!index--) return wlr_scene_buffer_from_node(node);
    }
    return NULL;
}

static struct wlr_scene_buffer *projection_image(struct PuDesktopLayer *layer)
{
    struct wlr_scene_tree *tree = preview_tree(layer);
    if (!tree) return NULL;
    struct wlr_scene_buffer *image = NULL;
    struct wlr_scene_node *node;
    wl_list_for_each(node, &tree->children, link)
        if (node->enabled && node->type == WLR_SCENE_NODE_BUFFER) image = wlr_scene_buffer_from_node(node);
    return image;
}

static bool preview_overlay_ready(struct PuDesktopLayer *layer)
{
    struct wlr_scene_buffer *image = preview_image(layer, 0);
    if (!image) return false;
    struct wlr_surface *surface = layer->surface->surface;
    struct wlr_buffer *source = surface->buffer ? surface->buffer->source : NULL;
    if (!source || surface->current.width < 1 || surface->current.height < 1) return false;
    int ix, iy, lx, ly;
    if (!wlr_scene_node_coords(&image->node, &ix, &iy) ||
        !wlr_scene_node_coords(&layer->tree->node, &lx, &ly)) return false;
    int x = (ix - lx + image->dst_width / 2) * source->width / surface->current.width;
    int y = (iy - ly + image->dst_height / 2) * source->height / surface->current.height;
    if (x < 0 || y < 0 || x >= source->width || y >= source->height) return false;
    void *data;
    uint32_t format, value;
    size_t stride;
    if (!wlr_buffer_begin_data_ptr_access(source, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride))
        return false;
    memcpy(&value, (char *)data + (size_t)y * stride + (size_t)x * 4, sizeof(value));
    unsigned opaque = 0;
    int top = 8 * source->height / surface->current.height;
    int bottom = 44 * source->height / surface->current.height;
    if (bottom > source->height) bottom = source->height;
    for (int py = top; py < bottom; py++) for (int px = 8; px < source->width - 8; px++) {
        uint32_t header;
        memcpy(&header, (char *)data + (size_t)py * stride + (size_t)px * 4, sizeof(header));
        opaque += (header >> 24) == 255;
    }
    wlr_buffer_end_data_ptr_access(source);
    return format == DRM_FORMAT_ARGB8888 && (value >> 24) == 0 && opaque > 100;
}

static bool preview_capture(struct PuDesktopLayer *layer, struct wlr_output_state *state)
{
    struct wlr_output *output = layer->surface->output;
    wlr_output_state_init(state);
    wlr_output_lock_attach_render(output, true);
    bool built = wlr_scene_output_build_state(wlr_scene_get_scene_output(desktop.scene, output), state, NULL);
    wlr_output_lock_attach_render(output, false);
    return built && state->buffer;
}

static bool wallpaper_pixels(struct PuDesktopLayer *layer, uint64_t *hash)
{
    struct wlr_output_state state;
    CHECK(preview_capture(layer, &state));
    void *data;
    uint32_t format;
    size_t stride;
    CHECK(wlr_buffer_begin_data_ptr_access(state.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride));
    bool supported = format == DRM_FORMAT_ARGB8888 || format == DRM_FORMAT_XRGB8888;
    *hash = UINT64_C(14695981039346656037);
    if (supported) for (int y = 0; y < 32; y++) for (int x = 0; x < 32; x++) {
        uint32_t pixel;
        int sx = state.buffer->width / 4 + x * state.buffer->width / 64;
        int sy = state.buffer->height / 4 + y * state.buffer->height / 64;
        memcpy(&pixel, (char *)data + (size_t)sy * stride + (size_t)sx * 4, sizeof(pixel));
        *hash = (*hash ^ (pixel & 0xffffff)) * UINT64_C(1099511628211);
    }
    wlr_buffer_end_data_ptr_access(state.buffer);
    wlr_output_state_finish(&state);
    CHECK(supported);
    return true;
}

static uint32_t *fixture_read_pixels(struct wlr_renderer *renderer, struct wlr_buffer *buffer)
{
    if (!buffer || buffer->width < 1 || buffer->height < 1 ||
        (uint64_t)buffer->width * buffer->height > WLR_SCENE_EFFECTS_MAX_PIXELS) return NULL;
    uint32_t *pixels = malloc((size_t)buffer->width * buffer->height * 4);
    struct wlr_texture *texture = pixels ? wlr_texture_from_buffer(renderer, buffer) : NULL;
    bool read = texture && wlr_texture_read_pixels(texture, &(struct wlr_texture_read_pixels_options){
        .data = pixels, .format = DRM_FORMAT_ARGB8888, .stride = (uint32_t)buffer->width * 4 });
    if (texture) wlr_texture_destroy(texture);
    if (!read) { free(pixels); return NULL; }
    return pixels;
}

static bool projection_capture_ready(struct PuDesktopLayer *layer, unsigned color)
{
    if (!layer || !layer->surface->surface->buffer) return false;
    struct wlr_scene_buffer *image = projection_image(layer);
    if (!image || !image->buffer) return false;
    struct wlr_buffer *gui = layer->surface->surface->buffer->source;
    uint32_t *overlay = fixture_read_pixels(desktop.renderer, gui);
    if (!overlay) return false;
    int x = (image->node.x + image->dst_width / 2) * gui->width / layer->surface->surface->current.width;
    int y = (image->node.y + image->dst_height / 2) * gui->height / layer->surface->surface->current.height;
    bool clear = x >= 0 && y >= 0 && x < gui->width && y < gui->height && (overlay[y * gui->width + x] >> 24) == 0;
    free(overlay);
    if (!clear) return false;
    struct wlr_output_state state;
    if (!preview_capture(layer, &state)) { wlr_output_state_finish(&state); return false; }
    uint32_t *pixels = fixture_read_pixels(desktop.renderer, state.buffer);
    unsigned count = 0;
    int lx, ly;
    struct wlr_box output_box;
    wlr_output_layout_get_box(desktop.layout, layer->surface->output, &output_box);
    bool positioned = wlr_scene_node_coords(&layer->tree->node, &lx, &ly);
    float scale = layer->surface->output->scale;
    int left = (int)lroundf((lx + image->node.x - output_box.x) * scale);
    int top = (int)lroundf((ly + image->node.y - output_box.y) * scale);
    int right = left + (int)lroundf(image->dst_width * scale);
    int bottom = top + (int)lroundf(image->dst_height * scale);
    if (pixels && positioned) for (int py = top; py < bottom; py++) for (int px = left; px < right; px++)
        if (py >= 0 && px >= 0 && py < state.buffer->height && px < state.buffer->width &&
            (pixels[py * state.buffer->width + px] & 0xffffff) == color) count++;
    free(pixels);
    wlr_output_state_finish(&state);
    return count > 1000;
}

static bool preview_save(struct PuDesktopLayer *layer, const char *mode, unsigned sequence)
{
    const char *prefix = getenv("POLLY_PREVIEW_EVIDENCE");
    if (!prefix) return true;
    char path[4096];
    int length = sequence == 1 ? snprintf(path, sizeof(path), "%s-%s.ppm", prefix, mode) :
        snprintf(path, sizeof(path), "%s-%s-%u.ppm", prefix, mode, sequence);
    CHECK(length >= 0 && length < (int)sizeof(path));
    struct wlr_output_state state;
    CHECK(preview_capture(layer, &state));
    uint32_t *data = fixture_read_pixels(desktop.renderer, state.buffer);
    CHECK(data);
    FILE *file = fopen(path, "wb");
    CHECK(file);
    CHECK(fprintf(file, "P6\n%d %d\n255\n", state.buffer->width, state.buffer->height) > 0);
    for (int y = 0; y < state.buffer->height; y++) for (int x = 0; x < state.buffer->width; x++) {
        uint32_t pixel;
        pixel = data[(size_t)y * state.buffer->width + x];
        const unsigned char rgb[] = {pixel >> 16 & 255, pixel >> 8 & 255, pixel & 255};
        CHECK(fwrite(rgb, sizeof(rgb), 1, file) == 1);
    }
    CHECK(fclose(file) == 0);
    free(data);
    wlr_output_state_finish(&state);
    return true;
}

static bool preview_color(struct PuDesktopLayer *layer, unsigned index, uint32_t expected)
{
    struct wlr_scene_buffer *image = preview_image(layer, index);
    if (!image || !image->buffer) return false;
    void *data;
    uint32_t format;
    size_t stride;
    if (!wlr_buffer_begin_data_ptr_access(image->buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ,
        &data, &format, &stride)) return false;
    unsigned colored = 0;
    if (format == DRM_FORMAT_ARGB8888) {
        for (int y = 0; y < image->buffer->height; y++) for (int x = 0; x < image->buffer->width; x++) {
            uint32_t value;
            memcpy(&value, (char *)data + (size_t)y * stride + (size_t)x * 4, sizeof(value));
            colored += (value >> 24) == 255 && (value & 0xffffff) == expected;
        }
    }
    wlr_buffer_end_data_ptr_access(image->buffer);
    if (colored < 100) return false;
    struct wlr_output *output = layer->surface->output;
    struct wlr_box bounds;
    wlr_output_layout_get_box(desktop.layout, output, &bounds);
    int nx, ny;
    if (!wlr_scene_node_coords(&image->node, &nx, &ny)) return false;
    int x = (int)((nx - bounds.x + image->dst_width / 2) * output->scale);
    int y = (int)((ny - bounds.y + image->dst_height / 2) * output->scale);
    struct wlr_output_state state;
    bool built = preview_capture(layer, &state);
    bool matches = false;
    if (built && state.buffer && x >= 0 && y >= 0 && x < state.buffer->width && y < state.buffer->height &&
        wlr_buffer_begin_data_ptr_access(state.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride)) {
        uint32_t value;
        memcpy(&value, (char *)data + (size_t)y * stride + (size_t)x * 4, sizeof(value));
        matches = (format == DRM_FORMAT_ARGB8888 || format == DRM_FORMAT_XRGB8888) &&
            (value & 0xffffff) == expected;
        wlr_buffer_end_data_ptr_access(state.buffer);
    }
    wlr_output_state_finish(&state);
    return matches;
}

static bool window_suite(char *executable, char *script, char *mode)
{
    char *args[] = { executable, "--desktop", "--no-legacy-storage", "--app-id", "org.pollyui.window-shell",
        script, mode, executable, script, getenv("POLLY_VIDEO_TEST_FILES"), NULL };
    CHECK(pu_desktop_spawn_shell(&desktop, args));
    pid_t settings_shell_identity = desktop.shell_pid;
    bool success = false, crashed = false;
    bool fixture_lock_started = false;
    struct wlr_output *wallpaper_disabled_output = NULL;
    char disabled_wallpaper_target[96] = "";
    unsigned preview_capture_sequence = 0;
    struct wlr_output *cube_capture_output = NULL;
    struct wlr_box placement_boxes[3] = {{0}};
    unsigned settings_sequence = 0;
    unsigned file_dialog_sequence = 0;
    unsigned files_sequence = 0;
    uint32_t settings_time = 70000;
    unsigned settings_state_sequence = 0;
    pid_t settings_survivor_identity = 0;
    char settings_state_previous[1024] = "";
    bool settings_suite = strstr(script, "settings-") != NULL || strstr(script, "files-window") != NULL;
    struct timespec started;
    CHECK(clock_gettime(CLOCK_MONOTONIC, &started) == 0);
    for (int i = 0; desktop.shell_pid && (settings_suite || i < 16000); i++) {
        if (settings_suite) {
            struct timespec now;
            CHECK(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
            if (now.tv_sec - started.tv_sec >= 240) {
                fprintf(stderr, "FAIL: Native interactive fixture exceeded its 240-second deadline\n");
                break;
            }
        }
        CHECK(pump());
        CHECK(ordinary_fixture_requests("org.pollyui.file-dialog-window", "PollyUI.FileText",
            "FileDialogFixture.", 10, 10, &file_dialog_sequence, &settings_time));
        CHECK(ordinary_fixture_requests("org.pollyui.files-window-fixture", "Files",
            "FilesFixture.", 6, 6, &files_sequence, &settings_time));
        struct PuDesktopLayer *marker, *tmp;
        wl_list_for_each_safe(marker, tmp, &desktop.layers, link) {
            if (!marker->surface->surface->mapped) continue;
            const char *name = marker->surface->namespace;
            unsigned cube_color;
            if (sscanf(name, "fixture-cube-ready %x", &cube_color) == 1) {
                CHECK(pu_workspace_cube_active(&desktop));
                bool seen = false;
                struct PuDesktopLayer *layer;
                wl_list_for_each(layer, &desktop.layers, link) {
                    if (strncmp(layer->surface->namespace, "PollyShell.wallpaper.", 21) || !layer->presented) continue;
                    struct wlr_output_state state;
                    CHECK(preview_capture(layer, &state));
                    uint32_t *pixels = fixture_read_pixels(desktop.renderer, state.buffer);
                    unsigned count = 0;
                    if (pixels) for (int y = 0; y < state.buffer->height; y++)
                        for (int x = 0; x < state.buffer->width; x++)
                            count += (pixels[y * state.buffer->width + x] & 0xffffff) == cube_color;
                    free(pixels);
                    wlr_output_state_finish(&state);
                    if (count > 1000) {
                        cube_capture_output = layer->surface->output;
                        CHECK(preview_save(layer, mode, ++preview_capture_sequence));
                        seen = true; break;
                    }
                }
                if (!seen) continue;
                printf("CUBE_PIXELS: actual workspace source color=%06x is composed in the native cube\n", cube_color);
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (!strcmp(name, "fixture-cube-pointer")) {
                CHECK(cube_capture_output && pu_workspace_cube_active(&desktop));
                struct wlr_box bounds;
                wlr_output_layout_get_box(desktop.layout, cube_capture_output, &bounds);
                fixture_pointer_click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2,
                    settings_time += 3, 0);
                CHECK(!pu_workspace_cube_active(&desktop));
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (!strcmp(name, "fixture-cube-transition")) {
                CHECK(cube_capture_output && pu_workspace_cube_active(&desktop));
                struct PuDesktopLayer *target = NULL, *layer;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (layer->surface->output == cube_capture_output &&
                        !strncmp(layer->surface->namespace, "PollyShell.wallpaper.", 21)) target = layer;
                CHECK(target);
                fixture_keyboard(KEY_RIGHT, 0, &settings_time);
                bool both = false;
                for (unsigned attempt = 0; attempt < 80 && !both; attempt++) {
                    CHECK(pump());
                    struct wlr_output_state state;
                    CHECK(preview_capture(target, &state));
                    uint32_t *pixels = fixture_read_pixels(desktop.renderer, state.buffer);
                    unsigned green = 0, blue = 0;
                    if (pixels) for (int y = 0; y < state.buffer->height; y++)
                        for (int x = 0; x < state.buffer->width; x++) {
                            uint32_t color = pixels[y * state.buffer->width + x] & 0xffffff;
                            green += color == 0x00ff00; blue += color == 0x0000ff;
                        }
                    free(pixels);
                    wlr_output_state_finish(&state);
                    both = green > 500 && blue > 500;
                    if (both) CHECK(preview_save(target, "cube-transition", ++preview_capture_sequence));
                }
                CHECK(both);
                puts("CUBE_ROTATION: two real neighboring workspace sources are visible together during native rotation");
                wlr_layer_surface_v1_destroy(marker->surface);
                break;
            }
            if (!strcmp(name, "fixture-cube-idle")) {
                CHECK(pu_workspace_cube_active(&desktop));
                struct wlr_scene_buffer *image = NULL;
                struct wlr_scene_node *node;
                wl_list_for_each(node, &desktop.scene->tree.children, link) {
                    if (node->type != WLR_SCENE_NODE_TREE || !node->enabled) continue;
                    struct wlr_scene_tree *tree = wlr_scene_tree_from_node(node);
                    if (wl_list_length(&tree->children) != 1) continue;
                    struct wlr_scene_node *child = wl_container_of(tree->children.next, child, link);
                    if (child->type != WLR_SCENE_NODE_BUFFER) continue;
                    struct wlr_scene_buffer *buffer = wlr_scene_buffer_from_node(child);
                    if (buffer->point_accepts_input && buffer->buffer) image = buffer;
                }
                CHECK(image);
                struct wlr_buffer *held = wlr_buffer_lock(image->buffer);
                for (unsigned attempt = 0; attempt < 150; attempt++) CHECK(pump());
                CHECK(pu_workspace_cube_active(&desktop) && image->buffer == held);
                wlr_buffer_unlock(held);
                puts("CUBE_IDLE: native cube retains its immutable frame without idle recomposition");
                wlr_layer_surface_v1_destroy(marker->surface);
                break;
            }
            if (!strcmp(name, "fixture-video-live") || !strcmp(name, "fixture-video-still")) {
                struct PuDesktopLayer *layer, *wallpaper = NULL;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (!strncmp(layer->surface->namespace, "PollyShell.wallpaper.", 21) && layer->presented)
                        wallpaper = layer;
                if (!wallpaper) continue;
                bool live_video = !strcmp(name, "fixture-video-live");
                unsigned seen = 0, first = 0;
                bool sampled = false, stable = true;
                for (unsigned attempt = 0; attempt < (live_video ? 700u : 80u); attempt++) {
                    CHECK(pump());
                    struct wlr_output_state state;
                    CHECK(preview_capture(wallpaper, &state));
                    uint32_t *pixels = fixture_read_pixels(desktop.renderer, state.buffer);
                    CHECK(pixels);
                    uint32_t color = pixels[(state.buffer->height / 2) * state.buffer->width + state.buffer->width / 2] & 0xffffff;
                    free(pixels);
                    wlr_output_state_finish(&state);
                    if (!sampled) { first = color; sampled = true; }
                    stable &= first == color;
                    unsigned red = color >> 16, green = color >> 8 & 255, blue = color & 255;
                    if (red > 100 && green < 20 && blue < 20) seen |= 1;
                    if (green > 100 && red < 20 && blue < 20) seen |= 2;
                    if (blue > 100 && red < 20 && green < 20) seen |= 4;
                    if (live_video && seen == 7) break;
                }
                CHECK(live_video ? seen == 7 : stable && sampled);
                CHECK(preview_save(wallpaper, mode, ++preview_capture_sequence));
                puts(live_video ? "VIDEO_NATIVE: actual composed red/green/blue frames, no JavaScript pixel transport" :
                    "VIDEO_NATIVE: actual composed paused frame remains stable");
                wlr_layer_surface_v1_destroy(marker->surface);
                break;
            }
            if (!strcmp(name, "fixture-video-remove-output") || !strcmp(name, "fixture-cube-remove-output")) {
                struct PuDesktopLayer *layer;
                struct wlr_output *output = NULL;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (!strncmp(layer->surface->namespace, "PollyShell.wallpaper.", 21))
                        output = layer->surface->output;
                CHECK(output && desktop.output_count >= 2);
                wlr_layer_surface_v1_destroy(marker->surface);
                wlr_output_destroy(output);
                break;
            }
            int companion_x, companion_y;
            bool companion_pixels = sscanf(name, "fixture-companion-pixels %d %d", &companion_x, &companion_y) == 2;
            bool companion_through = !companion_pixels &&
                sscanf(name, "fixture-companion-through %d %d", &companion_x, &companion_y) == 2;
            if (companion_pixels || companion_through) {
                struct PuDesktopLayer *layer, *actor = NULL;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (!strncmp(layer->surface->namespace, "PollyShell.companion.", 21) &&
                        layer->surface->surface->mapped && layer->presented) actor = layer;
                if (!actor) continue;
                struct wlr_surface *surface = actor->surface->surface;
                CHECK(actor->surface->current.keyboard_interactive == ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE);
                if (companion_through) {
                    CHECK(!pixman_region32_contains_point(&surface->input_region, companion_x, companion_y, NULL));
                    struct wlr_surface *focus = desktop.seat->keyboard_state.focused_surface;
                    int x, y;
                    CHECK(wlr_scene_node_coords(&actor->tree->node, &x, &y));
                    fixture_pointer_click(x + companion_x, y + companion_y, 85000, 0);
                    CHECK(desktop.seat->pointer_state.focused_surface &&
                        desktop.seat->pointer_state.focused_surface != surface);
                    CHECK(desktop.seat->keyboard_state.focused_surface == focus);
                    puts("COMPANION_NATIVE: transparent pixel sends actual pointer input through without taking keyboard focus");
                } else {
                    uint32_t *pixels = fixture_read_pixels(desktop.renderer, surface->buffer->source);
                    CHECK(pixels);
                    unsigned visible = 0, mismatch = 0;
                    struct wlr_buffer *buffer = surface->buffer->source;
                    for (int y = 0; y < 96; y++) for (int x = 0; x < 96; x++) {
                        int lx = companion_x + x, ly = companion_y + y;
                        CHECK(lx >= 0 && ly >= 0 && lx < surface->current.width && ly < surface->current.height);
                        int px = (int)((lx + 0.5) * buffer->width / surface->current.width);
                        int py = (int)((ly + 0.5) * buffer->height / surface->current.height);
                        bool alpha = (pixels[py * buffer->width + px] >> 24) != 0;
                        bool input = pixman_region32_contains_point(&surface->input_region, lx, ly, NULL);
                        mismatch += alpha != input;
                        visible += alpha;
                    }
                    free(pixels);
                    if (visible < 1000) continue;
                    CHECK(mismatch == 0);
                    CHECK(preview_save(actor, mode, ++preview_capture_sequence));
                    printf("COMPANION_NATIVE: visible pixels=%u, exact transparent/input mismatches=0\n", visible);
                }
                wlr_layer_surface_v1_destroy(marker->surface);
                break;
            }
            if (!strcmp(name, "fixture-companion-closed")) {
                bool found = false;
                struct PuDesktopLayer *layer;
                wl_list_for_each(layer, &desktop.layers, link)
                    found |= !strncmp(layer->surface->namespace, "PollyShell.companion.", 21);
                if (found) continue;
                puts("COMPANION_NATIVE: owned overlay and input recipient retired");
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (!strcmp(name, "fixture-companion-remove-output")) {
                struct PuDesktopLayer *layer;
                struct wlr_output *output = NULL;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (!strncmp(layer->surface->namespace, "PollyShell.companion.", 21))
                        output = layer->surface->output;
                CHECK(output && desktop.output_count >= 2);
                wlr_layer_surface_v1_destroy(marker->surface);
                wlr_output_destroy(output);
                break;
            }
            if (!strcmp(name, "fixture-projection-transition") || !strcmp(name, "fixture-projection-idle")) {
                struct wlr_scene_buffer *image = projection_image(preview_layer());
                CHECK(image && image->buffer);
                struct wlr_buffer *held = wlr_buffer_lock(image->buffer);
                bool animated = !strcmp(name, "fixture-projection-transition");
                if (animated) {
                    struct wlr_keyboard_key_event event = { .time_msec = 80000, .keycode = KEY_TAB,
                        .state = WL_KEYBOARD_KEY_STATE_PRESSED, .update_state = true };
                    wlr_keyboard_notify_key(&keyboard, &event);
                    event.state = WL_KEYBOARD_KEY_STATE_RELEASED; event.time_msec++;
                    wlr_keyboard_notify_key(&keyboard, &event);
                }
                unsigned changes = 0;
                for (unsigned attempt = 0; attempt < 100; attempt++) {
                    CHECK(pump());
                    image = projection_image(preview_layer());
                    CHECK(image && image->buffer);
                    if (image->buffer != held) {
                        changes++;
                        wlr_buffer_unlock(held);
                        held = wlr_buffer_lock(image->buffer);
                    }
                }
                wlr_buffer_unlock(held);
                CHECK(animated ? changes >= 2 && changes <= 12 : changes == 0);
                printf("PROJECTION_CADENCE: %s frame changes=%u\n", animated ? "bounded transition" : "idle", changes);
                wlr_layer_surface_v1_destroy(marker->surface);
                break;
            }
            unsigned projection_color;
            if (!strcmp(name, "fixture-projection-stack")) {
                struct PuDesktopLayer *target = preview_layer();
                static bool diagnostic_saved;
                if (!diagnostic_saved && preview_tree(target)) {
                    CHECK(preview_save(target, "stack-diagnostic", ++preview_capture_sequence));
                    diagnostic_saved = true;
                }
                if (!projection_capture_ready(target, 0x00ff00) || !projection_capture_ready(target, 0x0000ff) ||
                    !(projection_capture_ready(target, 0xff0000) || projection_capture_ready(target, 0xff00ff))) continue;
                CHECK(preview_save(target, mode, ++preview_capture_sequence));
                puts("PROJECTION_NATIVE: all three actual source images are independently visible in the perspective stack");
                wlr_layer_surface_v1_destroy(marker->surface);
                break;
            }
            if (sscanf(name, "fixture-projection-ready %x", &projection_color) == 1) {
                CHECK(projection_color <= 0xffffff);
                struct PuDesktopLayer *target = preview_layer();
                if (!projection_capture_ready(target, projection_color)) continue;
                CHECK(preview_save(target, mode, ++preview_capture_sequence));
                printf("PROJECTION_NATIVE: native GLES stack is visible through actual GUI alpha; color=%06x\n", projection_color);
                wlr_layer_surface_v1_destroy(marker->surface);
                break;
            }
            unsigned moving;
            char wallpaper_target[96];
            if (sscanf(name, "fixture-wallpaper-frame %u %95s", &moving, wallpaper_target) == 2) {
                CHECK(moving <= 1);
                struct PuDesktopLayer *layer, *target = NULL;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (!strcmp(layer->surface->namespace, wallpaper_target) &&
                        layer->presented && layer->surface->surface->mapped) target = layer;
                if (!target) continue;
                uint64_t first, next;
                CHECK(wallpaper_pixels(target, &first));
                bool changed = false;
                for (unsigned attempt = 0; attempt < (moving ? 300u : 60u); attempt++) {
                    CHECK(pump());
                    CHECK(wallpaper_pixels(target, &next));
                    changed |= first != next;
                    if (moving && changed) break;
                }
                CHECK(changed == (moving == 1));
                CHECK(preview_save(target, moving ? "wallpaper-live" : "wallpaper-still", ++preview_capture_sequence));
                printf("WALLPAPER_NATIVE: actual composed central pixels are %s\n", moving ? "animated" : "stable");
                wlr_layer_surface_v1_destroy(marker->surface);
                break;
            }
            unsigned output_enabled;
            if (sscanf(name, "fixture-wallpaper-output %u %95s", &output_enabled, wallpaper_target) == 2) {
                CHECK(output_enabled <= 1);
                struct wlr_output *target = wallpaper_disabled_output;
                if (!output_enabled) {
                    CHECK(!target);
                    struct PuDesktopLayer *layer;
                    wl_list_for_each(layer, &desktop.layers, link)
                        if (!strcmp(layer->surface->namespace, wallpaper_target))
                            target = layer->surface->output;
                    strcpy(disabled_wallpaper_target, wallpaper_target);
                }
                CHECK(target && !strcmp(disabled_wallpaper_target, wallpaper_target));
                struct wlr_output_state state;
                wlr_output_state_init(&state);
                wlr_output_state_set_enabled(&state, output_enabled == 1);
                wlr_layer_surface_v1_destroy(marker->surface);
                CHECK(wlr_output_commit_state(target, &state));
                wlr_output_state_finish(&state);
                wallpaper_disabled_output = output_enabled ? NULL : target;
                break;
            }
            unsigned preview_count, preview_index;
            if (sscanf(name, "fixture-previews-ready %u", &preview_count) == 1) {
                CHECK(preview_count >= 1 && preview_count <= 9);
                struct PuDesktopLayer *layer = preview_layer();
                if (!preview_tree(layer)) continue;
                bool ready = true;
                for (unsigned index = 0; index < preview_count; index++) {
                    struct wlr_scene_buffer *image = preview_image(layer, index);
                    if (!image || !image->buffer) { ready = false; break; }
                    CHECK(image->buffer->width <= 1024 && image->buffer->height <= 640);
                    double x = 0, y = 0;
                    CHECK(image->point_accepts_input && !image->point_accepts_input(image, &x, &y));
                }
                if (!ready || !preview_overlay_ready(layer) ||
                    !(preview_color(layer, 0, 0x0000ff) || preview_color(layer, 0, 0x00ff00) ||
                    preview_color(layer, 0, 0xff0000) || preview_color(layer, 0, 0xff00ff))) continue;
                CHECK(wl_resource_get_client(layer->surface->surface->resource) == desktop.shell_client);
                CHECK(pixman_region32_contains_point(&layer->surface->surface->input_region,
                    layer->surface->surface->current.width / 2, layer->surface->surface->current.height / 2, NULL));
                printf("PREVIEW_NATIVE: %u owned actual window frames are visible through the real selector alpha holes; no preview-node input\n",
                    preview_count);
                CHECK(preview_save(layer, mode, ++preview_capture_sequence));
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (sscanf(name, "fixture-preview-live %u", &preview_index) == 1) {
                bool first = false, second = false;
                for (unsigned attempt = 0; attempt < 700 && !(first && second); attempt++) {
                    CHECK(pump());
                    struct PuDesktopLayer *layer = preview_layer();
                    first |= preview_color(layer, preview_index, 0xff0000);
                    second |= preview_color(layer, preview_index, 0xff00ff);
                }
                CHECK(first && second);
                puts("PREVIEW_LIVE: source window red/magenta commits reach the actual composed selector without a JS pixel channel");
                wlr_layer_surface_v1_destroy(marker->surface);
                break;
            }
            if (sscanf(name, "fixture-preview-idle %u", &preview_index) == 1) {
                struct wlr_scene_buffer *image = preview_image(preview_layer(), preview_index);
                CHECK(image && image->buffer);
                struct wlr_buffer *held = wlr_buffer_lock(image->buffer);
                for (unsigned attempt = 0; attempt < 100; attempt++) CHECK(pump());
                image = preview_image(preview_layer(), preview_index);
                CHECK(image && image->buffer == held);
                wlr_buffer_unlock(held);
                puts("PREVIEW_IDLE: unchanged source reuses the same owned frame while another source animates");
                wlr_layer_surface_v1_destroy(marker->surface);
                break;
            }
            if (!strcmp(name, "fixture-previews-closed")) {
                CHECK(!pu_shortcuts_switching(&desktop));
                if (preview_layer()) continue;
                puts("PREVIEW_CLOSED: selector and native preview recipients retired");
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            unsigned placement_height;
            if (sscanf(name, "fixture-placement-output-height %u", &placement_height) == 1) {
                CHECK(placement_height == 360 || placement_height == 720);
                struct wlr_output_layout_output *entry;
                wl_list_for_each(entry, &desktop.layout->outputs, link) {
                    struct wlr_box bounds;
                    wlr_output_layout_get_box(desktop.layout, entry->output, &bounds);
                    if (bounds.x || bounds.y) continue;
                    struct wlr_output_state state;
                    wlr_output_state_init(&state);
                    wlr_output_state_set_custom_mode(&state, 1280, (int)placement_height, 60000);
                    CHECK(wlr_output_commit_state(entry->output, &state));
                    wlr_output_state_finish(&state);
                    break;
                }
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            unsigned placement_slot, placement_mode;
            bool placement_save = !strncmp(name, "fixture-placement-save ", 23);
            if (sscanf(name, placement_save ? "fixture-placement-save %u %u" : "fixture-placement-check %u %u",
                    &placement_slot, &placement_mode) == 2) {
                CHECK(placement_slot < 3);
                struct PuDesktopView *view = NULL, *item;
                wl_list_for_each(item, &desktop.views, link)
                    if (item->mapped && !item->geometry_pending && item->toplevel->app_id &&
                        !strcmp(item->toplevel->app_id, "org.pollyui.window-fixture")) view = item;
                if (!view) continue;
                CHECK((unsigned)view->mode == placement_mode && pu_decoration_ready(view));
                struct wlr_box box = view->presented_box;
                box.x = view->tree->node.x; box.y = view->tree->node.y;
                if (placement_save) placement_boxes[placement_slot] = box;
                else CHECK(wlr_box_equal(&placement_boxes[placement_slot], &box));
                printf("PLACEMENT_NATIVE %s slot=%u mode=%u box=%d,%d,%d,%d configure=%u pending=%u\n",
                    placement_save ? "save" : "check", placement_slot, placement_mode,
                    box.x, box.y, box.width, box.height, view->geometry_serial, view->geometry_pending);
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (!strcmp(name, "fixture-placement-menu-ready")) {
                if (!desktop.focused_layer || !desktop.focused_layer->presented) continue;
                CHECK(desktop.focused_layer->surface->surface->mapped &&
                    desktop.seat->keyboard_state.focused_surface == desktop.focused_layer->surface->surface);
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            char desktop_action[16], desktop_target[96];
            int desktop_x, desktop_y;
            if (sscanf(name, "fixture-desktop-pointer %15s %d %d %95s",
                    desktop_action, &desktop_x, &desktop_y, desktop_target) == 4) {
                struct wlr_scene_tree *tree = NULL;
                struct PuDesktopLayer *layer;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (layer->presented && layer->surface->surface->mapped &&
                        !strcmp(layer->surface->namespace, desktop_target)) { tree = layer->tree; break; }
                if (!tree) {
                    struct PuDesktopView *view;
                    wl_list_for_each(view, &desktop.views, link)
                        if (view->mapped && !view->geometry_pending && view->toplevel->title &&
                            !strcmp(view->toplevel->title, desktop_target)) { tree = view->tree; break; }
                }
                if (!tree) continue;
                int sx, sy;
                CHECK(wlr_scene_node_coords(&tree->node, &sx, &sy));
                move_pointer(sx + desktop_x, sy + desktop_y);
                if (!strcmp(desktop_action, "wheel")) {
                    struct wlr_pointer_axis_event event = { .pointer = &pointer, .time_msec = 100000,
                        .source = WL_POINTER_AXIS_SOURCE_WHEEL, .orientation = WL_POINTER_AXIS_VERTICAL_SCROLL,
                        .delta = 104, .delta_discrete = 120 };
                    wl_signal_emit_mutable(&pointer.events.axis, &event);
                    wl_signal_emit_mutable(&pointer.events.frame, NULL);
                    wlr_layer_surface_v1_destroy(marker->surface);
                    continue;
                }
                if (strcmp(desktop_action, "move")) {
                    CHECK(!strcmp(desktop_action, "down") || !strcmp(desktop_action, "up") ||
                        !strcmp(desktop_action, "click") || !strcmp(desktop_action, "right"));
                    static uint32_t desktop_time = 100000;
                    struct wlr_pointer_button_event event = { .pointer = &pointer, .time_msec = ++desktop_time,
                        .button = !strcmp(desktop_action, "right") ? BTN_RIGHT : BTN_LEFT,
                        .state = !strcmp(desktop_action, "up") ? WL_POINTER_BUTTON_STATE_RELEASED : WL_POINTER_BUTTON_STATE_PRESSED };
                    wlr_pointer_notify_button(&pointer, &event);
                    if (!strcmp(desktop_action, "click") || !strcmp(desktop_action, "right")) {
                        event.time_msec = ++desktop_time; event.state = WL_POINTER_BUTTON_STATE_RELEASED;
                        wlr_pointer_notify_button(&pointer, &event);
                    }
                    wl_signal_emit_mutable(&pointer.events.frame, NULL);
                }
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            unsigned desktop_color;
            if (sscanf(name, "fixture-desktop-pixel %d %d %x %95s",
                    &desktop_x, &desktop_y, &desktop_color, desktop_target) == 4) {
                bool found = false;
                struct PuDesktopLayer *layer;
                wl_list_for_each(layer, &desktop.layers, link) {
                    struct wlr_surface *surface = layer->surface->surface;
                    if (strcmp(layer->surface->namespace, desktop_target) || !surface->mapped || !surface->buffer) continue;
                    void *pixels; uint32_t format, pixel; size_t stride;
                    struct wlr_buffer *buffer = surface->buffer->source;
                    int x = desktop_x * buffer->width / surface->current.width;
                    int y = desktop_y * buffer->height / surface->current.height;
                    CHECK(x >= 0 && y >= 0 && x < buffer->width && y < buffer->height);
                    CHECK(wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &pixels, &format, &stride));
                    memcpy(&pixel, (char *)pixels + (size_t)y * stride + (size_t)x * 4, sizeof(pixel));
                    wlr_buffer_end_data_ptr_access(buffer);
                    if ((pixel & 0xffffff) != desktop_color) {
                        fprintf(stderr, "FAIL: desktop native pixel (%d,%d) actual=%06x expected=%06x\n",
                            desktop_x, desktop_y, pixel & 0xffffff, desktop_color);
                        CHECK(false);
                    }
                    printf("PASS: desktop native buffer pixel %s (%d,%d)=%06x\n",
                        desktop_target, desktop_x, desktop_y, pixel & 0xffffff);
                    found = true;
                }
                CHECK(found);
                wlr_layer_surface_v1_destroy(marker->surface); continue;
            }
            float desktop_scale;
            if (sscanf(name, "fixture-desktop-scale %f %95s", &desktop_scale, desktop_target) == 2) {
                struct wlr_output_layout_output *entry;
                struct wlr_output *target = NULL;
                wl_list_for_each(entry, &desktop.layout->outputs, link)
                    if (!strcmp(entry->output->name, desktop_target)) target = entry->output;
                CHECK(target && desktop_scale >= 1 && desktop_scale <= 2);
                struct wlr_output_state state;
                wlr_output_state_init(&state); wlr_output_state_set_scale(&state, desktop_scale);
                CHECK(wlr_output_commit_state(target, &state)); wlr_output_state_finish(&state);
                wlr_layer_surface_v1_destroy(marker->surface); continue;
            }
            if (!strcmp(name, "fixture-desktop-lock") || !strcmp(name, "fixture-desktop-lock-long")) {
                if (!fixture_lock_started) {
                    char *args[] = { getenv("PU_DESKTOP_FIXTURE_LOCK"),
                        !strcmp(name, "fixture-desktop-lock-long") ? "unlock-held" : "unlock", NULL };
                    CHECK(args[0] && pu_session_lock_spawn(&desktop, args)); fixture_lock_started = true;
                }
                if (!pu_session_lock_active(&desktop)) continue;
                if (desktop.seat->keyboard_state.focused_surface &&
                    !pu_session_lock_surface(&desktop, desktop.seat->keyboard_state.focused_surface)) continue;
                CHECK(!desktop.seat->pointer_state.focused_surface ||
                    pu_session_lock_surface(&desktop, desktop.seat->pointer_state.focused_surface));
                puts("PASS: desktop capture test acquired a real trusted session lock");
                wlr_layer_surface_v1_destroy(marker->surface); continue;
            }
            if (!strcmp(name, "fixture-desktop-unlocked")) {
                if (pu_session_lock_pid(&desktop) || pu_session_lock_active(&desktop)) continue;
                CHECK(pu_session_lock_client_succeeded(&desktop));
                fixture_lock_started = false;
                puts("PASS: desktop real session lock completed explicit protocol unlock");
                wlr_layer_surface_v1_destroy(marker->surface); continue;
            }
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
            if (!strcmp(name, "fixture-classic-menu-placement")) {
                struct PuDesktopLayer *menu = NULL, *panel = NULL, *layer;
                wl_list_for_each(layer, &desktop.layers, link) {
                    if (!layer->presented || !layer->surface->surface->mapped) continue;
                    if (!strncmp(layer->surface->namespace, "PollyShell.menu.", 16)) menu = layer;
                }
                if (!menu) continue;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (layer->presented && layer->surface->surface->mapped &&
                        layer->surface->output == menu->surface->output &&
                        !strncmp(layer->surface->namespace, "PollyShell.panel.", 17) &&
                        layer->surface->current.exclusive_zone == 28) panel = layer;
                if (!panel) continue;
                struct wlr_box full;
                wlr_output_layout_get_box(desktop.layout, menu->surface->output, &full);
                int mx, my, px, py;
                CHECK(wlr_scene_node_coords(&menu->tree->node, &mx, &my));
                CHECK(wlr_scene_node_coords(&panel->tree->node, &px, &py));
                CHECK(menu->surface->current.exclusive_zone == -1);
                CHECK(menu->surface->current.configure_serial == menu->serial);
                CHECK(menu->surface->surface->current.width == 380 && menu->surface->surface->current.height == 444);
                CHECK(mx == full.x + 2 && my == full.y + full.height - 24 - 444);
                CHECK(py == full.y + full.height - 28 && my + 444 - py == 4);
                CHECK(desktop.focused_layer == menu);
                CHECK(desktop.seat->keyboard_state.focused_surface == menu->surface->surface);
                printf("MENU_NATIVE_PLACEMENT {\"output\":[%d,%d,%d,%d],\"menu\":[%d,%d,380,444],"
                    "\"bar\":[%d,%d,%d,28],\"zone\":-1,\"overlap\":4,\"committed\":%u}\n",
                    full.x, full.y, full.width, full.height, mx, my, px, py, full.width, menu->serial);
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (!strcmp(name, "fixture-exclusive-prompt-ready")) {
                struct PuDesktopLayer *layer, *prompt = NULL;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (layer->presented && layer->surface->surface->mapped &&
                        !strcmp(layer->surface->namespace, "Fixture.exclusive.prompt")) prompt = layer;
                if (!prompt) continue;
                CHECK(desktop.focused_layer == prompt &&
                    prompt->surface->current.keyboard_interactive == ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE);
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (!strcmp(name, "fixture-menu-client-click")) {
                struct PuDesktopView *view = NULL, *item;
                wl_list_for_each(item, &desktop.views, link)
                    if (item->mapped && !item->geometry_pending && item->toplevel->app_id &&
                        !strcmp(item->toplevel->app_id, "org.pollyui.menu-pointer-fixture")) view = item;
                if (!view) continue;
                CHECK(wl_resource_get_client(view->toplevel->base->resource) != desktop.shell_client);
                CHECK(desktop.focused_layer &&
                    !strncmp(desktop.focused_layer->surface->namespace, "PollyShell.menu.", 16));
                int vx, vy;
                CHECK(wlr_scene_node_coords(&view->tree->node, &vx, &vy));
                fixture_pointer_click(vx + 40, vy + 40, settings_time += 3, 0);
                CHECK(!desktop.focused_layer && desktop.focused == view);
                CHECK(desktop.seat->pointer_state.focused_surface == view->toplevel->base->surface);
                bool green = false;
                for (int attempt = 0; attempt < 1000 && !green; attempt++) {
                    CHECK(pump());
                    struct wlr_surface *surface = view->toplevel->base->surface;
                    if (!surface->buffer || surface->current.width != surface->current.buffer_width) continue;
                    void *pixels; uint32_t format, pixel; size_t stride;
                    struct wlr_buffer *buffer = surface->buffer->source;
                    CHECK(wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &pixels, &format, &stride));
                    CHECK(format == DRM_FORMAT_ARGB8888 || format == DRM_FORMAT_XRGB8888);
                    memcpy(&pixel, (char *)pixels + 40 * stride + 40 * 4, sizeof(pixel));
                    wlr_buffer_end_data_ptr_access(buffer);
                    green = (pixel & 0xffffff) == 0x00ff00;
                    if (!attempt || attempt == 999) printf("MENU_CLIENT_PIXEL: %06x\n", pixel & 0xffffff);
                    CHECK((pixel & 0xffffff) != 0xff0000);
                }
                CHECK(green);
                puts("MENU_FOREIGN_CLIENT_POINTER: one actual click, green client buffer, no duplicate red state");
                wlr_layer_surface_v1_destroy(marker->surface);
                /* The outside press can destroy the cached next layer. */
                break;
            }
            if (!strcmp(name, "fixture-menu-caption-cancel")) {
                struct PuDesktopView *view = NULL, *item;
                wl_list_for_each(item, &desktop.views, link)
                    if (item->mapped && !item->geometry_pending && item->toplevel->app_id &&
                        !strcmp(item->toplevel->app_id, "org.pollyui.window-fixture")) view = item;
                if (!view) continue;
                CHECK(desktop.focused_layer && !strncmp(desktop.focused_layer->surface->namespace, "PollyShell.menu.", 16));
                struct wlr_box box;
                CHECK(pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
                int vx, vy;
                CHECK(wlr_scene_node_coords(&view->tree->node, &vx, &vy));
                fixture_pointer_motion(vx + box.x + box.width / 2, vy + box.y + box.height / 2, settings_time += 3);
                struct wlr_pointer_button_event event = { .pointer = &pointer, .time_msec = ++settings_time,
                    .button = BTN_LEFT, .state = WL_POINTER_BUTTON_STATE_PRESSED };
                wlr_pointer_notify_button(&pointer, &event);
                CHECK(!desktop.focused_layer && desktop.decoration_pressed == view);
                fixture_pointer_motion(vx + 40, vy + 40, ++settings_time);
                event.time_msec = ++settings_time; event.state = WL_POINTER_BUTTON_STATE_RELEASED;
                wlr_pointer_notify_button(&pointer, &event);
                CHECK(!desktop.decoration_pressed && !desktop.suppressed_button && !view->minimized);
                puts("CAPTION_MENU_CANCEL: outside dismissal keeps release-outside cancellation");
                wlr_layer_surface_v1_destroy(marker->surface);
                break;
            }
            unsigned caption_command, menu_exclusive;
            if (sscanf(name, "fixture-caption-pointer %u %u", &caption_command, &menu_exclusive) == 2) {
                CHECK(caption_command < 3 && menu_exclusive <= 2);
                struct PuDesktopView *view = NULL, *item;
                wl_list_for_each(item, &desktop.views, link)
                    if (item->mapped && !item->geometry_pending && item->toplevel->app_id &&
                        !strcmp(item->toplevel->app_id, "org.pollyui.window-fixture")) view = item;
                if (!view) continue;
                CHECK((desktop.focused_layer != NULL) == (menu_exclusive != 0));
                if (menu_exclusive == 1)
                    CHECK(!strncmp(desktop.focused_layer->surface->namespace, "PollyShell.menu.", 16));
                if (menu_exclusive == 2)
                    CHECK(!strcmp(desktop.focused_layer->surface->namespace, "Fixture.exclusive.prompt"));
                struct wlr_box box;
                CHECK(pu_decoration_button_box(view, PU_DECORATION_CLOSE + (int)caption_command, &box));
                int vx, vy;
                CHECK(wlr_scene_node_coords(&view->tree->node, &vx, &vy));
                bool maximized = view->maximized;
                fixture_pointer_click(vx + box.x + box.width / 2, vy + box.y + box.height / 2,
                    settings_time += 3, 0);
                if (menu_exclusive == 2) CHECK(view->maximized == maximized && desktop.focused_layer);
                if (menu_exclusive == 1) CHECK(!desktop.focused_layer);
                printf("CAPTION_NATIVE_POINTER {\"command\":%u,\"exclusiveLayer\":%u,\"at\":[%d,%d],"
                    "\"maximizedBefore\":%u,\"maximizedAfter\":%u,\"minimizedAfter\":%u}\n",
                    caption_command, menu_exclusive, vx + box.x + box.width / 2, vy + box.y + box.height / 2,
                    maximized, view->maximized, view->minimized);
                wlr_layer_surface_v1_destroy(marker->surface);
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
                    for (unsigned theme = 0; theme < PU_DECORATION_LAYOUT_COUNT; theme++) {
                        if (strcmp(name + 20, pu_decoration_layouts[theme].id)) continue;
                        struct wlr_box inset = { .width = 1280, .height = 720 }, button;
                        pu_decoration_inset(view, &inset, false);
                        CHECK(inset.y == pu_decoration_layouts[theme].layout.title_height &&
                              inset.x == pu_decoration_layouts[theme].layout.border_width);
                        CHECK(pu_decoration_button_box(view, PU_DECORATION_CLOSE, &button));
                        if (!strcmp(pu_decoration_layouts[theme].id, "server2003"))
                            CHECK(capture_caption_output(view));
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
            int settings_border, settings_title;
            if (sscanf(name, "fixture-settings-decoration %d %d", &settings_border, &settings_title) == 2) {
                struct PuDesktopView *view = settings_view();
                if (!view) continue;
                struct wlr_box inset = { .width = 1280, .height = 720 };
                pu_decoration_inset(view, &inset, false);
                CHECK(inset.x == settings_border && inset.y == settings_title);
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            unsigned settings_open, sequence;
            if (sscanf(name, "fixture-settings-state %u %u", &sequence, &settings_open) == 2) {
                CHECK(settings_open <= 1 && desktop.shell_pid == settings_shell_identity && desktop.shell_pid > 0);
                bool found_settings = false, found_survivor = false;
                unsigned settings_mapped = 0, settings_pending = 0, survivor_mapped = 0, survivor_pending = 0;
                pid_t survivor_pid = 0;
                uid_t survivor_uid = (uid_t)-1;
                int survivor_alive = 0;
                bool survivor_minimized = false, survivor_visible = false, survivor_buffer_present = false;
                uint32_t survivor_required_serial = 0, survivor_committed_serial = 0, survivor_acked_serial = 0;
                struct wlr_box survivor_current = {0}, survivor_wanted = {0}, survivor_presented = {0};
                int survivor_buffer_width = 0, survivor_buffer_height = 0;
                struct PuDesktopView *view;
                wl_list_for_each(view, &desktop.views, link) {
                    struct wl_client *client = wl_resource_get_client(view->toplevel->base->resource);
                    if (view->toplevel->app_id && !strcmp(view->toplevel->app_id, "org.pollyui.settings") && view->toplevel->title &&
                        !strcmp(view->toplevel->title, "Settings")) {
                        pid_t settings_pid;
                        uid_t settings_uid;
                        wl_client_get_credentials(client, &settings_pid, &settings_uid, NULL);
                        CHECK(client != desktop.shell_client && settings_uid == 1000 &&
                            settings_pid > 0 && settings_pid != desktop.shell_pid);
                        settings_mapped += view->mapped;
                        settings_pending += view->geometry_pending;
                    }
                    if (view->toplevel->app_id && !strcmp(view->toplevel->app_id, "org.pollyui.settings-survivor")) {
                        wl_client_get_credentials(client, &survivor_pid, &survivor_uid, NULL);
                        CHECK(client != desktop.shell_client && survivor_uid == 1000 && survivor_pid > 0);
                        if (!settings_survivor_identity) settings_survivor_identity = survivor_pid;
                        CHECK(survivor_pid == settings_survivor_identity);
                        survivor_mapped += view->mapped;
                        survivor_pending += view->geometry_pending;
                        survivor_alive = kill(survivor_pid, 0) == 0;
                        survivor_minimized = view->minimized;
                        survivor_visible = view->tree->node.enabled;
                        survivor_buffer_present = view->toplevel->base->surface->buffer &&
                            view->toplevel->base->surface->buffer->source;
                        found_survivor = view->mapped && survivor_alive && !survivor_minimized &&
                            survivor_visible && survivor_buffer_present;
                        survivor_required_serial = view->geometry_serial;
                        survivor_committed_serial = view->toplevel->base->current.configure_serial;
                        survivor_acked_serial = view->toplevel->base->pending.configure_serial;
                        survivor_current = view->toplevel->base->geometry;
                        survivor_wanted = view->pending_box;
                        survivor_presented = view->presented_box;
                        survivor_buffer_width = view->toplevel->base->surface->current.buffer_width;
                        survivor_buffer_height = view->toplevel->base->surface->current.buffer_height;
                    }
                    if (!view->mapped || view->geometry_pending) continue;
                    if (view->toplevel->app_id && !strcmp(view->toplevel->app_id, "org.pollyui.settings") && view->toplevel->title &&
                        !strcmp(view->toplevel->title, "Settings")) found_settings = true;
                }
                char diagnostic[1024];
                CHECK(settings_mapped <= 1);
                snprintf(diagnostic, sizeof(diagnostic),
                    "SETTINGS_STATE: seq=%u expected_open=%u shell_pid=%ld settings_ready=%d settings_mapped=%u "
                    "settings_pending=%u survivor_lifetime=%d survivor_mapped=%u survivor_pending=%u "
                    "survivor_pid=%ld survivor_uid=%lu survivor_alive=%d survivor_minimized=%d survivor_visible=%d "
                    "survivor_buffer_present=%d required_serial=%u committed_serial=%u acked_serial=%u "
                    "current_size=%dx%d wanted_box=%d,%d,%dx%d presented_box=%d,%d,%dx%d buffer_size=%dx%d",
                    sequence, settings_open, (long)desktop.shell_pid, found_settings, settings_mapped,
                    settings_pending, found_survivor, survivor_mapped, survivor_pending,
                    (long)survivor_pid, (unsigned long)survivor_uid, survivor_alive, survivor_minimized,
                    survivor_visible, survivor_buffer_present, survivor_required_serial, survivor_committed_serial,
                    survivor_acked_serial, survivor_current.width, survivor_current.height,
                    survivor_wanted.x, survivor_wanted.y, survivor_wanted.width, survivor_wanted.height,
                    survivor_presented.x, survivor_presented.y, survivor_presented.width, survivor_presented.height,
                    survivor_buffer_width, survivor_buffer_height);
                if (sequence != settings_state_sequence || strcmp(diagnostic, settings_state_previous)) {
                    puts(diagnostic);
                    fflush(stdout);
                    settings_state_sequence = sequence;
                    strcpy(settings_state_previous, diagnostic);
                }
                if (settings_lifetime_matches(settings_open != 0, (struct SettingsLifetimeState){
                    settings_mapped != 0, found_settings, found_survivor,
                    survivor_pending != 0 }))
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
            if (!strcmp(name, "fixture-settings-transparency")) {
                struct PuDesktopView *view = NULL, *item, *settings = settings_view();
                wl_list_for_each(item, &desktop.views, link)
                    if (item->mapped && !item->geometry_pending && item->toplevel->title &&
                        !strcmp(item->toplevel->title, "Transparency preview")) view = item;
                if (!view || !settings) continue;
                struct wlr_surface *surface = view->toplevel->base->surface;
                struct wlr_buffer *buffer = surface->buffer ? surface->buffer->source : NULL;
                if (!buffer || buffer->width < 16 || buffer->height < 16) continue;
                void *pixels;
                uint32_t format, pixel;
                size_t stride;
                CHECK(wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ,
                    &pixels, &format, &stride));
                memcpy(&pixel, (char *)pixels + 8 * stride + 8 * 4, sizeof(pixel));
                unsigned opaque = 0;
                for (int py = 0; py < buffer->height; py++)
                    for (int px = 0; px < buffer->width; px++) {
                        uint32_t value;
                        memcpy(&value, (char *)pixels + (size_t)py * stride + (size_t)px * 4, sizeof(value));
                        if ((value >> 24) == 255) opaque++;
                    }
                wlr_buffer_end_data_ptr_access(buffer);
                if ((pixel >> 24) != 128 || opaque < 100) continue;
                CHECK(format == DRM_FORMAT_ARGB8888);
                CHECK(wl_resource_get_client(view->toplevel->base->resource) ==
                    wl_resource_get_client(settings->toplevel->base->resource));
                CHECK(wl_resource_get_client(view->toplevel->base->resource) != desktop.shell_client);
                CHECK(pixman_region32_contains_point(&surface->input_region, 8, 8, NULL));
                printf("SETTINGS_TRANSPARENCY: real owned ordinary surface, background alpha=%u, "
                    "opaque foreground pixels=%u, rectangular input retained\n", pixel >> 24, opaque);
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            unsigned expected_opacity;
            if (!strcmp(name, "fixture-settings-opacity-pressure")) {
                struct PuDesktopView *view = NULL, *item;
                wl_list_for_each(item, &desktop.views, link)
                    if (item->mapped && item->toplevel->title &&
                        !strcmp(item->toplevel->title, "Transparency preview")) view = item;
                if (!view) continue;
                CHECK(desktop.window_opacity_percent == 75);
                struct wlr_scene_rect *pressure = wlr_scene_rect_create(view->popups, 40000, 1,
                    (float[4]){1, 1, 1, 1});
                CHECK(pressure);
                CHECK(!pu_desktop_set_window_opacity(&desktop, 50));
                CHECK(desktop.window_opacity_percent == 75);
                wlr_scene_node_destroy(&pressure->node);
                CHECK(pu_window_effects_update(view) && desktop.window_opacity_percent == 75);
                pressure = wlr_scene_rect_create(view->popups, 40000, 1, (float[4]){1, 1, 1, 1});
                CHECK(pressure && pu_window_effects_update(view));
                CHECK(desktop.window_opacity_percent == 100 && desktop.window_opacity_error[0]);
                wlr_scene_node_destroy(&pressure->node);
                CHECK(!desktop.failed);
                puts("SETTINGS_WINDOW_OPACITY_PRESSURE: invalid popup extent rejects a request, "
                    "then new geometry explicitly disables transparency without terminating the desktop");
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            if (sscanf(name, "fixture-settings-window-opacity %u", &expected_opacity) == 1) {
                CHECK(expected_opacity >= 50 && expected_opacity <= 100);
                if (desktop.window_opacity_percent != expected_opacity) continue;
                struct PuDesktopView *view;
                unsigned ordinary = 0;
                wl_list_for_each(view, &desktop.views, link) {
                    if (!view->mapped || !view->toplevel->base->surface->buffer ||
                        wl_resource_get_client(view->toplevel->base->resource) == desktop.shell_client) continue;
                    if (expected_opacity < 100) CHECK(view->effects->rounding);
                    ordinary++;
                }
                CHECK(ordinary >= 3);
                CHECK(desktop.scene->effects_cached_bytes > 0 &&
                    desktop.scene->effects_cached_bytes <= WLR_SCENE_EFFECTS_MAX_BYTES);
                printf("SETTINGS_WINDOW_OPACITY: percent=%u, ordinary windows=%u, "
                    "new preview included, group caches bounded\n", expected_opacity, ordinary);
                wlr_layer_surface_v1_destroy(marker->surface);
                continue;
            }
            unsigned code, modifiers;
            bool managed_key = sscanf(name, "fixture-settings-managed-key %u %u %u", &sequence, &code, &modifiers) == 3;
            if (managed_key || sscanf(name, "fixture-settings-key %u %u %u", &sequence, &code, &modifiers) == 3) {
                struct PuDesktopView *view = settings_view();
                if (managed_key) {
                    view = NULL;
                    struct PuDesktopView *candidate;
                    wl_list_for_each(candidate, &desktop.views, link)
                        if (candidate->mapped && !candidate->geometry_pending && candidate->toplevel->title &&
                            !strcmp(candidate->toplevel->title, "Desktop control panel") &&
                            wl_resource_get_client(candidate->toplevel->base->resource) == desktop.shell_client) {
                            view = candidate; break;
                        }
                }
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
            bool ordinary = sscanf(name, "fixture-xdg-click %u %d %d %u %95[^\n]", &serial, &x, &y, &button, target) == 5;
            if (!ordinary && sscanf(name, "fixture-click %u %d %d %u %95s", &serial, &x, &y, &button, target) != 5)
                continue;
            struct PuDesktopLayer *layer;
            struct wlr_scene_tree *tree = NULL;
            if (ordinary) {
                CHECK(!strcmp(target, "Settings") || !strcmp(target, "Desktop control panel"));
                struct PuDesktopView *view = NULL, *candidate;
                wl_list_for_each(candidate, &desktop.views, link)
                    if (candidate->mapped && !candidate->geometry_pending && candidate->toplevel->title &&
                        !strcmp(candidate->toplevel->title, target)) { view = candidate; break; }
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
    if (argc == 2 && !strcmp(argv[1], "--settings-lifetime-policy"))
        return settings_lifetime_policy() ? 0 : 1;
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
#if defined(PU_TEST_DECORATOR)
        char *decorator[] = {argv[1], "--decorator", "--app-id", "org.pollyui.decorator",
            "desktop/decorator/main.mjs", NULL};
        ready = pu_decorator_spawn(&desktop, decorator);
#endif
    }
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
