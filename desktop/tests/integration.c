#include "server.h"
#include "wire.h"

#include <errno.h>
#include <drm_fourcc.h>
#include <fcntl.h>
#include <linux/input-event-codes.h>
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
#include <wlr/interfaces/wlr_keyboard.h>
#include <wlr/interfaces/wlr_pointer.h>
#include <wlr/types/wlr_cursor.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_xdg_shell.h>
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
static struct TestClient clients[2];
static int checks;
static uint32_t time_msec;
static bool nested;
static wl_notify_func_t compositor_new_input;
static const struct wlr_keyboard_impl keyboard_impl = { .name = "pollywm-test" };
static const struct wlr_pointer_impl pointer_impl = { .name = "pollywm-test" };

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

static bool command(struct TestClient *client, enum TestCommand type, int id,
                    uint32_t serial, uint32_t edges)
{
    struct TestRequest request = { .command = type, .id = id, .serial = serial, .edges = edges };
    CHECK(send(client->control, &request, sizeof(request), MSG_NOSIGNAL) == sizeof(request));
    for (int i = 0; i < 1000; i++) {
        ssize_t n = recv(client->control, &client->reply, sizeof(client->reply), MSG_DONTWAIT);
        if (n == sizeof(client->reply)) return true;
        CHECK(n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
        CHECK(pump());
    }
    fprintf(stderr, "Timed out waiting for test client command %d\n", type);
    return false;
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

    /* A small output must not place even a min-size-constrained window offscreen. */
    extra = wlr_headless_add_output(backend, 100, 60);
    CHECK(extra);
    CHECK(wlr_output_layout_add(desktop.layout, extra, 1400, 0));
    motion(1410, 10);
    CHECK(command(client, TEST_DESTROY, 0, 0, 0));
    CHECK(command(client, TEST_MAP, 2, 0, 0));
    view = find_view(2);
    CHECK(view && view->tree->node.x == 1400 && view->tree->node.y == 0);
    CHECK(command(client, TEST_MAXIMIZE, 0, 0, 0));
    CHECK(geometry_is(view, 1400, 0, 100, 60));
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_enabled(&state, false);
    CHECK(wlr_output_commit_state(extra, &state));
    wlr_output_state_finish(&state);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(view->output == original && geometry_is(view, 0, 0, 1280, 720));
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

static bool suite(const char *client_path)
{
    CHECK(desktop.output_count > 0);
    CHECK(desktop.seat->capabilities ==
          (WL_SEAT_CAPABILITY_KEYBOARD | WL_SEAT_CAPABILITY_POINTER));
    CHECK(spawn_client(&clients[0], client_path));
    CHECK(spawn_client(&clients[1], client_path));
    struct TestClient *a = &clients[0], *b = &clients[1];
    CHECK(command(a, TEST_MAP, 1, 0, 0));
    CHECK(command(b, TEST_MAP, 2, 0, 0));
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
    CHECK(pu_desktop_spawn_shell(&desktop, shell));
    for (int i = 0; i < 1000 && desktop.shell_pid; i++) CHECK(pump());
    CHECK(!desktop.shell_pid && !desktop.shell_client && desktop.shell_exited);
    CHECK(WIFEXITED(desktop.shell_status) && WEXITSTATUS(desktop.shell_status) == 19);
    CHECK(!desktop.failed && find_view(1) == first && find_view(2) == second);
    CHECK(desktop.focused == second);
    CHECK(command(a, TEST_QUERY, 0, 0, 0));
    CHECK(command(b, TEST_QUERY, 0, 0, 0));
    CHECK(a->reply.frames > 0 && b->reply.frames > 0);

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
    for (size_t i = 0; i < 2; i++) {
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

int main(int argc, char **argv)
{
    if (argc != 2 && argc != 3) return 2;
    nested = argc == 3 && strcmp(argv[2], "--nested") == 0;
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
    wlr_log_init(WLR_INFO, NULL);
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
        passed = suite(argv[1]);
        if (!stop_clients(passed)) passed = false;
        wlr_pointer_finish(&pointer);
        if (desktop.grab != PU_DESKTOP_PASSTHROUGH) passed = false;
        wlr_keyboard_finish(&keyboard);
        if (!nested && desktop.seat->capabilities != 0) passed = false;
    }
    pu_desktop_finish(&desktop);
    if (rmdir(runtime) < 0) { perror("runtime cleanup"); passed = false; }
    if (passed) printf("PASS: %s Wayland integration (%d checks)\n", nested ? "nested" : "headless", checks);
    return passed ? 0 : 1;
}
