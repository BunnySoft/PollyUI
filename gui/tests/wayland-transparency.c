#include "server.h"
#include "shortcut-control.h"
#include "decoration.h"
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
#include <wlr/interfaces/wlr_pointer.h>
#include <wlr/render/wlr_texture.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_pointer.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_xdg_decoration_v1.h>
#include <wlr/types/wlr_xdg_dialog_v1.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>

#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL alpha line %d: %s\n", __LINE__, #c); return false; } } while (0)
static struct PuDesktop desktop;
static struct wlr_pointer pointer;
static const struct wlr_pointer_impl pointer_impl = { .name = "transparency-pointer" };
static pid_t child;
static uint32_t time_msec = 1000;
static float scale;

static bool pump(void)
{
    wl_display_flush_clients(desktop.display);
    return wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 5) >= 0 && !desktop.failed;
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
    for (int i = 0; i < 600; i++) { CHECK(pump()); if (view(title)) return true; }
    CHECK(false);
}
static bool read_pixel(struct wlr_buffer *buffer, int x, int y, uint32_t *value)
{
    CHECK(buffer && x >= 0 && y >= 0 && x < buffer->width && y < buffer->height);
    struct wlr_texture *texture = wlr_texture_from_buffer(desktop.renderer, buffer);
    CHECK(texture);
    struct wlr_texture_read_pixels_options options = {
        .data = value, .format = DRM_FORMAT_ARGB8888, .stride = 4,
        .src_box = { x, y, 1, 1 },
    };
    bool ok = wlr_texture_read_pixels(texture, &options);
    wlr_texture_destroy(texture);
    CHECK(ok);
    return true;
}
static bool near(uint32_t actual, uint32_t expected)
{
    for (int shift = 0; shift < 24; shift += 8)
        if (abs((int)((actual >> shift) & 255) - (int)((expected >> shift) & 255)) > 2) return false;
    return true;
}
static bool output_pixel(struct PuDesktopView *v, int x, int y, uint32_t expected)
{
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_lock_attach_render(v->output, true);
    struct wlr_scene_output *output = wlr_scene_get_scene_output(desktop.scene, v->output);
    bool ok = wlr_scene_output_build_state(output, &state, NULL) && state.buffer;
    uint32_t actual = 0;
    if (ok) ok = read_pixel(state.buffer, (int)((v->tree->node.x + x) * scale),
        (int)((v->tree->node.y + y) * scale), &actual);
    wlr_output_state_finish(&state);
    wlr_output_lock_attach_render(v->output, false);
    printf("COMPOSED: %s logical=%d,%d actual=%06x expected=%06x tolerance=2\n",
        v->toplevel->title, x, y, actual & 0xffffff, expected);
    CHECK(ok && near(actual, expected));
    return true;
}
static bool wait_surface(struct PuDesktopView *v, int x, int y, uint32_t expected)
{
    for (int i = 0; i < 600; i++) {
        CHECK(pump());
        struct wlr_surface *s = v->toplevel->base->surface;
        uint32_t actual = 0;
        if (s->buffer && read_pixel(&s->buffer->base, (int)(x * scale), (int)(y * scale), &actual) &&
            actual == expected) return true;
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
static bool suite(const char *exe, const char *script, const char *renderer)
{
    struct wlr_output_layout_output *entry = wl_container_of(desktop.layout->outputs.next, entry, link);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_custom_mode(&state, 1920, 1200, 60000);
    wlr_output_state_set_scale(&state, scale);
    bool configured = wlr_output_commit_state(entry->output, &state);
    wlr_output_state_finish(&state);
    CHECK(configured);
    child = fork();
    CHECK(child >= 0);
    if (!child) {
        setenv("WAYLAND_DISPLAY", desktop.socket_name, 1);
        setenv("SDL_VIDEODRIVER", "wayland", 1);
        setenv("PU_RENDERER", renderer, 1);
        setenv("PU_TRACE_STARTUP", "1", 1);
        execl(exe, exe, script, (char *)NULL);
        perror("exec transparency client"); _exit(127);
    }
    CHECK(wait_view("Alpha.marker") && wait_view("Alpha.opaque") &&
        wait_view("Alpha.framed") && wait_view("Alpha.frameless") && wait_view("Alpha.modal"));
    struct PuDesktopView *marker = view("Alpha.marker"), *framed = view("Alpha.framed");
    struct PuDesktopView *frameless = view("Alpha.frameless"), *opaque = view("Alpha.opaque");
    struct PuDesktopView *modal = view("Alpha.modal");
    CHECK(framed->toplevel->parent == marker->toplevel && modal->toplevel->parent == opaque->toplevel &&
        modal->dialog && modal->dialog->modal);
    wlr_scene_node_set_position(&marker->tree->node, 20, 60);
    wlr_scene_node_set_position(&framed->tree->node, 40, 120);
    wlr_scene_node_set_position(&frameless->tree->node, 40, 350);
    wlr_scene_node_set_position(&opaque->tree->node, 700, 400);
    wlr_scene_node_set_position(&modal->tree->node, 350, 350);
    wlr_scene_node_raise_to_top(&framed->tree->node);
    wlr_scene_node_raise_to_top(&frameless->tree->node);
    wlr_scene_node_raise_to_top(&opaque->tree->node);
    wlr_scene_node_raise_to_top(&modal->tree->node);
    for (int i = 0; i < 20; i++) CHECK(pump());
    struct wlr_box caption_button;
    CHECK(pu_decoration_button_box(framed, PU_DECORATION_CLOSE, &caption_button) &&
        !pu_decoration_button_box(frameless, PU_DECORATION_CLOSE, &caption_button));
    for (int i = 0; i < 2; i++) {
        struct PuDesktopView *v = i ? frameless : framed;
        struct wlr_surface *s = v->toplevel->base->surface;
        CHECK(wait_surface(v, 130, 30, 0xff20e080));
        CHECK(wait_surface(v, 20, 30, 0) && wait_surface(v, 70, 30, 0x80642814));
        CHECK(!pixman_region32_not_empty(&s->opaque_region) && pixman_region32_not_empty(&s->input_region));
        CHECK(output_pixel(v, 20, 30, 0x204080));
        CHECK(output_pixel(v, 70, 30, 0x744854));
        CHECK(output_pixel(v, 130, 30, 0x20e080));
        bool found_text = false;
        for (int y = 80; y < 116 && !found_text; y++) for (int x = 20; x < 120 && !found_text; x++) {
            uint32_t value;
            CHECK(read_pixel(&s->buffer->base, (int)(x * scale), (int)(y * scale), &value));
            if (value == 0xffffffff) { CHECK(output_pixel(v, x, y, 0xffffff)); found_text = true; }
        }
        CHECK(found_text);
        printf("NATIVE: %s logical=%dx%d buffer=%dx%d scale=%.2f alpha-region=empty input=rectangle\n",
            v->toplevel->title, s->current.width, s->current.height,
            s->current.buffer_width, s->current.buffer_height, scale);
    }
    CHECK(output_pixel(opaque, 20, 30, 0xffffff));
    CHECK(pixman_region32_not_empty(&opaque->toplevel->base->surface->opaque_region));
    CHECK(output_pixel(modal, 130, 30, 0x20e080));
    CHECK(output_pixel(modal, 20, 30, 0x204080) &&
        !pixman_region32_not_empty(&modal->toplevel->base->surface->opaque_region));
    wlr_scene_node_set_position(&framed->tree->node, 500, 120);
    CHECK(output_pixel(framed, 20, 30, 0x802040));
    CHECK(output_pixel(framed, 70, 30, 0xa43834));
    wlr_xdg_toplevel_set_size(framed->toplevel, 320, 200);
    bool resized = false;
    for (int i = 0; i < 600; i++) {
        CHECK(pump());
        struct wlr_surface *s = framed->toplevel->base->surface;
        if (s->current.width == 320 && s->current.height == 200 &&
            s->current.buffer_width == (int)(320 * scale)) { resized = true; break; }
    }
    CHECK(resized && output_pixel(framed, 20, 30, 0x802040) &&
        output_pixel(framed, 70, 30, 0xa43834) && output_pixel(framed, 130, 30, 0x20e080));
    pu_desktop_focus_mapped(&desktop, framed->workspace_window);
    motion(520, 150);
    CHECK(desktop.seat->pointer_state.focused_surface == framed->toplevel->base->surface);
    for (int i = 0; i < 15; i++) CHECK(pump());
    button(true);
    CHECK(wait_surface(framed, 185, 25, 0xffe02080));
    motion(900, 500); button(false);
    CHECK(wait_surface(framed, 185, 25, 0xff2080e0));
    wlr_xdg_toplevel_send_close(framed->toplevel);
    int status = 0;
    for (int i = 0; i < 600; i++) {
        CHECK(pump());
        pid_t result = waitpid(child, &status, WNOHANG);
        CHECK(result >= 0);
        if (result == child) { child = 0; break; }
    }
    CHECK(!child && WIFEXITED(status) && WEXITSTATUS(status) == 0 && wl_list_empty(&desktop.views));
    printf("PASS: ordinary compositor transparency renderer=%s scale=%.2f frame/frameless/default/owned/modal/move/resize/input/close\n", renderer, scale);
    return true;
}
int main(int argc, char **argv)
{
    if (argc != 5) return 2;
    scale = !strcmp(argv[4], "1.5") ? 1.5f : 1.0f;
    wlr_log_init(WLR_INFO, NULL);
    bool ready = pu_desktop_init(&desktop, "ordinary-transparency") && pu_desktop_start(&desktop);
    bool passed = false;
    if (ready) {
        wlr_pointer_init(&pointer, &pointer_impl, "transparency-pointer");
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &pointer.base);
        passed = suite(argv[1], argv[2], argv[3]);
        if (child > 0) { kill(child, SIGKILL); waitpid(child, NULL, 0); child = 0; }
        wlr_pointer_finish(&pointer);
    }
    pu_desktop_finish(&desktop);
    return passed ? 0 : 1;
}
