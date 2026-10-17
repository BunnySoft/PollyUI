#define _POSIX_C_SOURCE 200809L
#include "server.h"
#include "decoration.h"
#include "decorator-process.h"
#include "workspace.h"
#include "shortcut-control.h"
#include "session-lock.h"
#include "polly-appearance-server.h"
#include "decoration-layout-fixtures.h"
#include "wire.h"
#include <drm_fourcc.h>
#include <errno.h>
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
#include <wlr/interfaces/wlr_keyboard.h>
#include <wlr/interfaces/wlr_pointer.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_layer_shell_v1.h>
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
static pid_t paused_renderer;
static int control = -1;
static struct TestReply reply;
static uint32_t clock_ms = 1000;
static struct wlr_seat_keyboard_grab picker_keyboard_grab;
static struct wlr_keyboard_grab_interface picker_keyboard_impl;
static struct wlr_seat_pointer_grab picker_pointer_grab;
static struct wlr_pointer_grab_interface picker_pointer_impl;
static struct PuWorkspace *picker_workspace;
static int picker_wire_control = -1;

static void finish_picker_grabs(void)
{
    if (desktop.seat->keyboard_state.grab == &picker_keyboard_grab) wlr_seat_keyboard_end_grab(desktop.seat);
    if (desktop.seat->pointer_state.grab == &picker_pointer_grab) wlr_seat_pointer_end_grab(desktop.seat);
}

struct BackdropWatch {
    struct wl_listener listener;
    const char *event;
    bool retired, linked;
};
static struct {
    bool active, reported;
    struct PuDesktopLayer *layer;
    struct wlr_layer_surface_v1 *role;
    struct wlr_surface *surface;
    struct wl_resource *resource;
    struct wl_client *owner;
    struct wlr_output *output;
    struct PuDesktopView *views[3];
    struct wlr_surface *view_surfaces[3];
    uint64_t view_ids[3];
    struct BackdropWatch watches[10];
    unsigned count;
} backdrop_guard;
static struct {
    struct PuDesktopLayer *layer;
    struct wlr_surface *surface;
    struct wl_resource *resource;
    struct wl_client *owner;
    struct wlr_output *output;
    struct wlr_box box;
    struct BackdropWatch destroy, unmap;
} backdrop_candidate;
static bool backdrop_guard_current(void);
static void backdrop_retired(struct wl_listener *listener, void *data)
{
    (void)data;
    struct BackdropWatch *watch = wl_container_of(listener, watch, listener);
    watch->retired = true;
    wl_list_remove(&watch->listener.link);
    watch->linked = false;
}
static void backdrop_watch(struct wl_signal *signal, const char *event)
{
    struct BackdropWatch *watch = &backdrop_guard.watches[backdrop_guard.count++];
    *watch = (struct BackdropWatch){.event = event, .linked = true};
    watch->listener.notify = backdrop_retired;
    wl_signal_add(signal, &watch->listener);
}
static void backdrop_candidate_stop(void)
{
    if (backdrop_candidate.destroy.retired || backdrop_candidate.unmap.retired)
        fputs("[backdrop-fixture] initial Dock candidate retired before pixel phase; clearing initialization witness\n", stderr);
    if (backdrop_candidate.destroy.linked) wl_list_remove(&backdrop_candidate.destroy.listener.link);
    if (backdrop_candidate.unmap.linked) wl_list_remove(&backdrop_candidate.unmap.listener.link);
    memset(&backdrop_candidate, 0, sizeof(backdrop_candidate));
}
static bool backdrop_candidate_same(struct PuDesktopLayer *layer)
{
    return layer && !backdrop_candidate.destroy.retired && !backdrop_candidate.unmap.retired &&
        backdrop_candidate.layer == layer && backdrop_candidate.surface == layer->surface->surface &&
        backdrop_candidate.resource == layer->surface->surface->resource &&
        backdrop_candidate.owner == wl_resource_get_client(layer->surface->surface->resource) &&
        backdrop_candidate.output == layer->surface->output &&
        wlr_box_equal(&backdrop_candidate.box, &layer->pending_box);
}
static void backdrop_candidate_start(struct PuDesktopLayer *layer)
{
    backdrop_candidate_stop();
    backdrop_candidate.layer = layer;
    backdrop_candidate.surface = layer->surface->surface;
    backdrop_candidate.resource = layer->surface->surface->resource;
    backdrop_candidate.owner = wl_resource_get_client(backdrop_candidate.resource);
    backdrop_candidate.output = layer->surface->output;
    backdrop_candidate.box = layer->pending_box;
    backdrop_candidate.destroy = (struct BackdropWatch){.linked = true, .event = "initial Dock destroyed"};
    backdrop_candidate.unmap = (struct BackdropWatch){.linked = true, .event = "initial Dock unmapped"};
    backdrop_candidate.destroy.listener.notify = backdrop_candidate.unmap.listener.notify = backdrop_retired;
    wl_signal_add(&layer->surface->events.destroy, &backdrop_candidate.destroy.listener);
    wl_signal_add(&layer->surface->surface->events.unmap, &backdrop_candidate.unmap.listener);
}
static void backdrop_guard_stop(void)
{
    backdrop_guard.active = false;
    backdrop_candidate_stop();
    for (unsigned i = 0; i < backdrop_guard.count; i++)
        if (backdrop_guard.watches[i].linked) {
            wl_list_remove(&backdrop_guard.watches[i].listener.link);
            backdrop_guard.watches[i].linked = false;
        }
}
static void backdrop_guard_views(struct PuDesktopView *control_view,
    struct PuDesktopView *first, struct PuDesktopView *second)
{
    backdrop_guard_stop();
    memset(&backdrop_guard, 0, sizeof(backdrop_guard));
    struct PuDesktopView *views[] = {control_view, first, second};
    const char *destroyed[] = {"control destroyed", "first lower view destroyed", "second lower view destroyed"};
    const char *unmapped[] = {"control unmapped", "first lower view unmapped", "second lower view unmapped"};
    for (unsigned i = 0; i < 3; i++) {
        backdrop_guard.views[i] = views[i];
        backdrop_guard.view_surfaces[i] = views[i]->toplevel->base->surface;
        backdrop_guard.view_ids[i] = views[i]->workspace_window;
        backdrop_watch(&views[i]->toplevel->events.destroy, destroyed[i]);
        backdrop_watch(&backdrop_guard.view_surfaces[i]->events.unmap, unmapped[i]);
    }
    backdrop_guard.active = true;
}
static bool backdrop_guard_dock(struct PuDesktopLayer *layer)
{
    CHECK(backdrop_guard.active && !backdrop_guard.layer && backdrop_guard.count == 6 &&
        backdrop_guard_current());
    backdrop_guard.layer = layer; backdrop_guard.role = layer->surface;
    backdrop_guard.surface = layer->surface->surface;
    backdrop_guard.resource = backdrop_guard.surface->resource;
    backdrop_guard.owner = wl_resource_get_client(backdrop_guard.resource);
    backdrop_guard.output = layer->surface->output;
    backdrop_watch(&layer->surface->events.destroy, "Dock layer destroyed");
    backdrop_watch(&backdrop_guard.surface->events.destroy, "Dock surface destroyed");
    backdrop_watch(&backdrop_guard.surface->events.unmap, "Dock surface unmapped");
    backdrop_watch(&backdrop_guard.output->events.destroy, "Dock output destroyed");
    return true;
}
static bool backdrop_guard_current(void)
{
    if (!backdrop_guard.active) return true;
    const char *error = NULL;
    for (unsigned i = 0; i < backdrop_guard.count; i++)
        if (backdrop_guard.watches[i].retired) { error = backdrop_guard.watches[i].event; break; }
    if (!error && backdrop_guard.layer) {
        struct PuDesktopLayer *layer, *current = NULL;
        wl_list_for_each(layer, &desktop.layers, link)
            if (layer->surface == backdrop_guard.role && layer->surface->surface == backdrop_guard.surface &&
                layer->surface->surface->resource == backdrop_guard.resource) { current = layer; break; }
        if (current != backdrop_guard.layer || desktop.shell_client != backdrop_guard.owner ||
            wl_resource_get_client(current->surface->surface->resource) != backdrop_guard.owner ||
            current->surface->output != backdrop_guard.output)
            error = "original owner/surface/layer/output identity changed";
    }
    for (unsigned i = 0; !error && i < 3; i++) {
        struct PuDesktopView *view;
        bool current = false;
        wl_list_for_each(view, &desktop.all_views, all_link)
            if (view == backdrop_guard.views[i]) {
                current = view->mapped && view->toplevel->base->surface == backdrop_guard.view_surfaces[i] &&
                    view->workspace_window == backdrop_guard.view_ids[i];
                break;
            }
        if (!current) error = "original view identity or mapping changed";
    }
    if (error && !backdrop_guard.reported) {
        fprintf(stderr, "[backdrop-fixture] %s; refusing stale target access\n", error);
        backdrop_guard.reported = true;
    }
    return error == NULL;
}

static bool pump(void)
{
    if (!backdrop_guard_current()) return false;
    wl_display_flush_clients(desktop.display);
    bool dispatched = wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 5) >= 0 && !desktop.failed;
    return backdrop_guard_current() && dispatched;
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
static uint64_t frame_hash_at_scale(struct PuDesktopView *view, double scale)
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
    if (!buffer || buffer->height != (int)ceil(inset.y * scale) ||
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
static uint64_t frame_hash(struct PuDesktopView *view)
{
    return frame_hash_at_scale(view, pu_desktop_view_scale(view));
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
    if (!backdrop_guard_current()) return false;
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
static bool scene_pixels(struct wlr_output *output, uint32_t **pixels, int *width, int *height)
{
    CHECK(backdrop_guard_current());
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_lock_attach_render(output, true);
    bool built = wlr_scene_output_build_state(wlr_scene_get_scene_output(desktop.scene, output), &state, NULL);
    wlr_output_lock_attach_render(output, false);
    CHECK(built && state.buffer);
    void *data; uint32_t format; size_t stride;
    CHECK(wlr_buffer_begin_data_ptr_access(state.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride));
    CHECK(format == DRM_FORMAT_ARGB8888 || format == DRM_FORMAT_XRGB8888);
    *width = state.buffer->width; *height = state.buffer->height;
    *pixels = malloc((size_t)*width * *height * 4);
    CHECK(*pixels);
    for (int y = 0; y < *height; y++) memcpy(*pixels + y * *width, (char *)data + y * stride, (size_t)*width * 4);
    wlr_buffer_end_data_ptr_access(state.buffer);
    wlr_output_state_finish(&state);
    return true;
}
static struct PuDesktopLayer *sampled_layer(void)
{
    struct PuDesktopLayer *layer;
    wl_list_for_each(layer, &desktop.layers, link) if (layer->backdrop) return layer;
    return NULL;
}
static uint64_t milliseconds(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}
static bool dock_foreground_ready(struct PuDesktopLayer *dock)
{
    if (!backdrop_guard_current()) return false;
    struct wlr_client_buffer *buffer = dock ? dock->surface->surface->buffer : NULL;
    void *data; uint32_t format; size_t stride;
    if (!buffer || !buffer->source ||
        !wlr_buffer_begin_data_ptr_access(buffer->source, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride))
        return false;
    unsigned opaque = 0, clear = 0;
    for (int y = 0; y < buffer->source->height; y++) for (int x = 0; x < buffer->source->width; x++) {
        uint32_t pixel = ((uint32_t *)((char *)data + y * stride))[x];
        opaque += (pixel >> 24) == 255;
        clear += (pixel >> 24) == 0;
    }
    wlr_buffer_end_data_ptr_access(buffer->source);
    return format == DRM_FORMAT_ARGB8888 && opaque > 200 && clear > 1000;
}
static bool control_key(struct PuDesktopView *view, uint32_t expected, bool focus)
{
    CHECK(backdrop_guard_current());
    if (focus) {
        pu_desktop_focus_mapped(&desktop, view->workspace_window);
        for (int i = 0; i < 10; i++) CHECK(pump());
    }
    wlr_seat_keyboard_notify_key(desktop.seat, ++clock_ms, KEY_SPACE, WL_KEYBOARD_KEY_STATE_PRESSED);
    wlr_seat_keyboard_notify_key(desktop.seat, ++clock_ms, KEY_SPACE, WL_KEYBOARD_KEY_STATE_RELEASED);
    uint64_t deadline = milliseconds() + 5000;
    while (milliseconds() < deadline) {
        CHECK(pump());
        if (body_pixel(view, expected)) return true;
    }
    CHECK(false);
}
static uint64_t surface_hash(struct wlr_surface *surface)
{
    struct wlr_client_buffer *client = surface->buffer;
    struct wlr_buffer *source = client ? client->source : NULL;
    void *data = NULL; uint32_t format = 0; size_t stride = 0;
    bool access = source && wlr_buffer_begin_data_ptr_access(source,
        WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride);
    bool valid = access && data && source->width > 0 && source->height > 0 &&
        stride >= (size_t)source->width * 4 &&
        (format == DRM_FORMAT_ARGB8888 || format == DRM_FORMAT_XRGB8888);
    if (!valid) {
        fprintf(stderr, "[backdrop-fixture] unreadable input: surface=%p resource=%u client=%p source=%p dimensions=%dx%d format=%#x stride=%zu access=%d\n",
            (void *)surface, wl_resource_get_id(surface->resource), (void *)client, (void *)source,
            source ? source->width : 0, source ? source->height : 0, format, stride, access);
        if (access) wlr_buffer_end_data_ptr_access(source);
        return 0;
    }
    uint64_t hash = UINT64_C(14695981039346656037);
    for (int y = 0; y < source->height; y++)
        for (int x = 0; x < source->width * 4; x++) {
            hash ^= ((unsigned char *)data)[y * stride + x]; hash *= UINT64_C(1099511628211);
        }
    wlr_buffer_end_data_ptr_access(source);
    return hash;
}
struct BackdropViewState {
    struct wlr_box geometry;
    int x, y;
    uint64_t body;
    uint32_t frame_revision;
    bool focused;
};
static bool backdrop_view_state(struct PuDesktopView *view, struct BackdropViewState *state)
{
    CHECK(backdrop_guard_current() && pu_decoration_presented_current(view));
    *state = (struct BackdropViewState){.geometry = view->toplevel->base->geometry,
        .x = view->tree->node.x, .y = view->tree->node.y,
        .body = surface_hash(view->toplevel->base->surface),
        .frame_revision = pu_decoration_presented_revision(view),
        .focused = desktop.focused == view && !desktop.focused_layer};
    if (!state->body || !state->frame_revision)
        fprintf(stderr, "[backdrop-fixture] invalid owned input fingerprint: view=%p workspaceId=%llu surface=%p body=%016llx ownedCurrentRevision=%u\n",
            (void *)view, (unsigned long long)view->workspace_window,
            (void *)view->toplevel->base->surface, (unsigned long long)state->body, state->frame_revision);
    CHECK(state->body && state->frame_revision);
    return true;
}
static bool control_outside_backdrop(struct PuDesktopView *view, const struct wlr_box *dock)
{
    CHECK(backdrop_guard_current() && pu_decoration_presented_current(view));
    CHECK(view->output && view->output->scale == 1 && wl_list_empty(&view->popups->children));
    struct wlr_box inset = {0};
    pu_decoration_inset(view, &inset, false);
    struct wlr_box frame = {view->tree->node.x - inset.x, view->tree->node.y - inset.y,
        view->toplevel->base->geometry.width + 2 * inset.x,
        view->toplevel->base->geometry.height + inset.y + inset.x};
    /* Schema 2 bounds sigma at 32; 96px contains every permitted kernel at scale 1. */
    struct wlr_box sample = {dock->x - 96, dock->y - 96, dock->width + 192, dock->height + 192}, overlap;
    CHECK(!wlr_box_intersection(&overlap, &frame, &sample));
    struct wlr_box shadow = {0};
    if (view->shadow->node.enabled) {
        int x, y;
        CHECK(wlr_scene_node_coords(&view->shadow->node, &x, &y));
        shadow = (struct wlr_box){x, y, view->shadow->width, view->shadow->height};
        CHECK(!wlr_box_intersection(&overlap, &shadow, &sample));
    }
    printf("BACKDROP_ACK_ISOLATION frame=%d,%d,%d,%d shadow=%d,%d,%d,%d maximumKernelRegion=%d,%d,%d,%d scale=1\n",
        frame.x, frame.y, frame.width, frame.height, shadow.x, shadow.y, shadow.width, shadow.height,
        sample.x, sample.y, sample.width, sample.height);
    return true;
}
static bool resume_renderer(void)
{
    if (!paused_renderer) return true;
    pid_t pid = paused_renderer;
    paused_renderer = 0;
    if (kill(pid, SIGCONT) == 0) return true;
    perror("resume exact fixture renderer");
    return false;
}
static bool wait_presented_frame(struct PuDesktopView *view)
{
    uint64_t id = view->workspace_window;
    struct wlr_surface *surface = view->toplevel->base->surface;
    uint64_t deadline = milliseconds() + 5000;
    while (milliseconds() < deadline) {
        struct PuDesktopView *candidate, *current = NULL;
        wl_list_for_each(candidate, &desktop.views, link)
            if (candidate == view && candidate->workspace_window == id &&
                candidate->toplevel->base->surface == surface) { current = candidate; break; }
        CHECK(current);
        if (pu_decoration_presented_current(current)) return true;
        CHECK(pump());
    }
    CHECK(false);
}
static bool pause_renderer(void)
{
    pid_t pid = pu_decorator_pid(&desktop);
    CHECK(!paused_renderer && pid > 0 && !kill(pid, SIGSTOP));
    paused_renderer = pid;
    int status;
    pid_t stopped;
    do { stopped = waitpid(pid, &status, WUNTRACED); } while (stopped < 0 && errno == EINTR);
    CHECK(stopped == pid && WIFSTOPPED(status) && WSTOPSIG(status) == SIGSTOP);
    return true;
}
static void placement_key(uint32_t code)
{
    uint32_t codes[] = {KEY_LEFTMETA, code, code, KEY_LEFTMETA};
    for (unsigned i = 0; i < 4; i++) {
        struct wlr_keyboard_key_event event = {.time_msec = ++clock_ms, .keycode = codes[i],
            .update_state = true, .state = i < 2 ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED};
        wlr_keyboard_notify_key(&keyboard, &event);
    }
}
static void find_headless(struct wlr_backend *backend, void *data)
{
    if (wlr_backend_is_headless(backend)) *(struct wlr_backend **)data = backend;
}
static bool begin_title_drag(struct PuDesktopView *view)
{
    CHECK(wait_presented_frame(view));
    struct wlr_box inset = {0};
    pu_decoration_inset(view, &inset, false);
    int x = 0;
    for (int i = 0; i < view->presented_box.width; i++) {
        x = (view->presented_box.width / 4 + i) % view->presented_box.width;
        if (pu_decoration_hit(view, x, -inset.y / 2.0) == PU_DECORATION_TITLE) break;
    }
    CHECK(pu_decoration_hit(view, x, -inset.y / 2.0) == PU_DECORATION_TITLE);
    clock_ms += 401;
    motion(view->tree->node.x + x, view->tree->node.y - inset.y / 2.0);
    button(true);
    CHECK(desktop.grabbed == view && desktop.grab == PU_DESKTOP_MOVE && desktop.grab_title);
    CHECK(wait_presented_frame(view));
    return true;
}
static bool title_edge_snap(const char *wire)
{
    struct PuDesktopView *view = wire_view();
    CHECK(view && wl_list_length(&desktop.views) == 1 &&
        command(TEST_UNCONSTRAINED, 0, 0) && wait_presented_frame(view));
    struct wlr_output *original = view->output;
    struct wlr_box full;
    wlr_output_layout_get_box(desktop.layout, original, &full);
    CHECK(full.x == 0 && full.y == 0 && full.width == 1280 && full.height == 720);
    int width = view->presented_box.width, height = view->presented_box.height;
    for (int edge = 0; edge < 3; edge++) {
        wlr_scene_node_set_position(&view->tree->node, 80, 160);
        CHECK(begin_title_drag(view));
        motion(edge == 0 ? 0 : edge == 1 ? 1279 : 600, edge == 2 ? 0 : 200);
        CHECK(wait_presented_frame(view) && pause_renderer() && command(TEST_HOLD, 0, 0));
        struct wlr_box old = view->presented_box;
        int x = view->tree->node.x, y = view->tree->node.y;
        uint64_t before = frame_hash(view);
        uint32_t revision = pu_decoration_presented_revision(view), serial = view->geometry_serial;
        CHECK(before && revision && !view->geometry_pending && view->mode == PU_DESKTOP_FLOATING);
        button(false);
        CHECK(view->geometry_pending && view->geometry_serial != serial &&
            desktop.grab == PU_DESKTOP_PASSTHROUGH && view->mode == PU_DESKTOP_FLOATING &&
            wlr_box_equal(&view->presented_box, &old) && frame_hash(view) == before);
        CHECK(command(TEST_QUERY, 0, 0) && command(TEST_RELEASE, 0, 0));
        struct wlr_box expected = full;
        if (edge != 2) {
            expected.width = 640;
            if (edge) expected.x = 640;
        }
        pu_decoration_inset(view, &expected, true);
        CHECK(view->toplevel->base->geometry.width == expected.width &&
            view->toplevel->base->geometry.height == expected.height &&
            view->geometry_pending && !pu_decoration_presented_current(view) &&
            view->mode == PU_DESKTOP_FLOATING && view->tree->node.x == x &&
            view->tree->node.y == y && frame_hash(view) == before);
        serial = view->geometry_serial;
        motion(300, 400);
        CHECK(resume_renderer() && wait_presented_frame(view));
        CHECK(wlr_box_equal(&view->presented_box, &expected) &&
            view->tree->node.x == expected.x && view->tree->node.y == expected.y &&
            view->mode == (edge == 2 ? PU_DESKTOP_MAXIMIZED :
                edge == 0 ? PU_DESKTOP_TILED_LEFT : PU_DESKTOP_TILED_RIGHT) &&
            pu_decoration_presented_revision(view) > revision && frame_hash(view) &&
            view->geometry_serial == serial);
        printf("PASS: GUI edge release %d holds old owned frame through client ACK; actual client %dx%d and current native revision=%u present at %d,%d exactly once\n",
            edge, expected.width, expected.height, pu_decoration_presented_revision(view), expected.x, expected.y);
        if (edge == 2) CHECK(command(TEST_UNMAXIMIZE, 0, 0));
        else placement_key(KEY_DOWN);
        CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view) &&
            view->presented_box.width == width && view->presented_box.height == height);
    }

    /* A completed drag restore can snap within the same held gesture. */
    placement_key(KEY_LEFT);
    CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view) && begin_title_drag(view));
    motion(500, 250);
    CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view) &&
        view->mode == PU_DESKTOP_FLOATING && desktop.grab_title_restored);
    motion(1279, 250); button(false);
    CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view) &&
        view->mode == PU_DESKTOP_TILED_RIGHT &&
        view->floating_box.width == width && view->floating_box.height == height);
    placement_key(KEY_DOWN);
    CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view) &&
        view->presented_box.width == width && view->presented_box.height == height);

    /* Pending restore is rejected, not queued for an ACK-triggered edge action. */
    placement_key(KEY_LEFT);
    CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view) && begin_title_drag(view));
    CHECK(pause_renderer() && command(TEST_HOLD, 0, 0));
    motion(1279, 250);
    CHECK(view->geometry_pending && view->drag_restore_pending);
    uint32_t serial = view->geometry_serial;
    struct wlr_box frozen = view->pending_box;
    button(false);
    CHECK(view->geometry_serial == serial && view->tile == PU_TILE_NONE && !view->maximized &&
        desktop.grab == PU_DESKTOP_PASSTHROUGH);
    motion(0, 0);
    CHECK(wlr_box_equal(&view->pending_box, &frozen) && command(TEST_RELEASE, 0, 0) &&
        resume_renderer() && wait_presented_frame(view));
    CHECK(view->mode == PU_DESKTOP_FLOATING && view->geometry_serial == serial &&
        !view->drag_restore_pending && !view->tile && !view->maximized &&
        view->presented_box.width == width && view->presented_box.height == height &&
        view->tree->node.y == frozen.y);
    struct wlr_box inset = {0};
    pu_decoration_inset(view, &inset, false);
    CHECK(view->tree->node.x == full.width - inset.x - width);
    puts("PASS: GUI pending restore edge release is explicitly refused, landing freezes, late ACK/frame never replay snap");

    /* A newer native caption alone must also be presented before admission. */
    wlr_scene_node_set_position(&view->tree->node, 80, 160);
    CHECK(begin_title_drag(view) && pause_renderer() && command(TEST_RENAME, 0, 0));
    motion(0, 200);
    CHECK(!pu_decoration_presented_current(view));
    serial = view->geometry_serial;
    button(false);
    CHECK(view->geometry_serial == serial && !view->geometry_pending && !view->tile && !view->maximized);
    CHECK(resume_renderer() && wait_presented_frame(view) && view->mode == PU_DESKTOP_FLOATING &&
        view->geometry_serial == serial);

    struct wlr_backend *backend = NULL;
    wlr_multi_for_each_backend(desktop.backend, find_headless, &backend);
    CHECK(backend);
    struct wlr_output *extra = wlr_headless_add_output(backend, 200, 300);
    CHECK(extra);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_scale(&state, 1.25f);
    CHECK(wlr_output_commit_state(extra, &state));
    wlr_output_state_finish(&state);
    CHECK(command(TEST_MAXIMIZE, 0, 0) && wait_presented_frame(view));
    struct wlr_box destination;
    wlr_output_layout_get_box(desktop.layout, extra, &destination);
    CHECK(begin_title_drag(view));
    motion(destination.x + destination.width / 2, destination.y + 80);
    CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view) &&
        view->mode == PU_DESKTOP_FLOATING && view->presented_box.width < width &&
        view->output == extra && pu_desktop_view_scale(view) == 1.25);
    motion(destination.x + destination.width - 1, destination.y + 100);
    CHECK(wait_presented_frame(view));
    button(false);
    CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view) &&
        view->mode == PU_DESKTOP_TILED_RIGHT && view->output == extra && frame_hash(view) &&
        view->floating_box.width == width && view->floating_box.height == height);
    struct wlr_box expected = destination;
    expected.x += expected.width / 2; expected.width -= destination.width / 2;
    pu_decoration_inset(view, &expected, false);
    CHECK(wlr_box_equal(&view->presented_box, &expected) &&
        view->toplevel->base->geometry.width == expected.width &&
        view->toplevel->base->geometry.height == expected.height);
    placement_key(KEY_DOWN);
    CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view) &&
        view->floating_box.width == width && view->floating_box.height == height);
    CHECK(begin_title_drag(view));
    motion(destination.x + destination.width - 1, destination.y + 100);
    wlr_output_destroy(extra);
    CHECK(!desktop.grabbed && desktop.grab == PU_DESKTOP_PASSTHROUGH);
    button(false);
    CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view) &&
        view->mode == PU_DESKTOP_FLOATING && view->output == original);
    puts("PASS: GUI cross-output restore then edge snap preserves original floating size, presents correct 125% native frame, and output retirement prevents replay");

    wlr_scene_node_set_position(&view->tree->node, 80, 160);
    CHECK(begin_title_drag(view));
    motion(0, 200);
    char locker[PATH_MAX];
    const char *slash = strrchr(wire, '/');
    CHECK(slash && snprintf(locker, sizeof(locker), "%.*s/polly-lock-test-client",
        (int)(slash - wire), wire) < (int)sizeof(locker));
    char *args[] = {locker, "unlock", NULL};
    CHECK(pu_session_lock_spawn(&desktop, args) && pu_session_lock_active(&desktop) &&
        desktop.grab == PU_DESKTOP_PASSTHROUGH);
    button(false);
    for (int i = 0; i < 600 && pu_session_lock_active(&desktop); i++) CHECK(pump());
    CHECK(!pu_session_lock_active(&desktop) && command(TEST_QUERY, 0, 0) &&
        wait_presented_frame(view) && view->mode == PU_DESKTOP_FLOATING);
    for (int retirement = 0; retirement < 2; retirement++) {
        wlr_scene_node_set_position(&view->tree->node, 80, 160);
        CHECK(begin_title_drag(view));
        motion(0, 200);
        /* Drain focus configures before deliberately resetting the xdg role. */
        CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view));
        CHECK(command(retirement ? TEST_DESTROY_ROLE : TEST_UNMAP, 0, 0));
        CHECK(!wire_view() && !desktop.grabbed && desktop.grab == PU_DESKTOP_PASSTHROUGH);
        view = NULL;
        button(false);
        if (!retirement) {
            CHECK(command(TEST_REMAP, 0, 0));
            view = wire_view();
            CHECK(view && wait_presented_frame(view) && view->mode == PU_DESKTOP_FLOATING);
        }
    }
    CHECK(command(TEST_DESTROY, 0, 0) && command(TEST_QUIT, 0, 0));
    puts("PASS: GUI lock, unmap/remap and role retirement cancel edge gestures without stale release operations");
    return true;
}
static bool title_drag_restore(void)
{
    struct PuDesktopView *view = wire_view();
    CHECK(view && wl_list_length(&desktop.views) == 1 &&
        command(TEST_UNCONSTRAINED, 0, 0) && wait_presented_frame(view));
    int width = view->presented_box.width, height = view->presented_box.height;
    for (int placement = 0; placement < 3; placement++) {
        if (!placement) CHECK(command(TEST_MAXIMIZE, 0, 0));
        else placement_key(placement == 1 ? KEY_LEFT : KEY_RIGHT);
        CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view));
        enum PuDesktopMode mode = view->mode;
        struct wlr_box old = view->presented_box, inset = {0};
        pu_decoration_inset(view, &inset, false);
        int source_anchor = old.width / 2, restored_anchor = (int)(width * ((double)source_anchor / old.width));
        double x = old.x + source_anchor, y = old.y - inset.y / 2.0;
        clock_ms += 401;
        motion(x, y); button(true);
        CHECK(desktop.grabbed == view && desktop.grab == PU_DESKTOP_MOVE);
        CHECK(wait_presented_frame(view));
        CHECK(pause_renderer() && command(TEST_HOLD, 0, 0));
        uint64_t before = frame_hash(view);
        uint32_t revision = pu_decoration_presented_revision(view);
        printf("TITLE_DRAG_BASELINE placement=%d mode=%d frameHash=%llu ownedRevision=%u\n",
            placement, mode, (unsigned long long)before, revision);
        CHECK(before && revision);
        motion(x + 4, y);
        CHECK(!view->geometry_pending && view->mode == mode && frame_hash(view) == before);
        if (!placement) {
            motion(x + 5, y);
            CHECK(!view->geometry_pending && view->mode == mode && frame_hash(view) == before);
        }
        motion(x + 6, y);
        CHECK(view->geometry_pending && view->drag_restore_pending && view->mode == mode &&
            wlr_box_equal(&view->presented_box, &old) && frame_hash(view) == before);
        motion(x + 30, y + 60);
        CHECK(view->geometry_pending && view->drag_restore_pending && view->mode == mode &&
            wlr_box_equal(&view->presented_box, &old) &&
            view->tree->node.x == old.x && view->tree->node.y == old.y && frame_hash(view) == before);
        motion(x + 50, y + 80);
        CHECK(command(TEST_RELEASE, 0, 0));
        CHECK(view->toplevel->base->geometry.width == width &&
            view->toplevel->base->geometry.height == height && view->geometry_pending &&
            view->mode == mode && !pu_decoration_presented_current(view) &&
            view->tree->node.x == old.x && view->tree->node.y == old.y && frame_hash(view) == before);
        motion(x + 70, y + 100);
        int expected_x = (int)(x + 70 - restored_anchor), expected_y = old.y + 100;
        if (placement == 1) {
            button(false);
            CHECK(desktop.grab == PU_DESKTOP_PASSTHROUGH);
            motion(x + 170, y + 200);
        }
        CHECK(resume_renderer() && wait_presented_frame(view));
        CHECK(view->mode == PU_DESKTOP_FLOATING && view->tree->node.x == expected_x &&
            view->tree->node.y == expected_y && view->presented_box.width == width &&
            view->presented_box.height == height && !view->drag_restore_pending &&
            pu_decoration_presented_revision(view) > revision && frame_hash(view));
        if (placement != 1) {
            motion(x + 81, y + 113);
            CHECK(view->tree->node.x == expected_x + 11 && view->tree->node.y == expected_y + 13);
            button(false);
        }
        printf("PASS: GUI title drag %d old mode/frame held through client ACK; current frame presents saved %dx%d at pointer anchor, pending release=%d\n",
            placement, width, height, placement == 1);
    }
    struct wlr_backend *backend = NULL;
    wlr_multi_for_each_backend(desktop.backend, find_headless, &backend);
    CHECK(backend);
    struct wlr_output *extra = wlr_headless_add_output(backend, 200, 300);
    CHECK(extra);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_scale(&state, 1.25f);
    CHECK(wlr_output_commit_state(extra, &state));
    wlr_output_state_finish(&state);
    CHECK(command(TEST_MAXIMIZE, 0, 0) && wait_presented_frame(view));
    struct wlr_box old = view->presented_box, destination;
    wlr_output_layout_get_box(desktop.layout, extra, &destination);
    clock_ms += 401;
    double x = old.x + old.width / 2, y = old.y - 16;
    motion(x, y); button(true);
    CHECK(wait_presented_frame(view) && pause_renderer() && command(TEST_HOLD, 0, 0));
    uint64_t before = frame_hash(view);
    motion(x + 10, y + 30);
    CHECK(command(TEST_QUERY, 0, 0) && view->geometry_pending);
    uint32_t previous_serial = view->geometry_serial;
    motion(destination.x + destination.width / 2, destination.y + 30);
    CHECK(view->output == extra && pu_desktop_view_scale(view) == 1.25 &&
        view->geometry_serial != previous_serial && view->pending_box.width < width &&
        view->mode == PU_DESKTOP_MAXIMIZED && wlr_box_equal(&view->presented_box, &old));
    struct wlr_box expected = view->pending_box;
    CHECK(command(TEST_APPLY_FIRST, 0, 0) && view->geometry_pending &&
        view->mode == PU_DESKTOP_MAXIMIZED && frame_hash_at_scale(view, 1) == before);
    CHECK(command(TEST_RELEASE, 0, 0) && view->geometry_pending &&
        !pu_decoration_presented_current(view) && wlr_box_equal(&view->presented_box, &old));
    CHECK(resume_renderer() && wait_presented_frame(view));
    CHECK(view->mode == PU_DESKTOP_FLOATING && wlr_box_equal(&view->presented_box, &expected) &&
        view->toplevel->base->geometry.width == expected.width &&
        view->toplevel->base->geometry.height == expected.height &&
        pu_desktop_view_scale(view) == 1.25 && frame_hash(view));
    button(false);
    CHECK(command(TEST_MAXIMIZE, 0, 0) && wait_presented_frame(view));
    y = view->tree->node.y - 16;
    int title_x = 0;
    while (title_x < view->presented_box.width &&
        pu_decoration_hit(view, title_x, -16) != PU_DECORATION_TITLE) title_x++;
    CHECK(title_x < view->presented_box.width && pu_decoration_hit(view, title_x, -16) == PU_DECORATION_TITLE);
    x = view->tree->node.x + title_x;
    clock_ms += 401;
    motion(x, y); button(true);
    CHECK(desktop.grab == PU_DESKTOP_MOVE && desktop.grabbed == view);
    CHECK(wait_presented_frame(view) && pause_renderer());
    motion(x + 6, y + 20);
    CHECK(command(TEST_QUERY, 0, 0) && view->geometry_pending && view->drag_restore_pending);
    wlr_output_destroy(extra);
    extra = NULL;
    CHECK(!desktop.grabbed && desktop.grab == PU_DESKTOP_PASSTHROUGH && !view->drag_restore_pending);
    button(false);
    CHECK(command(TEST_QUERY, 0, 0) && resume_renderer() && wait_presented_frame(view));
    CHECK(view->mode == PU_DESKTOP_FLOATING && pu_desktop_view_scale(view) == 1 &&
        desktop.grab == PU_DESKTOP_PASSTHROUGH);
    puts("PASS: pending restore crossing to a smaller 125% output refits original size, rejects old output ACK, fences actual scaled GUI frame, and output retirement cancels without revival");
    for (int retirement = 0; retirement < 2; retirement++) {
        CHECK(command(TEST_MAXIMIZE, 0, 0) && wait_presented_frame(view));
        double x = view->tree->node.x + 100, y = view->tree->node.y - 16;
        clock_ms += 401;
        motion(x, y); button(true);
        CHECK(pause_renderer());
        motion(x + 30, y + 50);
        CHECK(command(TEST_QUERY, 0, 0) && view->geometry_pending && desktop.grabbed == view);
        CHECK(command(retirement ? TEST_DESTROY_ROLE : TEST_UNMAP, 0, 0));
        CHECK(!wire_view() && !desktop.grabbed && desktop.grab == PU_DESKTOP_PASSTHROUGH);
        view = NULL;
        button(false);
        CHECK(resume_renderer());
        if (!retirement) {
            CHECK(command(TEST_REMAP, 0, 0));
            view = wire_view();
            CHECK(view && wait_presented_frame(view) && !view->drag_restore_pending);
        }
    }
    CHECK(command(TEST_DESTROY, 0, 0) && command(TEST_QUIT, 0, 0));
    puts("PASS: actual GUI pending restore cancels safely on target unmap/remap and toplevel-role retirement without stale gesture revival");
    return true;
}
static bool presented_frame_fence(const char *ui)
{
    CHECK(start_app(ui));
    struct PuDesktopView *view = wire_view(), *app = find("Decorator.fixture.app");
    CHECK(view && app);
    pu_desktop_focus_mapped(&desktop, view->workspace_window);
    CHECK(wait_presented_frame(view) && wait_presented_frame(app));
    uint32_t before = pu_decoration_presented_revision(view);
    CHECK(before);
    pid_t pid = pu_decorator_pid(&desktop);
    CHECK(pid > 0 && !kill(pid, SIGSTOP));
    paused_renderer = pid;
    int status;
    pid_t stopped;
    do { stopped = waitpid(pid, &status, WUNTRACED); } while (stopped < 0 && errno == EINTR);
    CHECK(stopped == pid && WIFSTOPPED(status) && WSTOPSIG(status) == SIGSTOP &&
        pu_decorator_pid(&desktop) == pid);
    pu_desktop_focus_mapped(&desktop, app->workspace_window);
    struct wlr_box box;
    CHECK(desktop.focused == app && !view->geometry_pending &&
        pu_decoration_button_box(view, PU_DECORATION_CLOSE, &box));
    CHECK(!pu_decoration_presented_current(view) && !pu_decoration_presented_current(app));
    CHECK(!pu_decoration_presented_revision(view) && !pu_decoration_presented_current(view));
    printf("FRAME_FENCE rendererPid=%ld stopped=SIGSTOP oldButtonProxy=1 latestFrame=0 previousOwnedRevision=%u\n",
        (long)pid, before);
    CHECK(resume_renderer());
    CHECK(wait_presented_frame(view) && wait_presented_frame(app) &&
        pu_decorator_pid(&desktop) == pid && pu_decoration_presented_revision(view) > before);
    printf("FRAME_FENCE rendererPid=%ld resumedSamePid=1 latestFrame=1 currentOwnedRevision=%u\n",
        (long)pid, pu_decoration_presented_revision(view));
    puts("PASS: deterministic focus-frame counterexample retains an old usable button box while the pure latest-frame fence rejects it; the same stopped renderer PID submits and presents current frames after resume");
    return true;
}
struct OutputWitness { struct wl_listener commit, destroy; struct wlr_buffer *buffer; unsigned count; bool linked; };
static struct {
    struct OutputWitness output;
    struct wlr_scene_tree *pressure;
    struct wlr_scene_rect *mark;
    struct wlr_buffer *reading;
    unsigned char *committed;
    uint32_t *actual, *plain, *moved;
    pixman_region32_t input;
    bool input_initialized, standard;
} shell_fixture;
static void witness_destroy(struct wl_listener *listener, void *data)
{
    (void)data;
    struct OutputWitness *witness = wl_container_of(listener, witness, destroy);
    if (!witness->linked) return;
    wl_list_remove(&witness->commit.link);
    wl_list_remove(&witness->destroy.link);
    if (witness->buffer) wlr_buffer_unlock(witness->buffer);
    witness->buffer = NULL;
    witness->linked = false;
}
static void witness_commit(struct wl_listener *listener, void *data)
{
    struct OutputWitness *witness = wl_container_of(listener, witness, commit);
    const struct wlr_output_event_commit *event = data;
    if (!(event->state->committed & WLR_OUTPUT_STATE_BUFFER)) return;
    if (witness->buffer) wlr_buffer_unlock(witness->buffer);
    witness->buffer = wlr_buffer_lock(event->state->buffer);
    witness->count++;
}
static void witness_start(struct wlr_output *output)
{
    struct OutputWitness *witness = &shell_fixture.output;
    witness_destroy(&witness->destroy, NULL);
    *witness = (struct OutputWitness){.commit.notify = witness_commit, .destroy.notify = witness_destroy,
        .linked = true};
    wl_signal_add(&output->events.commit, &witness->commit);
    wl_signal_add(&output->events.destroy, &witness->destroy);
}
static void shell_fixture_cleanup(void)
{
    if (shell_fixture.reading) wlr_buffer_end_data_ptr_access(shell_fixture.reading);
    witness_destroy(&shell_fixture.output.destroy, NULL);
    if (shell_fixture.mark) wlr_scene_node_destroy(&shell_fixture.mark->node);
    if (shell_fixture.pressure) wlr_scene_node_destroy(&shell_fixture.pressure->node);
    if (shell_fixture.input_initialized) pixman_region32_fini(&shell_fixture.input);
    free(shell_fixture.committed); free(shell_fixture.actual); free(shell_fixture.plain); free(shell_fixture.moved);
    memset(&shell_fixture, 0, sizeof(shell_fixture));
}
static bool shell_buffer_begin(struct wlr_buffer *buffer, void **data, uint32_t *format, size_t *stride)
{
    bool accessed = wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, data, format, stride);
    if (accessed) shell_fixture.reading = buffer;
    return accessed;
}
static void shell_buffer_end(void)
{
    wlr_buffer_end_data_ptr_access(shell_fixture.reading); shell_fixture.reading = NULL;
}
static bool committed_shell_pixels(struct wlr_output *output, uint32_t **pixels, int *width, int *height)
{
    if (!shell_fixture.standard) return scene_pixels(output, pixels, width, height);
    witness_start(output);
    shell_fixture.mark = wlr_scene_rect_create(desktop.layer_trees[3], 1, 1, (float[4]){0.2f, 0.4f, 0.6f, 1});
    CHECK(shell_fixture.mark);
    wlr_scene_node_set_position(&shell_fixture.mark->node, output->width - 1, 0);
    wlr_output_lock_attach_render(output, true);
    bool committed = wlr_scene_output_commit(wlr_scene_get_scene_output(desktop.scene, output), NULL);
    wlr_output_lock_attach_render(output, false);
    struct OutputWitness *witness = &shell_fixture.output;
    CHECK(committed && witness->count && witness->buffer);
    void *data; uint32_t format; size_t stride;
    CHECK(shell_buffer_begin(witness->buffer, &data, &format, &stride));
    *width = witness->buffer->width; *height = witness->buffer->height;
    *pixels = malloc((size_t)*width * *height * 4);
    bool valid = *pixels && (format == DRM_FORMAT_ARGB8888 || format == DRM_FORMAT_XRGB8888);
    if (valid) for (int y = 0; y < *height; y++)
        memcpy(*pixels + y * *width, (char *)data + y * stride, (size_t)*width * 4);
    shell_buffer_end();
    CHECK(valid);
    witness_destroy(&witness->destroy, NULL);
    wlr_scene_node_destroy(&shell_fixture.mark->node); shell_fixture.mark = NULL;
    return true;
}
static bool live_backdrop_failure(struct PuDesktopLayer *dock, const char *lock_client)
{
    struct wlr_output *output = dock->surface->output;
    struct wlr_scene_output *scene_output = wlr_scene_get_scene_output(desktop.scene, output);
    witness_start(output);
    struct OutputWitness *witness = &shell_fixture.output;
    struct wlr_scene_rect *mark = shell_fixture.mark = wlr_scene_rect_create(desktop.layer_trees[3], 1, 1,
        (float[4]){0.2f, 0.4f, 0.6f, 1});
    CHECK(mark && wlr_scene_output_commit(scene_output, NULL) && witness->buffer);
    void *data; uint32_t format; size_t stride;
    CHECK(shell_buffer_begin(witness->buffer, &data, &format, &stride));
    size_t bytes = stride * witness->buffer->height;
    unsigned char *committed = shell_fixture.committed = malloc(bytes);
    CHECK(committed);
    memcpy(committed, data, bytes);
    shell_buffer_end();
    unsigned commits = witness->count;
    uint32_t sequence = output->commit_seq;
    size_t available = WLR_SCENE_EFFECTS_MAX_BYTES - desktop.scene->effects_cached_bytes;
    CHECK(available > 100u * 1024u * 1024u);
    int height = (int)((available - 128u * 1024u) / (4096u * 8u));
    CHECK(height > 3000 && height < 4096);
    struct wlr_scene_tree *pressure = shell_fixture.pressure = wlr_scene_tree_create(desktop.windows);
    CHECK(pressure && wlr_scene_rect_create(pressure, 4096, height, (float[4]){0.4f, 0.2f, 0.6f, 1}) &&
        wlr_scene_tree_set_rounding(pressure, &(struct wlr_box){0, 0, 4096, height}, 16));
    wl_signal_emit_mutable(&output->events.frame, NULL);
    CHECK(scene_output->backdrop_failed && !desktop.failed && witness->count == commits && output->commit_seq == sequence);
    uint64_t renders = desktop.scene->backdrop_render_count;
    for (int i = 0; i < 10; i++) wl_signal_emit_mutable(&output->events.frame, NULL);
    CHECK(witness->count == commits && desktop.scene->backdrop_render_count == renders);
    uint64_t deadline = milliseconds() + 100;
    while (milliseconds() < deadline) CHECK(pump());
    CHECK(witness->count == commits && output->commit_seq == sequence && !desktop.failed);
    CHECK(shell_buffer_begin(witness->buffer, &data, &format, &stride));
    CHECK(!memcmp(committed, data, bytes));
    shell_buffer_end();
    uint64_t epoch = desktop.backdrop_epoch;
    char *crash[] = {(char *)lock_client, "crash", NULL};
    CHECK(pu_session_lock_spawn(&desktop, crash) && pu_session_lock_active(&desktop) &&
        desktop.backdrop_epoch != epoch);
    wl_signal_emit_mutable(&output->events.frame, NULL);
    CHECK(!desktop.failed && !scene_output->backdrop_failed && output->commit_seq != sequence);
    CHECK(shell_buffer_begin(witness->buffer, &data, &format, &stride));
    CHECK((((uint32_t *)((char *)data + (output->height / 2) * stride))[output->width / 2] & 0xffffff) == 0);
    shell_buffer_end();
    deadline = milliseconds() + 5000;
    while (milliseconds() < deadline && pu_session_lock_pid(&desktop)) CHECK(pump());
    CHECK(!pu_session_lock_pid(&desktop) && pu_session_lock_active(&desktop));
    CHECK(desktop.scene->backdrop_render_count == renders);
    uint32_t *locked;
    int width, screen_height;
    CHECK(scene_pixels(output, &locked, &width, &screen_height));
    CHECK((locked[(screen_height / 2) * width + width / 2] & 0xffffff) == 0);
    free(locked);
    wlr_scene_node_destroy(&pressure->node); shell_fixture.pressure = NULL;
    char *unlock[] = {(char *)lock_client, "unlock", NULL};
    CHECK(pu_session_lock_spawn(&desktop, unlock));
    deadline = milliseconds() + 5000;
    while (milliseconds() < deadline && (pu_session_lock_active(&desktop) ||
        desktop.scene->backdrop_render_count == renders)) CHECK(pump());
    CHECK(!pu_session_lock_active(&desktop) && desktop.backdrop_epoch > epoch &&
        desktop.scene->backdrop_render_count > renders && !desktop.failed);
    witness_destroy(&witness->destroy, NULL);
    wlr_scene_node_destroy(&mark->node); shell_fixture.mark = NULL;
    free(committed); shell_fixture.committed = NULL;
    puts("PASS: real backing/cache pressure fails live Dock composition, reports to Shell, holds identical last committed output bytes with no retry tick, then recovers on new damage");
    puts("PASS: headless private lock overrides stalled old output with black; crashed lock stays black with zero backdrop resampling; unlock crosses privacy epoch and samples freshly");
    return true;
}
static bool backdrop_consumer(const char *ui, const char *wire)
{
    CHECK(start_app(ui));
    char *shell[] = {(char *)ui, "--desktop", "--no-legacy-storage", "--app-id", "org.pollyui.shell",
        "desktop/tests/backdrop-shell.mjs", NULL};
    CHECK(pu_desktop_spawn_shell(&desktop, shell));
    struct PuDesktopView *control_view = NULL, *first = NULL, *second = NULL;
    uint64_t deadline = milliseconds() + 15000;
    while (milliseconds() < deadline) {
        CHECK(pump());
        control_view = find("Backdrop.fixture.control");
        first = wire_view(); second = find("Decorator.fixture.app");
        if (control_view && first && second) break;
    }
    CHECK(control_view && first && second);
    backdrop_guard_views(control_view, first, second);
    pu_desktop_focus_mapped(&desktop, control_view->workspace_window);
    for (int i = 0; i < 10; i++) CHECK(pump());
    while (milliseconds() < deadline &&
        (!pu_decoration_presented_current(control_view) || !pu_decoration_presented_current(first) ||
         !pu_decoration_presented_current(second))) CHECK(pump());
    CHECK(pu_decoration_presented_current(control_view) && pu_decoration_presented_current(first) &&
        pu_decoration_presented_current(second));
    uint64_t dock_stable_since = milliseconds();
    while (milliseconds() < deadline && milliseconds() - dock_stable_since < 300) {
        CHECK(pump());
        struct PuDesktopLayer *current = sampled_layer();
        if (!dock_foreground_ready(current) || !body_pixel(control_view, 0x314159)) {
            backdrop_candidate_stop();
            dock_stable_since = milliseconds();
            continue;
        }
        if (!backdrop_candidate_same(current)) {
            backdrop_candidate_start(current);
            dock_stable_since = milliseconds();
        }
    }
    CHECK(milliseconds() - dock_stable_since >= 300 && control_view && dock_foreground_ready(sampled_layer()));
    struct PuDesktopLayer *dock = sampled_layer();
    CHECK(dock && backdrop_candidate_same(dock) && dock->surface->surface->mapped && dock->backdrop_owner);
    CHECK(backdrop_guard_dock(dock));
    backdrop_candidate_stop();
    struct wlr_box box = dock->pending_box;
    wlr_scene_node_set_position(&first->tree->node, box.x - 20, box.y - 45);
    wlr_scene_node_set_position(&second->tree->node, box.x + box.width / 2, box.y - 45);
    struct wlr_box output_box;
    wlr_output_layout_get_box(desktop.layout, dock->surface->output, &output_box);
    int x = box.x - output_box.x, y = box.y - output_box.y;
    uint32_t *actual, *plain, *moved;
    int width, height, w, h;
    CHECK(scene_pixels(dock->surface->output, &actual, &width, &height));
    pixman_region32_t input;
    pixman_region32_init(&input);
    pixman_region32_copy(&input, &dock->surface->surface->input_region);
    wlr_scene_node_set_enabled(&dock->backdrop->node, false);
    CHECK(scene_pixels(dock->surface->output, &plain, &w, &h));
    wlr_scene_node_set_enabled(&dock->backdrop->node, true);
    uint32_t *underlay;
    wlr_scene_node_set_enabled(&dock->content->node, false);
    CHECK(scene_pixels(dock->surface->output, &underlay, &w, &h));
    wlr_scene_node_set_enabled(&dock->content->node, true);
    struct wlr_client_buffer *client = dock->surface->surface->buffer;
    void *data; uint32_t format; size_t stride;
    CHECK(client && client->source && client->source->width == box.width &&
        client->source->height == box.height &&
        shell_buffer_begin(client->source, &data, &format, &stride));
    CHECK(format == DRM_FORMAT_ARGB8888);
    unsigned opaque = 0, changed_pixels = 0, clear = 0;
    for (int py = 0; py < box.height; py++) for (int px = 0; px < box.width; px++) {
        uint32_t pixel = ((uint32_t *)((char *)data + py * stride))[px];
        size_t offset = (size_t)(y + py) * width + x + px;
        if ((pixel >> 24) == 255) {
            CHECK(actual[offset] == plain[offset]);
            opaque++;
        }
        if ((pixel >> 24) == 0) {
            CHECK(actual[offset] == underlay[offset]);
            clear++;
        }
        changed_pixels += actual[offset] != plain[offset];
    }
    shell_buffer_end();
    if (!(opaque > 200 && clear > 1000 && changed_pixels > 1000))
        fprintf(stderr, "Dock pixels: opaque=%u clear=%u changed=%u size=%dx%d\n",
            opaque, clear, changed_pixels, box.width, box.height);
    CHECK(opaque > 200 && clear > 1000 && changed_pixels > 1000);
    free(underlay);
    CHECK(pixman_region32_equal(&input, &dock->surface->surface->input_region));
    wlr_scene_node_set_position(&first->tree->node, box.x + 30, box.y - 45);
    CHECK(scene_pixels(dock->surface->output, &moved, &w, &h));
    unsigned first_changes = 0, second_changes = 0;
    for (int py = 0; py < box.height; py++) for (int px = 0; px < box.width; px++) {
        size_t offset = (size_t)(y + py) * width + x + px;
        first_changes += actual[offset] != moved[offset];
    }
    free(actual); actual = moved;
    wlr_scene_node_set_position(&second->tree->node, box.x + box.width / 2 + 50, box.y - 45);
    CHECK(scene_pixels(dock->surface->output, &moved, &w, &h));
    for (int py = 0; py < box.height; py++) for (int px = 0; px < box.width; px++) {
        size_t offset = (size_t)(y + py) * width + x + px;
        second_changes += actual[offset] != moved[offset];
    }
    CHECK(first_changes > 100 && second_changes > 100);
    free(actual); free(plain); actual = moved;
    printf("PASS: production BigSur Shell Dock samples two real independent applications (%u/%u changed pixels); %u opaque glyph/bitmap/marker pixels and rectangular input unchanged\n",
        first_changes, second_changes, opaque);
    uint64_t idle = desktop.scene->backdrop_render_count;
    uint64_t stable_since = milliseconds();
    deadline = stable_since + 4000;
    while (milliseconds() < deadline && milliseconds() - stable_since < 300) {
        CHECK(pump());
        if (desktop.scene->backdrop_render_count != idle) {
            idle = desktop.scene->backdrop_render_count;
            stable_since = milliseconds();
        }
    }
    CHECK(milliseconds() - stable_since >= 300);
    free(actual);
    CHECK(control_outside_backdrop(control_view, &box));
    struct PuDesktopView *sources[] = {control_view, first, second};
    struct BackdropViewState baseline[3];
    for (unsigned i = 0; i < 3; i++) CHECK(backdrop_view_state(sources[i], &baseline[i]));
    uint64_t foreground = surface_hash(dock->surface->surface);
    CHECK(foreground);
    CHECK(scene_pixels(dock->surface->output, &actual, &width, &height));
    struct wlr_scene_rect *committed = dock->backdrop;
    CHECK(control_key(control_view, 0x112233, false));
    CHECK(dock->backdrop == committed);
    CHECK(control_outside_backdrop(control_view, &box));
    for (unsigned i = 0; i < 3; i++) {
        struct BackdropViewState current;
        CHECK(backdrop_view_state(sources[i], &current));
        CHECK(wlr_box_equal(&baseline[i].geometry, &current.geometry) &&
            baseline[i].x == current.x && baseline[i].y == current.y &&
            baseline[i].focused == current.focused && baseline[i].frame_revision == current.frame_revision &&
            (!i || baseline[i].body == current.body));
    }
    CHECK(surface_hash(dock->surface->surface) == foreground &&
        wlr_box_equal(&dock->pending_box, &box));
    CHECK(scene_pixels(dock->surface->output, &moved, &w, &h));
    CHECK(w == width && h == height);
    for (int py = 0; py < box.height; py++)
        CHECK(!memcmp(actual + (y + py) * width + x, moved + (y + py) * width + x, (size_t)box.width * 4));
    free(actual); free(moved);
    puts("PASS: production mapped Dock excludes its own glyphs; idle has no resampling; wrong role/ordinary target/radius/sigma/duplicate-count transactions preserve committed node and exact Dock pixels");
    char lock_client[PATH_MAX];
    const char *slash = strrchr(wire, '/');
    CHECK(slash && snprintf(lock_client, sizeof(lock_client), "%.*s/polly-lock-test-client",
        (int)(slash - wire), wire) < (int)sizeof(lock_client));
    CHECK(live_backdrop_failure(dock, lock_client));
    CHECK(control_key(control_view, 0x271828, true));
    CHECK(!sampled_layer() && wl_list_empty(&desktop.scene->backdrops));
    CHECK(pixman_region32_equal(&input, &dock->surface->surface->input_region));
    CHECK(control_key(control_view, 0x161803, true));
    CHECK(sampled_layer());
    CHECK(scene_pixels(sampled_layer()->surface->output, &actual, &w, &h));
    free(actual);
    CHECK(backdrop_guard_current());
    pu_desktop_focus_mapped(&desktop, control_view->workspace_window);
    wlr_seat_keyboard_notify_key(desktop.seat, ++clock_ms, KEY_SPACE, WL_KEYBOARD_KEY_STATE_PRESSED);
    wlr_seat_keyboard_notify_key(desktop.seat, ++clock_ms, KEY_SPACE, WL_KEYBOARD_KEY_STATE_RELEASED);
    backdrop_guard_stop();
    for (int i = 0; i < 1200 && desktop.shell_pid; i++) CHECK(pump());
    CHECK(!desktop.shell_pid && wl_list_empty(&desktop.scene->backdrops));
    pixman_region32_fini(&input);
    puts("PASS: real missing-field legacy retirement, reactivation and Shell exit release all regional nodes/pixels");
    return true;
}
static bool backdrop_guard_retirement(const char *ui)
{
    char *shell[] = {(char *)ui, "--desktop", "--no-legacy-storage", "--app-id", "org.pollyui.shell",
        "desktop/tests/backdrop-shell.mjs", "guard-retire", NULL};
    CHECK(pu_desktop_spawn_shell(&desktop, shell));
    struct PuDesktopLayer *dock = NULL, *ready = NULL;
    struct PuDesktopView *control_view = NULL, *first = NULL, *second = NULL;
    for (int i = 0; i < 1200; i++) {
        CHECK(pump());
        control_view = find("Backdrop.guard.control");
        first = find("Backdrop.guard.first"); second = find("Backdrop.guard.second");
        struct PuDesktopLayer *layer;
        dock = ready = NULL;
        wl_list_for_each(layer, &desktop.layers, link) {
            if (!layer->presented || !layer->surface->surface->mapped) continue;
            if (!strcmp(layer->surface->namespace, "Backdrop.guard.Dock")) dock = layer;
            if (!strcmp(layer->surface->namespace, "Backdrop.guard.ready")) ready = layer;
        }
        if (dock && ready && control_view && first && second) break;
    }
    CHECK(dock && ready && control_view && first && second);
    backdrop_guard_views(control_view, first, second);
    CHECK(backdrop_guard_dock(dock));
    CHECK(backdrop_guard_current());
    /* The owned client closes its original Dock when this test-only handshake retires. */
    wlr_layer_surface_v1_destroy(ready->surface);
    bool current = true;
    for (int i = 0; i < 1200 && current; i++) current = pump();
    CHECK(!current && !desktop.failed && backdrop_guard.reported &&
        (backdrop_guard.watches[6].retired || backdrop_guard.watches[7].retired ||
         backdrop_guard.watches[8].retired));
    CHECK(!backdrop_guard_current());
    struct PuDesktopView *fresh[] = {find("Backdrop.guard.control"), find("Backdrop.guard.first"),
        find("Backdrop.guard.second")};
    for (unsigned i = 0; i < 3; i++)
        CHECK(fresh[i] && fresh[i] == backdrop_guard.views[i] &&
            fresh[i]->workspace_window == backdrop_guard.view_ids[i] &&
            fresh[i]->toplevel->base->surface == backdrop_guard.view_surfaces[i]);
    backdrop_guard_stop();
    puts("PASS: test-only lifetime guard rejects the original owned Dock after real client unmap/destroy; repeated checks refuse stale access while all three witnessed views remain live");
    return true;
}
static unsigned shell_backdrop_count(uint32_t role)
{
    unsigned count = 0;
    struct PuDesktopLayer *layer;
    wl_list_for_each(layer, &desktop.layers, link)
        if (layer->backdrop && layer->backdrop_role == role) count++;
    return count;
}
static bool shell_region_pixels(struct PuDesktopLayer *layer)
{
    struct PuDesktopView *first = wire_view(), *second = find("Decorator.fixture.app");
    CHECK(first && second && layer->backdrop && dock_foreground_ready(layer));
    struct wlr_box box = layer->pending_box, output_box;
    wlr_output_layout_get_box(desktop.layout, layer->surface->output, &output_box);
    wlr_scene_node_set_position(&first->tree->node, box.x - 20, box.y + box.height / 2 - 45);
    wlr_scene_node_set_position(&second->tree->node, box.x + box.width / 2, box.y + box.height / 2 - 45);
    int width, height, w, h;
    CHECK(committed_shell_pixels(layer->surface->output, &shell_fixture.actual, &width, &height));
    wlr_scene_node_set_enabled(&layer->backdrop->node, false);
    CHECK(committed_shell_pixels(layer->surface->output, &shell_fixture.plain, &w, &h) && w == width && h == height);
    wlr_scene_node_set_enabled(&layer->backdrop->node, true);
    struct wlr_client_buffer *client = layer->surface->surface->buffer;
    void *data; uint32_t format; size_t stride;
    CHECK(client && client->source &&
        wlr_buffer_begin_data_ptr_access(client->source, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride));
    CHECK(format == DRM_FORMAT_ARGB8888 && client->source->width == box.width &&
        client->source->height == box.height);
    unsigned opaque = 0, clear = 0, effect = 0;
    int x = box.x - output_box.x, y = box.y - output_box.y;
    CHECK(x >= 0 && y >= 0 && x + box.width <= width && y + box.height <= height);
    for (int py = 0; py < box.height; py++) for (int px = 0; px < box.width; px++) {
        uint32_t pixel = ((uint32_t *)((char *)data + py * stride))[px];
        size_t offset = (size_t)(y + py) * width + x + px;
        if ((pixel >> 24) == 255) { CHECK(shell_fixture.actual[offset] == shell_fixture.plain[offset]); opaque++; }
        clear += (pixel >> 24) == 0;
        effect += shell_fixture.actual[offset] != shell_fixture.plain[offset];
    }
    wlr_buffer_end_data_ptr_access(client->source);
    CHECK(opaque > 200 && clear > 1000 && effect > 1000);
    pixman_region32_init(&shell_fixture.input); shell_fixture.input_initialized = true;
    pixman_region32_copy(&shell_fixture.input, &layer->surface->surface->input_region);
    wlr_scene_node_set_position(&first->tree->node, box.x + 30, box.y + box.height / 2 - 45);
    CHECK(committed_shell_pixels(layer->surface->output, &shell_fixture.moved, &w, &h) && w == width && h == height);
    unsigned changes = 0;
    for (int py = 0; py < box.height; py++) for (int px = 0; px < box.width; px++) {
        size_t offset = (size_t)(y + py) * width + x + px;
        changes += shell_fixture.actual[offset] != shell_fixture.moved[offset];
    }
    CHECK(changes > 100 && pixman_region32_equal(&shell_fixture.input, &layer->surface->surface->input_region));
    printf("PASS: production Shell role %u output %s entire actual %dx%d current-lower-app movement changes %u regional pixels; %u opaque foreground pixels and actual input unchanged; outputCommitted=%u\n",
        layer->backdrop_role, layer->surface->output->name, box.width, box.height, changes, opaque, shell_fixture.standard);
    pixman_region32_fini(&shell_fixture.input); shell_fixture.input_initialized = false;
    free(shell_fixture.actual); free(shell_fixture.plain); free(shell_fixture.moved);
    shell_fixture.actual = shell_fixture.plain = shell_fixture.moved = NULL;
    return true;
}
static void picker_key(uint32_t code, bool down);
static bool modern_backdrop_consumer(const char *ui, const char *wire, const char *mode)
{
    bool standard = !strcmp(mode, "standard-start"), old = !strcmp(mode, "standard-start-old");
    shell_fixture.standard = standard;
    if (standard || old) {
        struct wlr_output_layout_output *entry;
        wl_list_for_each(entry, &desktop.layout->outputs, link) {
            struct wlr_output_state state;
            wlr_output_state_init(&state);
            wlr_output_state_set_custom_mode(&state, 1280, old ? 540 : entry->x == 0 ? 720 : 800, 60000);
            bool applied = wlr_output_commit_state(entry->output, &state);
            wlr_output_state_finish(&state);
            CHECK(applied);
        }
    }
    CHECK(start_app(ui));
    char *shell[] = {(char *)ui, "--desktop", "--no-legacy-storage", "--app-id", "org.pollyui.shell",
        "desktop/tests/backdrop-shell.mjs", old ? "modern-v8" : standard ? "modern-standard" : "modern", NULL};
    CHECK(pu_desktop_spawn_shell(&desktop, shell));
    struct wlr_scene_tree *pressure = NULL;
    struct wlr_scene_rect *retained[2] = {0};
    unsigned checks = 0;
    uint32_t retired_serial = 0, retired_target = 0;
    uint64_t deadline = milliseconds() + 60000;
    while (desktop.shell_pid && milliseconds() < deadline) {
        CHECK(pump());
        struct PuDesktopLayer *marker, *tmp;
        wl_list_for_each_safe(marker, tmp, &desktop.layers, link) {
            if (!marker->surface->surface->mapped) continue;
            const char *name = marker->surface->namespace;
            int x, y;
            unsigned code;
            char target[96], stage[32];
            if (sscanf(name, "backdrop-click %d %d %95s", &x, &y, target) == 3) {
                struct PuDesktopLayer *layer, *found = NULL;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (!strcmp(layer->surface->namespace, target) && layer->presented &&
                        layer->surface->surface->mapped) { found = layer; break; }
                CHECK(found);
                int lx = found->pending_box.x + x, ly = found->pending_box.y + y;
                wlr_layer_surface_v1_destroy(marker->surface);
                motion(lx, ly); button(true); button(false);
                break;
            }
            if (sscanf(name, "backdrop-key %u", &code) == 1) {
                CHECK(desktop.focused_layer && desktop.focused_layer->surface->current.keyboard_interactive ==
                    ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE);
                bool shift = strstr(name, " shift") != NULL;
                wlr_layer_surface_v1_destroy(marker->surface);
                if (shift) picker_key(KEY_LEFTSHIFT, true);
                picker_key(code, true); picker_key(code, false);
                if (shift) picker_key(KEY_LEFTSHIFT, false);
                break;
            }
            if (sscanf(name, "backdrop-pressure %31s", stage) == 1) {
                if (!strcmp(stage, "on")) {
                    unsigned i = 0;
                    struct PuDesktopLayer *layer;
                    wl_list_for_each(layer, &desktop.layers, link)
                        if (layer->backdrop && layer->backdrop_role == 2) {
                            CHECK(i < 2); retained[i++] = layer->backdrop;
                        }
                    CHECK(i == 2 && !pressure);
                    size_t available = WLR_SCENE_EFFECTS_MAX_BYTES - desktop.scene->effects_cached_bytes;
                    int height = (int)((available - 128u * 1024u) / (4096u * 8u));
                    CHECK(height > 3000 && height < 4096);
                    pressure = shell_fixture.pressure = wlr_scene_tree_create(desktop.windows);
                    CHECK(pressure && wlr_scene_rect_create(pressure, 4096, height, (float[4]){0.4f, 0.2f, 0.6f, 1}) &&
                        wlr_scene_tree_set_rounding(pressure, &(struct wlr_box){0, 0, 4096, height}, 16));
                } else {
                    CHECK(pressure); wlr_scene_node_destroy(&pressure->node); pressure = shell_fixture.pressure = NULL;
                }
                wlr_layer_surface_v1_destroy(marker->surface); break;
            }
            if (sscanf(name, "backdrop-check %31s", stage) != 1) continue;
            if (!strcmp(stage, "old-v8")) {
                CHECK(old && shell_backdrop_count(2) == 2 && shell_backdrop_count(3) == 1);
                puts("PASS: actual frozen v8 provider retains taskbars and original bounded Start with new GUI; new capability false and explicit opt-in rejected without mutation");
            } else if (!strcmp(stage, "taskbars") || !strcmp(stage, "start") || !strcmp(stage, "retained")) {
                CHECK(shell_backdrop_count(2) == 2);
                CHECK(shell_backdrop_count(3) == (strcmp(stage, "taskbars") ? 1u : 0u));
                struct PuDesktopLayer *layer;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (layer->backdrop && (!strcmp(stage, "taskbars") ? layer->backdrop_role == 2 :
                        layer->backdrop_role == 3)) {
                        uint64_t ready = milliseconds() + 3000;
                        while (!dock_foreground_ready(layer) && milliseconds() < ready) CHECK(pump());
                        if (standard && layer->backdrop_role == 3) {
                            CHECK(layer->pending_box.width == 640 &&
                                layer->pending_box.height == (layer->surface->output->height == 720 ? 640 : 660));
                            CHECK(desktop.focused_layer == layer && layer->surface->surface->current.width == 640);
                        }
                        CHECK(shell_region_pixels(layer));
                        if (!strcmp(stage, "retained")) {
                            retired_serial = layer->backdrop_serial;
                            retired_target = layer->backdrop_index;
                        }
                    }
            } else if (!strcmp(stage, "stale")) {
                struct PuDesktopLayer *layer, *current = NULL;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (layer->backdrop && layer->backdrop_role == 3) current = layer;
                CHECK(current && retired_serial && current->backdrop_serial != retired_serial);
                polly_appearance_v1_send_shell_backdrop_retired(current->backdrop_owner, retired_serial,
                    retired_target, 3, "stale Start retirement must be ignored");
                polly_appearance_v1_send_shell_backdrop_retired(current->backdrop_owner, retired_serial,
                    0, 2, "stale taskbar retirement must be ignored");
                puts("PASS: real v8 old-serial Start/taskbar retirement events sent after close/reopen on another output");
            } else if (!strcmp(stage, "closed")) {
                CHECK(shell_backdrop_count(2) == 2 && !shell_backdrop_count(3));
                puts("PASS: actual Tab/Enter closes Start with both production taskbars retained");
            } else if (!strcmp(stage, "extent")) {
                CHECK(shell_backdrop_count(2) == 2 && !shell_backdrop_count(3));
                struct PuDesktopLayer *layer;
                bool oversized = false;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (layer->surface->current.keyboard_interactive ==
                        ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE)
                        oversized |= layer->pending_box.height > 512 && !layer->backdrop;
                CHECK(oversized);
                puts("PASS: actual standard 640-high Start is rejected at effects3 512 bound, retaining solid foreground and both taskbars; standard-height Start remains BLOCKED");
                struct wlr_output_layout_output *entry;
                wl_list_for_each(entry, &desktop.layout->outputs, link) {
                    struct wlr_output_state state;
                    wlr_output_state_init(&state);
                    wlr_output_state_set_custom_mode(&state, 1280, 540, 60000);
                    bool applied = wlr_output_commit_state(entry->output, &state);
                    wlr_output_state_finish(&state);
                    CHECK(applied);
                }
            } else if (!strcmp(stage, "legacy") || !strcmp(stage, "stopped")) {
                if (!strcmp(stage, "stopped")) {
                    uint64_t retired = milliseconds() + 3000;
                    while (!wl_list_empty(&desktop.scene->backdrops) && milliseconds() < retired) CHECK(pump());
                }
                CHECK(wl_list_empty(&desktop.scene->backdrops));
            } else if (!strcmp(stage, "budget")) {
                CHECK(pressure && shell_backdrop_count(2) == 2 && !shell_backdrop_count(3));
                unsigned i = 0;
                struct PuDesktopLayer *layer;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (layer->backdrop && layer->backdrop_role == 2) CHECK(layer->backdrop == retained[i++]);
                CHECK(i == 2);
                puts("PASS: actual old-plus-candidate/scratch peak rejects Start without replacing either committed taskbar");
            } else if (!strcmp(stage, "privacy")) {
                char lock_client[PATH_MAX];
                const char *slash = strrchr(wire, '/');
                CHECK(slash && snprintf(lock_client, sizeof(lock_client), "%.*s/polly-lock-test-client",
                    (int)(slash - wire), wire) < (int)sizeof(lock_client));
                struct PuDesktopLayer *layer;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (layer->backdrop_role == 3 && layer->backdrop) {
                        CHECK(live_backdrop_failure(layer, lock_client)); break;
                    }
            } else if (!strcmp(stage, "unpair")) {
                struct PuDesktopLayer *layer, *peer = NULL;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (layer->backdrop && layer->backdrop_role == 3) {
                        struct PuDesktopLayer *candidate;
                        wl_list_for_each(candidate, &desktop.layers, link)
                            if (wl_resource_get_id(candidate->surface->surface->resource) == layer->backdrop_taskbar)
                                peer = candidate;
                    }
                CHECK(peer);
                wlr_layer_surface_v1_destroy(marker->surface);
                wlr_layer_surface_v1_destroy(peer->surface);
                CHECK(!shell_backdrop_count(3) && shell_backdrop_count(2) == 1);
                puts("PASS: destruction of the real paired taskbar revokes Start immediately, retaining the other output taskbar");
                break;
            } else if (!strcmp(stage, "output")) {
                struct wlr_output *output = NULL;
                struct PuDesktopLayer *layer;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (layer->backdrop && layer->backdrop_role == 3) output = layer->surface->output;
                CHECK(output);
                struct PuDesktopView *keeper = wire_view();
                struct wlr_output_layout_output *entry;
                wl_list_for_each(entry, &desktop.layout->outputs, link)
                    if (entry->output != output && keeper) {
                        struct wlr_box full;
                        wlr_output_layout_get_box(desktop.layout, entry->output, &full);
                        wlr_scene_node_set_position(&keeper->tree->node, full.x + 20, full.y + 80);
                        keeper->output = entry->output;
                    }
                wlr_layer_surface_v1_destroy(marker->surface);
                wlr_output_destroy(output);
                CHECK(!shell_backdrop_count(3));
                puts("PASS: actual output destruction retires its Start and taskbar without cross-output sampling");
                break;
            } else CHECK(false);
            checks++;
            wlr_layer_surface_v1_destroy(marker->surface);
            break;
        }
    }
    CHECK(!desktop.shell_pid && checks >= (old ? 2u : 9u) && !pressure && wl_list_empty(&desktop.scene->backdrops));
    puts("PASS: production modern Shell backdrop consumer completes mapped lifecycle, native input, peer, output, budget and privacy boundaries");
    return true;
}
static void picker_key(uint32_t code, bool down)
{
    struct wlr_keyboard_key_event event = {.time_msec = ++clock_ms, .keycode = code,
        .update_state = true, .state = down ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED};
    wlr_keyboard_notify_key(&keyboard, &event);
}

static bool picker_hover(struct PuDesktopView *view)
{
    motion(view->tree->node.x + 20, view->tree->node.y + 20);
    CHECK(wait_presented_frame(view));
    struct wlr_box box;
    CHECK(pu_decoration_button_box(view, PU_DECORATION_MAXIMIZE, &box));
    motion(view->tree->node.x + box.x + box.width / 2.0,
        view->tree->node.y + box.y + box.height / 2.0);
    return true;
}

static struct PuDesktopLayer *picker_menu(void)
{
    struct PuDesktopLayer *layer;
    wl_list_for_each(layer, &desktop.layers, link)
        if (layer->surface->namespace && !strncmp(layer->surface->namespace, "PollyShell.menu.", 16) &&
            layer->presented && layer->surface->surface->mapped) return layer;
    return NULL;
}

static bool picker_output_size(int width, int height, int x, int y)
{
    struct PuDesktopView *view = wire_view();
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_custom_mode(&state, width, height, 60000);
    bool committed = wlr_output_commit_state(view->output, &state);
    wlr_output_state_finish(&state);
    CHECK(committed);
    wlr_output_layout_add(desktop.layout, view->output, x, y);
    CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view));
    return true;
}

static bool layout_picker_consumer(const char *ui, const char *wire, bool old)
{
    app_pid = fork();
    CHECK(app_pid >= 0);
    if (!app_pid) {
        setenv("WAYLAND_DISPLAY", desktop.socket_name, 1);
        execl(ui, ui, "--app-id", "org.pollyui.picker-public",
            "desktop/tests/layout-picker-shell.mjs", "denied", (char *)NULL);
        _exit(127);
    }
    int public_status = 0;
    bool public_done = false, public_denied = false;
    for (int i = 0; i < 1200; i++) {
        pid_t result = waitpid(app_pid, &public_status, WNOHANG);
        if (result == app_pid) { app_pid = 0; public_done = true; break; }
        CHECK(result == 0 && pump());
        struct PuDesktopView *witness = find("Picker.public.denied");
        if (witness) { public_denied = true; wlr_xdg_toplevel_send_close(witness->toplevel); }
    }
    CHECK(public_done && public_denied && WIFEXITED(public_status) && WEXITSTATUS(public_status) == 0 &&
        !desktop.shell_client && wire_view());
    char *shell[] = {(char *)ui, "--desktop", "--no-legacy-storage", "--app-id", "org.pollyui.shell",
        "desktop/tests/layout-picker-shell.mjs", old ? "old" : "current", NULL};
    CHECK(pu_desktop_spawn_shell(&desktop, shell));
    unsigned checks = 0;
    struct wlr_box floating = {0};
    struct wlr_output *cross_origin = NULL, *cross_output = NULL;
    struct wlr_box cross_origin_box = {0};
    uint64_t window_id = 0;
    uint64_t deadline = milliseconds() + 25000;
    while (desktop.shell_pid && milliseconds() < deadline) {
        CHECK(pump());
        struct PuDesktopLayer *marker, *tmp;
        wl_list_for_each_safe(marker, tmp, &desktop.layers, link) {
            if (!marker->surface->surface->mapped) continue;
            const char *name = marker->surface->namespace;
            if (!name || strncmp(name, "picker-", 7)) continue;
            char operation[32], argument[32] = {0};
            int x = 0, y = 0;
            CHECK(sscanf(name, "picker-%31s", operation) == 1);
            struct PuDesktopView *view = wire_view();
            if (!strcmp(operation, "ready")) {
                CHECK(view && command(TEST_UNCONSTRAINED, 0, 0));
                pu_desktop_focus_mapped(&desktop, view->workspace_window);
                wlr_scene_node_set_position(&view->tree->node, 80, 160);
                CHECK(wait_presented_frame(view));
                floating = view->presented_box;
                window_id = view->workspace_window;
            } else if (!strcmp(operation, "original")) {
                CHECK(view && click(view, PU_DECORATION_MAXIMIZE) && wait_presented_frame(view) &&
                    view->mode == PU_DESKTOP_MAXIMIZED);
                CHECK(click(view, PU_DECORATION_MAXIMIZE) && wait_presented_frame(view) &&
                    view->mode == PU_DESKTOP_FLOATING);
                struct wlr_box inset = {0};
                pu_decoration_inset(view, &inset, false);
                clock_ms += 401;
                motion(view->tree->node.x + 40, view->tree->node.y - inset.y / 2.0);
                CHECK(pu_decoration_hit(view, 40, -inset.y / 2.0) == PU_DECORATION_TITLE);
                button(true); button(false); button(true); button(false);
                CHECK(command(TEST_QUERY, 0, 0) && wait_presented_frame(view) &&
                    view->mode == PU_DESKTOP_MAXIMIZED);
                CHECK(click(view, PU_DECORATION_MAXIMIZE) && wait_presented_frame(view) &&
                    view->mode == PU_DESKTOP_FLOATING);
                CHECK(!picker_menu());
            } else if (!strcmp(operation, "hover") || !strcmp(operation, "stopped")) {
                CHECK(view && picker_hover(view));
            } else if (!strcmp(operation, "cancel-before")) {
                CHECK(view && picker_hover(view));
                motion(view->tree->node.x + 20, view->tree->node.y + 20);
            } else if (!strcmp(operation, "key")) {
                CHECK(sscanf(name, "picker-key %d %d", &x, &y) == 2);
                if (y) picker_key(KEY_LEFTSHIFT, true);
                picker_key((uint32_t)x, true); picker_key((uint32_t)x, false);
                if (y) picker_key(KEY_LEFTSHIFT, false);
            } else if (!strcmp(operation, "click")) {
                CHECK(sscanf(name, "picker-click %d %d", &x, &y) == 2);
                struct PuDesktopLayer *menu = picker_menu();
                CHECK(menu && menu == desktop.focused_layer && menu->pending_box.width > x &&
                    menu->pending_box.height > y && x >= 0 && y >= 0);
                motion(menu->pending_box.x + x, menu->pending_box.y + y);
                CHECK(desktop.seat->pointer_state.focused_surface == menu->surface->surface);
                button(true); button(false);
            } else if (!strcmp(operation, "check")) {
                CHECK(sscanf(name, "picker-check %d", &x) == 1 && view && wait_presented_frame(view) &&
                    (int)view->mode == x && view->workspace_window == window_id);
                struct wlr_box expected;
                if (x == PU_DESKTOP_FLOATING) {
                    expected = floating;
                    expected.x = view->tree->node.x; expected.y = view->tree->node.y;
                } else {
                    wlr_output_layout_get_box(desktop.layout, view->output, &expected);
                    expected.height -= 48;
                    expected.width /= 2;
                    if (x == PU_DESKTOP_TILED_RIGHT) expected.x += expected.width;
                    pu_decoration_inset(view, &expected, false);
                }
                CHECK(wlr_box_equal(&view->presented_box, &expected) &&
                    view->toplevel->base->geometry.width == expected.width &&
                    view->toplevel->base->geometry.height == expected.height &&
                    frame_hash(view) && pu_decoration_presented_revision(view));
                printf("PASS: native picker actual client=%dx%d presented=%d,%d,%d,%d mode=%d ownedRevision=%u window=%llu\n",
                    view->toplevel->base->geometry.width, view->toplevel->base->geometry.height,
                    expected.x, expected.y, expected.width, expected.height, x,
                    pu_decoration_presented_revision(view), (unsigned long long)window_id);
                checks++;
            } else if (!strcmp(operation, "guard") || !strcmp(operation, "unguard")) {
                CHECK(sscanf(name, "picker-%*s %31s", argument) == 1);
                bool enable = !strcmp(operation, "guard");
                if (!strcmp(argument, "keyboard") && enable) {
                    picker_keyboard_impl = *desktop.seat->keyboard_state.default_grab->interface;
                    picker_keyboard_grab.interface = &picker_keyboard_impl;
                    wlr_seat_keyboard_start_grab(desktop.seat, &picker_keyboard_grab);
                    CHECK(wlr_seat_keyboard_has_grab(desktop.seat));
                } else if (!strcmp(argument, "pointer") && enable) {
                    picker_pointer_impl = *desktop.seat->pointer_state.default_grab->interface;
                    picker_pointer_grab.interface = &picker_pointer_impl;
                    wlr_seat_pointer_start_grab(desktop.seat, &picker_pointer_grab);
                    CHECK(wlr_seat_pointer_has_grab(desktop.seat));
                } else if (!strcmp(argument, "keyboard") || !strcmp(argument, "pointer")) finish_picker_grabs();
                else if (!strcmp(argument, "recording")) CHECK(pu_shortcuts_recording(&desktop) == enable);
                else if (!strcmp(argument, "lock")) {
                    if (enable) {
                        char locker[PATH_MAX];
                        const char *slash = strrchr(wire, '/');
                        CHECK(slash && snprintf(locker, sizeof(locker), "%.*s/polly-lock-test-client",
                            (int)(slash - wire), wire) < (int)sizeof(locker));
                        char *args[] = {locker, "unlock", NULL};
                        CHECK(pu_session_lock_spawn(&desktop, args) && pu_session_lock_active(&desktop));
                    } else {
                        for (int i = 0; i < 600 && pu_session_lock_active(&desktop); i++) CHECK(pump());
                        CHECK(!pu_session_lock_active(&desktop));
                    }
                } else if (!strcmp(argument, "fullscreen")) {
                    CHECK(command(enable ? TEST_FULLSCREEN : TEST_UNFULLSCREEN, 0, 0));
                    if (enable) {
                        for (int i = 0; i < 1200 && view->geometry_pending; i++) CHECK(pump());
                        CHECK(view->mode == PU_DESKTOP_FULLSCREEN);
                    } else CHECK(wait_presented_frame(view));
                } else if (!strcmp(argument, "minimized")) {
                    if (enable) CHECK(command(TEST_MINIMIZE, 0, 0));
                    else pu_desktop_focus_mapped(&desktop, view->workspace_window);
                } else if (!strcmp(argument, "modal")) {
                    CHECK(command(enable ? TEST_TRANSIENT : TEST_DESTROY, enable ? 0 : 4, enable ? 1 : 0));
                } else if (!strcmp(argument, "workspace")) {
                    if (enable) { picker_workspace = desktop.active_workspace; pu_workspace_step(&desktop, 1); }
                    else { pu_workspace_activate(&desktop, picker_workspace, view); picker_workspace = NULL; }
                } else CHECK(false);
                if (!enable) {
                    pu_desktop_focus_mapped(&desktop, view->workspace_window);
                    CHECK(wait_presented_frame(view));
                }
            } else if (!strcmp(operation, "cross-head")) {
                CHECK(view && !cross_output);
                for (int i = 0; i < 1200 && picker_menu(); i++) CHECK(pump());
                CHECK(!picker_menu() && wait_presented_frame(view) && view->mode == PU_DESKTOP_FLOATING);
                struct wlr_backend *backend = NULL;
                wlr_multi_for_each_backend(desktop.backend, find_headless, &backend);
                CHECK(backend);
                cross_origin = view->output;
                wlr_output_layout_get_box(desktop.layout, cross_origin, &cross_origin_box);
                cross_output = wlr_headless_add_output(backend, 1280, 720);
                CHECK(cross_output && cross_output != cross_origin);
                bool panel_ready = false;
                for (int i = 0; i < 1200 && !panel_ready; i++) {
                    struct PuDesktopLayer *panel;
                    wl_list_for_each(panel, &desktop.layers, link)
                        if (panel->surface->output == cross_output && panel->presented &&
                            panel->surface->surface->mapped && panel->surface->current.exclusive_zone == 48 &&
                            wl_resource_get_client(panel->surface->resource) == desktop.shell_client &&
                            !strncmp(panel->surface->namespace, "PollyShell.panel.", 17)) panel_ready = true;
                    if (!panel_ready) CHECK(pump());
                }
                CHECK(panel_ready && wait_presented_frame(view));
                struct wlr_box destination;
                wlr_output_layout_get_box(desktop.layout, cross_output, &destination);
                CHECK(destination.x == cross_origin_box.x + cross_origin_box.width &&
                    destination.y == cross_origin_box.y && begin_title_drag(view));
                motion(destination.x + 300, destination.y + 200);
                button(false);
                CHECK(wait_presented_frame(view) && view->mode == PU_DESKTOP_FLOATING &&
                    view->output == cross_origin);
                struct wlr_box button_box;
                CHECK(pu_decoration_button_box(view, PU_DECORATION_MAXIMIZE, &button_box) &&
                    wlr_output_layout_output_at(desktop.layout,
                        view->tree->node.x + button_box.x + button_box.width / 2.0,
                        view->tree->node.y + button_box.y + button_box.height / 2.0) == cross_output);
                printf("PASS: actual native caption MOVE released on head B with remembered view output still A; ownedRevision=%u\n",
                    pu_decoration_presented_revision(view));
            } else if (!strcmp(operation, "cross-check")) {
                CHECK(view && cross_output && wait_presented_frame(view) &&
                    view->mode == PU_DESKTOP_TILED_LEFT && view->output == cross_output);
                struct wlr_box expected, origin;
                wlr_output_layout_get_box(desktop.layout, cross_output, &expected);
                expected.width /= 2; expected.height -= 48;
                pu_decoration_inset(view, &expected, false);
                wlr_output_layout_get_box(desktop.layout, cross_origin, &origin);
                CHECK(wlr_box_equal(&origin, &cross_origin_box) &&
                    wlr_box_equal(&view->presented_box, &expected) &&
                    view->toplevel->base->geometry.width == expected.width &&
                    view->toplevel->base->geometry.height == expected.height &&
                    frame_hash(view) && pu_decoration_presented_revision(view));
                printf("PASS: cross-head picker places actual client=%dx%d at B=%d,%d with current ownedRevision=%u; head A unchanged\n",
                    expected.width, expected.height, expected.x, expected.y, pu_decoration_presented_revision(view));
                checks++;
            } else if (!strcmp(operation, "cross-clean")) {
                CHECK(view && cross_output && view->mode == PU_DESKTOP_FLOATING);
                wlr_layer_surface_v1_destroy(marker->surface); marker = NULL;
                wlr_output_destroy(cross_output); cross_output = NULL;
                CHECK(wait_presented_frame(view) && view->output == cross_origin);
            } else if (!strcmp(operation, "small")) {
                CHECK(picker_output_size(640, 180, -640, -180));
            } else if (!strcmp(operation, "normal")) {
                CHECK(picker_output_size(1280, 720, 0, 0));
            } else if (!strcmp(operation, "retire")) {
                CHECK(command(TEST_QUERY, 0, 0) && command(TEST_UNMAP, 0, 0));
            } else if (!strcmp(operation, "remap")) {
                CHECK(command(TEST_REMAP, 0, 0) && command(TEST_UNCONSTRAINED, 0, 0));
                view = wire_view();
                CHECK(view && view->workspace_window > window_id && wait_presented_frame(view));
                window_id = view->workspace_window;
            } else if (!strcmp(operation, "output-retire")) {
                struct wlr_backend *backend = NULL;
                wlr_multi_for_each_backend(desktop.backend, find_headless, &backend);
                CHECK(backend && view && picker_menu());
                struct wlr_output *old_output = view->output;
                struct wlr_output *replacement = wlr_headless_add_output(backend, 1280, 720);
                CHECK(replacement && replacement != old_output);
                wlr_layer_surface_v1_destroy(marker->surface); marker = NULL;
                wlr_output_destroy(old_output);
                CHECK(command(TEST_QUERY, 0, 0) && view->output == replacement && wait_presented_frame(view));
            } else if (!strcmp(operation, "success")) checks++;
            else CHECK(false);
            if (marker) wlr_layer_surface_v1_destroy(marker->surface);
            break;
        }
    }
    CHECK(!desktop.shell_pid && WIFEXITED(desktop.shell_status) && WEXITSTATUS(desktop.shell_status) == 0 &&
        checks == (old ? 1u : 5u) && !picker_menu());
    puts("PASS: production Shell picker completes actual native hover, old clicks, pointer/keyboard, guards and retirement");
    return true;
}

static bool picker_request(struct TestRequest request, bool accepted)
{
    unsigned results = reply.placement_results;
    CHECK(send(control, &request, sizeof(request), MSG_NOSIGNAL) == sizeof(request));
    for (int i = 0; i < 1200; i++) {
        ssize_t count = recv(control, &reply, sizeof(reply), MSG_DONTWAIT);
        if (count == sizeof(reply)) {
            CHECK(reply.placement_results == results + 1 && reply.placement_serial == request.serial &&
                reply.placement_accepted == (uint32_t)accepted);
            if (!accepted) CHECK(reply.placement_message[0]);
            return true;
        }
        CHECK(count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) && pump());
    }
    CHECK(false);
}

static bool picker_raw_offer(struct PuDesktopView *view, uint32_t target)
{
    pu_desktop_focus_mapped(&desktop, view->workspace_window);
    CHECK(wait_presented_frame(view) && picker_hover(view));
    for (int i = 0; i < 1200; i++) {
        CHECK(command(TEST_QUERY, 0, 0));
        if (reply.picker_token && reply.picker_target == target) return true;
        CHECK(pump());
    }
    CHECK(false);
}

static bool layout_picker_protocol(const char *wire)
{
    CHECK(command(TEST_UNCONSTRAINED, 0, 0) && command(TEST_TRANSIENT, 1, 8));
    struct PuDesktopView *first = wire_view(), *second = NULL, *view;
    wl_list_for_each(view, &desktop.views, link)
        if (view->toplevel->app_id && !strcmp(view->toplevel->app_id, "org.pollywm.test.8")) second = view;
    CHECK(first && second && wait_presented_frame(first) && wait_presented_frame(second));
    wlr_scene_node_set_position(&first->tree->node, 80, 160);
    wlr_scene_node_set_position(&second->tree->node, 500, 160);
    struct wlr_box before_first = first->presented_box, before_second = second->presented_box;
    int sockets[2];
    CHECK(!socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sockets));
    CHECK(!fcntl(sockets[1], F_SETFD, 0) && !setenv("POLLY_TEST_WORKSPACE_V4", "1", 1));
    char number[32]; snprintf(number, sizeof(number), "%d", sockets[1]);
    char *args[] = {(char *)wire, "--trusted", number, NULL};
    bool started = pu_desktop_spawn_shell(&desktop, args);
    unsetenv("POLLY_TEST_WORKSPACE_V4");
    close(sockets[1]);
    CHECK(started);
    picker_wire_control = control; control = sockets[0];
    CHECK(command(TEST_QUERY, 0, 0) && reply.picker_capability == 1 &&
        command(TEST_PICKER_ENABLE, 1, 0));
    struct TestRequest layer = {.command = TEST_LAYER_MAP, .id = 3, .layer = {
        .layer = ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY, .width = 280, .height = 260, .zone = -1,
        .anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP | ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT,
        .keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE}};
    CHECK(send(control, &layer, sizeof(layer), MSG_NOSIGNAL) == sizeof(layer));
    bool received = false;
    for (int i = 0; i < 1200 && !received; i++) {
        received = recv(control, &reply, sizeof(reply), MSG_DONTWAIT) == sizeof(reply);
        CHECK(received || pump());
    }
    CHECK(received && command(TEST_QUERY, 0, 0) && command(TEST_UNMAP, 0, 0));
    layer.id = 4;
    layer.layer.layer = ZWLR_LAYER_SHELL_V1_LAYER_TOP;
    layer.layer.keyboard = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE;
    layer.layer.width = layer.layer.height = 12; layer.layer.zone = 0;
    CHECK(send(control, &layer, sizeof(layer), MSG_NOSIGNAL) == sizeof(layer));
    received = false;
    for (int i = 0; i < 1200 && !received; i++) {
        received = recv(control, &reply, sizeof(reply), MSG_DONTWAIT) == sizeof(reply);
        CHECK(received || pump());
    }
    CHECK(received);
    CHECK(picker_raw_offer(first, 7));
    before_first = first->presented_box; before_second = second->presented_box;
    uint32_t stale = reply.picker_token, serial = 1;
    struct TestRequest open = {.command = TEST_PICKER_OPEN, .id = 8, .serial = serial++, .edges = stale};
    CHECK(picker_request(open, false) && first->mode == PU_DESKTOP_FLOATING &&
        second->mode == PU_DESKTOP_FLOATING && wlr_box_equal(&first->presented_box, &before_first) &&
        wlr_box_equal(&second->presented_box, &before_second));
    open.id = 7; open.serial = serial++; open.layer.live = 1;
    CHECK(picker_request(open, false) && !first->geometry_pending && !second->geometry_pending);
    CHECK(command(TEST_QUERY, 0, 0) && !reply.picker_token && picker_raw_offer(first, 7));
    stale = reply.picker_token;
    open.edges = stale; open.layer.live = 0;
    open.id = 7; open.serial = serial++;
    CHECK(picker_request(open, true));
    uint32_t epoch = reply.placement_epoch;
    open.serial = serial++;
    CHECK(picker_request(open, false));
    struct TestRequest place = {.command = TEST_MENU_PLACE, .id = 7, .serial = serial++, .edges = epoch,
        .layer = {.width = PU_TILE_LEFT}};
    CHECK(picker_request(place, false) && first->mode == PU_DESKTOP_FLOATING && !first->geometry_pending);
    puts("PASS: raw v4 wrong-target and duplicate grants cannot mutate either actual target or replay a menu epoch");

    CHECK(picker_raw_offer(second, 8));
    uint32_t current = reply.picker_token;
    CHECK(current > stale);
    open.id = 7; open.serial = serial++; open.edges = stale;
    CHECK(picker_request(open, false) && command(TEST_QUERY, 0, 0) && reply.picker_token == current);
    open.id = 8; open.serial = serial++; open.edges = current;
    CHECK(picker_request(open, true));
    epoch = reply.placement_epoch;
    place.id = 8; place.serial = serial++; place.edges = epoch;
    CHECK(picker_request(place, false) && second->mode == PU_DESKTOP_FLOATING && !second->geometry_pending);
    CHECK(command(TEST_REMAP, 0, 0));
    for (int i = 0; i < 1200 && !picker_menu(); i++) {
        /* Raw layer has no Shell namespace; presentation is checked below. */
        struct PuDesktopLayer *entry;
        bool ready = false;
        wl_list_for_each(entry, &desktop.layers, link)
            if (entry->surface->surface->mapped && entry->presented &&
                wl_resource_get_client(entry->surface->resource) == desktop.shell_client) ready = true;
        if (ready) break;
        CHECK(pump());
    }
    CHECK(desktop.focused_layer && desktop.focused_layer->presented);
    struct PuDesktopLayer *menu = desktop.focused_layer;
    motion(menu->pending_box.x + 20, menu->pending_box.y + 20);
    CHECK(desktop.seat->pointer_state.focused_surface == menu->surface->surface);
    place.serial = serial++;
    CHECK(picker_request(place, true));
    CHECK(wait_presented_frame(second) && second->mode == PU_DESKTOP_TILED_LEFT &&
        pu_decoration_presented_revision(second) && first->mode == PU_DESKTOP_FLOATING);
    place.serial = serial++;
    CHECK(picker_request(place, false));
    puts("PASS: old two-target grant rejected; unpresented exact menu denied; real mapped/presented input admits one existing placement only");
    CHECK(command(TEST_QUERY, 0, 0) && command(TEST_UNMAP, 0, 0));
    CHECK(picker_raw_offer(first, 7));
    stale = reply.picker_token;
    picker_keyboard_impl = *desktop.seat->keyboard_state.default_grab->interface;
    picker_keyboard_grab.interface = &picker_keyboard_impl;
    wlr_seat_keyboard_start_grab(desktop.seat, &picker_keyboard_grab);
    CHECK(wlr_seat_keyboard_has_grab(desktop.seat) && command(TEST_QUERY, 0, 0) && !reply.picker_token);
    open.id = 7; open.serial = serial++; open.edges = stale;
    CHECK(picker_request(open, false) && !first->geometry_pending);
    finish_picker_grabs();
    CHECK(command(TEST_PICKER_ENABLE, 0, 0));
    CHECK(command(TEST_QUIT, 0, 0));
    close(control); control = picker_wire_control; picker_wire_control = -1;
    for (int i = 0; i < 1200 && desktop.shell_pid; i++) CHECK(pump());
    CHECK(!desktop.shell_pid);
    puts("PASS: actual keyboard grab revokes unredeemed grant synchronously; disconnect leaves no timer or epoch");
    return true;
}

static bool suite(const char *ui, const char *wire, const char *mode)
{
    char *decorator[] = {(char *)ui, "--decorator", "--app-id", "org.pollyui.decorator",
        !strcmp(mode, "frame-policy") ? "desktop/tests/decorator-app.mjs" : "desktop/decorator/main.mjs", NULL};
    CHECK(pu_decorator_spawn(&desktop, decorator));
    CHECK(wait_service(0));
    CHECK(wl_list_empty(&desktop.all_views) && wl_list_empty(&desktop.layers));
    if (!strcmp(mode, "backdrop-guard")) return backdrop_guard_retirement(ui);
    CHECK(start_wire(wire));
    struct PuDesktopView *view = wire_view();
    CHECK(frame_hash(view) && buffer_count(&view->tree->node) == 5);
    if (!strcmp(mode, "layout-picker") || !strcmp(mode, "layout-picker-old"))
        return layout_picker_consumer(ui, wire, !strcmp(mode, "layout-picker-old"));
    if (!strcmp(mode, "layout-picker-protocol")) return layout_picker_protocol(wire);
    if (!strcmp(mode, "title-snap")) return title_edge_snap(wire);
    if (!strcmp(mode, "title-drag")) return title_drag_restore();
    if (!strcmp(mode, "frame-fence")) return presented_frame_fence(ui);
    if (!strcmp(mode, "backdrop")) return backdrop_consumer(ui, wire);
    if (!strcmp(mode, "shell-backdrop") || !strncmp(mode, "standard-start", 14))
        return modern_backdrop_consumer(ui, wire, mode);
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
    wlr_log_init(!strncmp(argv[3], "layout-picker", 13) ? WLR_DEBUG : WLR_INFO, NULL);
    bool ready = pu_desktop_init(&desktop, "decorator-fixture") && pu_desktop_start(&desktop);
    bool passed = false;
    if (ready) {
        wlr_pointer_init(&pointer, &pointer_impl, "decorator-fixture-pointer");
        wlr_keyboard_init(&keyboard, &keyboard_impl, "decorator-fixture-keyboard");
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &pointer.base);
        wl_signal_emit_mutable(&desktop.backend->events.new_input, &keyboard.base);
        passed = suite(argv[1], argv[2], argv[3]);
        shell_fixture_cleanup();
        if (!resume_renderer()) passed = false;
        backdrop_guard_stop();
        finish_picker_grabs();
        stop_child(&wire_pid); stop_child(&app_pid);
        wlr_pointer_finish(&pointer); wlr_keyboard_finish(&keyboard);
    }
    if (control >= 0) close(control);
    if (picker_wire_control >= 0 && picker_wire_control != control) close(picker_wire_control);
    pu_desktop_finish(&desktop);
    return passed ? 0 : 1;
}
