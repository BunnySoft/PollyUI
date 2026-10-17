#include "server.h"
#include "decoration.h"
#include "decorator-process.h"
#include "decoration-layout-fixtures.h"
#include "workspace.h"
#include "data-device.h"
#include "input-method.h"
#include "wire.h"
#include "cursor.h"
#include "session-lock.h"
#include "shortcut-control.h"

#include <errno.h>
#include <drm_fourcc.h>
#include <fcntl.h>
#include <linux/input-event-codes.h>
#include <limits.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <wlr/backend.h>
#include <wlr/backend/headless.h>
#include <wlr/backend/multi.h>
#include <wlr/render/wlr_texture.h>
#include <wlr/interfaces/wlr_keyboard.h>
#include <wlr/interfaces/wlr_pointer.h>
#include <wlr/types/wlr_cursor.h>
#include <wlr/types/wlr_cursor_shape_v1.h>
#include <wlr/types/wlr_xcursor_manager.h>
#include <wlr/types/wlr_data_device.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_layer_shell_v1.h>
#include <wlr/types/wlr_foreign_toplevel_management_v1.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/types/wlr_xdg_decoration_v1.h>
#include <wlr/util/edges.h>
#include <wlr/util/log.h>

#define CHECK(expression) do { \
    if (!(expression)) { \
        fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expression); return false; \
    } \
    checks++; \
} while (0)

struct TestClient {
    pid_t pid;
    int control;
    struct TestReply reply;
};

static struct PuDesktop desktop;
static struct wlr_keyboard keyboard;
static struct wlr_pointer pointer;
static struct TestClient clients[3];
static struct TestClient shell_client = { .control = -1 };
static int checks;
static uint32_t time_msec;
static bool nested;
static bool cursor_only;
static bool cursor_resources;
static wl_notify_func_t compositor_new_input;
static const struct wlr_keyboard_impl keyboard_impl = { .name = "pollywm-test" };
static const struct wlr_pointer_impl pointer_impl = { .name = "pollywm-test" };
static void find_headless(struct wlr_backend *backend, void *data);
static bool resize_output(struct wlr_output *output, int width, int height, float scale);
static bool snap_key(struct TestClient *client, uint32_t code);

static void test_input(struct wl_listener *listener, void *data)
{
    /* Nested output remains real, but user/WSLg input must not race the fixture. */
    if (data == &keyboard.base || data == &pointer.base)
        compositor_new_input(listener, data);
}

static bool pump(void)
{
    wl_display_flush_clients(desktop.display);
    return wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 5) >= 0 &&
           !desktop.failed;
}

static bool spawn_client(struct TestClient *client, const char *path)
{
    int sockets[2];
    CHECK(socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sockets) == 0);
    CHECK(fcntl(sockets[0], F_SETFD, FD_CLOEXEC) == 0);
    client->pid = fork();
    CHECK(client->pid >= 0);
    if (client->pid == 0) {
        close(sockets[0]);
        char fd[32];
        snprintf(fd, sizeof(fd), "%d", sockets[1]);
        execl(path, path, desktop.socket_name, fd, (char *)NULL);
        perror("exec test client");
        _exit(127);
    }
    close(sockets[1]);
    client->control = sockets[0];
    return true;
}

static bool exchange(struct TestClient *client, const struct TestRequest *request)
{
    CHECK(send(client->control, request, sizeof(*request), MSG_NOSIGNAL) == sizeof(*request));
    for (int i = 0; i < 1000; i++) {
        ssize_t n = recv(client->control, &client->reply, sizeof(client->reply), MSG_DONTWAIT);
        if (n == sizeof(client->reply)) return true;
        CHECK(n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
        CHECK(pump());
    }
    fprintf(stderr, "Timed out waiting for test client command %d\n", request->command);
    return false;
}

static bool command(struct TestClient *client, enum TestCommand type, int id,
                    uint32_t serial, uint32_t edges)
{
    struct TestRequest request = { .command = type, .id = id, .serial = serial, .edges = edges };
    return exchange(client, &request);
}

static bool layer_command(enum TestCommand type, int id, struct TestLayer layer)
{
    struct TestRequest request = { .command = type, .id = id, .layer = layer };
    return exchange(&shell_client, &request);
}

static struct PuDesktopView *find_view(int id)
{
    char name[64];
    snprintf(name, sizeof(name), "org.pollywm.test.%d", id);
    struct PuDesktopView *view;
    wl_list_for_each(view, &desktop.views, link)
        if (view->toplevel->app_id && strcmp(view->toplevel->app_id, name) == 0) return view;
    return NULL;
}

static void motion(double x, double y)
{
    struct wlr_box box;
    wlr_output_layout_get_box(desktop.layout, NULL, &box);
    struct wlr_pointer_motion_absolute_event event = {
        .pointer = &pointer, .time_msec = ++time_msec,
        .x = (x - box.x) / box.width, .y = (y - box.y) / box.height,
    };
    wl_signal_emit_mutable(&pointer.events.motion_absolute, &event);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
}

static void button(uint32_t code, bool down)
{
    struct wlr_pointer_button_event event = {
        .pointer = &pointer, .time_msec = ++time_msec, .button = code,
        .state = down ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED,
    };
    wlr_pointer_notify_button(&pointer, &event);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
}

static void key(uint32_t code, bool down)
{
    struct wlr_keyboard_key_event event = {
        .time_msec = ++time_msec, .keycode = code, .update_state = true,
        .state = down ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED,
    };
    wlr_keyboard_notify_key(&keyboard, &event);
}

static bool geometry_is(struct PuDesktopView *view, int x, int y, int width, int height)
{
    struct wlr_box geometry = view->toplevel->base->geometry;
    if (view->tree->node.x != x || view->tree->node.y != y ||
        geometry.width != width || geometry.height != height) {
        fprintf(stderr, "Geometry: actual %d,%d %dx%d, expected %d,%d %dx%d\n",
            view->tree->node.x, view->tree->node.y, geometry.width, geometry.height,
            x, y, width, height);
        return false;
    }
    return true;
}

static bool fullscreen_pixels(struct PuDesktopView *view)
{
    struct wlr_scene_output *output = wlr_scene_get_scene_output(desktop.scene, view->output);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    /* Read a composed output, not a client's scanout buffer with a destination box. */
    wlr_output_lock_attach_render(output->output, true);
    CHECK(wlr_scene_output_build_state(output, &state, NULL));
    CHECK(state.buffer);
    void *data;
    uint32_t format;
    size_t stride;
    CHECK(wlr_buffer_begin_data_ptr_access(state.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ,
                                           &data, &format, &stride));
    bool valid_format = format == DRM_FORMAT_XRGB8888 || format == DRM_FORMAT_ARGB8888;
    uint32_t corner, center;
    memcpy(&corner, data, sizeof(corner));
    memcpy(&center, (char *)data + (state.buffer->height / 2) * stride +
                                  (state.buffer->width / 2) * 4, sizeof(center));
    wlr_buffer_end_data_ptr_access(state.buffer);
    wlr_output_state_finish(&state);
    wlr_output_lock_attach_render(output->output, false);
    if ((corner & 0xffffff) != 0 || (center & 0xffffff) != 0x10b981)
        fprintf(stderr, "Fullscreen pixels: corner=%08x center=%08x\n", corner, center);
    CHECK(valid_format);
    CHECK((corner & 0xffffff) == 0);
    CHECK((center & 0xffffff) == 0x10b981);
    return true;
}

static bool scene_pixel(struct wlr_output *target, uint32_t expected)
{
    struct wlr_scene_output *output = wlr_scene_get_scene_output(desktop.scene, target);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_lock_attach_render(target, true);
    CHECK(wlr_scene_output_build_state(output, &state, NULL) && state.buffer);
    void *data;
    uint32_t format, pixel;
    size_t stride;
    CHECK(wlr_buffer_begin_data_ptr_access(state.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ,
                                           &data, &format, &stride));
    memcpy(&pixel, (char *)data + 10 * stride + 10 * 4, sizeof(pixel));
    wlr_buffer_end_data_ptr_access(state.buffer);
    wlr_output_state_finish(&state);
    wlr_output_lock_attach_render(target, false);
    CHECK(format == DRM_FORMAT_XRGB8888 || format == DRM_FORMAT_ARGB8888);
    if ((pixel & 0xffffff) != expected)
        fprintf(stderr, "Scene pixel: actual %06x, expected %06x\n", pixel & 0xffffff, expected);
    CHECK((pixel & 0xffffff) == expected);
    return true;
}

static uint64_t monotonic_ms(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static bool wait_ms(unsigned duration)
{
    uint64_t end = monotonic_ms() + duration;
    while (monotonic_ms() < end) CHECK(pump());
    return true;
}

static bool cursor_pixels(struct wlr_output *output, const char *name, const char *label, int *frame)
{
    CHECK(!wl_list_empty(&output->cursors));
    struct wlr_output_cursor *cursor = wl_container_of(output->cursors.next, cursor, link);
    if (!strcmp(name, "hidden")) {
        CHECK(!cursor->enabled && !cursor->texture);
        return true;
    }
    CHECK(cursor->enabled && cursor->texture);
    uint32_t pixels[256 * 256];
    CHECK(cursor->texture->width <= 256 && cursor->texture->height <= 256);
    struct wlr_texture_read_pixels_options options = {
        .data = pixels, .format = DRM_FORMAT_ARGB8888, .stride = cursor->texture->width * 4,
    };
    CHECK(wlr_texture_read_pixels(cursor->texture, &options));
    int matched = -1;
    if (!strcmp(name, "client-surface")) {
        CHECK(cursor->texture->width == 8 && cursor->texture->height == 8);
        CHECK(cursor->hotspot_x == 2 && cursor->hotspot_y == 3);
        CHECK((pixels[0] & 0xffffff) == 0x3b82f6);
    } else {
        struct wlr_xcursor *asset = wlr_xcursor_manager_get_xcursor(desktop.cursor_theme, name, output->scale);
        CHECK(asset);
        for (unsigned i = 0; i < asset->image_count; i++) {
            struct wlr_xcursor_image *image = asset->images[i];
            if (image->width == cursor->texture->width && image->height == cursor->texture->height &&
                !memcmp(image->buffer, pixels, image->width * image->height * 4)) matched = (int)i;
        }
        CHECK(matched >= 0);
        /* Public wlr_output_cursor_set_buffer normalizes integer hotspots via
         * logical coordinates, then rounds back to output pixels. */
        CHECK(cursor->hotspot_x == (int)roundf((int)(asset->images[matched]->hotspot_x / output->scale) * output->scale) &&
              cursor->hotspot_y == (int)roundf((int)(asset->images[matched]->hotspot_y / output->scale) * output->scale));
        if (frame) *frame = matched;
    }
    const char *directory = getenv("POLLY_CURSOR_EVIDENCE");
    if (directory && label) {
        char path[PATH_MAX];
        CHECK(snprintf(path, sizeof(path), "%s/%s.argb", directory, label) < (int)sizeof(path));
        FILE *file = fopen(path, "wb");
        CHECK(file);
        CHECK(fwrite(pixels, 4, cursor->texture->width * cursor->texture->height, file) ==
              cursor->texture->width * cursor->texture->height);
        CHECK(fclose(file) == 0);
        CHECK(snprintf(path, sizeof(path), "%s/native-frames.tsv", directory) < (int)sizeof(path));
        file = fopen(path, "a");
        CHECK(file);
        fprintf(file, "%s\t%s\t%d\t%u\t%u\t%d\t%d\t%llu\n", label, name, matched,
            cursor->texture->width, cursor->texture->height, cursor->hotspot_x, cursor->hotspot_y,
            (unsigned long long)monotonic_ms());
        CHECK(fclose(file) == 0);
    }
    return true;
}

static bool cursor_suite(const char *client_path)
{
    CHECK(spawn_client(&clients[0], client_path));
    CHECK(spawn_client(&clients[1], client_path));
    struct TestClient *a = &clients[0], *b = &clients[1];
    CHECK(command(a, TEST_MAP, 1, 0, 0));
    CHECK(command(b, TEST_MAP, 2, 0, 0));
    struct PuDesktopView *first = find_view(1), *second = find_view(2);
    CHECK(first && second && a->reply.cursor_shape_capability && b->reply.cursor_shape_capability);
    wlr_scene_node_set_position(&first->tree->node, 30, 60);
    wlr_scene_node_set_position(&second->tree->node, 700, 60);
    struct wlr_output *output = first->output;
    motion(50, 80);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(command(a, TEST_CURSOR_SHAPE, 0, 0, WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT));
    CHECK(wait_ms(140));
    CHECK(cursor_pixels(output, "default", "idle", NULL));
    CHECK(!pu_cursor_timer_active(&desktop));
    motion(51, 80);
    CHECK(!strcmp(pu_cursor_selected(&desktop), "motion"));
    int seen = 0;
    for (unsigned i = 0; i < 10; i++) {
        CHECK(wait_ms(35));
        motion(52 + i, 80);
        char label[32];
        snprintf(label, sizeof(label), "run-%02u", i);
        int frame = -1;
        CHECK(cursor_pixels(output, "motion", label, &frame));
        seen |= 1 << frame;
    }
    CHECK(seen == 15); /* Repeated motion must not restart frame zero. */
    CHECK(wait_ms(145));
    CHECK(cursor_pixels(output, "default", "run-stopped", NULL));
    CHECK(!pu_cursor_timer_active(&desktop));
    button(BTN_LEFT, true);
    CHECK(cursor_pixels(output, "press", "pressed", NULL));
    button(BTN_LEFT, false);
    CHECK(!strcmp(pu_cursor_selected(&desktop), "click"));
    seen = 0;
    for (unsigned i = 0; i < 5; i++) {
        char label[32];
        snprintf(label, sizeof(label), "hop-%02u", i);
        int frame = -1;
        CHECK(cursor_pixels(output, "click", label, &frame));
        seen |= 1 << frame;
        CHECK(wait_ms(40));
    }
    CHECK((seen & 12) == 12 && (seen & 17)); /* Symmetric hop: two heights and ground. */
    CHECK(wait_ms(30));
    CHECK(cursor_pixels(output, "default", "hop-finished", NULL));
    CHECK(!pu_cursor_timer_active(&desktop));
    button(BTN_LEFT, true); button(BTN_LEFT, false);
    CHECK(wait_ms(110));
    motion(63, 80);
    CHECK(wait_ms(100));
    CHECK(!strcmp(pu_cursor_selected(&desktop), "motion")); /* Hop restores current motion, not stale idle. */
    CHECK(cursor_pixels(output, "motion", "hop-current-motion", NULL));
    CHECK(wait_ms(145));
    button(BTN_LEFT, true);
    motion(85, 80);
    CHECK(!strcmp(pu_cursor_selected(&desktop), "drag"));
    seen = 0;
    for (unsigned i = 0; i < 9; i++) {
        char label[32];
        snprintf(label, sizeof(label), "effort-%02u", i);
        int frame = -1;
        CHECK(cursor_pixels(output, "drag", label, &frame));
        seen |= 1 << frame;
        CHECK(wait_ms(40));
    }
    CHECK(seen == 15);
    button(BTN_LEFT, false);
    CHECK(strcmp(pu_cursor_selected(&desktop), "click"));
    CHECK(command(a, TEST_CURSOR_SHAPE, 0, 0, WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_TEXT));
    motion(86, 80); button(BTN_LEFT, true); motion(110, 80); button(BTN_LEFT, false);
    CHECK(cursor_pixels(output, "text", "text-override", NULL));
    CHECK(!pu_cursor_timer_active(&desktop));
    CHECK(command(a, TEST_CURSOR_INVALID, 0, 0, 0));
    CHECK(cursor_pixels(output, "text", NULL, NULL));
    CHECK(command(b, TEST_CURSOR_SHAPE, 1, a->reply.cursor_enter_serial,
        WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT));
    CHECK(cursor_pixels(output, "text", NULL, NULL));
    CHECK(command(a, TEST_CURSOR_SHAPE, 1, 0, WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT));
    CHECK(cursor_pixels(output, "text", NULL, NULL));
    CHECK(command(b, TEST_CURSOR_SURFACE, 1, a->reply.cursor_enter_serial, 0));
    CHECK(cursor_pixels(output, "text", NULL, NULL));
    CHECK(command(a, TEST_CURSOR_SURFACE, 1, 0, 0));
    CHECK(cursor_pixels(output, "text", NULL, NULL));
    CHECK(command(a, TEST_CURSOR_SURFACE, 0, 0, 0));
    CHECK(cursor_pixels(output, "hidden", NULL, NULL));
    motion(111, 80); button(BTN_LEFT, true); motion(125, 80); button(BTN_LEFT, false);
    CHECK(cursor_pixels(output, "hidden", NULL, NULL));
    CHECK(command(a, TEST_CURSOR_SURFACE, 0, 0, 1));
    CHECK(cursor_pixels(output, "client-surface", "legacy-custom", NULL));
    motion(126, 80);
    CHECK(cursor_pixels(output, "client-surface", NULL, NULL));
    motion(720, 80);
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    CHECK(command(b, TEST_CURSOR_SHAPE, 0, 0, WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_CROSSHAIR));
    CHECK(!strcmp(pu_cursor_selected(&desktop), "crosshair"));
    CHECK(cursor_pixels(output, "crosshair", "crosshair-override", NULL));
    motion(50, 80);
    CHECK(cursor_pixels(output, "client-surface", NULL, NULL)); /* Restore actual current owner. */
    CHECK(command(a, TEST_CURSOR_IMAGE_DESTROY, 0, 0, 0));
    CHECK(cursor_pixels(output, "hidden", NULL, NULL));
    CHECK(command(a, TEST_CURSOR_SHAPE, 0, 0, WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT));
    CHECK(command(b, TEST_DRAG_TARGET, 0, 0, WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY));
    button(BTN_LEFT, true);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(command(a, TEST_DRAG, 0, a->reply.serial, 9));
    CHECK(pu_data_device_drag_active(&desktop));
    motion(720, 80);
    CHECK(command(a, TEST_CURSOR_SURFACE, 0, 0, 0)); /* Actual native drag owner may hide. */
    CHECK(cursor_pixels(output, "hidden", NULL, NULL));
    CHECK(command(b, TEST_CURSOR_SHAPE, 0, 0, WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_TEXT));
    CHECK(cursor_pixels(output, "hidden", NULL, NULL));
    CHECK(command(a, TEST_CURSOR_SHAPE, 0, 0, WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT));
    CHECK(wait_ms(90));
    CHECK(cursor_pixels(output, "drag-copy", "native-drag-copy", NULL));
    CHECK(command(b, TEST_DRAG_TARGET, 0, 0, WL_DATA_DEVICE_MANAGER_DND_ACTION_MOVE));
    CHECK(wait_ms(90));
    CHECK(cursor_pixels(output, "drag-move", "native-drag-move", NULL));
    CHECK(command(b, TEST_DRAG_TARGET, 0, 0, 0));
    CHECK(wait_ms(90));
    CHECK(cursor_pixels(output, "drag-no-drop", "native-drag-no-drop", NULL));
    key(KEY_ESC, true); key(KEY_ESC, false);
    button(BTN_LEFT, false);
    CHECK(!pu_data_device_drag_active(&desktop));
    CHECK(wait_ms(145));
    CHECK(cursor_pixels(output, "crosshair", NULL, NULL));
    motion(50, 80);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    uint32_t old_enter = a->reply.cursor_enter_serial;
    motion(720, 80); motion(50, 80);
    CHECK(command(a, TEST_CURSOR_SHAPE, 1, old_enter, WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_TEXT));
    CHECK(strcmp(pu_cursor_selected(&desktop), "text"));
    CHECK(command(a, TEST_CURSOR_SHAPE, 0, 0, WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT));
    CHECK(wait_ms(145));
    CHECK(command(a, TEST_CURSOR_SHAPE, 0, 0, WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_TEXT));
    button(BTN_LEFT, true);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(command(a, TEST_MOVE, 0, a->reply.serial, 0));
    CHECK(desktop.grab == PU_DESKTOP_MOVE);
    CHECK(cursor_pixels(output, "drag", "window-move", NULL));
    button(BTN_LEFT, false);
    CHECK(cursor_pixels(output, "text", NULL, NULL));
    button(BTN_LEFT, true);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(command(a, TEST_RESIZE, 0, a->reply.serial, WLR_EDGE_BOTTOM | WLR_EDGE_RIGHT));
    CHECK(desktop.grab == PU_DESKTOP_RESIZE);
    CHECK(cursor_pixels(output, wlr_xcursor_get_resize_name(WLR_EDGE_BOTTOM | WLR_EDGE_RIGHT),
        "window-resize", NULL));
    button(BTN_LEFT, false);
    CHECK(cursor_pixels(output, "text", NULL, NULL));
    CHECK(command(a, TEST_CURSOR_SHAPE, 0, 0, WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT));
    struct wlr_output_state scale;
    wlr_output_state_init(&scale);
    wlr_output_state_set_scale(&scale, 2);
    CHECK(wlr_output_commit_state(output, &scale));
    wlr_output_state_finish(&scale);
    CHECK(cursor_pixels(output, "default", "scale-2", NULL));
    struct wlr_output_cursor *native = wl_container_of(output->cursors.next, native, link);
    CHECK(native->texture->width == 64 && native->hotspot_x == 4 && native->hotspot_y == 36);
    button(BTN_LEFT, true); motion(65, 80);
    pu_desktop_isolate_input(&desktop);
    CHECK(!pu_cursor_timer_active(&desktop));
    CHECK(cursor_pixels(output, "default", "isolated", NULL));
    pu_desktop_restore_input(&desktop);
    motion(50, 80);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(command(a, TEST_CURSOR_SURFACE, 0, 0, 1));
    button(BTN_LEFT, true);
    CHECK(command(a, TEST_DESTROY, 0, 0, 0));
    CHECK(strcmp(pu_cursor_selected(&desktop), "client-surface"));
    CHECK(!pu_cursor_timer_active(&desktop));
    button(BTN_LEFT, false);
    CHECK(command(b, TEST_DESTROY, 0, 0, 0));
    CHECK(!pu_cursor_timer_active(&desktop));
    CHECK(command(a, TEST_QUIT, 0, 0, 0));
    CHECK(command(b, TEST_QUIT, 0, 0, 0));
    return true;
}

static bool cursor_resource_suite(void)
{
    struct wlr_output_layout_output *entry = wl_container_of(desktop.layout->outputs.next, entry, link);
    struct wlr_output *output = entry->output;
    CHECK(cursor_pixels(output, "default", "resource-default", NULL));
    motion(70, 70);
    const char *motion_name = (getenv("POLLY_CURSOR_STATIC") && !strcmp(getenv("POLLY_CURSOR_STATIC"), "1")) ||
        pu_cursor_classic_theme(getenv("POLLY_CURSOR_THEME")) ? "default" : "motion";
    CHECK(!strcmp(pu_cursor_selected(&desktop), motion_name));
    CHECK(cursor_pixels(output, motion_name, "resource-motion", NULL));
    CHECK(wait_ms(150));
    CHECK(!pu_cursor_timer_active(&desktop));
    for (unsigned shape = 1; shape <= WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_ZOOM_OUT; shape++) {
        const char *name = wlr_cursor_shape_v1_name(shape);
        pu_cursor_compositor(&desktop, name);
        CHECK(cursor_pixels(output, name, shape == WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_TEXT ? "resource-text" : NULL, NULL));
    }
    const char *previous = pu_cursor_selected(&desktop);
    pu_cursor_compositor(&desktop, NULL);
    pu_cursor_compositor(&desktop, "../default");
    CHECK(!strcmp(pu_cursor_selected(&desktop), previous));
    pu_cursor_compositor(&desktop, "default");
    struct wlr_backend *headless = NULL;
    wlr_multi_for_each_backend(desktop.backend, find_headless, &headless);
    CHECK(headless);
    struct wlr_output *extra = wlr_headless_add_output(headless, 640, 480);
    CHECK(extra);
    struct wlr_output_state extra_scale;
    wlr_output_state_init(&extra_scale);
    wlr_output_state_set_scale(&extra_scale, 2);
    CHECK(wlr_output_commit_state(extra, &extra_scale));
    wlr_output_state_finish(&extra_scale);
    for (unsigned i = 0; i < 3; i++) {
        float scales[] = {1.5f, 2, 3};
        struct wlr_output_state scale;
        wlr_output_state_init(&scale);
        wlr_output_state_set_scale(&scale, scales[i]);
        CHECK(wlr_output_commit_state(output, &scale));
        wlr_output_state_finish(&scale);
        char label[32];
        snprintf(label, sizeof(label), "resource-scale-%u", i);
        CHECK(cursor_pixels(output, "default", label, NULL));
        struct wlr_output_cursor *native = wl_container_of(output->cursors.next, native, link);
        CHECK(native->texture->width == (unsigned)(32 * scales[i]));
        CHECK(cursor_pixels(extra, "default", "resource-other-output", NULL));
    }
    wlr_output_destroy(extra);
    motion(72, 72);
    wlr_pointer_finish(&pointer);
    CHECK(!pu_cursor_timer_active(&desktop) && desktop.seat->pointer_state.button_count == 0);
    wlr_pointer_init(&pointer, &pointer_impl, "test-pointer");
    wl_signal_emit_mutable(&desktop.backend->events.new_input, &pointer.base);
    /* Exercise explicit cursor teardown while both native animation and the
     * quiet deadline are live, then dispatch after their owning buffers die. */
    if (!getenv("POLLY_CURSOR_STATIC") &&
        !pu_cursor_classic_theme(getenv("POLLY_CURSOR_THEME"))) {
        motion(74, 74);
        CHECK(pu_cursor_timer_active(&desktop));
        CHECK(cursor_pixels(output, "motion", "resource-shutdown-live", NULL));
        pu_cursor_finish(&desktop);
        CHECK(!desktop.cursor_state && !desktop.cursor_theme);
        CHECK(wait_ms(160));
        struct wlr_output_cursor *native = wl_container_of(output->cursors.next, native, link);
        CHECK(!native->enabled && !native->texture);
    }
    return true;
}

static bool layer_output_suite(struct TestLayer options);
static void find_headless(struct wlr_backend *backend, void *data);

static bool foreign_suite(void)
{
    struct TestClient *a = &clients[0], *b = &clients[1], *shell = &shell_client;
    struct PuDesktopView *first = find_view(1), *second = find_view(2);
    CHECK(command(shell, TEST_QUERY, 0, 0, 0));
    CHECK(shell->reply.foreign_capability && shell->reply.foreign_count == 2);
    CHECK(!a->reply.foreign_capability && !b->reply.foreign_capability);
    CHECK(b->reply.minimize_capability);
    CHECK(command(b, TEST_MINIMIZE, 0, 0, 0));
    CHECK(second->mapped && second->minimized && !second->tree->node.enabled && desktop.focused == first);
    CHECK(command(shell, TEST_FOREIGN_QUERY, 2, 0, 0));
    CHECK((shell->reply.foreign_state & WLR_FOREIGN_TOPLEVEL_HANDLE_V1_STATE_MINIMIZED) &&
        !(shell->reply.foreign_state & WLR_FOREIGN_TOPLEVEL_HANDLE_V1_STATE_ACTIVATED));
    CHECK(command(shell, TEST_FOREIGN_RESTORE, 2, 0, 0));
    CHECK(!second->minimized && second->tree->node.enabled && desktop.focused == first);
    CHECK(command(shell, TEST_FOREIGN_ACTIVATE, 2, 0, 0));
    CHECK(desktop.focused == second);
    CHECK(command(b, TEST_POPUP, 0, 0, 0));
    CHECK(command(shell, TEST_FOREIGN_MINIMIZE, 2, 0, 0));
    CHECK(wl_list_empty(&second->toplevel->base->popups));
    CHECK(command(b, TEST_DESTROY_POPUP, 0, 0, 0));
    CHECK(command(b, TEST_POPUP, 0, 0, 0));
    CHECK(wl_list_empty(&second->toplevel->base->popups));
    CHECK(command(b, TEST_DESTROY_POPUP, 0, 0, 0));
    CHECK(command(shell, TEST_FOREIGN_ACTIVATE, 2, 0, 0));
    CHECK(!second->minimized && desktop.focused == second);
    struct wlr_box old = second->toplevel->base->geometry;
    int x = second->tree->node.x, y = second->tree->node.y;
    CHECK(command(shell, TEST_FOREIGN_MAXIMIZE, 2, 0, 0));
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    CHECK(second->mode == PU_DESKTOP_MAXIMIZED);
    CHECK(command(shell, TEST_FOREIGN_MINIMIZE, 2, 0, 0));
    CHECK(command(shell, TEST_FOREIGN_ACTIVATE, 2, 0, 0));
    CHECK(second->mode == PU_DESKTOP_MAXIMIZED && !second->minimized);
    CHECK(command(shell, TEST_FOREIGN_UNMAXIMIZE, 2, 0, 0));
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(second, x, y, old.width, old.height));
    CHECK(command(shell, TEST_FOREIGN_FULLSCREEN, 2, 0, 0));
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    CHECK(second->mode == PU_DESKTOP_FULLSCREEN);
    CHECK(command(shell, TEST_FOREIGN_MINIMIZE, 2, 0, 0));
    CHECK(!second->tree->node.enabled);
    CHECK(command(shell, TEST_FOREIGN_ACTIVATE, 2, 0, 0));
    CHECK(command(shell, TEST_FOREIGN_UNFULLSCREEN, 2, 0, 0));
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(second, x, y, old.width, old.height));
    CHECK(command(shell, TEST_FOREIGN_MINIMIZE, 1, 0, 0));
    CHECK(command(shell, TEST_FOREIGN_MINIMIZE, 2, 0, 0));
    CHECK(!desktop.focused);
    key(KEY_LEFTALT, true); key(KEY_TAB, true); key(KEY_TAB, false); key(KEY_LEFTALT, false);
    CHECK(desktop.focused && !desktop.focused->minimized);
    CHECK(command(shell, TEST_FOREIGN_ACTIVATE, 1, 0, 0));
    CHECK(command(shell, TEST_FOREIGN_ACTIVATE, 2, 0, 0));
    CHECK(command(b, TEST_RENAME, 0, 0, 0));
    CHECK(command(shell, TEST_FOREIGN_QUERY, 2, 0, 0));
    CHECK(!strcmp(shell->reply.foreign_title, "Updated title") && shell->reply.foreign_outputs == 1);
    int done = shell->reply.foreign_done;
    for (int i = 0; i < 10; i++) CHECK(pump());
    CHECK(command(shell, TEST_FOREIGN_QUERY, 2, 0, 0));
    CHECK(shell->reply.foreign_done == done);
    int closed = b->reply.closed;
    CHECK(command(shell, TEST_FOREIGN_CLOSE, 2, 0, 0));
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    CHECK(b->reply.closed == closed + 1);
    CHECK(command(b, TEST_UNMAP, 0, 0, 0));
    CHECK(command(shell, TEST_QUERY, 0, 0, 0));
    CHECK(shell->reply.foreign_count == 1);
    CHECK(command(b, TEST_REMAP, 0, 0, 4));
    CHECK(second->mapped && second->minimized && desktop.focused == first);
    CHECK(command(shell, TEST_QUERY, 0, 0, 0));
    CHECK(shell->reply.foreign_count == 2);
    CHECK(command(shell, TEST_FOREIGN_ACTIVATE, 2, 0, 0));
    CHECK(!second->minimized && desktop.focused == second);
    return true;
}

static struct PuDesktopLayer *find_layer(int id)
{
    char name[64];
    snprintf(name, sizeof(name), "org.pollywm.layer.%d", id);
    struct PuDesktopLayer *layer;
    wl_list_for_each(layer, &desktop.layers, link)
        if (strcmp(layer->surface->namespace, name) == 0) return layer;
    return NULL;
}

static bool settle_decoration(struct PuDesktopView *view)
{
    for (int i = 0; i < 1000; i++) {
        if (!view->geometry_pending && pu_decoration_ready(view)) return true;
        CHECK(pump());
    }
    CHECK(false);
}
static bool decoration_click(struct TestClient *client, struct PuDesktopView *view, int part)
{
    struct wlr_box box;
    CHECK(settle_decoration(view));
    CHECK(pu_decoration_button_box(view, part, &box));
    motion(view->tree->node.x + box.x + box.width / 2.0,
           view->tree->node.y + box.y + box.height / 2.0);
    CHECK(desktop.seat->pointer_state.focused_surface == NULL);
    button(BTN_LEFT, true);
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(settle_decoration(view));
    return true;
}

static bool decoration_pixels(struct PuDesktopView *view, unsigned theme_id, uint64_t *hash)
{
    CHECK(settle_decoration(view));
    const struct PuDecorationLayout *theme = &pu_decoration_layouts[theme_id].layout;
    struct wlr_scene_output *output = wlr_scene_get_scene_output(desktop.scene, view->output);
    struct wlr_box bounds;
    wlr_output_layout_get_box(desktop.layout, view->output, &bounds);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_lock_attach_render(view->output, true);
    CHECK(wlr_scene_output_build_state(output, &state, NULL) && state.buffer);
    void *pixels;
    uint32_t format;
    size_t stride;
    CHECK(wlr_buffer_begin_data_ptr_access(state.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ,
                                           &pixels, &format, &stride));
    double scale = view->output->scale;
    int left = (int)((view->tree->node.x - bounds.x) * scale);
    int top = (int)((view->tree->node.y - theme->title_height - bounds.y) * scale);
    int width = (int)(view->toplevel->base->geometry.width * scale);
    int height = (int)(theme->title_height * scale);
    bool inside = left >= 0 && top >= 0 && left + width <= state.buffer->width &&
        top + height <= state.buffer->height;
    uint32_t sample = 0;
    *hash = 1469598103934665603ull;
    if (inside) {
        memcpy(&sample, (char *)pixels + (top + height / 2) * stride + (left + width / 2) * 4, 4);
        for (int y = top; y < top + height; y++)
            for (int x = left; x < left + width; x++) {
                uint32_t color;
                memcpy(&color, (char *)pixels + y * stride + x * 4, 4);
                *hash = (*hash ^ color) * 1099511628211ull;
            }
    }
    wlr_buffer_end_data_ptr_access(state.buffer);
    wlr_output_state_finish(&state);
    wlr_output_lock_attach_render(view->output, false);
    CHECK(inside && (format == DRM_FORMAT_XRGB8888 || format == DRM_FORMAT_ARGB8888));
    /* The independent C client sends a plain transport marker, not a theme painter. */
    CHECK((sample & 0xffffff) == ((theme_id + 1) * 0x200000 | 0x004000));
    return true;
}

static bool effect_pixel(struct PuDesktopView *view, int x, int y, uint32_t *pixel)
{
    struct wlr_scene_output *output = wlr_scene_get_scene_output(desktop.scene, view->output);
    struct wlr_box bounds;
    wlr_output_layout_get_box(desktop.layout, view->output, &bounds);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_lock_attach_render(view->output, true);
    bool built = wlr_scene_output_build_state(output, &state, NULL);
    wlr_output_lock_attach_render(view->output, false);
    CHECK(built && state.buffer);
    void *pixels; uint32_t format; size_t stride;
    CHECK(wlr_buffer_begin_data_ptr_access(state.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ,
        &pixels, &format, &stride));
    int px = (int)roundf((x - bounds.x) * view->output->scale);
    int py = (int)roundf((y - bounds.y) * view->output->scale);
    CHECK(px >= 0 && py >= 0 && px < state.buffer->width && py < state.buffer->height);
    memcpy(pixel, (char *)pixels + py * stride + px * 4, 4);
    wlr_buffer_end_data_ptr_access(state.buffer);
    wlr_output_state_finish(&state);
    CHECK(format == DRM_FORMAT_XRGB8888 || format == DRM_FORMAT_ARGB8888);
    return true;
}

static bool native_effect_suite(struct TestClient *client, struct PuDesktopView *view)
{
    CHECK(!view->effects->rounding);
    CHECK(command(&shell_client, TEST_EFFECT_APPEARANCE, PU_DECORATION_DEFAULT_LAYOUT, 0, 24));
    CHECK(command(client, TEST_EFFECT_SUBSURFACE, 1, 0, 0));
    CHECK(settle_decoration(view) && view->effects->rounding);
    struct wlr_box inset = {0};
    pu_decoration_inset(view, &inset, false);
    int left = view->tree->node.x - inset.x, top = view->tree->node.y - inset.y;
    int right = view->tree->node.x + view->toplevel->base->geometry.width + inset.x - 1;
    int bottom = view->tree->node.y + view->toplevel->base->geometry.height + inset.x - 1;
    int corners[][2] = {{left, top}, {right, top}, {left, bottom}, {right, bottom}};
    uint32_t hidden[4], shown;
    wlr_scene_node_set_enabled(&view->tree->node, false);
    for (unsigned i = 0; i < 4; i++)
        CHECK(effect_pixel(view, corners[i][0], corners[i][1], &hidden[i]));
    wlr_scene_node_set_enabled(&view->tree->node, true);
    for (unsigned i = 0; i < 4; i++) {
        CHECK(effect_pixel(view, corners[i][0], corners[i][1], &shown));
        CHECK((shown & 0xffffff) == (hidden[i] & 0xffffff));
    }
    CHECK(command(&shell_client, TEST_EFFECT_APPEARANCE, PU_DECORATION_DEFAULT_LAYOUT, 6, 24));
    CHECK(settle_decoration(view) && view->shadow->node.enabled && view->shadow->is_shadow);
    CHECK(fabsf(view->shadow->color[3] - 0.4f) < 0.001f);
    struct wlr_scene_rect *white = wlr_scene_rect_create(desktop.windows, 600, 500, (float[4]){1, 1, 1, 1});
    CHECK(white);
    wlr_scene_node_set_position(&white->node, left - 32, top - 32);
    wlr_scene_node_place_below(&white->node, &view->tree->node);
    int sample_x = right + 6, sample_y = view->tree->node.y + 30;
    wlr_scene_node_set_enabled(&view->shadow->node, false);
    uint32_t bare, shaded;
    CHECK(effect_pixel(view, sample_x, sample_y, &bare));
    wlr_scene_node_set_enabled(&view->shadow->node, true);
    CHECK(effect_pixel(view, sample_x, sample_y, &shaded));
    CHECK((bare & 255) > (shaded & 255) + 3);
    double nx, ny;
    CHECK(wlr_scene_node_at(&desktop.windows->node, sample_x, sample_y, &nx, &ny) != &view->shadow->node);
    wlr_scene_node_destroy(&white->node);
    pu_desktop_focus_mapped(&desktop, find_view(1)->workspace_window);
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && settle_decoration(view));
    CHECK(fabsf(view->shadow->color[3] - 0.15f) < 0.001f);
    pu_desktop_focus_mapped(&desktop, view->workspace_window);
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && settle_decoration(view));
    CHECK(fabsf(view->shadow->color[3] - 0.4f) < 0.001f);
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0) && !view->effects->rounding && !view->shadow->node.enabled);
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0) && settle_decoration(view) && view->effects->rounding);
    CHECK(view->shadow->node.enabled);
    CHECK(command(client, TEST_FULLSCREEN, 0, 0, 0) && !view->effects->rounding && !view->shadow->node.enabled);
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0) && settle_decoration(view) && view->effects->rounding);
    CHECK(command(client, TEST_DECORATION, 1, 0, 0) && !view->effects->rounding && !view->shadow->node.enabled);
    CHECK(command(client, TEST_DECORATION, 0, 0, 0) && settle_decoration(view) && view->effects->rounding);
    CHECK(command(client, TEST_EFFECT_SUBSURFACE, 0, 0, 0));
    CHECK(command(&shell_client, TEST_EFFECT_APPEARANCE, PU_DECORATION_DEFAULT_LAYOUT, 0, 0));
    CHECK(settle_decoration(view) && !view->effects->rounding && !view->shadow->node.enabled);
    puts("PASS: real client/subsurface four-corner clipping, true external non-input shadow, presented active/inactive opacity and maximize/fullscreen/CSD/none lifecycle");
    return true;
}

static bool current_native_frame(struct PuDesktopView *view)
{
    uint64_t id = view->workspace_window;
    for (int i = 0; i < 1000; i++) {
        struct PuDesktopView *candidate, *current = NULL;
        wl_list_for_each(candidate, &desktop.views, link)
            if (candidate == view && candidate->workspace_window == id) { current = candidate; break; }
        CHECK(current);
        if (pu_decoration_presented_current(current)) return true;
        CHECK(pump());
    }
    CHECK(false);
}

static bool title_restore_suite(struct TestClient *client, struct PuDesktopView *view, const char *path)
{
    CHECK(command(client, TEST_UNCONSTRAINED, 0, 0, 0) && current_native_frame(view));
    int buttons = client->reply.buttons;
    struct wlr_box saved = view->toplevel->base->geometry;
    for (int placement = 0; placement < 4; placement++) {
        if (placement == 0) CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
        else CHECK(snap_key(client, placement == 2 ? KEY_RIGHT : KEY_LEFT));
        if (placement == 3) CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
        CHECK(current_native_frame(view));
        enum PuDesktopMode mode = view->mode;
        struct wlr_box before = view->presented_box, inset = {0};
        pu_decoration_inset(view, &inset, false);
        double fraction = (placement % 3 + 1) / 4.0;
        int anchor = (int)(before.width * fraction);
        double x = before.x + anchor, y = before.y - inset.y / 2.0;
        CHECK(pu_decoration_hit(view, anchor, -inset.y / 2.0) == PU_DECORATION_TITLE);
        time_msec += 401;
        motion(x, y); button(BTN_LEFT, true);
        uint32_t serial = view->geometry_serial;
        CHECK(desktop.grab == PU_DESKTOP_MOVE && !view->geometry_pending && view->mode == mode);
        motion(x + 4, y);
        CHECK(view->geometry_serial == serial && !view->geometry_pending &&
            geometry_is(view, before.x, before.y, before.width, before.height));
        button(BTN_LEFT, false);
        CHECK(view->mode == mode && desktop.grab == PU_DESKTOP_PASSTHROUGH);

        time_msec += 401;
        motion(x, y);
        CHECK(command(client, TEST_HOLD, 0, 0, 0));
        button(BTN_LEFT, true); motion(x + 30, y + 50);
        CHECK(desktop.grab == PU_DESKTOP_MOVE && view->drag_restore_pending &&
            view->geometry_pending && view->mode == mode && !view->maximized && view->tile == PU_TILE_NONE);
        CHECK(geometry_is(view, before.x, before.y, before.width, before.height));
        double px = x + 60, py = y + 80;
        motion(px, py);
        int expected_x = (int)(px - (int)(saved.width * ((double)anchor / before.width)));
        int expected_y = (int)(py + inset.y / 2.0);
        CHECK(view->pending_box.x == expected_x && view->pending_box.y == expected_y &&
            view->pending_box.width == saved.width && view->pending_box.height == saved.height);
        if (placement == 1) {
            button(BTN_LEFT, false);
            CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH && view->geometry_pending);
            motion(px + 100, py + 100);
        }
        CHECK(command(client, TEST_RELEASE, 0, 0, 0) && current_native_frame(view));
        CHECK(view->mode == PU_DESKTOP_FLOATING && !view->drag_restore_pending &&
            geometry_is(view, expected_x, expected_y, saved.width, saved.height));
        CHECK(!client->reply.maximized && !client->reply.fullscreen && !client->reply.tiled);
        if (placement != 1) {
            motion(px + 17, py + 11);
            CHECK(geometry_is(view, expected_x + 17, expected_y + 11, saved.width, saved.height));
            button(BTN_LEFT, false);
        }
        CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
    }
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && client->reply.buttons == buttons);

    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0) && current_native_frame(view));
    double x = view->tree->node.x + 100, y = view->tree->node.y - 16;
    time_msec += 401;
    motion(x, y); button(BTN_LEFT, true); button(BTN_LEFT, false);
    CHECK(view->mode == PU_DESKTOP_MAXIMIZED && !view->geometry_pending);
    button(BTN_LEFT, true); button(BTN_LEFT, false);
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && current_native_frame(view));
    CHECK(view->mode == PU_DESKTOP_FLOATING);
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0) && current_native_frame(view));

    /* Client move/resize requests remain floating-only, even with a real serial. */
    motion(view->tree->node.x + 100, view->tree->node.y + 20);
    button(BTN_LEFT, true);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(command(client, TEST_MOVE, 0, client->reply.serial, 0));
    CHECK(command(client, TEST_RESIZE, 0, client->reply.serial, WLR_EDGE_RIGHT));
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH && view->maximized);
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_MOVE, 0, 0, 0) && desktop.grab == PU_DESKTOP_PASSTHROUGH);

    struct wlr_seat_keyboard_grab grab = {0};
    static const struct wlr_keyboard_grab_interface grab_impl = {0};
    grab.interface = &grab_impl;
    wlr_seat_keyboard_start_grab(desktop.seat, &grab);
    time_msec += 401;
    motion(x, y); button(BTN_LEFT, true); motion(x + 30, y + 50); button(BTN_LEFT, false);
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH && view->maximized);
    wlr_seat_keyboard_end_grab(desktop.seat);

    /* A workspace switch cancels both an armed and an admitted pending gesture. */
    for (int pending = 0; pending < 2; pending++) {
        CHECK(command(client, TEST_HOLD, 0, 0, 0));
        time_msec += 401;
        motion(x, y); button(BTN_LEFT, true);
        CHECK(desktop.grab == PU_DESKTOP_MOVE);
        if (pending) motion(x + 30, y + 50);
        struct PuWorkspace *workspace = desktop.active_workspace;
        pu_workspace_step(&desktop, 1);
        CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
        button(BTN_LEFT, false);
        pu_workspace_activate(&desktop, workspace, view);
        CHECK(command(client, TEST_RELEASE, 0, 0, 0) && current_native_frame(view));
        CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
        CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0) && current_native_frame(view));
    }
    for (int cancellation = 0; cancellation < 3; cancellation++) {
        CHECK(command(client, TEST_HOLD, 0, 0, 0));
        time_msec += 401;
        motion(x, y); button(BTN_LEFT, true); motion(x + 30, y + 50);
        CHECK(view->geometry_pending && view->drag_restore_pending);
        if (cancellation == 0) {
            CHECK(command(client, TEST_MINIMIZE, 0, 0, 0) && view->minimized);
            CHECK(command(&shell_client, TEST_FOREIGN_ACTIVATE, 7, 0, 0));
        } else if (cancellation == 1) {
            CHECK(resize_output(view->output, 1279, 720, 1));
            CHECK(!view->drag_restore_pending);
            CHECK(resize_output(view->output, 1280, 720, 1));
        } else {
            char locker[PATH_MAX];
            const char *slash = strrchr(path, '/');
            CHECK(slash && snprintf(locker, sizeof(locker), "%.*s/polly-lock-test-client",
                (int)(slash - path), path) < (int)sizeof(locker));
            char *args[] = {locker, "unlock", NULL};
            CHECK(pu_session_lock_spawn(&desktop, args) && pu_session_lock_active(&desktop));
            CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
            for (int i = 0; i < 600 && pu_session_lock_active(&desktop); i++) CHECK(pump());
            CHECK(!pu_session_lock_active(&desktop));
        }
        CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
        button(BTN_LEFT, false);
        CHECK(command(client, TEST_RELEASE, 0, 0, 0) && current_native_frame(view));
        int frozen_x = view->tree->node.x, frozen_y = view->tree->node.y;
        motion(x + 80, y + 100);
        CHECK(view->tree->node.x == frozen_x && view->tree->node.y == frozen_y);
        CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0) && current_native_frame(view));
    }
    CHECK(command(client, TEST_HOLD, 0, 0, 0));
    time_msec += 401;
    motion(x, y); button(BTN_LEFT, true); motion(x + 30, y + 50);
    CHECK(view->geometry_pending && view->drag_restore_pending);
    CHECK(command(client, TEST_FULLSCREEN, 0, 0, 0));
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH && !view->drag_restore_pending);
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_RELEASE, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_FULLSCREEN);
    CHECK(command(client, TEST_MOVE, 0, 0, 0) && desktop.grab == PU_DESKTOP_PASSTHROUGH);
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0) && current_native_frame(view));
    struct TestRequest limits = {.command = TEST_LIMITS,
        .layer = {.width = saved.width + 30, .height = saved.height + 20}};
    CHECK(exchange(client, &limits));
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0) && current_native_frame(view));
    time_msec += 401;
    motion(x, y); button(BTN_LEFT, true); motion(x + 30, y + 50);
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && current_native_frame(view));
    CHECK(view->mode == PU_DESKTOP_FLOATING && view->presented_box.width == saved.width + 30 &&
        view->presented_box.height == saved.height + 20);
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_UNCONSTRAINED, 0, 0, 0));
    struct TestRequest size = {.command = TEST_CLIENT_SIZE,
        .layer = {.width = saved.width, .height = saved.height}};
    CHECK(exchange(client, &size) && current_native_frame(view));
    puts("PASS: native max/left/right/max-from-tile drag restore retains floating size, pointer anchor, >5px threshold, double click, pending motion/release, client serial/size guards and configure/workspace/minimize/output/lock cancellation");
    return true;
}

static bool decoration_suite(const char *path)
{
    struct TestClient *client = &clients[2];
    CHECK(spawn_client(client, path));
    CHECK(command(client, TEST_MAP, 7, 0, 8));
    struct PuDesktopView *view = find_view(7);
    CHECK(view && client->reply.decoration_mode == 2 && !client->reply.appearance_capability);
    CHECK(shell_client.reply.appearance_capability);
    if (!nested) CHECK(native_effect_suite(client, view));
    struct wlr_box box;
    CHECK(pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    CHECK(pu_decoration_hit(view, 80, -16) == PU_DECORATION_TITLE);
    int x = view->tree->node.x, y = view->tree->node.y;
    int buttons_before = client->reply.buttons;
    motion(x + 80, y - 16);
    button(BTN_LEFT, true);
    CHECK(desktop.grab == PU_DESKTOP_MOVE);
    motion(x + 110, y + 4);
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(view->tree->node.x == x + 30 && view->tree->node.y == y + 20);
    x = view->tree->node.x; y = view->tree->node.y;
    int width = client->reply.width, height = client->reply.height;
    struct wlr_box resize_inset = {0};
    pu_decoration_inset(view, &resize_inset, false);
    double edge = resize_inset.x / 2.0;
    CHECK(edge > 0);
    motion(x + width + edge, y + height + edge);
    button(BTN_LEFT, true);
    CHECK(desktop.grab == PU_DESKTOP_RESIZE);
    motion(x + width + edge + 30, y + height + edge + 25);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(client->reply.width == width + 30 && client->reply.height == height + 25);
    CHECK(client->reply.buttons == buttons_before);
    struct wlr_box inset = { .width = width, .height = height };
    pu_decoration_inset(view, &inset, false);
    double resize_top = y - inset.y + edge;
    motion(x - edge, resize_top);
    button(BTN_LEFT, true);
    CHECK(desktop.grab == PU_DESKTOP_RESIZE && desktop.grab_edges == (WLR_EDGE_TOP | WLR_EDGE_LEFT));
    motion(x - edge + 10, resize_top + 8);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(view, x + 10, y + 8, width + 20, height + 17));
    motion(x - edge, resize_top);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(view, x, y, width + 30, height + 25));
    CHECK(decoration_click(client, view, PU_DECORATION_MINIMIZE));
    CHECK(view->minimized && !view->tree->node.enabled);
    CHECK(command(&shell_client, TEST_FOREIGN_ACTIVATE, 7, 0, 0));
    CHECK(!view->minimized && desktop.focused == view);
    CHECK(command(client, TEST_HOLD, 0, 0, 0));
    CHECK(command(client, TEST_DECORATION, 1, 0, 0));
    CHECK(view->geometry_pending && pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    CHECK(command(client, TEST_RELEASE, 0, 0, 0));
    CHECK(client->reply.decoration_mode == 1 && !pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    CHECK(command(client, TEST_DECORATION, 0, 0, 0));
    CHECK(client->reply.decoration_mode == 2 && pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    /* Decoration geometry covers the full work area; constrained maximize has
     * its own real native window-contract fixture. */
    CHECK(command(client, TEST_UNCONSTRAINED, 0, 0, 0));
    CHECK(title_restore_suite(client, view, path));
    CHECK(decoration_click(client, view, PU_DECORATION_MAXIMIZE));
    CHECK(view->mode == PU_DESKTOP_MAXIMIZED);
    CHECK(pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    motion(view->tree->node.x + box.x + box.width / 2.0, view->tree->node.y + box.y + box.height / 2.0);
    button(BTN_LEFT, true);
    motion(view->tree->node.x + 50, view->tree->node.y + 50);
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && client->reply.closed == 0);
    struct wlr_box full, content;
    CHECK(command(&clients[0], TEST_QUERY, 0, 0, 0));
    int csd_configures = clients[0].reply.configured;
    for (unsigned theme = 0; theme < PU_DECORATION_LAYOUT_COUNT; theme++) {
        CHECK(command(&shell_client, TEST_APPEARANCE, (int)theme, 0, 0));
        CHECK(command(client, TEST_QUERY, 0, 0, 0));
        wlr_output_layout_get_box(desktop.layout, view->output, &full);
        content = full;
        pu_decoration_inset(view, &content, false);
        CHECK(content.y == full.y + pu_decoration_layouts[theme].layout.title_height);
        CHECK(geometry_is(view, content.x, content.y, content.width, content.height));
        CHECK(pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
        CHECK(pu_decoration_layouts[theme].layout.left_controls ? box.x < 20 : box.x > content.width / 2);
        uint64_t before, after;
        CHECK(decoration_pixels(view, theme, &before));
        if (!theme) {
            CHECK(command(client, TEST_RENAME, 0, 0, 0));
            CHECK(decoration_pixels(view, theme, &after) && before != after);
        }
    }
    CHECK(command(&clients[0], TEST_QUERY, 0, 0, 0));
    CHECK(clients[0].reply.configured == csd_configures);
    if (!nested) {
        struct wlr_output_state state;
        wlr_output_state_init(&state);
        wlr_output_state_set_scale(&state, 1.25f);
        CHECK(wlr_output_commit_state(view->output, &state));
        wlr_output_state_finish(&state);
        CHECK(command(client, TEST_QUERY, 0, 0, 0));
        uint64_t hash;
        CHECK(decoration_pixels(view, PU_DECORATION_LAYOUT_COUNT - 1, &hash));
        wlr_output_state_init(&state);
        wlr_output_state_set_scale(&state, 1);
        CHECK(wlr_output_commit_state(view->output, &state));
        wlr_output_state_finish(&state);
        CHECK(command(client, TEST_QUERY, 0, 0, 0));
        struct wlr_backend *backend = NULL;
        wlr_multi_for_each_backend(desktop.backend, find_headless, &backend);
        CHECK(backend);
        struct wlr_output *extra = wlr_headless_add_output(backend, 800, 600);
        CHECK(extra);
        wlr_output_state_init(&state);
        wlr_output_state_set_scale(&state, 1.25f);
        CHECK(wlr_output_commit_state(extra, &state));
        wlr_output_state_finish(&state);
        CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
        struct wlr_box destination;
        wlr_output_layout_get_box(desktop.layout, extra, &destination);
        motion(view->tree->node.x + 80, view->tree->node.y - 20);
        button(BTN_LEFT, true);
        CHECK(desktop.grab == PU_DESKTOP_MOVE);
        motion(destination.x + 180, destination.y + 60);
        button(BTN_LEFT, false);
        CHECK(pu_desktop_view_scale(view) == 1.25);
        CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
        CHECK(view->output == extra && decoration_pixels(view, PU_DECORATION_LAYOUT_COUNT - 1, &hash));
        wlr_output_destroy(extra);
        CHECK(command(client, TEST_QUERY, 0, 0, 0));
        CHECK(pu_desktop_view_scale(view) == 1 && decoration_pixels(view, PU_DECORATION_LAYOUT_COUNT - 1, &hash));
        CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
        motion(view->tree->node.x + 80, view->tree->node.y - 20);
        button(BTN_LEFT, true);
        CHECK(desktop.grab == PU_DESKTOP_MOVE);
        motion(x + 80, y - 20);
        button(BTN_LEFT, false);
        CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    }
    CHECK(command(client, TEST_FULLSCREEN, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_FULLSCREEN && !pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_MAXIMIZED && pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    CHECK(command(client, TEST_HOLD, 0, 0, 0));
    CHECK(command(&shell_client, TEST_APPEARANCE, 0, 0, 0));
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    content = full; pu_decoration_inset(view, &content, false);
    CHECK(content.y == full.y + pu_decoration_layouts[PU_DECORATION_LAYOUT_COUNT - 1].layout.title_height);
    CHECK(command(client, TEST_RELEASE, 0, 0, 0));
    content = full; pu_decoration_inset(view, &content, false);
    CHECK(content.y == full.y + pu_decoration_layouts[0].layout.title_height);
    CHECK(decoration_click(client, view, PU_DECORATION_MAXIMIZE));
    CHECK(view->mode == PU_DESKTOP_FLOATING);
    CHECK(geometry_is(view, x, y, width + 30, height + 25));
    time_msec += 500;
    motion(view->tree->node.x + 80, view->tree->node.y - 16);
    button(BTN_LEFT, true); button(BTN_LEFT, false);
    button(BTN_LEFT, true); button(BTN_LEFT, false);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_MAXIMIZED);
    CHECK(decoration_click(client, view, PU_DECORATION_CLOSE));
    CHECK(client->reply.closed == 1 && find_view(7) == view);
    CHECK(command(client, TEST_DECORATION_DESTROY, 0, 0, 0));
    CHECK(!pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    CHECK(command(client, TEST_DESTROY, 0, 0, 0));
    CHECK(command(client, TEST_MAP, 7, 0, 8 | 16));
    view = find_view(7);
    CHECK(view && client->reply.decoration_mode == 1 && !pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    CHECK(command(client, TEST_DECORATION, 2, 0, 0));
    CHECK(pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    uint32_t committed = view->toplevel->base->current.configure_serial;
    struct wlr_client_buffer *buffer = view->toplevel->base->surface->buffer;
    CHECK(command(client, TEST_HOLD, 0, 0, 0));
    CHECK(command(&shell_client, TEST_APPEARANCE, 1, 0, 0));
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(!view->geometry_pending && view->toplevel->base->current.configure_serial == committed);
    CHECK(view->toplevel->base->surface->buffer == buffer);
    inset = (struct wlr_box){0};
    pu_decoration_inset(view, &inset, false);
    CHECK(inset.y == pu_decoration_layouts[1].layout.title_height);
    pu_desktop_redecorate(view);
    CHECK(!view->geometry_pending && view->toplevel->base->surface->buffer == buffer);
    int before_x = view->tree->node.x, before_y = view->tree->node.y;
    motion(before_x + 80, before_y - inset.y / 2.0);
    button(BTN_LEFT, true);
    CHECK(desktop.grab == PU_DESKTOP_MOVE);
    motion(before_x + 110, before_y - inset.y / 2.0 + 20);
    button(BTN_LEFT, false);
    CHECK(view->tree->node.x == before_x + 30 && view->tree->node.y == before_y + 20);
    int idle_width = view->toplevel->base->geometry.width, idle_height = view->toplevel->base->geometry.height;
    motion(view->tree->node.x + idle_width + 1, view->tree->node.y + idle_height + 1);
    button(BTN_LEFT, true);
    CHECK(desktop.grab == PU_DESKTOP_RESIZE);
    motion(view->tree->node.x + idle_width + 21, view->tree->node.y + idle_height + 16);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(view->resize_pending && view->toplevel->base->geometry.width == idle_width &&
        view->toplevel->base->geometry.height == idle_height);
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_RELEASE, 0, 0, 0));
    CHECK(view->toplevel->base->geometry.width == idle_width + 20 &&
        view->toplevel->base->geometry.height == idle_height + 15 && !view->resize_pending);
    CHECK(pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    motion(view->tree->node.x + box.x + box.width / 2.0, view->tree->node.y + box.y + box.height / 2.0);
    button(BTN_LEFT, true);
    CHECK(desktop.decoration_pressed == view);
    CHECK(command(client, TEST_DESTROY, 0, 0, 0));
    CHECK(desktop.decoration_pressed == NULL);
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_QUIT, 0, 0, 0));
    CHECK(command(&shell_client, TEST_FOREIGN_ACTIVATE, 2, 0, 0));
    return true;
}

static bool workspace_suite(void)
{
    struct TestClient *shell = &shell_client, *a = &clients[0], *b = &clients[1];
    struct PuDesktopView *first = find_view(1), *second = find_view(2);
    CHECK(command(shell, TEST_QUERY, 0, 0, 0));
    CHECK(shell->reply.workspace_capability && shell->reply.workspace_count == 4 && shell->reply.workspace_active == 0);
    CHECK(!a->reply.workspace_capability && !b->reply.workspace_capability);
    struct PuWorkspace *original = desktop.active_workspace;
    struct wlr_foreign_toplevel_handle_v1 *handle = second->foreign;
    CHECK(command(shell, TEST_FOREIGN_ACTIVATE, 1, 0, 0));
    motion(first->tree->node.x + 10, first->tree->node.y + 10);
    button(BTN_LEFT, true);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    int keys = a->reply.keys;
    int done = shell->reply.workspace_done;
    CHECK(command(shell, TEST_WORKSPACE_ACTIVATE, 1, 0, 0));
    CHECK(desktop.active_workspace == original && shell->reply.workspace_done == done);
    CHECK(command(shell, TEST_WORKSPACE_COMMIT, 0, 0, 0));
    CHECK(desktop.active_workspace == pu_workspace_at(&desktop, 1));
    CHECK(first->mapped && second->mapped && !first->minimized && !second->minimized);
    CHECK(!first->tree->node.enabled && !second->tree->node.enabled && !desktop.focused);
    CHECK(second->foreign == handle && shell->reply.workspace_done == done + 1);
    key(KEY_A, true); key(KEY_A, false);
    CHECK(command(a, TEST_QUERY, 0, 0, 0) && a->reply.keys == keys);
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    int buttons = b->reply.buttons;
    CHECK(command(b, TEST_TRANSIENT, 1, 0, 0));
    struct PuDesktopView *extra = find_view(8);
    CHECK(extra && pu_workspace_current(extra) && desktop.focused == extra);
    motion(extra->tree->node.x + 20, extra->tree->node.y + 20);
    button(BTN_LEFT, false);
    CHECK(command(b, TEST_QUERY, 0, 0, 0) && b->reply.buttons == buttons);
    CHECK(command(b, TEST_DESTROY, 4, 0, 0));
    key(KEY_LEFTALT, true); key(KEY_TAB, true); key(KEY_TAB, false); key(KEY_LEFTALT, false);
    CHECK(!desktop.focused && desktop.active_workspace != original);
    key(KEY_LEFTCTRL, true); key(KEY_LEFTMETA, true); key(KEY_LEFT, true);
    key(KEY_LEFT, false); key(KEY_LEFTMETA, false); key(KEY_LEFTCTRL, false);
    CHECK(desktop.active_workspace == original && desktop.focused == first);
    CHECK(command(shell, TEST_WORKSPACE_MOVE, 2, 0, 1));
    CHECK(second->workspace == original);
    CHECK(command(shell, TEST_WORKSPACE_COMMIT, 0, 0, 0));
    CHECK(second->workspace == pu_workspace_at(&desktop, 1) && !second->tree->node.enabled);
    CHECK(command(shell, TEST_FOREIGN_QUERY, 2, 0, 0) && shell->reply.foreign_workspace == 1);
    CHECK(command(shell, TEST_FOREIGN_RESTORE, 2, 0, 0));
    CHECK(!second->tree->node.enabled && desktop.active_workspace == original);
    CHECK(command(shell, TEST_FOREIGN_ACTIVATE, 2, 0, 0));
    CHECK(pu_workspace_current(second) && desktop.focused == second);
    CHECK(command(b, TEST_POPUP, 0, 0, 0));
    CHECK(!wl_list_empty(&second->toplevel->base->popups));
    CHECK(command(shell, TEST_WORKSPACE_ACTIVATE, 0, 0, 0));
    CHECK(command(shell, TEST_WORKSPACE_COMMIT, 0, 0, 0));
    CHECK(wl_list_empty(&second->toplevel->base->popups));
    CHECK(command(b, TEST_DESTROY_POPUP, 0, 0, 0));
    CHECK(command(b, TEST_POPUP, 0, 0, 0));
    CHECK(wl_list_empty(&second->toplevel->base->popups));
    CHECK(command(b, TEST_DESTROY_POPUP, 0, 0, 0));
    CHECK(command(b, TEST_TRANSIENT, 0, 0, 0));
    extra = find_view(8);
    CHECK(extra && extra->workspace == second->workspace && !extra->tree->node.enabled && desktop.focused == first);
    CHECK(command(shell, TEST_WORKSPACE_MOVE, 8, 0, 0));
    CHECK(command(shell, TEST_WORKSPACE_COMMIT, 0, 0, 0));
    CHECK(extra->workspace == original && second->workspace == original && desktop.focused == first);
    CHECK(command(b, TEST_DESTROY, 4, 0, 0));
    CHECK(command(shell, TEST_WORKSPACE_MOVE, 2, 0, 1));
    CHECK(command(b, TEST_UNMAP, 0, 0, 0));
    CHECK(command(b, TEST_REMAP, 0, 0, 0));
    CHECK(command(shell, TEST_WORKSPACE_COMMIT, 0, 0, 0));
    CHECK(second->workspace == original && pu_workspace_current(second));
    CHECK(command(shell, TEST_QUERY, 0, 0, 0));
    done = shell->reply.workspace_done;
    CHECK(command(shell, TEST_WORKSPACE_CREATE, 0, 0, 0));
    CHECK(command(shell, TEST_WORKSPACE_ACTIVATE, 1, 0, 0));
    CHECK(command(shell, TEST_WORKSPACE_MOVE, 2, 0, 1));
    CHECK(desktop.active_workspace == original && shell->reply.workspace_count == 4);
    CHECK(command(shell, TEST_WORKSPACE_COMMIT, 0, 0, 0));
    CHECK(shell->reply.workspace_count == 5 && shell->reply.workspace_done == done + 1);
    CHECK(pu_workspace_current(second) && !pu_workspace_current(first));
    CHECK(command(shell, TEST_WORKSPACE_REMOVE, 1, 0, 0));
    CHECK(command(shell, TEST_WORKSPACE_COMMIT, 0, 0, 0));
    CHECK(desktop.active_workspace == original && second->workspace == original);
    CHECK(command(shell, TEST_WORKSPACE_REMOVE, 0, 0, 0));
    CHECK(command(shell, TEST_WORKSPACE_COMMIT, 0, 0, 0));
    CHECK(desktop.active_workspace == pu_workspace_at(&desktop, 0));
    CHECK(pu_workspace_current(first) && pu_workspace_current(second) && first->mapped && second->mapped);
    while (shell->reply.workspace_count > 1) {
        CHECK(command(shell, TEST_WORKSPACE_REMOVE, shell->reply.workspace_count - 1, 0, 0));
        CHECK(command(shell, TEST_WORKSPACE_COMMIT, 0, 0, 0));
    }
    CHECK(command(shell, TEST_WORKSPACE_REMOVE, 0, 0, 0));
    CHECK(command(shell, TEST_WORKSPACE_COMMIT, 0, 0, 0));
    CHECK(shell->reply.workspace_count == 1);
    for (int i = 0; i < 3; i++) CHECK(command(shell, TEST_WORKSPACE_CREATE, 0, 0, 0));
    CHECK(command(shell, TEST_WORKSPACE_COMMIT, 0, 0, 0) && shell->reply.workspace_count == 4);
    CHECK(command(shell, TEST_FOREIGN_ACTIVATE, 2, 0, 0));
    return true;
}

static bool snap_key(struct TestClient *client, uint32_t code)
{
    key(KEY_LEFTMETA, true); key(code, true); key(code, false); key(KEY_LEFTMETA, false);
    return command(client, TEST_QUERY, 0, 0, 0);
}

static bool menu_place(uint32_t serial, uint32_t epoch, enum PuDesktopTile tile, bool accepted)
{
    uint32_t results = shell_client.reply.placement_results;
    struct TestRequest request = { .command = TEST_MENU_PLACE, .id = 2,
        .serial = serial, .edges = epoch, .layer = { .width = tile } };
    CHECK(exchange(&shell_client, &request));
    CHECK(shell_client.reply.placement_results == results + 1 &&
        shell_client.reply.placement_serial == serial &&
        shell_client.reply.placement_accepted == accepted);
    if (!accepted) CHECK(shell_client.reply.placement_message[0]);
    return true;
}

static bool menu_placement_suite(struct TestClient *client, struct PuDesktopView *view, const char *path)
{
    struct TestLayer menu = { .layer = ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY,
        .anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP | ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT,
        .width = 300, .height = 300, .zone = -1,
        .keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE };
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, menu));
    struct PuDesktopLayer *layer = find_layer(3);
    CHECK(layer && desktop.focused_layer == layer && layer->presented);
    pu_desktop_focus_mapped(&desktop, find_view(1)->workspace_window);
    CHECK(desktop.focused == find_view(1) && desktop.focused_layer == layer);
    struct wlr_box original = view->presented_box;
    original.x = view->tree->node.x; original.y = view->tree->node.y;
    uint32_t serial = 1;
    CHECK(command(&shell_client, TEST_MENU_OPEN, 2, serial++, 0));
    uint32_t epoch = shell_client.reply.placement_epoch;
    CHECK(epoch && shell_client.reply.placement_accepted);
    uint32_t geometry = view->geometry_serial;
    CHECK(snap_key(client, KEY_LEFT) && view->geometry_serial == geometry);
    CHECK(command(client, TEST_HOLD, 0, 0, 0));
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, true));
    CHECK(view->geometry_pending && view->mode == PU_DESKTOP_FLOATING &&
        shell_client.reply.placement == PU_TILE_NONE && shell_client.reply.placement_pending);
    geometry = view->geometry_serial;
    CHECK(menu_place(serial - 1, epoch, PU_TILE_RIGHT, false) && view->geometry_serial == geometry);
    CHECK(menu_place(serial++, epoch, PU_TILE_RIGHT, false) && view->geometry_serial == geometry);
    CHECK(command(client, TEST_RELEASE, 0, 0, 0) && settle_decoration(view));
    CHECK(view->mode == PU_DESKTOP_TILED_LEFT);
    CHECK(command(&shell_client, TEST_FOREIGN_QUERY, 2, 0, 0) &&
        shell_client.reply.placement == PU_TILE_LEFT && !shell_client.reply.placement_pending);
    for (enum PuDesktopTile tile = PU_TILE_RIGHT; ; tile = PU_TILE_NONE) {
        CHECK(command(&shell_client, TEST_MENU_OPEN, 2, serial++, 0));
        epoch = shell_client.reply.placement_epoch;
        CHECK(menu_place(serial++, epoch, tile, true));
        CHECK(command(client, TEST_QUERY, 0, 0, 0) && settle_decoration(view));
        if (tile == PU_TILE_NONE) break;
        CHECK(view->mode == PU_DESKTOP_TILED_RIGHT);
    }
    CHECK(geometry_is(view, original.x, original.y, original.width, original.height));
    CHECK(command(&shell_client, TEST_MENU_OPEN, 2, serial++, 0));
    epoch = shell_client.reply.placement_epoch;
    geometry = view->geometry_serial;
    struct PuDesktopView *focused = desktop.focused;
    CHECK(menu_place(0, epoch, PU_TILE_LEFT, false));
    CHECK(menu_place(serial++, epoch + 1, PU_TILE_LEFT, false));
    CHECK(menu_place(serial++, epoch, (enum PuDesktopTile)99, false));
    CHECK(view->geometry_serial == geometry && desktop.focused == focused && desktop.focused_layer == layer);
    struct TestLayer blocker = { .layer = ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY,
        .anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM, .width = 120, .height = 40, .zone = 40,
        .keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE };
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 4, blocker));
    CHECK(desktop.focused_layer == find_layer(4));
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, false) && desktop.focused == focused);
    blocker.layer = ZWLR_LAYER_SHELL_V1_LAYER_TOP;
    blocker.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 4, blocker) && desktop.focused_layer == layer);
    CHECK(command(&shell_client, TEST_SHORTCUT_RECORDING, 1, 0, 0));
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, false));
    CHECK(command(&shell_client, TEST_SHORTCUT_RECORDING, 0, 0, 0));
    struct wlr_seat_keyboard_grab grab = {0};
    static const struct wlr_keyboard_grab_interface grab_impl = {0};
    grab.interface = &grab_impl;
    wlr_seat_keyboard_start_grab(desktop.seat, &grab);
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, false) && view->geometry_serial == geometry);
    wlr_seat_keyboard_end_grab(desktop.seat);
    char locker[PATH_MAX];
    const char *slash = strrchr(path, '/');
    CHECK(slash && snprintf(locker, sizeof(locker), "%.*s/polly-lock-test-client", (int)(slash - path), path) <
        (int)sizeof(locker));
    char *lock_args[] = {locker, "unlock", NULL};
    CHECK(pu_session_lock_spawn(&desktop, lock_args) && pu_session_lock_active(&desktop));
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, false) && view->geometry_serial == geometry);
    for (int i = 0; i < 600 && pu_session_lock_active(&desktop); i++) CHECK(pump());
    CHECK(!pu_session_lock_active(&desktop));
    CHECK(command(client, TEST_FULLSCREEN, 0, 0, 0));
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, false));
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0) && settle_decoration(view));
    struct TestRequest limits = { .command = TEST_LIMITS, .layer = { .width = 2000, .height = 100 } };
    CHECK(exchange(client, &limits));
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, false));
    CHECK(command(client, TEST_UNCONSTRAINED, 0, 0, 0));
    CHECK(command(&shell_client, TEST_FOREIGN_MINIMIZE, 2, 0, 0));
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, false) && view->minimized);
    CHECK(command(&shell_client, TEST_FOREIGN_RESTORE, 2, 0, 0));
    CHECK(command(&shell_client, TEST_MENU_CLOSE, 2, 0, epoch));
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, false));
    CHECK(command(&shell_client, TEST_MENU_OPEN, 2, serial++, 0));
    epoch = shell_client.reply.placement_epoch;
    struct PuWorkspace *workspace = desktop.active_workspace;
    pu_workspace_step(&desktop, 1);
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, false));
    pu_workspace_activate(&desktop, workspace, view);
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, false));
    CHECK(command(&shell_client, TEST_MENU_OPEN, 2, serial++, 0));
    epoch = shell_client.reply.placement_epoch;
    CHECK(command(&shell_client, TEST_UNMAP, 0, 0, 0));
    CHECK(command(&shell_client, TEST_REMAP, 0, 0, 0));
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, false));
    CHECK(command(&shell_client, TEST_MENU_OPEN, 2, serial++, 0));
    epoch = shell_client.reply.placement_epoch;
    menu.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, menu));
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, false));
    menu.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, menu));
    CHECK(command(client, TEST_REFUSE_TILE, 1, 0, 0));
    CHECK(menu_place(serial++, epoch, PU_TILE_LEFT, true));
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && settle_decoration(view));
    CHECK(view->tile == PU_TILE_NONE && view->mode == PU_DESKTOP_FLOATING &&
        geometry_is(view, original.x, original.y, original.width, original.height));
    CHECK(command(client, TEST_REFUSE_TILE, 0, 0, 0));
    CHECK(command(&shell_client, TEST_MENU_OPEN, 2, serial++, 0));
    epoch = shell_client.reply.placement_epoch;
    CHECK(command(client, TEST_UNMAP, 0, 0, 0));
    CHECK(command(&shell_client, TEST_QUERY, 0, 0, 0));
    uint32_t results = shell_client.reply.placement_results;
    CHECK(command(&shell_client, TEST_MENU_RETIRED_PLACE, 0, serial++, epoch));
    CHECK(shell_client.reply.placement_results == results);
    CHECK(command(client, TEST_REMAP, 0, 0, 0) && settle_decoration(view));
    CHECK(command(client, TEST_UNCONSTRAINED, 0, 0, 0));
    geometry = view->geometry_serial;
    CHECK(command(&shell_client, TEST_MENU_RETIRED_PLACE, 0, serial++, epoch));
    CHECK(shell_client.reply.placement_results == results && view->geometry_serial == geometry);
    struct TestLayer top = { .layer = ZWLR_LAYER_SHELL_V1_LAYER_TOP,
        .anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP | ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT |
            ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT, .height = 32, .zone = 32 };
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    blocker.layer = ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 4, blocker));
    blocker.layer = ZWLR_LAYER_SHELL_V1_LAYER_TOP;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 4, blocker));
    pu_desktop_focus_mapped(&desktop, view->workspace_window);
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && settle_decoration(view));
    puts("PASS: private menu v3 admits once, separates ACK/presentation, rejects serial/epoch/focus/grab/recording/fullscreen/minimized/limits/workspace/unmap, and recovers declined size");
    return true;
}

static bool snap_suite(struct TestClient *client, struct PuDesktopView *view, const char *path)
{
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
    struct wlr_box original = view->toplevel->base->geometry;
    original.x = view->tree->node.x; original.y = view->tree->node.y;
    struct wlr_output *output = view->output;
    CHECK(resize_output(output, 1281, 721, 1));
    CHECK(snap_key(client, KEY_LEFT));
    CHECK(view->mode == PU_DESKTOP_TILED_LEFT && !view->maximized && !view->fullscreen);
    CHECK(geometry_is(view, 0, 32, 640, 649) && client->reply.tiled == 15);
    CHECK(!client->reply.maximized && !client->reply.fullscreen);
    CHECK(wlr_box_equal(&view->floating_box, &original));
    CHECK(snap_key(client, KEY_LEFT));
    CHECK(geometry_is(view, 0, 32, 640, 649) && wlr_box_equal(&view->floating_box, &original));
    key(KEY_LEFTMETA, true); key(KEY_LEFT, true);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    uint32_t repeat_serial = view->geometry_serial;
    key(KEY_LEFT, true);
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && view->geometry_serial == repeat_serial);
    key(KEY_LEFT, false); key(KEY_LEFTMETA, false);
    CHECK(snap_key(client, KEY_RIGHT));
    CHECK(geometry_is(view, 640, 32, 641, 649) && view->mode == PU_DESKTOP_TILED_RIGHT);
    CHECK(wlr_box_equal(&view->floating_box, &original));
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_MAXIMIZED && client->reply.tiled == 0);
    CHECK(command(client, TEST_FULLSCREEN, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_FULLSCREEN && client->reply.tiled == 0);
    CHECK(snap_key(client, KEY_LEFT) && view->mode == PU_DESKTOP_FULLSCREEN);
    CHECK(snap_key(client, KEY_DOWN) && view->mode == PU_DESKTOP_FULLSCREEN);
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_MAXIMIZED);
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_TILED_RIGHT && geometry_is(view, 640, 32, 641, 649));
    CHECK(command(client, TEST_FULLSCREEN, 0, 0, 0));
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_TILED_RIGHT);
    motion(660, 60); button(BTN_LEFT, true);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(command(client, TEST_MOVE, 0, client->reply.serial, 0));
    CHECK(command(client, TEST_RESIZE, 0, client->reply.serial, WLR_EDGE_LEFT));
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
    button(BTN_LEFT, false);
    CHECK(snap_key(client, KEY_DOWN));
    CHECK(view->mode == PU_DESKTOP_FLOATING && !client->reply.tiled && !view->minimized);
    CHECK(geometry_is(view, original.x, original.y, original.width, original.height));

    /* The client commits an old size, but must not acquire the latest placement. */
    CHECK(command(client, TEST_HOLD, 0, 0, 0));
    CHECK(snap_key(client, KEY_LEFT));
    CHECK(snap_key(client, KEY_RIGHT));
    CHECK(view->geometry_pending && view->mode == PU_DESKTOP_FLOATING);
    CHECK(command(client, TEST_APPLY_FIRST, 0, 0, 0));
    CHECK(view->geometry_pending && view->mode == PU_DESKTOP_FLOATING &&
        view->tree->node.x == original.x && view->tree->node.y == original.y);
    CHECK(command(client, TEST_RELEASE, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_TILED_RIGHT && geometry_is(view, 640, 32, 641, 649));
    CHECK(snap_key(client, KEY_DOWN));
    CHECK(geometry_is(view, original.x, original.y, original.width, original.height));
    CHECK(command(client, TEST_HOLD, 0, 0, 0));
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(snap_key(client, KEY_LEFT));
    CHECK(wlr_box_equal(&view->floating_box, &original));
    CHECK(command(client, TEST_RELEASE, 0, 0, 0));
    CHECK(snap_key(client, KEY_DOWN));
    CHECK(geometry_is(view, original.x, original.y, original.width, original.height));

    for (int limit = 0; limit < 3; limit++) {
        struct TestRequest request = { .command = TEST_LIMITS, .layer =
            limit == 0 ? (struct TestLayer){ .width = 700, .height = 100 } :
            limit == 1 ? (struct TestLayer){ .right = 600, .bottom = 400 } :
            (struct TestLayer){ .width = 240, .height = 160, .right = 240, .bottom = 160 } };
        CHECK(exchange(client, &request));
        uint32_t serial = view->geometry_serial;
        CHECK(snap_key(client, KEY_LEFT));
        CHECK(view->mode == PU_DESKTOP_FLOATING && view->tile == PU_TILE_NONE &&
            !view->geometry_pending && view->geometry_serial == serial);
        CHECK(geometry_is(view, original.x, original.y, original.width, original.height));
    }
    CHECK(command(client, TEST_UNCONSTRAINED, 0, 0, 0));
    CHECK(command(client, TEST_REFUSE_TILE, 1, 0, 0));
    CHECK(snap_key(client, KEY_LEFT));
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(view->tile == PU_TILE_NONE && view->mode == PU_DESKTOP_FLOATING && !view->geometry_pending);
    CHECK(geometry_is(view, original.x, original.y, original.width, original.height));
    CHECK(command(client, TEST_REFUSE_TILE, 0, 0, 0));
    CHECK(snap_key(client, KEY_LEFT));
    key(KEY_LEFTCTRL, true);
    CHECK(snap_key(client, KEY_RIGHT));
    key(KEY_LEFTCTRL, false);
    CHECK(!pu_workspace_current(view) && !view->tree->node.enabled);
    CHECK(snap_key(client, KEY_DOWN));
    CHECK(view->tile == PU_TILE_LEFT);
    key(KEY_LEFTCTRL, true);
    CHECK(snap_key(client, KEY_LEFT));
    key(KEY_LEFTCTRL, false);
    CHECK(pu_workspace_current(view));
    CHECK(command(&shell_client, TEST_FOREIGN_ACTIVATE, 2, 0, 0));
    CHECK(snap_key(client, KEY_DOWN));

    struct TestRequest binding = { .command = TEST_SHORTCUT_BIND,
        .id = PU_SHORTCUT_TILE_LEFT, .serial = PU_SHORTCUT_SUPER, .key = "h" };
    CHECK(exchange(&shell_client, &binding));
    CHECK(command(&shell_client, TEST_SHORTCUT_COMMIT, 0, 1, 0));
    CHECK(!shell_client.reply.shortcut_error[0]);
    CHECK(snap_key(client, KEY_LEFT) && view->tile == PU_TILE_NONE);
    CHECK(snap_key(client, KEY_H) && view->tile == PU_TILE_LEFT);
    CHECK(snap_key(client, KEY_DOWN));
    binding.id = PU_SHORTCUT_CLOSE;
    CHECK(exchange(&shell_client, &binding));
    CHECK(command(&shell_client, TEST_SHORTCUT_COMMIT, 0, 2, 0) && shell_client.reply.shortcut_error[0]);
    CHECK(snap_key(client, KEY_H) && view->tile == PU_TILE_LEFT);
    CHECK(snap_key(client, KEY_DOWN));
    binding.id = PU_SHORTCUT_TILE_LEFT; binding.key[0] = 0; binding.serial = 0;
    CHECK(exchange(&shell_client, &binding));
    CHECK(command(&shell_client, TEST_SHORTCUT_COMMIT, 0, 3, 0) && !shell_client.reply.shortcut_error[0]);
    CHECK(snap_key(client, KEY_H) && view->tile == PU_TILE_NONE);
    binding.serial = PU_SHORTCUT_SUPER; strcpy(binding.key, "Left");
    CHECK(exchange(&shell_client, &binding));
    CHECK(command(&shell_client, TEST_SHORTCUT_COMMIT, 0, 4, 0) && !shell_client.reply.shortcut_error[0]);
    CHECK(snap_key(client, KEY_LEFT));
    char locker[PATH_MAX];
    const char *slash = strrchr(path, '/');
    CHECK(slash && snprintf(locker, sizeof(locker), "%.*s/polly-lock-test-client", (int)(slash - path), path) <
        (int)sizeof(locker));
    char *lock_args[] = {locker, "crash", NULL};
    uint32_t lock_serial = view->geometry_serial;
    CHECK(pu_session_lock_spawn(&desktop, lock_args));
    CHECK(pu_session_lock_active(&desktop) && !desktop.seat->keyboard_state.focused_surface);
    CHECK(snap_key(client, KEY_RIGHT));
    pu_desktop_shortcut_action(&desktop, PU_SHORTCUT_RESTORE_FLOATING, false);
    CHECK(view->tile == PU_TILE_LEFT && view->geometry_serial == lock_serial);
    for (int i = 0; i < 600 && pu_session_lock_pid(&desktop); i++) CHECK(pump());
    CHECK(!pu_session_lock_pid(&desktop));
    lock_args[1] = "unlock";
    CHECK(pu_session_lock_spawn(&desktop, lock_args));
    for (int i = 0; i < 600 && pu_session_lock_active(&desktop); i++) CHECK(pump());
    CHECK(!pu_session_lock_active(&desktop));
    CHECK(command(&shell_client, TEST_FOREIGN_ACTIVATE, 2, 0, 0));
    CHECK(snap_key(client, KEY_DOWN));

    CHECK(command(client, TEST_DECORATION, WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE, 0, 0));
    CHECK(settle_decoration(view));
    CHECK(snap_key(client, KEY_RIGHT) && settle_decoration(view));
    struct wlr_box content = {640, 32, 641, 649};
    pu_decoration_inset(view, &content, false);
    CHECK(geometry_is(view, content.x, content.y, content.width, content.height));
    CHECK(!view->shadow->node.enabled && !view->maximized && client->reply.tiled == 15);
    CHECK(command(&shell_client, TEST_APPEARANCE, 0, 0, 0));
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && settle_decoration(view));
    content = (struct wlr_box){640, 32, 641, 649};
    pu_decoration_inset(view, &content, false);
    CHECK(geometry_is(view, content.x, content.y, content.width, content.height));
    CHECK(snap_key(client, KEY_DOWN) && settle_decoration(view));
    CHECK(geometry_is(view, original.x, original.y, original.width, original.height));
    pid_t renderer = pu_decorator_pid(&desktop);
    CHECK(renderer > 0 && kill(renderer, SIGSTOP) == 0);
    struct TestRequest size = { .command = TEST_CLIENT_SIZE,
        .layer = { .width = original.width + 37, .height = original.height + 29 } };
    CHECK(exchange(client, &size));
    CHECK(view->mode == PU_DESKTOP_FLOATING && !pu_decoration_ready(view) &&
        view->toplevel->base->geometry.width == original.width + 37);
    CHECK(snap_key(client, KEY_LEFT));
    CHECK(wlr_box_equal(&view->floating_box, &original));
    CHECK(kill(renderer, SIGCONT) == 0);
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && settle_decoration(view));
    CHECK(snap_key(client, KEY_DOWN) && settle_decoration(view));
    CHECK(geometry_is(view, original.x, original.y, original.width, original.height));
    CHECK(kill(renderer, SIGSTOP) == 0);
    size.layer.width += 4; size.layer.height += 4;
    CHECK(exchange(client, &size) && !pu_decoration_ready(view));
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(wlr_box_equal(&view->restore_box, &original));
    CHECK(kill(renderer, SIGCONT) == 0);
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && settle_decoration(view));
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0) && settle_decoration(view));
    CHECK(geometry_is(view, original.x, original.y, original.width, original.height));
    size.layer.width = original.width + 37; size.layer.height = original.height + 29;
    CHECK(exchange(client, &size) && settle_decoration(view));
    time_msec += 500;
    motion(original.x + 80, original.y - 16); button(BTN_LEFT, true);
    CHECK(desktop.grab == PU_DESKTOP_MOVE);
    motion(original.x + 91, original.y - 3); button(BTN_LEFT, false);
    original.x += 11; original.y += 13;
    CHECK(snap_key(client, KEY_LEFT) && settle_decoration(view));
    CHECK(view->floating_box.x == original.x && view->floating_box.y == original.y &&
        view->floating_box.width == size.layer.width && view->floating_box.height == size.layer.height);
    CHECK(snap_key(client, KEY_DOWN) && settle_decoration(view));
    CHECK(geometry_is(view, original.x, original.y, size.layer.width, size.layer.height));
    size.layer.width = original.width; size.layer.height = original.height;
    CHECK(exchange(client, &size) && settle_decoration(view));
    puts("PASS: tile restore retains last frame-presented floating size, not an unfenced client buffer");
    CHECK(command(client, TEST_DECORATION, WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE, 0, 0));
    CHECK(settle_decoration(view));
    CHECK(resize_output(output, 1280, 720, 1));
    puts("PASS: real snap odd partition, panel/Dock work area, restore, delayed ACK, limits, max/full, drag, workspaces and decoration frame fence");
    return true;
}

static bool layer_suite(const char *path)
{
    if (!pu_decorator_configured(&desktop)) {
        char *renderer[] = {(char *)path, "--trusted", "-1", NULL};
        CHECK(pu_decorator_spawn(&desktop, renderer));
        for (int i = 0; i < 600 && pu_decorator_status(&desktop, NULL) != 2; i++) CHECK(pump());
        CHECK(pu_decorator_status(&desktop, NULL) == 2);
    }
    int sockets[2];
    CHECK(socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sockets) == 0);
    CHECK(fcntl(sockets[0], F_SETFD, FD_CLOEXEC) == 0);
    int inherited = fcntl(sockets[1], F_DUPFD, 4);
    close(sockets[1]);
    CHECK(inherited >= 4);
    char fd[32];
    snprintf(fd, sizeof(fd), "%d", inherited);
    char *args[] = { (char *)path, "--trusted", fd, NULL };
    bool started = pu_desktop_spawn_shell(&desktop, args);
    close(inherited);
    shell_client.control = sockets[0];
    CHECK(started);
    CHECK(command(&shell_client, TEST_QUERY, 0, 0, 0));
    CHECK(shell_client.reply.layer_capability == 1);
    CHECK(shell_client.reply.shortcut_version == 2 &&
        shell_client.reply.shortcut_mask == (1u << PU_SHORTCUT_COUNT) - 1);
    CHECK(command(&clients[1], TEST_QUERY, 0, 0, 0));
    CHECK(!clients[1].reply.layer_capability);
    CHECK(!clients[1].reply.shortcut_version);
    CHECK(foreign_suite());
    CHECK(decoration_suite(path));
    CHECK(workspace_suite());
    struct PuDesktopView *view = find_view(2);
    struct wlr_box full;
    wlr_output_layout_get_box(desktop.layout, view->output, &full);
    struct TestLayer top = {
        .layer = ZWLR_LAYER_SHELL_V1_LAYER_TOP,
        .anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP |
            ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT | ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT,
        .height = 32, .zone = 32,
    };
    CHECK(layer_command(TEST_LAYER_MAP, 3, top));
    struct PuDesktopLayer *layer = find_layer(3);
    CHECK(layer && layer->surface->surface->mapped);
    CHECK(layer->tree->node.x == full.x && layer->tree->node.y == full.y);
    CHECK(shell_client.reply.width == full.width && shell_client.reply.height == 32);
    CHECK(desktop.focused == view && !desktop.focused_layer);
    CHECK(command(&clients[1], TEST_UNCONSTRAINED, 0, 0, 0));
    CHECK(command(&clients[1], TEST_MAXIMIZE, 0, 0, 0));
    CHECK(geometry_is(view, full.x, full.y + 32, full.width, full.height - 32));
    struct TestLayer dock = {
        .layer = ZWLR_LAYER_SHELL_V1_LAYER_TOP,
        .anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM,
        .width = 120, .height = 40, .zone = 40,
    };
    CHECK(layer_command(TEST_LAYER_MAP, 4, dock));
    struct PuDesktopLayer *extra = find_layer(4);
    CHECK(extra && extra->tree->node.y == full.y + full.height - 40);
    CHECK(command(&clients[1], TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(view, full.x, full.y + 32, full.width, full.height - 72));
    CHECK(snap_suite(&clients[1], view, path));
    CHECK(menu_placement_suite(&clients[1], view, path));
    CHECK(command(&clients[1], TEST_MAXIMIZE, 0, 0, 0));
    dock.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE;
    top.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 4, dock));
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(desktop.focused_layer == extra);
    CHECK(command(&shell_client, TEST_SHORTCUT_RECORDING, 1, 0, 0));
    CHECK(snap_key(&clients[1], KEY_LEFT) && view->mode == PU_DESKTOP_MAXIMIZED);
    CHECK(command(&shell_client, TEST_SHORTCUT_RECORDING, 0, 0, 0));
    top.layer = ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(desktop.focused_layer == layer);
    top.layer = ZWLR_LAYER_SHELL_V1_LAYER_TOP;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(desktop.focused_layer == layer);
    top.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(desktop.focused_layer == extra);
    CHECK(command(&shell_client, TEST_DESTROY, 4, 0, 0));
    CHECK(!find_layer(4) && !desktop.focused_layer);
    CHECK(command(&clients[1], TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(view, full.x, full.y + 32, full.width, full.height - 32));

    CHECK(command(&clients[1], TEST_FULLSCREEN, 0, 0, 0));
    CHECK(geometry_is(view, full.x, full.y, full.width, full.height));
    CHECK(!layer->tree->node.enabled);
    top.layer = ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(layer->tree->node.enabled);
    top.layer = ZWLR_LAYER_SHELL_V1_LAYER_TOP;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(!layer->tree->node.enabled);
    CHECK(command(&clients[1], TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(layer->tree->node.enabled);
    CHECK(geometry_is(view, full.x, full.y + 32, full.width, full.height - 32));

    top.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_ON_DEMAND;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(!desktop.focused_layer);
    motion(full.x + 10, full.y + 10);
    button(BTN_LEFT, true);
    button(BTN_LEFT, false);
    CHECK(desktop.focused_layer == layer);
    int keys = shell_client.reply.keys;
    key(KEY_A, true);
    key(KEY_A, false);
    CHECK(command(&shell_client, TEST_QUERY, 0, 0, 0));
    CHECK(shell_client.reply.focused == 3 && shell_client.reply.keys == keys + 2);
    top.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(!desktop.focused_layer && desktop.focused == view);
    top.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(desktop.focused_layer == layer);
    motion(full.x + 10, full.y + 80);
    button(BTN_LEFT, true);
    button(BTN_LEFT, false);
    CHECK(desktop.focused_layer == layer);
    CHECK(desktop.seat->keyboard_state.focused_surface == layer->surface->surface);

    CHECK(command(&shell_client, TEST_POPUP, 1, 0, 0));
    CHECK(shell_client.reply.popups > 0 && shell_client.reply.popup_y + 40 > top.height);
    CHECK(command(&shell_client, TEST_CHILD_POPUP, 1, 0, 0));
    CHECK(shell_client.reply.popups > 1);
    CHECK(command(&shell_client, TEST_DESTROY_POPUP, 0, 0, 0));
    CHECK(command(&shell_client, TEST_HOLD, 0, 0, 0));
    top.top = 5;
    top.height = top.zone = 48;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(shell_client.reply.pending > 0 && layer->tree->node.y == full.y);
    CHECK(command(&shell_client, TEST_RELEASE, 0, 0, 0));
    CHECK(layer->tree->node.y == full.y + 5 && shell_client.reply.height == 48);
    CHECK(command(&clients[1], TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(view, full.x, full.y + 53, full.width, full.height - 53));
    int configured = shell_client.reply.configured;
    for (int i = 0; i < 20; i++) CHECK(pump());
    CHECK(command(&shell_client, TEST_QUERY, 0, 0, 0));
    CHECK(shell_client.reply.configured == configured);

    CHECK(command(&shell_client, TEST_UNMAP, 0, 0, 0));
    CHECK(!layer->tree->node.enabled && !desktop.focused_layer);
    CHECK(command(&clients[1], TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(view, full.x, full.y, full.width, full.height));
    CHECK(command(&shell_client, TEST_REMAP, 0, 0, 0));
    CHECK(layer->surface->surface->mapped && desktop.focused_layer == layer);
    CHECK(command(&shell_client, TEST_DESTROY, 0, 0, 0));
    CHECK(wl_list_empty(&desktop.layers) && !desktop.focused_layer);
    top.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE;
    top.top = 0;
    top.height = top.zone = 32;
    CHECK(command(&shell_client, TEST_HOLD, 0, 0, 0));
    CHECK(layer_command(TEST_LAYER_MAP, 3, top));
    layer = find_layer(3);
    CHECK(layer && !layer->tree->node.enabled && shell_client.reply.pending == 1);
    top.height = top.zone = 48;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(shell_client.reply.pending == 2);
    CHECK(command(&shell_client, TEST_APPLY_FIRST, 0, 0, 0));
    CHECK(layer->surface->surface->mapped && !layer->tree->node.enabled);
    CHECK(command(&shell_client, TEST_RELEASE, 0, 0, 0));
    CHECK(layer->tree->node.enabled && shell_client.reply.height == 48);
    top.zone = INT_MAX;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(command(&clients[1], TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(view, full.x, full.y + full.height - 1, full.width, 1));
    top.left = INT_MAX;
    int closed = shell_client.reply.closed;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(shell_client.reply.closed == closed + 1 && !find_layer(3));
    CHECK(!desktop.failed);
    CHECK(command(&shell_client, TEST_DESTROY, 0, 0, 0));
    struct TestLayer background = {
        .layer = ZWLR_LAYER_SHELL_V1_LAYER_BACKGROUND, .zone = -1,
        .anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP | ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM |
            ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT | ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT,
    };
    CHECK(layer_command(TEST_LAYER_MAP, 3, background));
    CHECK(command(&clients[0], TEST_MAXIMIZE, 0, 0, 0));
    key(KEY_LEFTALT, true); key(KEY_TAB, true); key(KEY_TAB, false); key(KEY_LEFTALT, false);
    CHECK(desktop.focused == find_view(1));
    CHECK(command(&clients[0], TEST_QUERY, 0, 0, 0));
    CHECK(scene_pixel(view->output, 0x3b82f6));
    background.layer = ZWLR_LAYER_SHELL_V1_LAYER_BOTTOM;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, background));
    CHECK(scene_pixel(view->output, 0x3b82f6));
    background.layer = ZWLR_LAYER_SHELL_V1_LAYER_TOP;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, background));
    CHECK(scene_pixel(view->output, 0x10b981));
    background.layer = ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, background));
    CHECK(command(&clients[0], TEST_FULLSCREEN, 0, 0, 0));
    CHECK(scene_pixel(view->output, 0x10b981));
    background.layer = ZWLR_LAYER_SHELL_V1_LAYER_TOP;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, background));
    CHECK(scene_pixel(view->output, 0x3b82f6));
    CHECK(command(&clients[0], TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(command(&shell_client, TEST_DESTROY, 0, 0, 0));
    CHECK(command(&clients[0], TEST_UNMAXIMIZE, 0, 0, 0));
    key(KEY_LEFTALT, true); key(KEY_TAB, true); key(KEY_TAB, false); key(KEY_LEFTALT, false);
    CHECK(desktop.focused == view);
    top.left = 0;
    top.height = top.zone = 32;
    CHECK(layer_output_suite(top));
    top.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE;
    CHECK(layer_command(TEST_LAYER_MAP, 3, top));
    CHECK(command(&shell_client, TEST_POPUP, 1, 0, 0));
    CHECK(command(&shell_client, TEST_CHILD_POPUP, 1, 0, 0));
    CHECK(kill(desktop.shell_pid, SIGKILL) == 0);
    close(shell_client.control);
    shell_client.control = -1;
    for (int i = 0; i < 1000 && desktop.shell_pid; i++) CHECK(pump());
    CHECK(!desktop.shell_pid && desktop.shell_exited && WIFSIGNALED(desktop.shell_status) &&
          WTERMSIG(desktop.shell_status) == SIGKILL);
    CHECK(wl_list_empty(&desktop.layers) && !desktop.focused_layer && desktop.focused == view);
    CHECK(command(&clients[1], TEST_QUERY, 0, 0, 0));
    wlr_output_layout_get_box(desktop.layout, view->output, &full);
    CHECK(geometry_is(view, full.x, full.y, full.width, full.height));
    CHECK(command(&clients[1], TEST_UNMAXIMIZE, 0, 0, 0));
    return true;
}

static bool state_suite(struct TestClient *client, struct PuDesktopView *view)
{
    struct wlr_box bounds;
    wlr_output_layout_get_box(desktop.layout, view->output, &bounds);
    int x = view->tree->node.x, y = view->tree->node.y;
    int width = view->toplevel->base->geometry.width, height = view->toplevel->base->geometry.height;
    CHECK(client->reply.max_capability && client->reply.full_capability);
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(client->reply.maximized && !client->reply.fullscreen);
    CHECK(geometry_is(view, bounds.x, bounds.y, bounds.width, bounds.height));
    CHECK(view->mode == PU_DESKTOP_MAXIMIZED && desktop.focused == view);
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(command(client, TEST_FULLSCREEN, 0, 0, 0));
    CHECK(client->reply.maximized && client->reply.fullscreen);
    CHECK(view->backdrop->node.enabled);
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(client->reply.maximized && !client->reply.fullscreen);
    CHECK(!view->backdrop->node.enabled);
    CHECK(geometry_is(view, bounds.x, bounds.y, bounds.width, bounds.height));
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
    CHECK(geometry_is(view, x, y, width, height));

    CHECK(command(client, TEST_FULLSCREEN, 0, 0, 0));
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_MAXIMIZED);
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
    CHECK(geometry_is(view, x, y, width, height));
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(command(client, TEST_FULLSCREEN, 0, 0, 0));
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_FULLSCREEN && !view->maximized);
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(geometry_is(view, x, y, width, height));

    /* Delayed and skipped buffers must not change placement or the restore box. */
    CHECK(command(client, TEST_HOLD, 0, 0, 0));
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(view->geometry_pending && geometry_is(view, x, y, width, height));
    pu_desktop_redecorate(view);
    CHECK(view->geometry_pending && geometry_is(view, x, y, width, height));
    CHECK(command(client, TEST_FULLSCREEN, 0, 0, 0));
    CHECK(client->reply.pending >= 2);
    CHECK(command(client, TEST_APPLY_FIRST, 0, 0, 0));
    CHECK(view->geometry_pending && view->tree->node.x == x && view->tree->node.y == y);
    CHECK(command(client, TEST_RELEASE, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_FULLSCREEN && !view->geometry_pending);
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(command(client, TEST_HOLD, 0, 0, 0));
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(command(client, TEST_RELEASE, 0, 0, 0));
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
    CHECK(geometry_is(view, x, y, width, height));

    CHECK(command(client, TEST_SMALL_FULLSCREEN, 1, 0, 0));
    CHECK(command(client, TEST_FULLSCREEN, 0, 0, 0));
    CHECK(view->backdrop->width == bounds.width && view->backdrop->height == bounds.height);
    CHECK(view->content->node.x == (bounds.width - 240) / 2);
    CHECK(view->content->node.y == (bounds.height - 160) / 2);
    CHECK(fullscreen_pixels(view));
    motion(bounds.x + 1, bounds.y + 1);
    button(BTN_LEFT, true); button(BTN_LEFT, false);
    CHECK(desktop.focused == view);
    motion(bounds.x + view->content->node.x + 10, bounds.y + view->content->node.y + 10);
    button(BTN_LEFT, true);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(command(client, TEST_MOVE, 0, client->reply.serial, 0));
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
    CHECK(command(client, TEST_RESIZE, 0, client->reply.serial, WLR_EDGE_RIGHT));
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
    button(BTN_LEFT, false);
    key(KEY_LEFTALT, true);
    button(BTN_LEFT, true); button(BTN_LEFT, false);
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
    key(KEY_F11, true); key(KEY_F11, false);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_FLOATING && geometry_is(view, x, y, width, height));
    key(KEY_F10, true); key(KEY_F10, false);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_MAXIMIZED);
    key(KEY_F10, true); key(KEY_F10, false);
    key(KEY_LEFTALT, false);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(view, x, y, width, height));
    CHECK(command(client, TEST_SMALL_FULLSCREEN, 0, 0, 0));

    /* Entering a state during a client-requested drag cancels the interaction. */
    motion(x + 10, y + 10);
    button(BTN_LEFT, true);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(command(client, TEST_RESIZE, 0, client->reply.serial, WLR_EDGE_RIGHT));
    CHECK(desktop.grab == PU_DESKTOP_RESIZE);
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH && !view->resize_pending);
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
    CHECK(geometry_is(view, x, y, width, height));

    /* Requests before the initial commit and remap must not reuse old geometry. */
    CHECK(command(client, TEST_DESTROY, 0, 0, 0));
    CHECK(command(client, TEST_MAP, 2, 0, 3));
    view = find_view(2);
    CHECK(view && view->mode == PU_DESKTOP_FULLSCREEN);
    CHECK(geometry_is(view, bounds.x, bounds.y, bounds.width, bounds.height));
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_MAXIMIZED);
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
    CHECK(client->reply.width == 240 && client->reply.height == 160);
    CHECK(command(client, TEST_FULLSCREEN, 0, 0, 0));
    CHECK(command(client, TEST_UNMAP, 0, 0, 0));
    CHECK(command(client, TEST_REMAP, 0, 0, 0));
    CHECK(view->mode == PU_DESKTOP_FLOATING && !view->fullscreen && !view->maximized);
    CHECK(client->reply.width == 240 && client->reply.height == 160);
    return true;
}

static bool popup_inside(struct PuDesktopView *view, struct wlr_xdg_popup *popup,
                         const struct wlr_box *bounds)
{
    struct wlr_scene_tree *tree = popup->base->data;
    int x, y;
    CHECK(wlr_scene_node_coords(&tree->node, &x, &y));
    CHECK(x >= bounds->x && y >= bounds->y);
    CHECK(x + popup->current.geometry.width <= bounds->x + bounds->width);
    CHECK(y + popup->current.geometry.height <= bounds->y + bounds->height);
    CHECK(desktop.focused == view);
    return true;
}

static bool popup_suite(struct TestClient *client, struct PuDesktopView *view)
{
    struct wlr_box bounds;
    wlr_output_layout_get_box(desktop.layout, view->output, &bounds);
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(command(client, TEST_POPUP, 1, 0, 0));
    struct wlr_xdg_popup *popup = wl_container_of(view->toplevel->base->popups.next, popup, link);
    CHECK(popup_inside(view, popup, &bounds));
    CHECK(command(client, TEST_CHILD_POPUP, 1, 0, 0));
    struct wlr_xdg_popup *child = wl_container_of(popup->base->popups.next, child, link);
    CHECK(popup_inside(view, child, &bounds));
    CHECK(command(client, TEST_REPOSITION_POPUP, 0, 77, 0));
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(client->reply.repositioned == 77);
    CHECK(popup_inside(view, popup, &bounds));
    CHECK(popup_inside(view, child, &bounds));
    CHECK(command(client, TEST_DESTROY_POPUP, 0, 0, 0));
    CHECK(command(client, TEST_POPUP, 2, 0, 0));
    popup = wl_container_of(view->toplevel->base->popups.next, popup, link);
    int popup_x = popup->current.geometry.x, popup_y = popup->current.geometry.y;
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
    CHECK(popup->current.geometry.x == popup_x && popup->current.geometry.y == popup_y);
    CHECK(command(client, TEST_DESTROY_POPUP, 0, 0, 0));
    return true;
}

static void find_headless(struct wlr_backend *backend, void *data)
{
    if (wlr_backend_is_headless(backend)) *(struct wlr_backend **)data = backend;
}

static bool resize_output(struct wlr_output *output, int width, int height, float scale)
{
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_custom_mode(&state, width, height, 60000);
    wlr_output_state_set_scale(&state, scale);
    bool ok = wlr_output_commit_state(output, &state);
    wlr_output_state_finish(&state);
    CHECK(ok);
    return true;
}

static bool layer_output_suite(struct TestLayer options)
{
    if (nested) return true;
    struct wlr_backend *backend = NULL;
    wlr_multi_for_each_backend(desktop.backend, find_headless, &backend);
    CHECK(backend);
    struct wlr_output *extra = wlr_headless_add_output(backend, 800, 600);
    CHECK(extra && wlr_output_layout_add(desktop.layout, extra, -900, -100));
    CHECK(command(&shell_client, TEST_QUERY, 0, 0, 0));
    CHECK(shell_client.reply.output_count == 2);
    options.output = 2;
    CHECK(layer_command(TEST_LAYER_MAP, 3, options));
    struct PuDesktopLayer *layer = find_layer(3);
    CHECK(layer && layer->surface->output == extra);
    CHECK(layer->tree->node.x == -900 && layer->tree->node.y == -100);
    CHECK(shell_client.reply.width == 800 && shell_client.reply.height == 32);
    CHECK(resize_output(extra, 1200, 1000, 2));
    CHECK(command(&shell_client, TEST_QUERY, 0, 0, 0));
    CHECK(shell_client.reply.width == 600 && shell_client.reply.height == 32);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_transform(&state, WL_OUTPUT_TRANSFORM_90);
    CHECK(wlr_output_commit_state(extra, &state));
    wlr_output_state_finish(&state);
    CHECK(command(&shell_client, TEST_QUERY, 0, 0, 0));
    CHECK(shell_client.reply.width == 500);
    CHECK(command(&shell_client, TEST_POPUP, 1, 0, 0));
    CHECK(shell_client.reply.popup_x >= 0 && shell_client.reply.popup_x + 80 <= 500);
    CHECK(command(&shell_client, TEST_CHILD_POPUP, 1, 0, 0));
    int closed = shell_client.reply.closed;
    wlr_output_state_init(&state);
    wlr_output_state_set_enabled(&state, false);
    CHECK(wlr_output_commit_state(extra, &state));
    wlr_output_state_finish(&state);
    CHECK(command(&shell_client, TEST_QUERY, 0, 0, 0));
    CHECK(shell_client.reply.closed == closed + 1 && !find_layer(3));
    CHECK(command(&shell_client, TEST_DESTROY, 0, 0, 0));
    wlr_output_state_init(&state);
    wlr_output_state_set_enabled(&state, true);
    CHECK(wlr_output_commit_state(extra, &state));
    wlr_output_state_finish(&state);
    CHECK(command(&shell_client, TEST_QUERY, 0, 0, 0));
    CHECK(layer_command(TEST_LAYER_MAP, 3, options));
    CHECK(find_layer(3));
    closed = shell_client.reply.closed;
    wlr_output_destroy(extra);
    CHECK(command(&shell_client, TEST_QUERY, 0, 0, 0));
    CHECK(shell_client.reply.closed == closed + 1 && !find_layer(3));
    CHECK(command(&shell_client, TEST_DESTROY, 0, 0, 0));
    return true;
}

static bool output_suite(struct TestClient *client)
{
    if (nested) return true;
    struct wlr_backend *backend = NULL;
    wlr_multi_for_each_backend(desktop.backend, find_headless, &backend);
    CHECK(backend);
    struct wlr_output_layout_output *first =
        wl_container_of(desktop.layout->outputs.next, first, link);
    struct wlr_output *original = first->output;
    struct wlr_output *extra = wlr_headless_add_output(backend, 800, 600);
    CHECK(extra && desktop.output_count == 2);
    CHECK(wlr_output_layout_add(desktop.layout, original, 0, 0));
    CHECK(wlr_output_layout_add(desktop.layout, extra, -1000, -100));
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(client->reply.output_count == 2);
    motion(-900, 0);
    CHECK(command(client, TEST_DESTROY, 0, 0, 0));
    CHECK(command(client, TEST_MAP, 2, 0, 0));
    struct PuDesktopView *view = find_view(2);
    CHECK(view && view->output == extra && view->tree->node.x < 0);
    int x = view->tree->node.x, y = view->tree->node.y;
    CHECK(command(client, TEST_UNCONSTRAINED, 0, 0, 0));
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(geometry_is(view, -1000, -100, 800, 600));
    CHECK(resize_output(extra, 1000, 700, 1.25f));
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(view, -1000, -100, 800, 560));
    struct wlr_output_state transform;
    wlr_output_state_init(&transform);
    wlr_output_state_set_transform(&transform, WL_OUTPUT_TRANSFORM_90);
    CHECK(wlr_output_commit_state(extra, &transform));
    wlr_output_state_finish(&transform);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(view, -1000, -100, 560, 800));
    wlr_output_state_init(&transform);
    wlr_output_state_set_transform(&transform, WL_OUTPUT_TRANSFORM_NORMAL);
    CHECK(wlr_output_commit_state(extra, &transform));
    wlr_output_state_finish(&transform);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(command(client, TEST_FULLSCREEN, 1, 0, 0));
    CHECK(view->output == original);
    CHECK(geometry_is(view, 0, 0, 1280, 720));
    CHECK(command(client, TEST_FULLSCREEN, 2, 0, 0));
    CHECK(view->output == extra);
    CHECK(geometry_is(view, -1000, -100, 800, 560));
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
    CHECK(geometry_is(view, x, y, 240, 160));
    CHECK(command(client, TEST_FULLSCREEN, 1, 0, 0));
    CHECK(view->output == original);
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(view->output == extra && geometry_is(view, x, y, 240, 160));
    CHECK(popup_suite(client, view));

    CHECK(command(client, TEST_HOLD, 0, 0, 0));
    CHECK(command(client, TEST_FULLSCREEN, 2, 0, 0));
    wlr_output_destroy(extra);
    CHECK(desktop.output_count == 1);
    CHECK(command(client, TEST_RELEASE, 0, 0, 0));
    CHECK(view->output == original && view->mode == PU_DESKTOP_FULLSCREEN);
    CHECK(geometry_is(view, 0, 0, 1280, 720));
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(geometry_is(view, 0, 0, 240, 160));

    extra = wlr_headless_add_output(backend, 801, 601);
    CHECK(extra && wlr_output_layout_add(desktop.layout, extra, -1000, -100));
    wlr_scene_node_set_position(&view->tree->node, -950, -50);
    CHECK(snap_key(client, KEY_LEFT));
    CHECK(view->output == extra && geometry_is(view, -1000, -100, 400, 601));
    CHECK(resize_output(extra, 1000, 700, 1.25f));
    CHECK(command(client, TEST_QUERY, 0, 0, 0) && geometry_is(view, -1000, -100, 400, 560));
    CHECK(command(client, TEST_HOLD, 0, 0, 0) && snap_key(client, KEY_RIGHT));
    wlr_output_destroy(extra);
    CHECK(command(client, TEST_APPLY_FIRST, 0, 0, 0) && view->geometry_pending);
    CHECK(command(client, TEST_RELEASE, 0, 0, 0));
    CHECK(view->output == original && view->mode == PU_DESKTOP_TILED_RIGHT &&
        geometry_is(view, 640, 0, 640, 720));
    CHECK(snap_key(client, KEY_DOWN) && geometry_is(view, 0, 0, 240, 160));

    /* Keep a constrained window's origin visible even when its minimum exceeds the output. */
    extra = wlr_headless_add_output(backend, 100, 60);
    CHECK(extra);
    CHECK(wlr_output_layout_add(desktop.layout, extra, 1400, 0));
    motion(1410, 10);
    CHECK(command(client, TEST_DESTROY, 0, 0, 0));
    CHECK(command(client, TEST_MAP, 2, 0, 0));
    view = find_view(2);
    CHECK(view && view->tree->node.x == 1400 && view->tree->node.y == 0);
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(geometry_is(view, 1400, 0, 120, 80));
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_enabled(&state, false);
    CHECK(wlr_output_commit_state(extra, &state));
    wlr_output_state_finish(&state);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(view->output == original && geometry_is(view, 0, 0, 600, 400));
    wlr_output_state_init(&state);
    wlr_output_state_set_enabled(&state, true);
    CHECK(wlr_output_commit_state(extra, &state));
    wlr_output_state_finish(&state);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(client->reply.output_count == 2);
    /* Configured-but-not-yet-mapped windows participate in output migration. */
    CHECK(command(client, TEST_DESTROY, 0, 0, 0));
    struct wlr_box extra_box;
    wlr_output_layout_get_box(desktop.layout, extra, &extra_box);
    motion(extra_box.x + 10, extra_box.y + 10);
    CHECK(command(client, TEST_HOLD, 0, 0, 0));
    CHECK(command(client, TEST_MAP, 2, 0, 2));
    CHECK(!find_view(2));
    wlr_output_destroy(extra);
    CHECK(command(client, TEST_RELEASE, 0, 0, 0));
    view = find_view(2);
    CHECK(view && view->output == original && view->mode == PU_DESKTOP_FULLSCREEN);
    CHECK(geometry_is(view, 0, 0, 1280, 720));
    CHECK(command(client, TEST_UNFULLSCREEN, 0, 0, 0));
    CHECK(command(client, TEST_UNMAXIMIZE, 0, 0, 0));
    CHECK(view->tree->node.x >= 0 && view->tree->node.x + 240 <= 1280);
    return true;
}

static bool input_method_suite(const char *path)
{
    struct TestClient ime = { .control = -1 };
    int sockets[2];
    CHECK(socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sockets) == 0);
    CHECK(fcntl(sockets[0], F_SETFD, FD_CLOEXEC) == 0);
    char fd[32];
    snprintf(fd, sizeof(fd), "%d", sockets[1]);
    char *args[] = { (char *)path, "--trusted", fd, NULL };
    CHECK(pu_input_method_spawn(&desktop, args));
    close(sockets[1]); ime.control = sockets[0];
    CHECK(command(&ime, TEST_IME_CREATE, 0, 0, 0));
    CHECK(ime.reply.ime_global && ime.reply.virtual_global && !ime.reply.layer_capability &&
        !ime.reply.foreign_capability);
    CHECK(command(&ime, TEST_IME_FORCE_BIND, 0, ime.reply.ime_global, 0));
    CHECK(command(&ime, TEST_IME_FORCE_BIND, 1, ime.reply.virtual_global, 0));
    struct TestClient *a = &clients[0], *b = &clients[1];
    struct PuDesktopView *first = find_view(1), *second = find_view(2);
    CHECK(first && second && !a->reply.ime_global && !b->reply.virtual_global);
    wlr_scene_node_set_position(&first->tree->node, 30, 60);
    wlr_scene_node_set_position(&second->tree->node, 700, 60);
    motion(50, 80); button(BTN_LEFT, true); button(BTN_LEFT, false);
    CHECK(command(a, TEST_TEXT_ENABLE, 0, 0, 0));
    CHECK(command(&ime, TEST_QUERY, 0, 0, 0) && ime.reply.ime_active == 1);
    CHECK(a->reply.text_enter == 1);
    int keys = a->reply.keys;
    key(KEY_N, true);
    CHECK(command(&ime, TEST_QUERY, 0, 0, 0) && ime.reply.ime_keys == 1);
    CHECK(command(a, TEST_QUERY, 0, 0, 0) && a->reply.keys == keys);
    CHECK(command(&ime, TEST_IME_COMMIT, 0, ime.reply.ime_serial, 0));
    CHECK(command(a, TEST_QUERY, 0, 0, 0) && !strcmp(a->reply.text_preedit, "ni"));
    key(KEY_N, false);
    CHECK(command(&ime, TEST_QUERY, 0, 0, 0) && ime.reply.ime_keys == 2);
    CHECK(command(&ime, TEST_IME_COMMIT, 1, ime.reply.ime_serial, 0));
    CHECK(command(a, TEST_QUERY, 0, 0, 0) && !strcmp(a->reply.text_commit, "\xe4\xbd\xa0"));
    CHECK(command(&ime, TEST_IME_FORWARD, 0, ime.reply.ime_serial, KEY_A));
    CHECK(command(a, TEST_QUERY, 0, 0, 0) && a->reply.keys == keys + 2);
    CHECK(command(&ime, TEST_IME_FORWARD, 1, ime.reply.ime_serial, KEY_B));
    CHECK(command(a, TEST_QUERY, 0, 0, 0) && a->reply.keys == keys + 3);
    CHECK(command(a, TEST_TEXT_DISABLE, 0, 0, 0));
    CHECK(command(a, TEST_QUERY, 0, 0, 0) && a->reply.keys == keys + 4);
    CHECK(command(a, TEST_TEXT_ENABLE, 0, 0, 0));
    CHECK(command(&ime, TEST_QUERY, 0, 0, 0));
    CHECK(command(&ime, TEST_IME_FORWARD, 2, ime.reply.ime_serial, KEY_B));
    CHECK(command(a, TEST_QUERY, 0, 0, 0) && a->reply.keys == keys + 4);
    CHECK(command(&ime, TEST_IME_POPUP, 0, 0, 0));
    CHECK(command(&ime, TEST_QUERY, 0, 0, 0));
    CHECK(ime.reply.ime_rect_x == 0 && ime.reply.ime_rect_y == -16);
    struct wlr_box box;
    struct PuDesktopOwner *owner;
    CHECK(pu_desktop_surface_box(&desktop, first->toplevel->base->surface, &box, &owner));
    motion(box.x + 25, box.y + 51); button(BTN_LEFT, true); button(BTN_LEFT, false);
    CHECK(desktop.focused == first && desktop.seat->keyboard_state.focused_surface == first->toplevel->base->surface);
    CHECK(desktop.seat->pointer_state.focused_surface != first->toplevel->base->surface);
    key(KEY_N, true);
    CHECK(command(&ime, TEST_QUERY, 0, 0, 0));
    uint32_t stale = ime.reply.ime_serial;
    motion(720, 80); button(BTN_LEFT, true); button(BTN_LEFT, false);
    key(KEY_N, false);
    CHECK(command(a, TEST_QUERY, 0, 0, 0) && a->reply.text_leave == 1 && !a->reply.text_preedit[0]);
    CHECK(command(b, TEST_TEXT_ENABLE, 0, 0, 0));
    CHECK(command(&ime, TEST_QUERY, 0, 0, 0) && ime.reply.ime_active == 1);
    uint32_t active_serial = ime.reply.ime_serial;
    CHECK(command(a, TEST_TEXT_ENABLE, 0, 0, 0));
    CHECK(command(&ime, TEST_QUERY, 0, 0, 0) && ime.reply.ime_serial == active_serial);
    int commits = b->reply.text_done, second_keys = b->reply.keys;
    CHECK(command(&ime, TEST_IME_COMMIT, 1, stale, 0));
    CHECK(command(&ime, TEST_IME_FORWARD, 0, stale, KEY_B));
    CHECK(command(b, TEST_QUERY, 0, 0, 0) && b->reply.text_done == commits && b->reply.keys == second_keys);
    CHECK(command(b, TEST_TEXT_ENABLE, 8, 0, 0));
    CHECK(command(&ime, TEST_QUERY, 0, 0, 0) && ime.reply.ime_active == 0);
    key(KEY_A, true); key(KEY_A, false);
    CHECK(command(b, TEST_QUERY, 0, 0, 0) && b->reply.keys == second_keys + 2);
    CHECK(command(&ime, TEST_IME_FORWARD, 0, ime.reply.ime_serial, KEY_B));
    CHECK(command(b, TEST_QUERY, 0, 0, 0) && b->reply.keys == second_keys + 2);
    CHECK(command(b, TEST_TEXT_ENABLE, 0, 0, 128));
    CHECK(command(&ime, TEST_QUERY, 0, 0, 0) && !ime.reply.ime_active);
    CHECK(command(b, TEST_TEXT_ENABLE, 0, 0, 0));
    CHECK(command(&ime, TEST_QUERY, 0, 0, 0) && ime.reply.ime_active == 1);
    CHECK(command(&ime, TEST_IME_COMMIT, 0, ime.reply.ime_serial, 0));
    CHECK(command(b, TEST_QUERY, 0, 0, 0) && !strcmp(b->reply.text_preedit, "ni"));
    CHECK(command(&ime, TEST_QUIT, 0, 0, 0));
    for (int i = 0; i < 40; i++) CHECK(pump());
    CHECK(command(b, TEST_QUERY, 0, 0, 0) && !b->reply.text_preedit[0]);
    second_keys = b->reply.keys;
    key(KEY_A, true); key(KEY_A, false);
    CHECK(command(b, TEST_QUERY, 0, 0, 0) && b->reply.keys == second_keys + 2);
    CHECK(command(a, TEST_TEXT_DISABLE, 0, 0, 0));
    CHECK(command(b, TEST_TEXT_DISABLE, 0, 0, 0));
    pu_input_method_stop(&desktop);
    close(ime.control);
    return true;
}

struct DragIconPosition { struct wlr_surface *surface; int x, y; bool found; };
static void drag_icon_position(struct wlr_scene_buffer *buffer, int x, int y, void *data)
{
    struct DragIconPosition *position = data;
    struct wlr_scene_surface *surface = wlr_scene_surface_try_from_buffer(buffer);
    if (surface && surface->surface == position->surface) {
        position->x = x; position->y = y; position->found = true;
    }
}

static bool drag_suite(void)
{
    struct TestClient *a = &clients[0], *b = &clients[1];
    struct PuDesktopView *first = find_view(1), *second = find_view(2);
    CHECK(first && second);
    wlr_scene_node_set_position(&first->tree->node, 30, 60);
    wlr_scene_node_set_position(&second->tree->node, 700, 60);
    for (int scenario = 0; scenario < 5; scenario++) {
        motion(50, 80); button(BTN_LEFT, true);
        CHECK(command(a, TEST_QUERY, 0, 0, 0));
        uint32_t serial = a->reply.serial;
        if (!scenario) {
            int cancelled = b->reply.drag_cancelled;
            CHECK(command(b, TEST_DRAG, 0, serial, 0));
            CHECK(!desktop.seat->drag && b->reply.drag_cancelled == cancelled + 1);
            CHECK(command(a, TEST_DRAG, 1, 0, 0));
            CHECK(!desktop.seat->drag);
        }
        CHECK(command(a, TEST_DRAG, 0, serial, 1));
        CHECK(pu_data_device_drag_active(&desktop) && desktop.seat->drag->icon);
        CHECK(!desktop.seat->keyboard_state.focused_surface);
        motion(720, 80);
        CHECK(desktop.seat->drag->focus == second->toplevel->base->surface);
        struct DragIconPosition position = {.surface = desktop.seat->drag->icon->surface};
        wlr_scene_node_for_each_buffer(&desktop.scene->tree.node, drag_icon_position, &position);
        CHECK(position.found && position.x == 720 && position.y == 80);
        if (scenario == 0) {
            CHECK(command(a, TEST_DRAG_ICON_DESTROY, 0, 0, 0));
            CHECK(pu_data_device_drag_active(&desktop) && !desktop.seat->drag->icon);
            key(KEY_ESC, true); key(KEY_ESC, false);
        } else if (scenario == 1) {
            CHECK(command(a, TEST_DRAG_SOURCE_DESTROY, 0, 0, 0));
        } else if (scenario == 2) {
            struct PuWorkspace *previous = desktop.active_workspace;
            pu_workspace_step(&desktop, 1);
            CHECK(!pu_data_device_drag_active(&desktop));
            pu_workspace_activate(&desktop, previous, first);
        } else if (scenario == 3) {
            CHECK(command(a, TEST_UNMAP, 0, 0, 0));
            CHECK(!pu_data_device_drag_active(&desktop));
        } else {
            CHECK(command(a, TEST_MINIMIZE, 0, 0, 0));
            CHECK(!pu_data_device_drag_active(&desktop));
        }
        CHECK(!desktop.seat->drag && !pu_data_device_drag_active(&desktop));
        CHECK(!wlr_seat_keyboard_has_grab(desktop.seat) && !wlr_seat_pointer_has_grab(desktop.seat));
        button(BTN_LEFT, false);
        CHECK(command(a, TEST_DRAG_ICON_DESTROY, 0, 0, 0));
        if (scenario == 3) {
            CHECK(command(a, TEST_REMAP, 0, 0, 0));
            first = find_view(1);
            CHECK(first);
            wlr_scene_node_set_position(&first->tree->node, 30, 60);
        }
    }
    CHECK(command(a, TEST_UNMAP, 0, 0, 0));
    CHECK(command(a, TEST_REMAP, 0, 0, 0));
    first = find_view(1);
    CHECK(first);
    CHECK(!first->minimized);
    motion(720, 80); button(BTN_LEFT, true); button(BTN_LEFT, false);
    return true;
}

static bool suite(const char *client_path)
{
    CHECK(desktop.output_count > 0);
    CHECK(desktop.seat->capabilities ==
          (WL_SEAT_CAPABILITY_KEYBOARD | WL_SEAT_CAPABILITY_POINTER));
    CHECK(spawn_client(&clients[0], client_path));
    CHECK(spawn_client(&clients[1], client_path));
    struct TestClient *a = &clients[0], *b = &clients[1];
    CHECK(command(a, TEST_MAP, 1, 0, 0));
    CHECK(command(b, TEST_MAP, 2, 0, 24));
    struct PuDesktopView *first = find_view(1), *second = find_view(2);
    CHECK(first && second && wl_list_length(&desktop.views) == 2);
    CHECK(desktop.focused == second);
    CHECK(b->reply.focused == 2);
    for (int i = 0; i < 50; i++) CHECK(pump());
    CHECK(command(a, TEST_QUERY, 0, 0, 0) && a->reply.frames > 0);
    CHECK(command(b, TEST_QUERY, 0, 0, 0) && b->reply.frames > 0);
    CHECK(a->reply.focused == 0);

    motion(first->tree->node.x + 10, first->tree->node.y + 10);
    button(BTN_LEFT, true);
    button(BTN_LEFT, false);
    CHECK(desktop.focused == first);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(a->reply.focused == 1 && a->reply.buttons == 2);
    key(KEY_A, true);
    key(KEY_A, false);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(a->reply.keys == 2);

    button(BTN_LEFT, true);
    motion(second->tree->node.x + 230, second->tree->node.y + 150);
    CHECK(desktop.seat->pointer_state.focused_surface == first->toplevel->base->surface);
    CHECK(desktop.focused == first);
    button(BTN_LEFT, false);
    CHECK(desktop.seat->pointer_state.focused_surface == second->toplevel->base->surface);
    CHECK(command(b, TEST_QUERY, 0, 0, 0) && b->reply.buttons == 0);
    motion(first->tree->node.x + 10, first->tree->node.y + 10);

    CHECK(command(a, TEST_MOVE, 0, 0, 0));
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
    CHECK(command(a, TEST_RESIZE, 0, 0, WLR_EDGE_RIGHT));
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
    button(BTN_LEFT, true);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    uint32_t serial = a->reply.serial;
    CHECK(serial != 0);
    CHECK(command(b, TEST_MOVE, 0, serial, 0));
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
    int x = first->tree->node.x, y = first->tree->node.y;
    CHECK(command(a, TEST_MOVE, 0, serial, 0));
    CHECK(desktop.grab == PU_DESKTOP_MOVE);
    motion(x + 90, y + 70);
    CHECK(first->tree->node.x == x + 80 && first->tree->node.y == y + 60);
    button(BTN_RIGHT, true);
    button(BTN_RIGHT, false);
    CHECK(desktop.grab == PU_DESKTOP_MOVE);
    button(BTN_LEFT, false);
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
    CHECK(command(a, TEST_MOVE, 0, serial, 0));
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);

    x = first->tree->node.x; y = first->tree->node.y;
    motion(x + 10, y + 10);
    button(BTN_LEFT, true);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(command(a, TEST_RESIZE, 0, a->reply.serial, WLR_EDGE_TOP | WLR_EDGE_LEFT));
    CHECK(desktop.grab == PU_DESKTOP_RESIZE);
    motion(x + 50, y + 30);
    CHECK(first->tree->node.x == x && first->tree->node.y == y);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(a->reply.width == 200 && a->reply.height == 140);
    CHECK(first->tree->node.x == x + 40 && first->tree->node.y == y + 20);
    int resize_configures = a->reply.configured;
    for (int i = 0; i < 10; i++) CHECK(pump());
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(a->reply.configured == resize_configures);
    motion(x + 500, y + 400);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(a->reply.width == 120 && a->reply.height == 80);
    CHECK(first->tree->node.x + a->reply.width == x + 240);
    CHECK(first->tree->node.y + a->reply.height == y + 160);
    button(BTN_LEFT, false);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(!first->toplevel->current.resizing && !first->resize_pending);

    /* Compositor shortcuts must not leak unmatched key/button releases to clients. */
    x = first->tree->node.x; y = first->tree->node.y;
    motion(x + 10, y + 10);
    key(KEY_LEFTALT, true);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    int buttons_before = a->reply.buttons;
    button(BTN_LEFT, true);
    CHECK(desktop.grab == PU_DESKTOP_MOVE);
    motion(x + 30, y + 40);
    button(BTN_LEFT, false);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(a->reply.buttons == buttons_before);
    CHECK(first->tree->node.x == x + 20 && first->tree->node.y == y + 30);
    motion(first->tree->node.x + 10, first->tree->node.y + 10);
    button(BTN_RIGHT, true);
    CHECK(desktop.grab == PU_DESKTOP_RESIZE);
    motion(1200, 680);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(a->reply.width == 600 && a->reply.height == 400);
    button(BTN_RIGHT, false);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    int keys_before = a->reply.keys;
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    int other_keys = b->reply.keys;
    key(KEY_TAB, true);
    key(KEY_TAB, false);
    CHECK(desktop.focused == second);
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    CHECK(b->reply.focused == 2 && b->reply.keys == other_keys);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(a->reply.keys == keys_before);
    key(KEY_F4, true);
    key(KEY_F4, false);
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    CHECK(b->reply.closed == 1 && b->reply.keys == other_keys);
    key(KEY_LEFTALT, false);

    char *shell[] = { "/bin/sh", "-c", "exit 19", NULL };
    CHECK(pu_desktop_supervise_shell(&desktop, shell, 1));
    for (int i = 0; i < 1000 && (desktop.shell_pid || desktop.shell_restart_pending); i++) CHECK(pump());
    CHECK(!desktop.shell_pid && !desktop.shell_client && desktop.shell_exited);
    CHECK(WIFEXITED(desktop.shell_status) && WEXITSTATUS(desktop.shell_status) == 19);
    CHECK(desktop.shell_restarts_used == 1 && !desktop.shell_restart_pending);
    pu_desktop_stop_shell(&desktop);
    CHECK(!desktop.failed && find_view(1) == first && find_view(2) == second);
    CHECK(desktop.focused == second);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    CHECK(a->reply.frames > 0 && b->reply.frames > 0);

    CHECK(drag_suite());
    first = find_view(1);
    CHECK(input_method_suite(client_path));
    CHECK(layer_suite(client_path));
    CHECK(state_suite(b, second));
    second = find_view(2);
    CHECK(popup_suite(b, second));
    CHECK(output_suite(b));
    second = find_view(2);
    CHECK(wl_list_empty(&second->toplevel->base->popups));

    CHECK(command(b, TEST_UNMAP, 0, 0, 0));
    CHECK(!find_view(2) && desktop.focused == first);
    CHECK(command(b, TEST_REMAP, 0, 0, 0));
    second = find_view(2);
    CHECK(second && desktop.focused == second);
    motion(second->tree->node.x + 10, second->tree->node.y + 10);
    button(BTN_LEFT, true);
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    CHECK(command(b, TEST_MOVE, 0, b->reply.serial, 0));
    CHECK(desktop.grab == PU_DESKTOP_MOVE);
    CHECK(command(b, TEST_DESTROY, 0, 0, 0));
    CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH && !desktop.grabbed);
    CHECK(desktop.focused == first);
    button(BTN_LEFT, false);

    /* A crashed client must release its windows, popup tree and focus. */
    CHECK(command(b, TEST_MAP, 2, 0, 0));
    CHECK(command(b, TEST_POPUP, 0, 0, 0));
    CHECK(kill(b->pid, SIGKILL) == 0);
    int status;
    CHECK(waitpid(b->pid, &status, 0) == b->pid && WIFSIGNALED(status));
    b->pid = 0;
    close(b->control);
    for (int i = 0; i < 30; i++) CHECK(pump());
    CHECK(!find_view(2) && desktop.focused == first);
    CHECK(spawn_client(b, client_path));
    CHECK(command(b, TEST_MAP, 2, 0, 0));
    CHECK(command(b, TEST_QUIT, 0, 0, 0));
    for (int i = 0; i < 30; i++) CHECK(pump());
    CHECK(desktop.focused == first);

    /* An xdg_toplevel may be destroyed while its xdg_surface still exists. */
    CHECK(command(a, TEST_POPUP, 0, 0, 0));
    CHECK(command(a, TEST_DESTROY_ROLE, 0, 0, 0));
    CHECK(wl_list_empty(&desktop.views) && !desktop.focused);
    CHECK(command(a, TEST_DESTROY, 0, 0, 0));
    CHECK(wl_list_empty(&desktop.views) && !desktop.focused);
    CHECK(command(a, TEST_QUIT, 0, 0, 0));
    return true;
}

static bool stop_clients(bool expect_success)
{
    bool passed = true;
    for (size_t i = 0; i < 3; i++) {
        struct TestClient *client = &clients[i];
        if (client->pid <= 0) continue;
        close(client->control);
        int status = 0;
        pid_t done = 0;
        for (int attempt = 0; attempt < 500; attempt++) {
            done = waitpid(client->pid, &status, WNOHANG);
            if (done != 0 || !expect_success) break;
            struct timespec delay = { .tv_nsec = 2000000 };
            nanosleep(&delay, NULL);
        }
        if (done == 0) {
            kill(client->pid, SIGTERM);
            waitpid(client->pid, &status, 0);
        }
        if (expect_success && (done != client->pid || !WIFEXITED(status) || WEXITSTATUS(status))) {
            fprintf(stderr, "Client did not exit cleanly (status %d)\n", status);
            passed = false;
        }
    }
    return passed;
}

static bool live_startup_suite(const char *path)
{
    CHECK(desktop.live_startup && desktop.live_splash && !desktop.live_ready);
    int sockets[2];
    CHECK(socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sockets) == 0);
    CHECK(fcntl(sockets[0], F_SETFD, FD_CLOEXEC) == 0);
    char fd[32];
    snprintf(fd, sizeof(fd), "%d", sockets[1]);
    char *args[] = { (char *)path, "--trusted", fd, NULL };
    CHECK(pu_desktop_spawn_shell(&desktop, args));
    close(sockets[1]);
    shell_client.control = sockets[0];
    CHECK(command(&shell_client, TEST_QUERY, 0, 0, 0));
    CHECK(!desktop.live_ready);
    struct TestLayer wallpaper = {
        .layer = ZWLR_LAYER_SHELL_V1_LAYER_BACKGROUND,
        .anchor = 15, .output = 1, .live = 1,
    };
    CHECK(layer_command(TEST_LAYER_MAP, 3, wallpaper));
    CHECK(!desktop.live_ready);
    struct TestLayer panel = {
        .layer = ZWLR_LAYER_SHELL_V1_LAYER_TOP, .anchor = 13,
        .height = 32, .zone = 32, .output = 1,
    };
    CHECK(layer_command(TEST_LAYER_MAP, 4, panel));
    CHECK(!desktop.live_ready);
    struct TestClient ime = { .control = -1 };
    CHECK(socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sockets) == 0);
    CHECK(fcntl(sockets[0], F_SETFD, FD_CLOEXEC) == 0);
    snprintf(fd, sizeof(fd), "%d", sockets[1]);
    CHECK(pu_input_method_spawn(&desktop, args));
    close(sockets[1]);
    ime.control = sockets[0];
    CHECK(command(&ime, TEST_IME_CREATE, 0, 0, 0));
    for (int i = 0; i < 10; i++) CHECK(pump());
    CHECK(pu_input_method_ready(&desktop) && !desktop.live_ready);
    CHECK(command(&shell_client, TEST_DESTROY, 4, 0, 0));
    struct wlr_backend *headless = NULL;
    wlr_multi_for_each_backend(desktop.backend, find_headless, &headless);
    CHECK(headless);
    struct wlr_output *extra = wlr_headless_add_output(headless, 800, 600);
    CHECK(extra);
    panel.live = 1;
    CHECK(layer_command(TEST_LAYER_MAP, 4, panel));
    for (int i = 0; i < 10; i++) CHECK(pump());
    CHECK(!desktop.live_ready);
    wlr_output_destroy(extra);
    for (int i = 0; i < 100 && !desktop.live_ready; i++) CHECK(pump());
    if (!desktop.live_ready) {
        fprintf(stderr, "Live gate: outputs=%d shell=%p caps=%u ime=%d workspace=%p\n",
            desktop.output_count, (void *)desktop.shell_client, desktop.seat->capabilities,
            pu_input_method_ready(&desktop), (void *)desktop.active_workspace);
        struct PuDesktopLayer *layer;
        wl_list_for_each(layer, &desktop.layers, link)
            fprintf(stderr, "Layer %s on %s: mapped=%d presented=%d enabled=%d\n",
                layer->surface->namespace, layer->surface->output->name,
                layer->surface->surface->mapped, layer->presented, layer->tree->node.enabled);
    }
    CHECK(desktop.live_ready && desktop.output_count == 1);
    CHECK(command(&shell_client, TEST_QUERY, 0, 0, 0));
    CHECK(shell_client.reply.frames > 0);
    extra = wlr_headless_add_output(headless, 800, 600);
    CHECK(extra);
    struct wlr_box box;
    wlr_output_layout_get_box(desktop.layout, extra, &box);
    double sx, sy;
    CHECK(!wlr_scene_node_at(&desktop.scene->tree.node,
        box.x + box.width / 2, box.y + box.height * 42 / 100, &sx, &sy));
    wlr_output_destroy(extra);
    CHECK(command(&ime, TEST_QUIT, 0, 0, 0));
    close(ime.control);
    pu_input_method_stop(&desktop);
    CHECK(command(&shell_client, TEST_QUIT, 0, 0, 0));
    pu_desktop_stop_shell(&desktop);
    return true;
}

int main(int argc, char **argv)
{
    if (argc != 2 && argc != 3) return 2;
    nested = argc == 3 && strcmp(argv[2], "--nested") == 0;
    cursor_only = argc == 3 && strcmp(argv[2], "--cursor") == 0;
    cursor_resources = argc == 3 && strcmp(argv[2], "--cursor-resources") == 0;
    bool live_startup = argc == 3 && strcmp(argv[2], "--live-startup") == 0;
    if (live_startup) {
        setenv("POLLY_LIVE_STARTUP", "1", 1);
        setenv("POLLY_LIVE_SPLASH", "1", 1);
    }
    char runtime[] = "/tmp/pollywm-test-XXXXXX";
    if (!mkdtemp(runtime)) { perror("mkdtemp"); return 1; }
    setenv("XDG_RUNTIME_DIR", runtime, 1);
    if (!nested) {
        setenv("WLR_BACKENDS", "headless", 1);
        setenv("WLR_HEADLESS_OUTPUTS", "1", 1);
    } else {
        setenv("WLR_BACKENDS", "wayland", 1);
    }
    setenv("WLR_RENDERER", "pixman", 1);
    wlr_log_init(cursor_only ? WLR_DEBUG : WLR_INFO, NULL);
    bool ready = pu_desktop_init(&desktop, NULL);
    if (ready) {
        compositor_new_input = desktop.new_input.notify;
        desktop.new_input.notify = test_input;
        ready = pu_desktop_start(&desktop);
    }
    bool passed = false;
    if (ready) {
        wlr_keyboard_init(&keyboard, &keyboard_impl, "test-keyboard");
        wlr_pointer_init(&pointer, &pointer_impl, "test-pointer");
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &keyboard.base);
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &pointer.base);
        passed = live_startup ? live_startup_suite(argv[1]) : cursor_only ? cursor_suite(argv[1]) :
            cursor_resources ? cursor_resource_suite() : suite(argv[1]);
        if (!stop_clients(passed)) passed = false;
        wlr_pointer_finish(&pointer);
        if (desktop.grab != PU_DESKTOP_PASSTHROUGH) passed = false;
        wlr_keyboard_finish(&keyboard);
        if (!nested && desktop.seat->capabilities != 0) passed = false;
    }
    if (shell_client.control >= 0) close(shell_client.control);
    pu_desktop_finish(&desktop);
    if (rmdir(runtime) < 0) { perror("runtime cleanup"); passed = false; }
    if (passed) printf("PASS: %s Wayland integration (%d checks)\n", nested ? "nested" : "headless", checks);
    return passed ? 0 : 1;
}
