#include "server.h"
#include "decoration.h"
#include "shortcut-control.h"
#include <drm_fourcc.h>
#include <linux/input-event-codes.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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
#include <wlr/types/wlr_xdg_dialog_v1.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>

#define CHECK(condition) do { if (!(condition)) { \
    fprintf(stderr, "FAIL native line %d: %s\n", __LINE__, #condition); return false; \
} } while (0)

static struct PuDesktop desktop;
static struct wlr_keyboard keyboard;
static struct wlr_pointer pointer;
static const struct wlr_keyboard_impl keyboard_impl = { .name = "window-contract-keyboard" };
static const struct wlr_pointer_impl pointer_impl = { .name = "window-contract-pointer" };
static uint32_t time_msec = 1000;
static pid_t child;
static bool no_dialog;
static bool tooltip;
static bool lifetime;
static bool close_tree;

static bool global_filter(const struct wl_client *client, const struct wl_global *global, void *data)
{
    if (!strcmp(wl_global_get_interface(global)->name, "xdg_wm_dialog_v1")) return false;
    return pu_desktop_global_filter(client, global, data);
}

static bool pump(void)
{
    wl_display_flush_clients(desktop.display);
    return wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 5) >= 0 && !desktop.failed;
}

static bool settle_native_focus(void)
{
    struct timespec start, now;
    CHECK(!clock_gettime(CLOCK_MONOTONIC, &start));
    do {
        CHECK(pump());
        CHECK(!clock_gettime(CLOCK_MONOTONIC, &now));
    } while ((now.tv_sec - start.tv_sec) * 1000000000LL + now.tv_nsec - start.tv_nsec < 25000000);
    return true;
}

static struct PuDesktopView *view(const char *title)
{
    struct PuDesktopView *v;
    wl_list_for_each(v, &desktop.views, link)
        if (v->mapped && !v->geometry_pending && v->toplevel->title &&
            !strcmp(v->toplevel->title, title)) return v;
    return NULL;
}

static bool wait_view(const char *title)
{
    for (int i = 0; i < 600; i++) {
        CHECK(pump());
        if (view(title)) return true;
    }
    CHECK(false);
}

static bool pixel(struct wlr_surface *surface, uint32_t expected)
{
    void *pixels;
    uint32_t format, value;
    size_t stride;
    if (!surface->buffer || !surface->buffer->source ||
        !wlr_buffer_begin_data_ptr_access(surface->buffer->source,
            WLR_BUFFER_DATA_PTR_ACCESS_READ, &pixels, &format, &stride)) return false;
    memcpy(&value, (char *)pixels + stride * 10 + 40, sizeof(value));
    wlr_buffer_end_data_ptr_access(surface->buffer->source);
    return (format == DRM_FORMAT_ARGB8888 || format == DRM_FORMAT_XRGB8888) &&
        (value & 0xffffff) == expected;
}

static bool wait_pixel(const char *title, uint32_t color)
{
    for (int i = 0; i < 600; i++) {
        CHECK(pump());
        struct PuDesktopView *v = view(title);
        if (v && pixel(v->toplevel->base->surface, color)) return true;
    }
    CHECK(false);
}

static void motion(double x, double y)
{
    struct wlr_box bounds;
    wlr_output_layout_get_box(desktop.layout, NULL, &bounds);
    struct wlr_pointer_motion_absolute_event event = { .pointer = &pointer, .time_msec = ++time_msec,
        .x = (x - bounds.x) / bounds.width, .y = (y - bounds.y) / bounds.height };
    wl_signal_emit_mutable(&pointer.events.motion_absolute, &event);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
}
static void button(bool pressed)
{
    struct wlr_pointer_button_event event = { .pointer = &pointer, .time_msec = ++time_msec,
        .button = BTN_LEFT, .state = pressed ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED };
    wlr_pointer_notify_button(&pointer, &event);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
}

static bool wait_size(int width, int height, bool maximized)
{
    for (int i = 0; i < 600; i++) {
        CHECK(pump());
        struct PuDesktopView *v = view("Contract.sized");
        if (v && v->toplevel->base->geometry.width == width && v->toplevel->base->geometry.height == height &&
            v->toplevel->current.maximized == maximized) return true;
    }
    CHECK(false);
}

static bool suite(const char *exe, const char *script, const char *capture)
{
    struct wlr_output_layout_output *entry = wl_container_of(desktop.layout->outputs.next, entry, link);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_custom_mode(&state, 1800, 1200, 60000);
    wlr_output_state_set_scale(&state, 1.5f);
    bool configured = wlr_output_commit_state(entry->output, &state);
    wlr_output_state_finish(&state);
    CHECK(configured);
    child = fork();
    CHECK(child >= 0);
    if (!child) {
        setenv("WAYLAND_DISPLAY", desktop.socket_name, 1);
        setenv("SDL_VIDEODRIVER", "wayland", 1);
        setenv("SDL_RENDER_DRIVER", "software", 1);
        setenv("PU_RENDERER", "raster", 1);
        execl(exe, exe, script, capture, no_dialog ? "unsupported" : tooltip ? "tooltip" : "native", (char *)NULL);
        perror("exec native window client"); _exit(127);
    }
    if (no_dialog || lifetime) {
        int status = 0;
        for (int i = 0; i < 600; i++) {
            CHECK(pump());
            pid_t result = waitpid(child, &status, WNOHANG);
            CHECK(result >= 0);
            if (result == child) { child = 0; break; }
        }
        CHECK(!child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
        return true;
    }
    if (close_tree) {
        CHECK(wait_view("Close.owner") && wait_view("Close.grand") && wait_view("Close.peer") &&
            wait_view("Close.gc") && wait_view("PollyUI"));
        pu_desktop_focus_mapped(&desktop, view("Close.peer")->workspace_window);
        CHECK(wait_pixel("Close.grand", 0x304080));
        struct PuDesktopView *owner = view("Close.owner"), *child_view = view("Close.child");
        struct PuDesktopView *grand = view("Close.grand");
        CHECK(child_view && child_view->toplevel->parent == owner->toplevel &&
            grand->toplevel->parent == child_view->toplevel && grand->dialog && grand->dialog->modal);
        pu_desktop_focus_mapped(&desktop, grand->workspace_window);
        CHECK(wait_pixel("Close.grand", 0x406090));
        motion(grand->tree->node.x + 20, grand->tree->node.y + 20);
        CHECK(desktop.seat->pointer_state.focused_surface == grand->toplevel->base->surface);
        /* SDL deliberately suppresses clicks immediately following native focus.
         * Respect that OS-input policy instead of enabling click-through globally. */
        CHECK(settle_native_focus());
        button(true);
        CHECK(desktop.seat->pointer_state.button_count == 1);
        CHECK(wait_pixel("Close.grand", 0x20c040));
        wlr_xdg_toplevel_send_close(owner->toplevel);
        CHECK(wait_view("Close.save"));
        for (int i = 0; i < 200 && (view("Close.peer") || !view("Close.owner") ||
            !view("Close.child") || !view("Close.grand")); i++) CHECK(pump());
        CHECK(view("Close.owner") && view("Close.child") && view("Close.grand") && !view("Close.peer"));
        struct PuDesktopView *save = view("Close.save");
        CHECK(save->toplevel->parent == view("Close.grand")->toplevel && save->dialog && save->dialog->modal);
        button(false);
        puts("PASS: native Wayland parent retained after descendant veto and native save prompt creation");
        wlr_xdg_toplevel_send_close(save->toplevel);
        for (int i = 0; i < 300 && view("Close.save"); i++) CHECK(pump());
        CHECK(!view("Close.save") && desktop.focused == view("Close.grand") &&
            desktop.seat->keyboard_state.focused_surface == view("Close.grand")->toplevel->base->surface);
        puts("PASS: native modal child retirement restores live owner keyboard focus");
        CHECK(wait_view("Close.retry"));
        CHECK(view("Close.owner") && view("Close.child") && view("Close.grand") && !view("Close.save"));
        puts("PASS: Promise settlement did not retry close or silently destroy native owners");
        wlr_xdg_toplevel_send_close(view("Close.owner")->toplevel);
        int status = 0;
        for (int i = 0; i < 800; i++) {
            CHECK(pump());
            pid_t result = waitpid(child, &status, WNOHANG);
            CHECK(result >= 0);
            if (result == child) { child = 0; break; }
        }
        CHECK(!child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
        CHECK(!view("Close.owner") && !view("Close.child") && !view("Close.grand"));
        puts("PASS: real native owner-close retry, actual child notifications and forced quit complete");
        return true;
    }
    CHECK(wait_view("Contract.modal") && wait_view("Contract.owner") &&
        wait_view("Contract.owned") && wait_view("Contract.sized"));
    struct PuDesktopView *owner = view("Contract.owner"), *modal = view("Contract.modal");
    struct PuDesktopView *sized = view("Contract.sized"), *owned = view("Contract.owned");
    pid_t pid;
    wl_client_get_credentials(wl_resource_get_client(owner->toplevel->resource), &pid, NULL, NULL);
    CHECK(pid == child && wl_resource_get_client(modal->toplevel->resource) ==
        wl_resource_get_client(owner->toplevel->resource));
    CHECK(owned->toplevel->parent == owner->toplevel && modal->toplevel->parent == owner->toplevel &&
        modal->dialog && modal->dialog->modal);
    CHECK(sized->toplevel->current.min_width == 200 && sized->toplevel->current.min_height == 140 &&
        sized->toplevel->current.max_width == 420 && sized->toplevel->current.max_height == 300);
    CHECK(wait_size(200, 140, false));
    wlr_scene_node_set_position(&owner->tree->node, 20, 100);
    wlr_scene_node_set_position(&modal->tree->node, 20, 420);
    wlr_scene_node_set_position(&owned->tree->node, 750, 100);
    wlr_scene_node_set_position(&sized->tree->node, 400, 100);
    pu_desktop_focus_mapped(&desktop, owner->workspace_window);
    CHECK(desktop.focused == modal);
    motion(50, 140); button(true); button(false);
    CHECK(desktop.focused == modal && desktop.seat->pointer_state.focused_surface == NULL);
    CHECK(desktop.seat->keyboard_state.focused_surface == modal->toplevel->base->surface);
    struct wlr_keyboard_key_event key = { .time_msec = ++time_msec, .keycode = KEY_A,
        .update_state = true, .state = WL_KEYBOARD_KEY_STATE_PRESSED };
    wlr_keyboard_notify_key(&keyboard, &key);
    key.time_msec = ++time_msec; key.state = WL_KEYBOARD_KEY_STATE_RELEASED;
    wlr_keyboard_notify_key(&keyboard, &key);
    CHECK(wait_pixel("Contract.modal", 0x20c040));
    puts("PASS: same-client xdg parents and standard modal block owner-native input only");
    motion(601, 241); button(true);
    CHECK(desktop.grab == PU_DESKTOP_RESIZE && desktop.grabbed == sized);
    motion(1100, 700);
    CHECK(wait_size(420, 300, false));
    button(false);
    motion(821, 401); button(true);
    CHECK(desktop.grab == PU_DESKTOP_RESIZE);
    motion(402, 102);
    CHECK(wait_size(200, 140, false));
    button(false);
    struct wlr_box box;
    CHECK(pu_decoration_button_box(sized, PU_DECORATION_MAXIMIZE, &box));
    motion(sized->tree->node.x + box.x + box.width / 2,
        sized->tree->node.y + box.y + box.height / 2);
    button(true); button(false);
    CHECK(wait_size(420, 300, true));
    CHECK(pu_decoration_button_box(sized, PU_DECORATION_MAXIMIZE, &box));
    motion(sized->tree->node.x + box.x + box.width / 2,
        sized->tree->node.y + box.y + box.height / 2);
    button(true); button(false);
    CHECK(wait_size(200, 140, false));
    struct wlr_surface *surface = sized->toplevel->base->surface;
    CHECK(surface->current.buffer_width == 300 && surface->current.buffer_height == 210);
    puts("PASS: real native resize/maximize constrain logical client size with 1.5x buffer geometry");
    wlr_xdg_toplevel_send_close(modal->toplevel);
    CHECK(wait_pixel("Contract.modal", 0xc04020));
    CHECK(view("Contract.modal") && modal->dialog->modal);
    wlr_xdg_toplevel_send_close(modal->toplevel);
    for (int i = 0; i < 600; i++) {
        CHECK(pump());
        owner = view("Contract.owner");
        CHECK(owner);
        if (!view("Contract.modal") && !wl_list_empty(&owner->toplevel->base->popups)) break;
    }
    CHECK(!view("Contract.modal") && !wl_list_empty(&owner->toplevel->base->popups));
    struct wlr_xdg_popup *popup = wl_container_of(owner->toplevel->base->popups.next, popup, link);
    for (int i = 0; i < 600 && !popup->base->surface->mapped; i++) CHECK(pump());
    CHECK(popup->base->surface->mapped && popup->parent == owner->toplevel->base->surface &&
        popup->base->geometry.width == 120 && popup->base->geometry.height == 70);
    CHECK(popup->current.geometry.x == 30 && popup->current.geometry.y == 40 &&
        popup->base->surface->current.buffer_width == 180 && popup->base->surface->current.buffer_height == 105);
    CHECK((pixman_region32_not_empty(&popup->base->surface->input_region) != 0) == !tooltip);
    CHECK(!wlr_seat_pointer_has_grab(desktop.seat));
    for (int i = 0; i < 600 && wl_list_empty(&popup->base->popups); i++) CHECK(pump());
    CHECK(!wl_list_empty(&popup->base->popups));
    struct wlr_xdg_popup *nested_popup = wl_container_of(popup->base->popups.next, nested_popup, link);
    for (int i = 0; i < 600 && !nested_popup->base->surface->mapped; i++) CHECK(pump());
    CHECK(nested_popup->base->surface->mapped && nested_popup->parent == popup->base->surface &&
        nested_popup->base->geometry.width == 60 && nested_popup->base->geometry.height == 30 &&
        !pixman_region32_not_empty(&nested_popup->base->surface->input_region));
    puts("PASS: nested native popup mapped under popup parent with tooltip input exclusion");
    printf("PASS: mapped native xdg_popup kind=%s parent=%s logical=%dx%d offset=%d,%d buffer=%dx%d (explicitly ungrabbed)\n",
        tooltip ? "tooltip" : "popover", owner->toplevel->title,
        popup->base->geometry.width, popup->base->geometry.height,
        popup->current.geometry.x, popup->current.geometry.y,
        popup->base->surface->current.buffer_width, popup->base->surface->current.buffer_height);
    wlr_xdg_popup_destroy(popup);
    int status = 0;
    for (int i = 0; i < 600; i++) {
        CHECK(pump());
        pid_t result = waitpid(child, &status, WNOHANG);
        CHECK(result >= 0);
        if (result == child) { child = 0; break; }
    }
    CHECK(!child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    puts("PASS: compositor popup_done, native close veto, JS state/viewport and child cleanup complete");
    return true;
}

int main(int argc, char **argv)
{
    if (argc != 4 && argc != 5) return 2;
    no_dialog = argc == 5 && !strcmp(argv[4], "--no-dialog");
    tooltip = argc == 5 && !strcmp(argv[4], "--tooltip");
    lifetime = argc == 5 && !strcmp(argv[4], "--lifetime");
    close_tree = argc == 5 && !strcmp(argv[4], "--close-tree");
    if (argc == 5 && !no_dialog && !tooltip && !lifetime && !close_tree) return 2;
    wlr_log_init(WLR_INFO, NULL);
    bool ready = pu_desktop_init(&desktop, "native-window-contract");
    if (ready && no_dialog) wl_display_set_global_filter(desktop.display, global_filter, &desktop);
    if (ready) ready = pu_desktop_start(&desktop);
    bool passed = false;
    if (ready) {
        wlr_keyboard_init(&keyboard, &keyboard_impl, "window-contract-keyboard");
        wlr_pointer_init(&pointer, &pointer_impl, "window-contract-pointer");
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &keyboard.base);
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &pointer.base);
        passed = suite(argv[1], argv[2], argv[3]);
        if (child > 0) {
            kill(child, SIGTERM);
            for (int i = 0; i < 50 && child > 0; i++) {
                pump();
                if (waitpid(child, NULL, WNOHANG) == child) child = 0;
            }
            if (child > 0) { kill(child, SIGKILL); waitpid(child, NULL, 0); child = 0; }
        }
        wlr_pointer_finish(&pointer); wlr_keyboard_finish(&keyboard);
    }
    pu_desktop_finish(&desktop);
    return passed ? 0 : 1;
}
