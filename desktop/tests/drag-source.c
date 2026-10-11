#define _GNU_SOURCE
#include "../../gui/tests/drag-wire.h"
#include "data-device.h"
#include "server.h"
#include <errno.h>
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
#include <wlr/interfaces/wlr_keyboard.h>
#include <wlr/interfaces/wlr_pointer.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_pointer.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>

#define CHECK(x)                                                                                                       \
    do                                                                                                                 \
    {                                                                                                                  \
        if (!(x))                                                                                                      \
        {                                                                                                              \
            fprintf(stderr, "FAIL %s:%d %s\n", scenario, __LINE__, #x);                                                \
            return 0;                                                                                                  \
        }                                                                                                              \
    } while (0)
static struct PuDesktop desktop;
static struct wlr_keyboard keyboard;
static struct wlr_pointer pointer;
static const struct wlr_keyboard_impl keyboard_impl = { .name = "drag-product-keyboard" };
static const struct wlr_pointer_impl pointer_impl = { .name = "drag-product-pointer" };
static const char *scenario;
struct Peer
{
    pid_t pid;
    int fd, status, exited;
    struct DragReceipt receipt;
};
static struct Peer app, receiver;
static long long millis(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static int pump(void)
{
    wl_display_flush_clients(desktop.display);
    return wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 5) >= 0 && !desktop.failed;
}
static int settle(int ms)
{
    long long end = millis() + ms;
    do
    {
        CHECK(pump());
    } while (millis() < end);
    return 1;
}
static struct PuDesktopView *view(const char *title)
{
    struct PuDesktopView *v;
    wl_list_for_each(v, &desktop.views, link) if (v->mapped && !v->geometry_pending && v->toplevel->title
        && !strcmp(v->toplevel->title, title)) return v;
    return NULL;
}
static int command(struct Peer *p, int code, int mode)
{
    struct DragRequest request = { code, mode };
    CHECK(send(p->fd, &request, sizeof(request), MSG_NOSIGNAL) == sizeof(request));
    long long end = millis() + 3500;
    do
    {
        CHECK(pump());
        ssize_t n = recv(p->fd, &p->receipt, sizeof(p->receipt), MSG_DONTWAIT);
        if (n == sizeof(p->receipt))
            return 1;
        CHECK(n < 0 && (errno == EAGAIN || errno == EINTR));
    } while (millis() < end);
    fprintf(stderr, "FAIL native command timeout %s code=%d\n", scenario, code);
    return 0;
}
static int spawn(struct Peer *p, const char *exe, const char *script, const char *mode)
{
    int fds[2];
    CHECK(socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, fds) == 0);
    p->pid = fork();
    CHECK(p->pid >= 0);
    if (!p->pid)
    {
        close(fds[0]);
        fcntl(fds[1], F_SETFD, 0);
        char fd[24];
        snprintf(fd, sizeof(fd), "%d", fds[1]);
        execl(exe, exe, fd, script, mode, (char *)NULL);
        _exit(127);
    }
    close(fds[1]);
    p->fd = fds[0];
    return 1;
}
static void motion(double x, double y)
{
    struct wlr_box box;
    wlr_output_layout_get_box(desktop.layout, NULL, &box);
    struct wlr_pointer_motion_absolute_event event
        = { .pointer = &pointer, .time_msec = 1000, .x = (x - box.x) / box.width, .y = (y - box.y) / box.height };
    wl_signal_emit_mutable(&pointer.events.motion_absolute, &event);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
}
static void button(int down)
{
    struct wlr_pointer_button_event event = { .pointer = &pointer,
        .time_msec = 1001,
        .button = BTN_LEFT,
        .state = down ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED };
    wlr_pointer_notify_button(&pointer, &event);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
}
static int wait_views(void)
{
    long long end = millis() + 5000;
    do
    {
        CHECK(pump());
        if (view("Drag.source") && view("Drag.peer") && view("Drag.native"))
            return 1;
    } while (millis() < end);
    CHECK(0);
}
static int terminal(int copied, int cancelled, int error)
{
    long long end = millis() + 3500;
    do
    {
        CHECK(command(&app, DRAG_QUERY, 0));
        if (app.receipt.copied >= copied && app.receipt.cancelled >= cancelled && app.receipt.error >= error)
            return 1;
    } while (millis() < end);
    CHECK(0);
}
static int quit_peer(struct Peer *p)
{
    if (!p->pid || p->exited)
        return 1;
    CHECK(command(p, DRAG_QUIT, 0));
    long long end = millis() + 3500;
    do
    {
        CHECK(pump());
        pid_t result = waitpid(p->pid, &p->status, WNOHANG);
        if (result == p->pid)
        {
            p->exited = 1;
            return 1;
        }
    } while (millis() < end);
    CHECK(0);
}
static int suite(const char *exe, const char *script)
{
    CHECK(spawn(&app, exe, script, scenario));
    CHECK(spawn(&receiver, exe, "--receiver", scenario));
    CHECK(wait_views());
    wlr_scene_node_set_position(&view("Drag.source")->tree->node, 30, 60);
    wlr_scene_node_set_position(&view("Drag.peer")->tree->node, 480, 60);
    wlr_scene_node_set_position(&view("Drag.native")->tree->node, 30, 400);
    if (view("Drag.owner"))
        wlr_scene_node_set_position(&view("Drag.owner")->tree->node, 900, 60);
    motion(80, 110);
    CHECK(settle(80));
    button(1);
    CHECK(settle(60));
    CHECK(command(&app, DRAG_QUERY, 0));
    CHECK(app.receipt.down == 1);
    if (!strcmp(scenario, "getter-detach"))
    {
        CHECK(command(&app, DRAG_START, 6));
        CHECK(app.receipt.invalid == 1 && !pu_data_device_drag_active(&desktop));
        button(0);
    }
    else if (!strcmp(scenario, "released"))
    {
        button(0);
        CHECK(settle(40));
        CHECK(command(&app, DRAG_START, 3));
        CHECK(app.receipt.invalid == 1 && !pu_data_device_drag_active(&desktop));
    }
    else
    {
        int large = !strcmp(scenario, "above-quota"), empty = !strcmp(scenario, "empty");
        int formats = !strcmp(scenario, "multi-format");
        int binary = !strcmp(scenario, "binary") || !strcmp(scenario, "blocked") || large || empty;
        if (large || empty)
            CHECK(command(&receiver, DRAG_EXPECT_SIZE, large ? 17 * 1024 * 1024 : 0));
        CHECK(command(&app, DRAG_START, formats ? 8 : large ? 5 : empty ? 4 : binary ? 1 : 2));
        CHECK(settle(60));
        CHECK(pu_data_device_drag_active(&desktop));
        if (!strcmp(scenario, "cancel") || !strcmp(scenario, "gc") || !strcmp(scenario, "detach")
            || !strcmp(scenario, "close") || !strcmp(scenario, "escape") || !strcmp(scenario, "quit")
            || !strcmp(scenario, "seat-loss") || !strcmp(scenario, "global-loss") || !strcmp(scenario, "owner-close")
            || !strcmp(scenario, "generation") || !strcmp(scenario, "connection-loss"))
        {
            if (!strcmp(scenario, "escape"))
            {
                struct wlr_keyboard_key_event e = {
                    .time_msec = 1002, .keycode = KEY_ESC, .state = WL_KEYBOARD_KEY_STATE_PRESSED, .update_state = true
                };
                wlr_keyboard_notify_key(&keyboard, &e);
                e.state = WL_KEYBOARD_KEY_STATE_RELEASED;
                wlr_keyboard_notify_key(&keyboard, &e);
            }
            else if (!strcmp(scenario, "seat-loss"))
                wlr_seat_set_capabilities(desktop.seat, WL_SEAT_CAPABILITY_KEYBOARD);
            else if (!strcmp(scenario, "global-loss"))
                wl_global_remove(desktop.seat->global);
            else if (!strcmp(scenario, "connection-loss"))
            {
                wl_client_destroy(wl_resource_get_client(view("Drag.source")->toplevel->base->surface->resource));
                long long end = millis() + 3500;
                do
                {
                    CHECK(pump());
                    if (waitpid(app.pid, &app.status, WNOHANG) == app.pid)
                    {
                        app.exited = 1;
                        break;
                    }
                } while (millis() < end);
                CHECK(app.exited && WIFEXITED(app.status));
            }
            else if (!strcmp(scenario, "quit"))
                CHECK(quit_peer(&app));
            else
                CHECK(command(&app,
                    !strcmp(scenario, "cancel")       ? DRAG_CANCEL
                        : !strcmp(scenario, "gc")     ? DRAG_GC
                        : !strcmp(scenario, "detach") ? DRAG_DETACH
                                                      : DRAG_CLOSE,
                    !strcmp(scenario, "owner-close")      ? 1
                        : !strcmp(scenario, "generation") ? 2
                                                          : 0));
            if (!app.exited && strcmp(scenario, "gc"))
                CHECK(terminal(0, (!strcmp(scenario, "seat-loss") || !strcmp(scenario, "global-loss")) ? 0 : 1,
                    (!strcmp(scenario, "seat-loss") || !strcmp(scenario, "global-loss")) ? 1 : 0));
            CHECK(settle(100));
            CHECK(!pu_data_device_drag_active(&desktop));
            button(0);
        }
        else
        {
            int self = !strcmp(scenario, "self"),
                sdl = !strcmp(scenario, "sdl") || !strcmp(scenario, "reverse") || self;
            if (!sdl)
                CHECK(command(&receiver, DRAG_HOLD_FINISH, 1));
            if (!strcmp(scenario, "refuse"))
                CHECK(command(&receiver, DRAG_REFUSE, 1));
            if (!strcmp(scenario, "sender-error"))
                CHECK(command(&receiver, DRAG_ABORT_READ, 1));
            if (!strcmp(scenario, "blocked"))
                CHECK(command(&receiver, DRAG_HOLD_READ, 1));
            motion(sdl ? (self ? 100 : 530) : 80, sdl ? 110 : 450);
            CHECK(settle(150));
            if (!strcmp(scenario, "target-exit"))
                CHECK(quit_peer(&receiver));
            button(0);
            CHECK(settle(200));
            if (!strcmp(scenario, "sender-error"))
                CHECK(terminal(0, 0, 1));
            else if (!strcmp(scenario, "refuse") || !strcmp(scenario, "target-exit"))
                CHECK(terminal(0, 1, 0));
            else
            {
                if (!strcmp(scenario, "blocked"))
                {
                    CHECK(command(&app, DRAG_QUERY, 0));
                    int beats = app.receipt.heartbeat;
                    CHECK(app.receipt.pending && !app.receipt.copied);
                    CHECK(settle(80));
                    CHECK(command(&app, DRAG_QUERY, 0));
                    CHECK(app.receipt.heartbeat > beats);
                    CHECK(command(&receiver, DRAG_HOLD_READ, 0));
                }
                if (!sdl)
                {
                    long long end = millis() + 3500;
                    do
                    {
                        CHECK(command(&receiver, DRAG_QUERY, 0));
                        if (receiver.receipt.received)
                            break;
                    } while (millis() < end);
                    CHECK(receiver.receipt.received == 1);
                    CHECK(command(&app, DRAG_QUERY, 0));
                    CHECK(app.receipt.pending && !app.receipt.copied);
                    if (!strcmp(scenario, "after-drop-exit"))
                    {
                        CHECK(quit_peer(&receiver));
                        CHECK(terminal(0, 1, 0));
                    }
                    else
                    {
                        CHECK(command(&receiver, DRAG_FINISH, 0));
                        CHECK(terminal(1, 0, 0));
                    }
                }
                else
                {
                    CHECK(terminal(1, 0, 0));
                    CHECK(app.receipt.received == 1);
                    if (!strcmp(scenario, "reverse"))
                    {
                        motion(530, 110);
                        CHECK(settle(60));
                        button(1);
                        CHECK(settle(50));
                        CHECK(command(&app, DRAG_START, 7));
                        CHECK(settle(60));
                        CHECK(pu_data_device_drag_active(&desktop));
                        motion(80, 110);
                        CHECK(settle(100));
                        button(0);
                        CHECK(terminal(2, 0, 0));
                        CHECK(app.receipt.received == 2);
                    }
                }
            }
        }
    }
    if (!app.exited && strcmp(scenario, "close") && strcmp(scenario, "detach") && strcmp(scenario, "reentrant")
        && strcmp(scenario, "seat-loss") && strcmp(scenario, "global-loss") && strcmp(scenario, "owner-close")
        && strcmp(scenario, "generation") && strcmp(scenario, "getter-detach"))
    {
        CHECK(command(&app, DRAG_QUERY, 0));
        int down = app.receipt.down, up = app.receipt.up;
        motion(80, 110);
        CHECK(settle(60));
        button(1);
        CHECK(settle(40));
        button(0);
        CHECK(settle(50));
        CHECK(command(&app, DRAG_QUERY, 0));
        CHECK(app.receipt.down == down + 1 && app.receipt.up == up + 1);
        CHECK(command(&app, DRAG_WRITE_CLIP, 0));
        CHECK(command(&app, DRAG_READ_CLIP, 0));
        CHECK(app.receipt.clipboard == 1);
    }
    if (!app.exited)
    {
        CHECK(command(&app, DRAG_QUERY, 0));
        CHECK(app.receipt.error
            == ((!strcmp(scenario, "seat-loss") || !strcmp(scenario, "global-loss")
                    || !strcmp(scenario, "sender-error"))
                    ? 1
                    : 0));
        if (app.receipt.copied)
        {
            CHECK(command(&app, DRAG_CANCEL, 0));
            CHECK(settle(30));
            CHECK(command(&app, DRAG_QUERY, 0));
            CHECK(app.receipt.copied == (!strcmp(scenario, "reverse") ? 2 : 1) && !app.receipt.cancelled);
        }
        printf("RECEIPT %s down=%d copied=%d cancelled=%d error=%d received=%d invalid=%d heartbeat=%d\n", scenario,
            app.receipt.down, app.receipt.copied, app.receipt.cancelled, app.receipt.error, app.receipt.received,
            app.receipt.invalid, app.receipt.heartbeat);
    }
    CHECK(quit_peer(&app));
    CHECK(quit_peer(&receiver));
    CHECK(WIFEXITED(app.status) && (!strcmp(scenario, "connection-loss") || WEXITSTATUS(app.status) == 0));
    CHECK(WIFEXITED(receiver.status) && WEXITSTATUS(receiver.status) == 0);
    return 1;
}
int main(int argc, char **argv)
{
    if (argc != 4)
        return 2;
    scenario = argv[3];
    setvbuf(stdout, NULL, _IOLBF, 0);
    setenv("WLR_BACKENDS", "headless", 1);
    setenv("WLR_RENDERER", "pixman", 1);
    setenv("SDL_VIDEODRIVER", "wayland", 1);
    setenv("SDL_RENDER_DRIVER", "software", 1);
    setenv("PU_RENDERER", "raster", 1);
    setenv("SDL_MOUSE_FOCUS_CLICKTHROUGH", "1", 1);
    wlr_log_init(WLR_INFO, NULL);
    signal(SIGPIPE, SIG_IGN);
    if (!pu_desktop_init(&desktop, "product-copy"))
        return 2;
    if (!pu_desktop_start(&desktop))
        return 2;
    setenv("WAYLAND_DISPLAY", "product-copy", 1);
    wlr_keyboard_init(&keyboard, &keyboard_impl, "drag-product-keyboard");
    wlr_pointer_init(&pointer, &pointer_impl, "drag-product-pointer");
    wl_signal_emit_mutable(&desktop.backend->events.new_input, &keyboard.base);
    wl_signal_emit_mutable(&desktop.backend->events.new_input, &pointer.base);
    int ok = suite(argv[1], argv[2]);
    struct Peer *peers[] = { &app, &receiver };
    for (int i = 0; i < 2; i++)
    {
        if (peers[i]->pid && !peers[i]->exited)
        {
            kill(peers[i]->pid, SIGKILL);
            waitpid(peers[i]->pid, NULL, 0);
        }
        if (peers[i]->fd > 0)
            close(peers[i]->fd);
    }
    wlr_pointer_finish(&pointer);
    wlr_keyboard_finish(&keyboard);
    if (!strcmp(scenario, "global-loss"))
    {
        /* The fault fixture unpublished a wlroots-owned global. Do not ask
         * wlroots to remove it twice; both production clients already retired. */
        printf("%s actual JS-to-native COPY %s\n", ok ? "PASS" : "FAIL", scenario);
        _exit(ok ? 0 : 1);
    }
    pu_desktop_finish(&desktop);
    printf("%s actual JS-to-native COPY %s\n", ok ? "PASS" : "FAIL", scenario);
    return ok ? 0 : 1;
}
