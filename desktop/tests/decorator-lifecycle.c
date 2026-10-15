#define _POSIX_C_SOURCE 200809L
#include "server.h"
#include "decoration.h"
#include "decorator-process.h"
#include "workspace.h"
#include "shortcut-control.h"
#include "decoration-layout-fixtures.h"
#include "wire.h"
#include <drm_fourcc.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/input-event-codes.h>
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
#include <wlr/interfaces/wlr_keyboard.h>
#include <wlr/interfaces/wlr_pointer.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_pointer.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>

#define CHECK(value) do { if (!(value)) { \
    fprintf(stderr, "FAIL decorator lifecycle line %d: %s\n", __LINE__, #value); return false; \
} } while (0)
static struct PuDesktop desktop;
static struct wlr_pointer pointer;
static struct wlr_keyboard keyboard;
static const struct wlr_pointer_impl pointer_impl = {.name = "decorator-fixture-pointer"};
static const struct wlr_keyboard_impl keyboard_impl = {.name = "decorator-fixture-keyboard"};
static pid_t app_pid, wire_pid;
static int control = -1;
static struct TestReply reply;
static uint32_t clock_ms = 1000;

static bool pump(void)
{
    wl_display_flush_clients(desktop.display);
    return wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 5) >= 0 && !desktop.failed;
}
static struct PuDesktopView *find(const char *title)
{
    struct PuDesktopView *view;
    wl_list_for_each(view, &desktop.views, link)
        if (view->mapped && view->toplevel->title && !strcmp(view->toplevel->title, title)) return view;
    return NULL;
}
static struct PuDesktopView *wire_view(void)
{
    struct PuDesktopView *view;
    wl_list_for_each(view, &desktop.views, link)
        if (view->toplevel->app_id && !strcmp(view->toplevel->app_id, "org.pollywm.test.7")) return view;
    return NULL;
}
static bool wait_frame(struct PuDesktopView *view)
{
    for (int i = 0; i < 1200; i++) {
        CHECK(pump());
        struct wlr_box box;
        if (!view->geometry_pending && pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box)) return true;
    }
    CHECK(false);
}
static bool command(enum TestCommand command, int id, uint32_t edges)
{
    const struct TestRequest request = {.command = command, .id = id, .edges = edges};
    CHECK(send(control, &request, sizeof(request), MSG_NOSIGNAL) == sizeof(request));
    for (int i = 0; i < 1200; i++) {
        ssize_t count = recv(control, &reply, sizeof(reply), MSG_DONTWAIT);
        if (count == sizeof(reply)) return true;
        CHECK(count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
        CHECK(pump());
    }
    CHECK(false);
}
static void motion(double x, double y)
{
    struct wlr_box bounds;
    wlr_output_layout_get_box(desktop.layout, NULL, &bounds);
    struct wlr_pointer_motion_absolute_event event = {.pointer = &pointer, .time_msec = ++clock_ms,
        .x = (x - bounds.x) / bounds.width, .y = (y - bounds.y) / bounds.height};
    wl_signal_emit_mutable(&pointer.events.motion_absolute, &event);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
}
static void button(bool down)
{
    struct wlr_pointer_button_event event = {.pointer = &pointer, .time_msec = ++clock_ms,
        .button = BTN_LEFT, .state = down ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED};
    wlr_pointer_notify_button(&pointer, &event);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
}
static bool click(struct PuDesktopView *view, int part)
{
    struct wlr_box box;
    CHECK(pu_decoration_button_box(view, part, &box));
    motion(view->tree->node.x + box.x + box.width / 2.0, view->tree->node.y + box.y + box.height / 2.0);
    button(true); button(false);
    CHECK(command(TEST_QUERY, 0, 0));
    return true;
}
static uint64_t frame_hash(struct PuDesktopView *view)
{
    struct wlr_box inset = {0};
    pu_decoration_inset(view, &inset, false);
    double x, y;
    struct wlr_scene_node *node = wlr_scene_node_at(&desktop.scene->tree.node,
        view->tree->node.x + view->presented_box.width / 2,
        view->tree->node.y - inset.y / 2, &x, &y);
    if (!node || node->type != WLR_SCENE_NODE_BUFFER) return 0;
    struct wlr_buffer *buffer = wlr_scene_buffer_from_node(node)->buffer;
    void *data; uint32_t format; size_t stride;
    if (!buffer || buffer->height != (int)ceil(inset.y * pu_desktop_view_scale(view)) ||
        !wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride))
        return 0;
    uint64_t hash = UINT64_C(14695981039346656037);
    for (int row = 0; row < buffer->height; row++)
        for (int col = 0; col < buffer->width * 4; col++) {
            hash ^= ((unsigned char *)data)[row * stride + col]; hash *= UINT64_C(1099511628211);
        }
    wlr_buffer_end_data_ptr_access(buffer);
    return format == DRM_FORMAT_ARGB8888 || format == DRM_FORMAT_XRGB8888 ? hash : 0;
}
static bool changed(struct PuDesktopView *view, uint64_t before)
{
    for (int i = 0; i < 1200; i++) {
        CHECK(pump());
        uint64_t hash = frame_hash(view);
        if (hash && hash != before && !view->geometry_pending) return true;
    }
    CHECK(false);
}
static unsigned buffer_count(struct wlr_scene_node *node)
{
    if (node->type == WLR_SCENE_NODE_BUFFER) return 1;
    if (node->type != WLR_SCENE_NODE_TREE) return 0;
    struct wlr_scene_tree *tree = wl_container_of(node, tree, node);
    unsigned count = 0;
    struct wlr_scene_node *child;
    wl_list_for_each(child, &tree->children, link) count += buffer_count(child);
    return count;
}
static bool body_pixel(struct PuDesktopView *view, uint32_t expected)
{
    struct wlr_client_buffer *buffer = view->toplevel->base->surface->buffer;
    if (!buffer || !buffer->source) return false;
    void *pixels; uint32_t format, pixel; size_t stride;
    if (!wlr_buffer_begin_data_ptr_access(buffer->source, WLR_BUFFER_DATA_PTR_ACCESS_READ,
        &pixels, &format, &stride)) return false;
    memcpy(&pixel, (char *)pixels + 10 * stride + 40, sizeof(pixel));
    wlr_buffer_end_data_ptr_access(buffer->source);
    return (format == DRM_FORMAT_ARGB8888 || format == DRM_FORMAT_XRGB8888) &&
        (pixel & 0xffffff) == expected;
}
static bool start_wire(const char *path)
{
    int sockets[2];
    CHECK(!socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sockets));
    wire_pid = fork();
    CHECK(wire_pid >= 0);
    if (!wire_pid) {
        close(sockets[0]);
        if (fcntl(sockets[1], F_SETFD, 0)) _exit(126);
        char number[32]; snprintf(number, sizeof(number), "%d", sockets[1]);
        execl(path, path, desktop.socket_name, number, (char *)NULL); _exit(127);
    }
    close(sockets[1]); control = sockets[0];
    CHECK(command(TEST_MAP, 7, 8));
    CHECK(wire_view() && wait_frame(wire_view()));
    return true;
}
static bool start_app(const char *ui)
{
    app_pid = fork();
    CHECK(app_pid >= 0);
    if (!app_pid) {
        setenv("WAYLAND_DISPLAY", desktop.socket_name, 1);
        execl(ui, ui, "--app-id", "org.pollyui.decorator-fixture",
            "desktop/tests/decorator-app.mjs", (char *)NULL);
        _exit(127);
    }
    for (int i = 0; i < 1200; i++) {
        CHECK(pump());
        if (find("Decorator.fixture.app") && find("Decorator.fixture.frameless")) return true;
    }
    CHECK(false);
}
static bool wait_service(pid_t previous)
{
    for (int i = 0; i < 1200; i++) {
        CHECK(pump());
        if (pu_decorator_status(&desktop, NULL) == 2 && pu_decorator_pid(&desktop) > 0 &&
            pu_decorator_pid(&desktop) != previous) return true;
    }
    CHECK(false);
}
static bool suite(const char *ui, const char *wire, const char *mode)
{
    char *decorator[] = {(char *)ui, "--decorator", "--app-id", "org.pollyui.decorator",
        "desktop/decorator/main.mjs", NULL};
    CHECK(pu_decorator_spawn(&desktop, decorator));
    CHECK(wait_service(0));
    CHECK(wl_list_empty(&desktop.all_views) && wl_list_empty(&desktop.layers));
    CHECK(start_wire(wire));
    struct PuDesktopView *view = wire_view();
    CHECK(frame_hash(view) && buffer_count(&view->tree->node) == 5);
    struct wlr_box initial = {0};
    pu_decoration_inset(view, &initial, false);
    if (!strncmp(mode, "cold", 4)) {
        CHECK(initial.y > 0 && !desktop.shell_pid);
        unsigned expected = PU_DECORATION_DEFAULT_LAYOUT;
        if (!strcmp(mode, "cold-saved") || !strcmp(mode, "cold-legacy")) {
            for (unsigned i = 0; i < PU_DECORATION_LAYOUT_COUNT; i++)
                if (!strcmp(pu_decoration_layouts[i].id, "server2003")) expected = i;
        }
        CHECK(initial.y == pu_decoration_layouts[expected].layout.title_height);
        puts("PASS: no-Shell cold boot rendered real four-strip GUI frame");
        if (strcmp(mode, "cold")) {
            pid_t previous = pu_decorator_pid(&desktop);
            CHECK(!kill(previous, SIGKILL));
            CHECK(wait_service(previous) && wait_frame(view));
            struct wlr_box restored = {0}; pu_decoration_inset(view, &restored, false);
            CHECK(restored.x == initial.x && restored.y == initial.y);
            CHECK(command(TEST_RENAME, 0, 0) && wait_frame(view));
            CHECK(command(TEST_QUIT, 0, 0));
            puts("PASS: saved/default cold theme and WM snapshot survived renderer reconnect");
            return true;
        }
    } else {
        char *shell[] = {(char *)ui, "--desktop", "--no-legacy-storage", "--app-id", "org.pollyui.shell",
            "desktop/tests/decorator-shell.mjs", NULL};
        CHECK(pu_desktop_spawn_shell(&desktop, shell));
        for (int i = 0; i < 1200 && !find("Decorator.fixture.shell"); i++) CHECK(pump());
        CHECK(find("Decorator.fixture.shell"));
        CHECK(wait_frame(view));
        pid_t renderer_pid = pu_decorator_pid(&desktop);
        CHECK(renderer_pid != desktop.shell_pid && renderer_pid != getpid());
        if (!strcmp(mode, "crash")) CHECK(!kill(desktop.shell_pid, SIGKILL));
        else wlr_xdg_toplevel_send_close(find("Decorator.fixture.shell")->toplevel);
        for (int i = 0; i < 1200 && desktop.shell_pid; i++) CHECK(pump());
        CHECK(!desktop.shell_pid && desktop.shell_exited);
        CHECK(!strcmp(mode, "crash") ? WIFSIGNALED(desktop.shell_status) :
            WIFEXITED(desktop.shell_status) && WEXITSTATUS(desktop.shell_status) == 0);
        CHECK(pu_decorator_pid(&desktop) == renderer_pid && pu_decorator_status(&desktop, NULL) == 2);
        puts("PASS: actual Shell exit retained independent renderer and client");
    }
    CHECK(start_app(ui));
    struct PuDesktopView *app = find("Decorator.fixture.app"), *frameless = find("Decorator.fixture.frameless");
    CHECK(wait_frame(app));
    struct wlr_box box;
    CHECK(!pu_decoration_button_box(frameless, PU_DECORATION_CLOSE, &box));
    pu_desktop_focus_mapped(&desktop, app->workspace_window);
    motion(app->tree->node.x + 20, app->tree->node.y + 20);
    for (int i = 0; i < 10; i++) CHECK(pump());
    button(true); button(false);
    for (int i = 0; i < 600 && !body_pixel(app, 0x33cc66); i++) CHECK(pump());
    CHECK(body_pixel(app, 0x33cc66));
    pu_desktop_focus_mapped(&desktop, view->workspace_window);
    CHECK(wait_frame(view));
    uint64_t before = frame_hash(view);
    CHECK(command(TEST_RENAME, 0, 0));
    CHECK(changed(view, before));
    before = frame_hash(view);
    CHECK(pu_decoration_button_box(view, PU_DECORATION_MAXIMIZE, &box));
    motion(view->tree->node.x + box.x + box.width / 2.0, view->tree->node.y + box.y + box.height / 2.0);
    CHECK(changed(view, before));
    before = frame_hash(view); button(true);
    CHECK(changed(view, before)); button(false);
    CHECK(command(TEST_QUERY, 0, 0) && wait_frame(view) && view->mode == PU_DESKTOP_MAXIMIZED);
    CHECK(click(view, PU_DECORATION_MAXIMIZE) && wait_frame(view) && view->mode == PU_DESKTOP_FLOATING);
    CHECK(command(TEST_UNCONSTRAINED, 0, 0));
    struct wlr_box old = view->toplevel->base->geometry, resize_inset = {0};
    pu_decoration_inset(view, &resize_inset, false);
    CHECK(resize_inset.x > 0);
    motion(view->tree->node.x + old.width + resize_inset.x / 2.0,
        view->tree->node.y + old.height + resize_inset.x / 2.0);
    button(true);
    CHECK(desktop.grab == PU_DESKTOP_RESIZE);
    motion(view->tree->node.x + old.width + 31, view->tree->node.y + old.height + 21);
    button(false);
    CHECK(command(TEST_QUERY, 0, 0) && wait_frame(view));
    CHECK(view->toplevel->base->geometry.width != old.width);
    struct wlr_output_state output;
    wlr_output_state_init(&output); wlr_output_state_set_scale(&output, 1.25f);
    CHECK(wlr_output_commit_state(view->output, &output)); wlr_output_state_finish(&output);
    CHECK(command(TEST_QUERY, 0, 0) && wait_frame(view));
    CHECK(pu_desktop_view_scale(view) == 1.25 && frame_hash(view));
    CHECK(click(view, PU_DECORATION_MINIMIZE) && view->minimized);
    pu_desktop_focus_mapped(&desktop, view->workspace_window);
    CHECK(!view->minimized && wait_frame(view));
    puts("PASS: Shell-independent title, hover/pressed, resize, DPI and min/max/restore use real pixels/input");
    pid_t previous = pu_decorator_pid(&desktop);
    CHECK(!kill(previous, SIGSTOP));
    int stopped;
    CHECK(waitpid(previous, &stopped, WUNTRACED) == previous && WIFSTOPPED(stopped));
    for (int i = 0; i < 5; i++) CHECK(pump());
    before = frame_hash(view); old = view->presented_box;
    CHECK(command(TEST_MAXIMIZE, 0, 0));
    CHECK(view->geometry_pending && view->presented_box.width == old.width);
    CHECK(frame_hash(view) == before);
    CHECK(!kill(previous, SIGKILL));
    CHECK(wait_service(previous) && wait_frame(view));
    CHECK(view->mode == PU_DESKTOP_MAXIMIZED && frame_hash(view));
    struct wlr_box restored = {0}; pu_decoration_inset(view, &restored, false);
    CHECK(restored.y > 0);
    before = frame_hash(view);
    CHECK(command(TEST_RENAME, 1, 0) && changed(view, before));
    CHECK(!desktop.shell_pid);
    puts("PASS: daemon disconnect held old presentation; new process rebuilt pending geometry/current theme");
    CHECK(command(TEST_FULLSCREEN, 0, 0));
    for (int i = 0; i < 200 && view->geometry_pending; i++) CHECK(pump());
    CHECK(!pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    CHECK(command(TEST_UNFULLSCREEN, 0, 0) && wait_frame(view));
    CHECK(command(TEST_DECORATION, 1, 0));
    for (int i = 0; i < 200 && view->geometry_pending; i++) CHECK(pump());
    CHECK(!pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    CHECK(command(TEST_DECORATION, 2, 0) && wait_frame(view));
    CHECK(click(view, PU_DECORATION_CLOSE));
    CHECK(reply.closed == 1);
    CHECK(command(TEST_QUIT, 0, 0));
    puts("PASS: explicit CSD/frameless/fullscreen preserved; caption close reached actual client");
    return true;
}
static void stop_child(pid_t *pid)
{
    if (*pid <= 0) return;
    if (kill(*pid, SIGTERM) < 0 && errno != ESRCH) perror("terminate fixture");
    int status;
    for (int i = 0; i < 100; i++) {
        pid_t result = waitpid(*pid, &status, WNOHANG);
        if (result == *pid || (result < 0 && errno == ECHILD)) { *pid = 0; return; }
        struct timespec delay = {.tv_nsec = 10000000};
        nanosleep(&delay, NULL);
    }
    if (kill(*pid, SIGKILL) < 0 && errno != ESRCH) perror("kill fixture");
    while (waitpid(*pid, &status, 0) < 0 && errno == EINTR) {}
    *pid = 0;
}
int main(int argc, char **argv)
{
    if (argc != 4) return 2;
    wlr_log_init(WLR_INFO, NULL);
    bool ready = pu_desktop_init(&desktop, "decorator-fixture") && pu_desktop_start(&desktop);
    bool passed = false;
    if (ready) {
        wlr_pointer_init(&pointer, &pointer_impl, "decorator-fixture-pointer");
        wlr_keyboard_init(&keyboard, &keyboard_impl, "decorator-fixture-keyboard");
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &pointer.base);
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &keyboard.base);
        passed = suite(argv[1], argv[2], argv[3]);
        stop_child(&wire_pid); stop_child(&app_pid);
        wlr_pointer_finish(&pointer); wlr_keyboard_finish(&keyboard);
    }
    if (control >= 0) close(control);
    pu_desktop_finish(&desktop);
    return passed ? 0 : 1;
}
