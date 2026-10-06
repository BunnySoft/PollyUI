#include "server.h"
#include "session-lock.h"
#include <signal.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/interfaces/wlr_keyboard.h>
#include <linux/input-event-codes.h>
#include <wlr/backend/headless.h>
#include <wlr/backend/multi.h>
#include <wlr/util/log.h>

#define CHECK(value) do { if (!(value)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #value); goto failed; } } while (0)
static const struct wlr_keyboard_impl keyboard_impl = {.name = "lock-fixture-keyboard"};
static void send_key(struct wlr_keyboard *keyboard, uint32_t code)
{
    static uint32_t clock = 2000;
    struct wlr_keyboard_key_event event = {.keycode = code, .state = WL_KEYBOARD_KEY_STATE_PRESSED,
        .time_msec = clock++, .update_state = true};
    wlr_keyboard_notify_key(keyboard, &event);
    event.state = WL_KEYBOARD_KEY_STATE_RELEASED; event.time_msec = clock++;
    wlr_keyboard_notify_key(keyboard, &event);
}
static void tick(struct PuDesktop *desktop)
{
    wl_display_flush_clients(desktop->display);
    wl_event_loop_dispatch(wl_display_get_event_loop(desktop->display), 10);
}
static void find_headless(struct wlr_backend *backend, void *data)
{ if (wlr_backend_is_headless(backend)) *(struct wlr_backend **)data = backend; }
static bool black_at(struct PuDesktop *desktop, double x, double y)
{
    double sx, sy;
    struct wlr_scene_node *node = wlr_scene_node_at(&desktop->scene->tree.node, x, y, &sx, &sy);
    if (!node || node->type != WLR_SCENE_NODE_RECT) return false;
    struct wlr_scene_rect *rect = wl_container_of(node, rect, node);
    return rect->color[0] == 0 && rect->color[1] == 0 && rect->color[2] == 0 && rect->color[3] == 1;
}
int main(int argc, char **argv)
{
    if (argc != 2 && argc != 4 && argc != 5) return 2;
    wlr_log_init(WLR_ERROR, NULL);
    struct PuDesktop desktop;
    struct wlr_keyboard keyboard;
    bool keyboard_ready = false;
    bool ready = pu_desktop_init(&desktop, "lock-test");
    if (!ready) goto failed;
    CHECK(pu_desktop_start(&desktop));
    wlr_keyboard_init(&keyboard, &keyboard_impl, "lock-fixture-keyboard");
    keyboard_ready = true;
    wl_signal_emit_mutable(&desktop.backend->events.new_input, &keyboard.base);
    struct wlr_scene_rect *background = wlr_scene_rect_create(desktop.windows, 2560, 720, (float[4]){1, 0, 0, 1});
    CHECK(background);
    for (int i = 0; i < 20; i++) tick(&desktop);
    CHECK(!black_at(&desktop, 20, 20));
    CHECK(setenv("WAYLAND_DISPLAY", "lock-test", 1) == 0);
    pid_t public = fork();
    CHECK(public >= 0);
    if (public == 0) { execl(argv[1], argv[1], "public", NULL); _exit(127); }
    int status = 0;
    bool exited = false;
    for (int i = 0; i < 300; i++) {
        tick(&desktop);
        if (waitpid(public, &status, WNOHANG) == public) { exited = true; break; }
    }
    if (!exited) { kill(public, SIGKILL); waitpid(public, &status, 0); }
    CHECK(exited && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    char *crash[] = {argv[1], "crash", NULL};
    wlr_seat_pointer_notify_button(desktop.seat, 1, BTN_LEFT, WL_POINTER_BUTTON_STATE_PRESSED);
    CHECK(pu_session_lock_spawn(&desktop, crash));
    CHECK(pu_session_lock_active(&desktop) && black_at(&desktop, 20, 20));
    CHECK(desktop.seat->pointer_state.button_count == 0);
    CHECK(!desktop.seat->keyboard_state.focused_surface && !desktop.seat->pointer_state.focused_surface);
    for (int i = 0; i < 60; i++) tick(&desktop);
    CHECK(pu_session_lock_active(&desktop) && black_at(&desktop, 20, 20));
    struct wlr_backend *backend = NULL;
    wlr_multi_for_each_backend(desktop.backend, find_headless, &backend);
    CHECK(backend);
    struct wlr_output *extra = wlr_headless_add_output(backend, 640, 480);
    CHECK(extra);
    for (int i = 0; i < 30; i++) tick(&desktop);
    struct wlr_box box;
    wlr_output_layout_get_box(desktop.layout, extra, &box);
    CHECK(box.width == 640 && black_at(&desktop, box.x + 10, box.y + 10));
    wlr_output_destroy(extra);
    CHECK(pu_session_lock_active(&desktop) && black_at(&desktop, 20, 20));
    while (!wl_list_empty(&desktop.layout->outputs)) {
        struct wlr_output_layout_output *output = wl_container_of(desktop.layout->outputs.next, output, link);
        wlr_output_destroy(output->output);
    }
    CHECK(desktop.output_count == 0 && pu_session_lock_active(&desktop));
    CHECK(wlr_headless_add_output(backend, 1280, 720));
    for (int i = 0; i < 20; i++) tick(&desktop);
    CHECK(black_at(&desktop, 20, 20) && pu_session_lock_active(&desktop));
    char *unlock[] = {argv[1], "unlock", NULL};
    CHECK(pu_session_lock_spawn(&desktop, unlock));
    for (int i = 0; i < 300 && pu_session_lock_active(&desktop); i++) tick(&desktop);
    CHECK(!pu_session_lock_active(&desktop));
    CHECK(!black_at(&desktop, 20, 20));
    for (int i = 0; i < 20; i++) tick(&desktop);
    if (argc >= 4) {
        char *ui[] = {argv[2], "--session-lock", argv[3], NULL};
        CHECK(pu_session_lock_spawn(&desktop, ui));
        for (int i = 0; i < 500 && !desktop.seat->keyboard_state.focused_surface; i++) tick(&desktop);
        CHECK(pu_session_lock_surface(&desktop, desktop.seat->keyboard_state.focused_surface));
        struct wlr_keyboard_key_event key = {.keycode = KEY_A, .state = WL_KEYBOARD_KEY_STATE_PRESSED,
            .time_msec = 500, .update_state = true};
        wlr_keyboard_notify_key(&keyboard, &key);
        key.state = WL_KEYBOARD_KEY_STATE_RELEASED; key.time_msec++;
        wlr_keyboard_notify_key(&keyboard, &key);
        for (int i = 0; i < 20; i++) tick(&desktop);
        CHECK(pu_session_lock_active(&desktop));
        if (argc == 5) {
            send_key(&keyboard, KEY_ENTER);
            for (int i = 0; i < 600; i++) tick(&desktop);
            CHECK(pu_session_lock_active(&desktop));
            FILE *source = fopen(argv[4], "rb");
            CHECK(source);
            char password[128];
            size_t length = fread(password, 1, sizeof(password), source);
            fclose(source);
            CHECK(length > 0 && length < sizeof(password));
            const uint32_t codes[] = {KEY_0, KEY_1, KEY_2, KEY_3, KEY_4, KEY_5, KEY_6, KEY_7, KEY_8, KEY_9,
                KEY_A, KEY_B, KEY_C, KEY_D, KEY_E, KEY_F};
            const char *digits = "0123456789abcdef";
            for (size_t i = 0; i < length; i++) {
                const char *digit = strchr(digits, password[i]);
                CHECK(digit);
                send_key(&keyboard, codes[digit - digits]);
                tick(&desktop);
            }
            volatile char *clear = password;
            for (size_t i = 0; i < sizeof(password); i++) clear[i] = 0;
            send_key(&keyboard, KEY_ENTER);
            for (int i = 0; i < 800 && pu_session_lock_active(&desktop); i++) tick(&desktop);
            CHECK(!pu_session_lock_active(&desktop));
            for (int i = 0; i < 300 && pu_session_lock_pid(&desktop); i++) tick(&desktop);
            CHECK(!pu_session_lock_pid(&desktop) && pu_session_lock_client_succeeded(&desktop));
        } else {
            pid_t locker = pu_session_lock_pid(&desktop);
            CHECK(locker > 0 && kill(locker, SIGKILL) == 0);
            for (int i = 0; i < 100 && pu_session_lock_pid(&desktop); i++) tick(&desktop);
            CHECK(!pu_session_lock_pid(&desktop) && pu_session_lock_active(&desktop));
            CHECK(black_at(&desktop, 20, 20) && !desktop.seat->keyboard_state.focused_surface);
            CHECK(pu_session_lock_spawn(&desktop, unlock));
            for (int i = 0; i < 300 && pu_session_lock_active(&desktop); i++) tick(&desktop);
            CHECK(!pu_session_lock_active(&desktop));
        }
    }
    wlr_keyboard_finish(&keyboard);
    keyboard_ready = false;
    pu_desktop_finish(&desktop);
    puts("PASS: private session-lock authority, covered presentation, crash protection, hotplug and explicit unlock");
    return 0;
failed:
    if (keyboard_ready) wlr_keyboard_finish(&keyboard);
    pu_desktop_finish(&desktop);
    return 1;
}
