#include "server.h"
#include <drm_fourcc.h>
#include <linux/input-event-codes.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include <wlr/backend.h>
#include <wlr/interfaces/wlr_pointer.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_pointer.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>

static struct PuDesktop desktop;
static struct wlr_pointer pointer;
static const struct wlr_pointer_impl pointer_impl = {.name = "canvas-smoke-pointer"};
static pid_t child;
static int fail(const char *message)
{
    fprintf(stderr, "FAIL: %s\n", message);
    return 0;
}
static int pump(void)
{
    wl_display_flush_clients(desktop.display);
    return wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 5) >= 0 &&
           !desktop.failed;
}
static struct PuDesktopView *mapped(void)
{
    struct PuDesktopView *view;
    wl_list_for_each(view, &desktop.views,
                     link) if (view->mapped && !view->geometry_pending && view->toplevel->title &&
                               !strcmp(view->toplevel->title, "Canvas2D.mapped")) return view;
    return NULL;
}
static int pixel(struct wlr_surface *surface, int x, int y, uint32_t expected)
{
    if (!surface->buffer || !surface->buffer->source)
        return 0;
    struct wlr_buffer *buffer = surface->buffer->source;
    if (buffer->width != 300 || buffer->height != 240)
        return 0;
    void *data;
    uint32_t format, value;
    size_t stride;
    if (!wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format,
                                          &stride))
        return 0;
    memcpy(&value, (char *)data + (size_t)y * stride + (size_t)x * 4, sizeof(value));
    wlr_buffer_end_data_ptr_access(buffer);
    if (format == DRM_FORMAT_ABGR8888 || format == DRM_FORMAT_XBGR8888)
        value = ((value & 255) << 16) | (value & 0xff00) | ((value >> 16) & 255);
    else if (format != DRM_FORMAT_ARGB8888 && format != DRM_FORMAT_XRGB8888)
        return 0;
    return (value & 0xffffff) == expected;
}
static int suite(const char *exe, const char *script)
{
    struct wlr_output_layout_output *output =
        wl_container_of(desktop.layout->outputs.next, output, link);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_custom_mode(&state, 1200, 900, 60000);
    wlr_output_state_set_scale(&state, 1.5f);
    int ok = wlr_output_commit_state(output->output, &state);
    wlr_output_state_finish(&state);
    if (!ok)
        return fail("configure fractional output");
    child = fork();
    if (child < 0)
        return fail("fork isolated GUI client");
    if (!child) {
        setenv("WAYLAND_DISPLAY", desktop.socket_name, 1);
        setenv("SDL_VIDEODRIVER", "wayland", 1);
        setenv("SDL_RENDER_DRIVER", "software", 1);
        setenv("PU_RENDERER", "raster", 1);
        execl(exe, exe, script, (char *)NULL);
        perror("exec canvas client");
        _exit(127);
    }
    struct PuDesktopView *view = NULL;
    for (int i = 0; i < 1200; ++i) {
        if (!pump())
            return fail("compositor pump");
        view = mapped();
        if (view && pixel(view->toplevel->base->surface, 20, 20, 0xff0000) &&
            pixel(view->toplevel->base->surface, 70, 20, 0xffffff) &&
            pixel(view->toplevel->base->surface, 100, 20, 0x0000ff))
            break;
        view = NULL;
    }
    if (!view)
        return fail("mapped 1.5 DPI canvas/clip/scroll/CSS scale/img frame");
    struct wlr_box bounds;
    wlr_output_layout_get_box(desktop.layout, NULL, &bounds);
    int x, y;
    wlr_scene_node_coords(&view->tree->node, &x, &y);
    struct wlr_pointer_motion_absolute_event motion = {
        .pointer = &pointer,
        .time_msec = 1000,
        .x = (double)(x + 20 - bounds.x) / bounds.width,
        .y = (double)(y + 20 - bounds.y) / bounds.height};
    wl_signal_emit_mutable(&pointer.events.motion_absolute, &motion);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
    struct wlr_pointer_button_event button = {.pointer = &pointer,
                                              .time_msec = 1001,
                                              .button = BTN_LEFT,
                                              .state = WL_POINTER_BUTTON_STATE_PRESSED};
    wlr_pointer_notify_button(&pointer, &button);
    button.state = WL_POINTER_BUTTON_STATE_RELEASED;
    button.time_msec = 1002;
    wlr_pointer_notify_button(&pointer, &button);
    wl_signal_emit_mutable(&pointer.events.frame, NULL);
    ok = 0;
    for (int i = 0; i < 400; ++i) {
        if (!pump())
            return fail("input repaint pump");
        view = mapped();
        if (view && pixel(view->toplevel->base->surface, 20, 20, 0x00ff00)) {
            ok = 1;
            break;
        }
    }
    if (!ok)
        return fail("Canvas event-triggered repaint");
    for (int i = 0; i < 400; ++i) {
        int status;
        pid_t result = waitpid(child, &status, WNOHANG);
        if (result == child) {
            child = 0;
            return WIFEXITED(status) && WEXITSTATUS(status) == 0;
        }
        if (!pump())
            break;
    }
    return fail("client exits cleanly after ordinary UI input");
}
int main(int argc, char **argv)
{
    if (argc != 3)
        return 2;
    wlr_log_init(WLR_INFO, NULL);
    int ready = pu_desktop_init(&desktop, "canvas-smoke") && pu_desktop_start(&desktop), ok = 0;
    if (ready) {
        wlr_pointer_init(&pointer, &pointer_impl, "canvas-smoke-pointer");
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &pointer.base);
        ok = suite(argv[1], argv[2]);
        if (child > 0) {
            kill(child, SIGTERM);
            waitpid(child, NULL, 0);
            child = 0;
        }
        wlr_pointer_finish(&pointer);
    }
    pu_desktop_finish(&desktop);
    if (ok)
        puts("PASS: mapped Canvas2D/img 1.5 DPI clip, scroll, CSS scale and logical input");
    return ok ? 0 : 1;
}
