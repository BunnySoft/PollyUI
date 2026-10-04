#include "server.h"
#include "decoration.h"
#include "decoration-themes.h"
#include "wire.h"

#include <errno.h>
#include <drm_fourcc.h>
#include <fcntl.h>
#include <linux/input-event-codes.h>
#include <limits.h>
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
#include <wlr/types/wlr_layer_shell_v1.h>
#include <wlr/types/wlr_foreign_toplevel_management_v1.h>
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
static struct TestClient clients[3];
static struct TestClient shell_client = { .control = -1 };
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

static bool decoration_click(struct TestClient *client, struct PuDesktopView *view, int part)
{
    struct wlr_box box;
    CHECK(pu_decoration_button_box(view, part, &box));
    motion(view->tree->node.x + box.x + box.width / 2.0,
           view->tree->node.y + box.y + box.height / 2.0);
    CHECK(desktop.seat->pointer_state.focused_surface == NULL);
    button(BTN_LEFT, true);
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    return true;
}

static bool decoration_pixels(struct PuDesktopView *view, unsigned theme_id, uint64_t *hash)
{
    const struct PuDecorationTheme *theme = &pu_decoration_themes[theme_id];
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
    for (int shift = 0; shift <= 16; shift += 8) {
        int from = (theme->titleFrom >> shift) & 255, to = (theme->titleTo >> shift) & 255;
        int expected = from + (int)((to - from) * ((height / 2 + 0.5) / scale / theme->title_height));
        int actual = (sample >> shift) & 255;
        if (theme->pinstripe) CHECK(abs(actual - expected) < 20);
        else CHECK(abs(actual - expected) <= 3);
    }
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
    motion(x + width + 1, y + height + 1);
    button(BTN_LEFT, true);
    CHECK(desktop.grab == PU_DESKTOP_RESIZE);
    motion(x + width + 31, y + height + 26);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    button(BTN_LEFT, false);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(client->reply.width == width + 30 && client->reply.height == height + 25);
    CHECK(client->reply.buttons == buttons_before);
    motion(x - 1, y - 31);
    button(BTN_LEFT, true);
    CHECK(desktop.grab == PU_DESKTOP_RESIZE && desktop.grab_edges == (WLR_EDGE_TOP | WLR_EDGE_LEFT));
    motion(x + 9, y - 23);
    CHECK(command(client, TEST_QUERY, 0, 0, 0));
    CHECK(geometry_is(view, x + 10, y + 8, width + 20, height + 17));
    motion(x - 1, y - 31);
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
    for (unsigned theme = 0; theme < PU_DECORATION_THEME_COUNT; theme++) {
        CHECK(command(&shell_client, TEST_APPEARANCE, (int)theme, 0, 0));
        CHECK(command(client, TEST_QUERY, 0, 0, 0));
        wlr_output_layout_get_box(desktop.layout, view->output, &full);
        content = full;
        pu_decoration_inset(view, &content, false);
        CHECK(content.y == full.y + pu_decoration_themes[theme].title_height);
        CHECK(geometry_is(view, content.x, content.y, content.width, content.height));
        CHECK(pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
        CHECK(pu_decoration_themes[theme].left_controls ? box.x < 20 : box.x > content.width / 2);
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
        CHECK(decoration_pixels(view, 4, &hash));
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
        CHECK(view->output == extra && decoration_pixels(view, 4, &hash));
        wlr_output_destroy(extra);
        CHECK(command(client, TEST_QUERY, 0, 0, 0));
        CHECK(pu_desktop_view_scale(view) == 1 && decoration_pixels(view, 4, &hash));
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
    CHECK(content.y == full.y + 40);
    CHECK(command(client, TEST_RELEASE, 0, 0, 0));
    content = full; pu_decoration_inset(view, &content, false);
    CHECK(content.y == full.y + 32);
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

static bool layer_suite(const char *path)
{
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
    CHECK(command(&clients[1], TEST_QUERY, 0, 0, 0));
    CHECK(!clients[1].reply.layer_capability);
    CHECK(foreign_suite());
    CHECK(decoration_suite(path));
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
    dock.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE;
    top.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE;
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 4, dock));
    CHECK(layer_command(TEST_LAYER_CONFIGURE, 3, top));
    CHECK(desktop.focused_layer == extra);
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
    if (shell_client.control >= 0) close(shell_client.control);
    pu_desktop_finish(&desktop);
    if (rmdir(runtime) < 0) { perror("runtime cleanup"); passed = false; }
    if (passed) printf("PASS: %s Wayland integration (%d checks)\n", nested ? "nested" : "headless", checks);
    return passed ? 0 : 1;
}
