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
static bool scene_pixels(struct wlr_output *output, uint32_t **pixels, int *width, int *height)
{
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
static bool control_key(struct PuDesktopView *view, uint32_t expected)
{
    pu_desktop_focus_mapped(&desktop, view->workspace_window);
    for (int i = 0; i < 10; i++) CHECK(pump());
    wlr_seat_keyboard_notify_key(desktop.seat, ++clock_ms, KEY_SPACE, WL_KEYBOARD_KEY_STATE_PRESSED);
    wlr_seat_keyboard_notify_key(desktop.seat, ++clock_ms, KEY_SPACE, WL_KEYBOARD_KEY_STATE_RELEASED);
    uint64_t deadline = milliseconds() + 5000;
    while (milliseconds() < deadline) {
        CHECK(pump());
        if (body_pixel(view, expected)) return true;
    }
    CHECK(false);
}
struct OutputWitness { struct wl_listener commit, destroy; struct wlr_buffer *buffer; unsigned count; };
static void witness_destroy(struct wl_listener *listener, void *data)
{
    (void)data;
    struct OutputWitness *witness = wl_container_of(listener, witness, destroy);
    wl_list_remove(&witness->commit.link);
    wl_list_remove(&witness->destroy.link);
    if (witness->buffer) wlr_buffer_unlock(witness->buffer);
    witness->buffer = NULL;
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
static bool live_backdrop_failure(struct PuDesktopLayer *dock, const char *lock_client)
{
    struct wlr_output *output = dock->surface->output;
    struct wlr_scene_output *scene_output = wlr_scene_get_scene_output(desktop.scene, output);
    static struct OutputWitness witness;
    witness = (struct OutputWitness){.commit.notify = witness_commit, .destroy.notify = witness_destroy};
    wl_signal_add(&output->events.commit, &witness.commit);
    wl_signal_add(&output->events.destroy, &witness.destroy);
    struct wlr_scene_rect *mark = wlr_scene_rect_create(desktop.layer_trees[3], 1, 1,
        (float[4]){0.2f, 0.4f, 0.6f, 1});
    CHECK(mark && wlr_scene_output_commit(scene_output, NULL) && witness.buffer);
    void *data; uint32_t format; size_t stride;
    CHECK(wlr_buffer_begin_data_ptr_access(witness.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride));
    size_t bytes = stride * witness.buffer->height;
    unsigned char *committed = malloc(bytes);
    CHECK(committed);
    memcpy(committed, data, bytes);
    wlr_buffer_end_data_ptr_access(witness.buffer);
    unsigned commits = witness.count;
    uint32_t sequence = output->commit_seq;
    size_t available = WLR_SCENE_EFFECTS_MAX_BYTES - desktop.scene->effects_cached_bytes;
    CHECK(available > 100u * 1024u * 1024u);
    int height = (int)((available - 128u * 1024u) / (4096u * 8u));
    CHECK(height > 3000 && height < 4096);
    struct wlr_scene_tree *pressure = wlr_scene_tree_create(desktop.windows);
    CHECK(pressure && wlr_scene_rect_create(pressure, 4096, height, (float[4]){0.4f, 0.2f, 0.6f, 1}) &&
        wlr_scene_tree_set_rounding(pressure, &(struct wlr_box){0, 0, 4096, height}, 16));
    wl_signal_emit_mutable(&output->events.frame, NULL);
    CHECK(scene_output->backdrop_failed && !desktop.failed && witness.count == commits && output->commit_seq == sequence);
    uint64_t renders = desktop.scene->backdrop_render_count;
    for (int i = 0; i < 10; i++) wl_signal_emit_mutable(&output->events.frame, NULL);
    CHECK(witness.count == commits && desktop.scene->backdrop_render_count == renders);
    uint64_t deadline = milliseconds() + 100;
    while (milliseconds() < deadline) CHECK(pump());
    CHECK(witness.count == commits && output->commit_seq == sequence && !desktop.failed);
    CHECK(wlr_buffer_begin_data_ptr_access(witness.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride));
    CHECK(!memcmp(committed, data, bytes));
    wlr_buffer_end_data_ptr_access(witness.buffer);
    uint64_t epoch = desktop.backdrop_epoch;
    char *crash[] = {(char *)lock_client, "crash", NULL};
    CHECK(pu_session_lock_spawn(&desktop, crash) && pu_session_lock_active(&desktop) &&
        desktop.backdrop_epoch != epoch);
    wl_signal_emit_mutable(&output->events.frame, NULL);
    CHECK(!desktop.failed && !scene_output->backdrop_failed && output->commit_seq != sequence);
    CHECK(wlr_buffer_begin_data_ptr_access(witness.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride));
    CHECK((((uint32_t *)((char *)data + (output->height / 2) * stride))[output->width / 2] & 0xffffff) == 0);
    wlr_buffer_end_data_ptr_access(witness.buffer);
    deadline = milliseconds() + 5000;
    while (milliseconds() < deadline && pu_session_lock_pid(&desktop)) CHECK(pump());
    CHECK(!pu_session_lock_pid(&desktop) && pu_session_lock_active(&desktop));
    CHECK(desktop.scene->backdrop_render_count == renders);
    uint32_t *locked;
    int width, screen_height;
    CHECK(scene_pixels(output, &locked, &width, &screen_height));
    CHECK((locked[(screen_height / 2) * width + width / 2] & 0xffffff) == 0);
    free(locked);
    wlr_scene_node_destroy(&pressure->node);
    char *unlock[] = {(char *)lock_client, "unlock", NULL};
    CHECK(pu_session_lock_spawn(&desktop, unlock));
    deadline = milliseconds() + 5000;
    while (milliseconds() < deadline && (pu_session_lock_active(&desktop) ||
        desktop.scene->backdrop_render_count == renders)) CHECK(pump());
    CHECK(!pu_session_lock_active(&desktop) && desktop.backdrop_epoch > epoch &&
        desktop.scene->backdrop_render_count > renders && !desktop.failed);
    witness_destroy(&witness.destroy, NULL);
    wlr_scene_node_destroy(&mark->node);
    free(committed);
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
    struct PuDesktopView *control_view = NULL;
    uint64_t deadline = milliseconds() + 15000;
    uint64_t dock_stable_since = milliseconds();
    uint32_t dock_id = 0;
    int dock_width = 0;
    while (milliseconds() < deadline && milliseconds() - dock_stable_since < 300) {
        CHECK(pump());
        control_view = find("Backdrop.fixture.control");
        struct PuDesktopLayer *current = sampled_layer();
        if (!control_view || !dock_foreground_ready(current) || !body_pixel(control_view, 0x314159)) {
            dock_stable_since = milliseconds();
            continue;
        }
        uint32_t id = wl_resource_get_id(current->surface->resource);
        if (id != dock_id || current->pending_box.width != dock_width) {
            dock_id = id; dock_width = current->pending_box.width;
            dock_stable_since = milliseconds();
        }
    }
    CHECK(milliseconds() - dock_stable_since >= 300 && control_view && dock_foreground_ready(sampled_layer()));
    struct PuDesktopLayer *dock = sampled_layer();
    CHECK(dock && dock->surface->surface->mapped && dock->backdrop_owner);
    struct wlr_box box = dock->pending_box;
    struct PuDesktopView *first = wire_view(), *second = find("Decorator.fixture.app");
    CHECK(first && second);
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
        wlr_buffer_begin_data_ptr_access(client->source, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride));
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
    wlr_buffer_end_data_ptr_access(client->source);
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
    CHECK(scene_pixels(dock->surface->output, &actual, &width, &height));
    struct wlr_scene_rect *committed = dock->backdrop;
    CHECK(control_key(control_view, 0x112233));
    CHECK(dock->backdrop == committed);
    CHECK(scene_pixels(dock->surface->output, &moved, &w, &h));
    for (int py = 0; py < box.height; py++)
        CHECK(!memcmp(actual + (y + py) * width + x, moved + (y + py) * width + x, (size_t)box.width * 4));
    free(actual); free(moved);
    puts("PASS: production mapped Dock excludes its own glyphs; idle has no resampling; wrong role/ordinary target/radius/sigma/duplicate-count transactions preserve committed node and exact Dock pixels");
    char lock_client[PATH_MAX];
    const char *slash = strrchr(wire, '/');
    CHECK(slash && snprintf(lock_client, sizeof(lock_client), "%.*s/polly-lock-test-client",
        (int)(slash - wire), wire) < (int)sizeof(lock_client));
    CHECK(live_backdrop_failure(dock, lock_client));
    CHECK(control_key(control_view, 0x271828));
    CHECK(!sampled_layer() && wl_list_empty(&desktop.scene->backdrops));
    CHECK(pixman_region32_equal(&input, &dock->surface->surface->input_region));
    CHECK(control_key(control_view, 0x161803));
    CHECK(sampled_layer());
    CHECK(scene_pixels(sampled_layer()->surface->output, &actual, &w, &h));
    free(actual);
    pu_desktop_focus_mapped(&desktop, control_view->workspace_window);
    wlr_seat_keyboard_notify_key(desktop.seat, ++clock_ms, KEY_SPACE, WL_KEYBOARD_KEY_STATE_PRESSED);
    wlr_seat_keyboard_notify_key(desktop.seat, ++clock_ms, KEY_SPACE, WL_KEYBOARD_KEY_STATE_RELEASED);
    for (int i = 0; i < 1200 && desktop.shell_pid; i++) CHECK(pump());
    CHECK(!desktop.shell_pid && wl_list_empty(&desktop.scene->backdrops));
    pixman_region32_fini(&input);
    puts("PASS: real missing-field legacy retirement, reactivation and Shell exit release all regional nodes/pixels");
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
    uint32_t *actual, *plain, *moved;
    int width, height, w, h;
    CHECK(scene_pixels(layer->surface->output, &actual, &width, &height));
    wlr_scene_node_set_enabled(&layer->backdrop->node, false);
    CHECK(scene_pixels(layer->surface->output, &plain, &w, &h));
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
        if ((pixel >> 24) == 255) { CHECK(actual[offset] == plain[offset]); opaque++; }
        clear += (pixel >> 24) == 0;
        effect += actual[offset] != plain[offset];
    }
    wlr_buffer_end_data_ptr_access(client->source);
    CHECK(opaque > 200 && clear > 1000 && effect > 1000);
    pixman_region32_t input;
    pixman_region32_init(&input);
    pixman_region32_copy(&input, &layer->surface->surface->input_region);
    wlr_scene_node_set_position(&first->tree->node, box.x + 30, box.y + box.height / 2 - 45);
    CHECK(scene_pixels(layer->surface->output, &moved, &w, &h));
    unsigned changes = 0;
    for (int py = 0; py < box.height; py++) for (int px = 0; px < box.width; px++) {
        size_t offset = (size_t)(y + py) * width + x + px;
        changes += actual[offset] != moved[offset];
    }
    CHECK(changes > 100 && pixman_region32_equal(&input, &layer->surface->surface->input_region));
    printf("PASS: production Shell role %u output %s current-lower-app movement changes %u regional pixels; %u opaque foreground pixels and actual input unchanged\n",
        layer->backdrop_role, layer->surface->output->name, changes, opaque);
    pixman_region32_fini(&input);
    free(actual); free(plain); free(moved);
    return true;
}
static bool modern_backdrop_consumer(const char *ui, const char *wire)
{
    CHECK(start_app(ui));
    char *shell[] = {(char *)ui, "--desktop", "--no-legacy-storage", "--app-id", "org.pollyui.shell",
        "desktop/tests/backdrop-shell.mjs", "modern", NULL};
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
                wlr_layer_surface_v1_destroy(marker->surface);
                wlr_seat_keyboard_notify_key(desktop.seat, ++clock_ms, code, WL_KEYBOARD_KEY_STATE_PRESSED);
                wlr_seat_keyboard_notify_key(desktop.seat, ++clock_ms, code, WL_KEYBOARD_KEY_STATE_RELEASED);
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
                    pressure = wlr_scene_tree_create(desktop.windows);
                    CHECK(pressure && wlr_scene_rect_create(pressure, 4096, height, (float[4]){0.4f, 0.2f, 0.6f, 1}) &&
                        wlr_scene_tree_set_rounding(pressure, &(struct wlr_box){0, 0, 4096, height}, 16));
                } else {
                    CHECK(pressure); wlr_scene_node_destroy(&pressure->node); pressure = NULL;
                }
                wlr_layer_surface_v1_destroy(marker->surface); break;
            }
            if (sscanf(name, "backdrop-check %31s", stage) != 1) continue;
            if (!strcmp(stage, "taskbars") || !strcmp(stage, "start") || !strcmp(stage, "retained")) {
                CHECK(shell_backdrop_count(2) == 2);
                CHECK(shell_backdrop_count(3) == (strcmp(stage, "taskbars") ? 1u : 0u));
                struct PuDesktopLayer *layer;
                wl_list_for_each(layer, &desktop.layers, link)
                    if (layer->backdrop && (!strcmp(stage, "taskbars") ? layer->backdrop_role == 2 :
                        layer->backdrop_role == 3)) {
                        uint64_t ready = milliseconds() + 3000;
                        while (!dock_foreground_ready(layer) && milliseconds() < ready) CHECK(pump());
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
    CHECK(!desktop.shell_pid && checks >= 9 && !pressure && wl_list_empty(&desktop.scene->backdrops));
    puts("PASS: production modern Shell backdrop consumer completes mapped lifecycle, native input, peer, output, budget and privacy boundaries");
    return true;
}
static bool suite(const char *ui, const char *wire, const char *mode)
{
    char *decorator[] = {(char *)ui, "--decorator", "--app-id", "org.pollyui.decorator",
        !strcmp(mode, "frame-policy") ? "desktop/tests/decorator-app.mjs" : "desktop/decorator/main.mjs", NULL};
    CHECK(pu_decorator_spawn(&desktop, decorator));
    CHECK(wait_service(0));
    CHECK(wl_list_empty(&desktop.all_views) && wl_list_empty(&desktop.layers));
    CHECK(start_wire(wire));
    struct PuDesktopView *view = wire_view();
    CHECK(frame_hash(view) && buffer_count(&view->tree->node) == 5);
    if (!strcmp(mode, "backdrop")) return backdrop_consumer(ui, wire);
    if (!strcmp(mode, "shell-backdrop")) return modern_backdrop_consumer(ui, wire);
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
