#include "wire.h"
#include "xdg-shell-client-protocol.h"

#include <errno.h>
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>
#include <wayland-client.h>

struct Client;
struct Configure {
    int width, height;
    bool maximized, fullscreen;
    uint32_t serial;
};

struct Window {
    struct Client *client;
    struct wl_surface *surface;
    struct xdg_surface *xdg;
    struct xdg_toplevel *toplevel;
    struct xdg_popup *popup;
    struct wl_callback *frame;
    int width, height;
    bool maximized, fullscreen, hold, small_fullscreen;
    struct Configure pending[32];
    size_t pending_count;
};

struct Buffer {
    struct wl_list link;
    struct wl_buffer *buffer;
    void *pixels;
    size_t size;
};

struct Client {
    struct wl_display *display;
    struct wl_compositor *compositor;
    struct wl_shm *shm;
    struct xdg_wm_base *wm;
    struct wl_seat *seat;
    struct wl_keyboard *keyboard;
    struct wl_pointer *pointer;
    struct wl_list buffers;
    struct Window window, popup, child;
    struct { uint32_t name; struct wl_output *output; } outputs[8];
    struct TestReply reply;
};

static void die(const char *message)
{
    fprintf(stderr, "test-client: %s (%s)\n", message, strerror(errno));
    exit(1);
}

static void buffer_release(void *data, struct wl_buffer *buffer)
{
    struct Buffer *entry = data;
    wl_list_remove(&entry->link);
    wl_buffer_destroy(buffer);
    munmap(entry->pixels, entry->size);
    free(entry);
}
static const struct wl_buffer_listener buffer_listener = { .release = buffer_release };

static struct wl_buffer *make_buffer(struct Client *client, int width, int height)
{
    struct Buffer *entry = calloc(1, sizeof(*entry));
    if (!entry) die("buffer allocation");
    entry->size = (size_t)width * height * 4;
    char name[] = "/tmp/pollywm-buffer-XXXXXX";
    int fd = mkstemp(name);
    if (fd < 0) die("mkstemp");
    unlink(name);
    if (ftruncate(fd, (off_t)entry->size) < 0) die("ftruncate");
    entry->pixels = mmap(NULL, entry->size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (entry->pixels == MAP_FAILED) die("mmap");
    uint32_t *pixels = entry->pixels;
    for (size_t i = 0; i < entry->size / 4; i++)
        pixels[i] = client->reply.id == 1 ? 0xff3b82f6 : 0xff10b981;
    struct wl_shm_pool *pool = wl_shm_create_pool(client->shm, fd, (int)entry->size);
    entry->buffer = wl_shm_pool_create_buffer(pool, 0, width, height,
                                             width * 4, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);
    close(fd);
    wl_list_insert(&client->buffers, &entry->link);
    wl_buffer_add_listener(entry->buffer, &buffer_listener, entry);
    return entry->buffer;
}

static void frame_done(void *data, struct wl_callback *callback, uint32_t time)
{
    (void)time;
    struct Window *window = data;
    window->frame = NULL;
    window->client->reply.frames++;
    wl_callback_destroy(callback);
}
static const struct wl_callback_listener frame_listener = { .done = frame_done };

static void apply_configure(struct Window *window, struct Configure config)
{
    xdg_surface_ack_configure(window->xdg, config.serial);
    int width = config.width, height = config.height;
    if (window->small_fullscreen && config.fullscreen) { width = 240; height = 160; }
    if (window->toplevel) {
        window->client->reply.maximized = config.maximized;
        window->client->reply.fullscreen = config.fullscreen;
        window->client->reply.width = width;
        window->client->reply.height = height;
    }
    /* Nonzero geometry offsets exercise the distinction from the buffer origin. */
    xdg_surface_set_window_geometry(window->xdg, 8, 12, width, height);
    struct wl_buffer *buffer = make_buffer(window->client, width + 16, height + 24);
    wl_surface_attach(window->surface, buffer, 0, 0);
    wl_surface_damage_buffer(window->surface, 0, 0, width + 16, height + 24);
    if (!window->frame) {
        window->frame = wl_surface_frame(window->surface);
        wl_callback_add_listener(window->frame, &frame_listener, window);
    }
    wl_surface_commit(window->surface);
}

static void configure_surface(void *data, struct xdg_surface *xdg, uint32_t serial)
{
    (void)xdg;
    struct Window *window = data;
    window->client->reply.configured++;
    struct Configure config = {
        .width = window->width, .height = window->height,
        .maximized = window->maximized, .fullscreen = window->fullscreen, .serial = serial,
    };
    if (window->hold) {
        if (window->pending_count == 32) die("too many pending configures");
        window->pending[window->pending_count++] = config;
    } else {
        apply_configure(window, config);
    }
}
static const struct xdg_surface_listener surface_listener = { .configure = configure_surface };

static void configure_toplevel(void *data, struct xdg_toplevel *toplevel,
    int32_t width, int32_t height, struct wl_array *states)
{
    (void)toplevel;
    struct Window *window = data;
    window->width = width > 0 ? width : 240;
    window->height = height > 0 ? height : 160;
    window->maximized = window->fullscreen = false;
    uint32_t *state;
    wl_array_for_each(state, states) {
        if (*state == XDG_TOPLEVEL_STATE_MAXIMIZED) window->maximized = true;
        if (*state == XDG_TOPLEVEL_STATE_FULLSCREEN) window->fullscreen = true;
    }
}
static void close_toplevel(void *data, struct xdg_toplevel *toplevel)
{
    (void)toplevel;
    struct Window *window = data;
    window->client->reply.closed++;
}
static void configure_bounds(void *data, struct xdg_toplevel *toplevel, int32_t w, int32_t h)
{ (void)data; (void)toplevel; (void)w; (void)h; }
static void wm_capabilities(void *data, struct xdg_toplevel *toplevel, struct wl_array *caps)
{
    (void)toplevel;
    struct Window *window = data;
    uint32_t *cap;
    wl_array_for_each(cap, caps) {
        if (*cap == XDG_TOPLEVEL_WM_CAPABILITIES_MAXIMIZE) window->client->reply.max_capability = 1;
        if (*cap == XDG_TOPLEVEL_WM_CAPABILITIES_FULLSCREEN) window->client->reply.full_capability = 1;
    }
}
static const struct xdg_toplevel_listener toplevel_listener = {
    .configure = configure_toplevel, .close = close_toplevel,
    .configure_bounds = configure_bounds, .wm_capabilities = wm_capabilities,
};

static void popup_configure(void *data, struct xdg_popup *popup,
                            int32_t x, int32_t y, int32_t w, int32_t h)
{
    (void)popup;
    struct Window *window = data;
    window->width = w;
    window->height = h;
    window->client->reply.popups++;
    window->client->reply.popup_x = x;
    window->client->reply.popup_y = y;
    window->client->reply.popup_w = w;
    window->client->reply.popup_h = h;
}
static void popup_done(void *data, struct xdg_popup *popup)
{ (void)data; (void)popup; }
static void popup_repositioned(void *data, struct xdg_popup *popup, uint32_t token)
{
    (void)popup;
    ((struct Window *)data)->client->reply.repositioned = (int)token;
}
static const struct xdg_popup_listener popup_listener = {
    .configure = popup_configure, .popup_done = popup_done, .repositioned = popup_repositioned,
};

static void ping(void *data, struct xdg_wm_base *wm, uint32_t serial)
{ (void)data; xdg_wm_base_pong(wm, serial); }
static const struct xdg_wm_base_listener wm_listener = { .ping = ping };

static void keymap(void *data, struct wl_keyboard *keyboard, uint32_t format, int32_t fd, uint32_t size)
{ (void)data; (void)keyboard; (void)format; (void)size; close(fd); }
static void keyboard_enter(void *data, struct wl_keyboard *keyboard, uint32_t serial,
                           struct wl_surface *surface, struct wl_array *keys)
{
    (void)keyboard; (void)serial; (void)keys;
    struct Client *client = data;
    client->reply.focused = surface == client->window.surface ? client->reply.id : -1;
}
static void keyboard_leave(void *data, struct wl_keyboard *keyboard, uint32_t serial, struct wl_surface *surface)
{
    (void)keyboard; (void)serial; (void)surface;
    ((struct Client *)data)->reply.focused = 0;
}
static void keyboard_key(void *data, struct wl_keyboard *keyboard, uint32_t serial,
                         uint32_t time, uint32_t key, uint32_t state)
{
    (void)keyboard; (void)serial; (void)time; (void)key; (void)state;
    ((struct Client *)data)->reply.keys++;
}
static void keyboard_modifiers(void *data, struct wl_keyboard *keyboard,
    uint32_t serial, uint32_t depressed, uint32_t latched, uint32_t locked, uint32_t group)
{ (void)data; (void)keyboard; (void)serial; (void)depressed; (void)latched; (void)locked; (void)group; }
static void keyboard_repeat(void *data, struct wl_keyboard *keyboard, int32_t rate, int32_t delay)
{ (void)data; (void)keyboard; (void)rate; (void)delay; }
static const struct wl_keyboard_listener keyboard_listener = {
    .keymap = keymap, .enter = keyboard_enter, .leave = keyboard_leave,
    .key = keyboard_key, .modifiers = keyboard_modifiers, .repeat_info = keyboard_repeat,
};

static void pointer_enter(void *data, struct wl_pointer *pointer, uint32_t serial,
                          struct wl_surface *surface, wl_fixed_t x, wl_fixed_t y)
{ (void)data; (void)pointer; (void)serial; (void)surface; (void)x; (void)y; }
static void pointer_leave(void *data, struct wl_pointer *pointer, uint32_t serial, struct wl_surface *surface)
{ (void)data; (void)pointer; (void)serial; (void)surface; }
static void pointer_motion(void *data, struct wl_pointer *pointer, uint32_t time, wl_fixed_t x, wl_fixed_t y)
{ (void)data; (void)pointer; (void)time; (void)x; (void)y; }
static void pointer_button(void *data, struct wl_pointer *pointer, uint32_t serial,
                           uint32_t time, uint32_t button, uint32_t state)
{
    (void)pointer; (void)time; (void)button;
    struct Client *client = data;
    client->reply.buttons++;
    if (state == WL_POINTER_BUTTON_STATE_PRESSED) client->reply.serial = serial;
}
static void pointer_axis(void *data, struct wl_pointer *pointer, uint32_t time, uint32_t axis, wl_fixed_t value)
{ (void)data; (void)pointer; (void)time; (void)axis; (void)value; }
static const struct wl_pointer_listener pointer_listener = {
    .enter = pointer_enter, .leave = pointer_leave, .motion = pointer_motion,
    .button = pointer_button, .axis = pointer_axis,
};

static void capabilities(void *data, struct wl_seat *seat, uint32_t caps)
{
    struct Client *client = data;
    if ((caps & WL_SEAT_CAPABILITY_KEYBOARD) && !client->keyboard) {
        client->keyboard = wl_seat_get_keyboard(seat);
        wl_keyboard_add_listener(client->keyboard, &keyboard_listener, client);
    }
    if ((caps & WL_SEAT_CAPABILITY_POINTER) && !client->pointer) {
        client->pointer = wl_seat_get_pointer(seat);
        wl_pointer_add_listener(client->pointer, &pointer_listener, client);
    }
}
static const struct wl_seat_listener seat_listener = { .capabilities = capabilities };

static void output_geometry(void *data, struct wl_output *output, int32_t x, int32_t y,
    int32_t pw, int32_t ph, int32_t subpixel, const char *make, const char *model, int32_t transform)
{
    (void)data; (void)output; (void)x; (void)y; (void)pw; (void)ph;
    (void)subpixel; (void)make; (void)model; (void)transform;
}
static void output_mode(void *data, struct wl_output *output, uint32_t flags,
                        int32_t width, int32_t height, int32_t refresh)
{ (void)data; (void)output; (void)flags; (void)width; (void)height; (void)refresh; }
static const struct wl_output_listener output_listener = {
    .geometry = output_geometry, .mode = output_mode,
};

static void global(void *data, struct wl_registry *registry,
                   uint32_t name, const char *interface, uint32_t version)
{
    (void)version;
    struct Client *client = data;
    if (strcmp(interface, wl_compositor_interface.name) == 0)
        client->compositor = wl_registry_bind(registry, name, &wl_compositor_interface, 4);
    else if (strcmp(interface, wl_shm_interface.name) == 0)
        client->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
    else if (strcmp(interface, xdg_wm_base_interface.name) == 0) {
        client->wm = wl_registry_bind(registry, name, &xdg_wm_base_interface, 5);
        xdg_wm_base_add_listener(client->wm, &wm_listener, client);
    } else if (strcmp(interface, wl_seat_interface.name) == 0) {
        /* Version 1 keeps the fixture's input listener surface deliberately small. */
        client->seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
        wl_seat_add_listener(client->seat, &seat_listener, client);
    } else if (strcmp(interface, wl_output_interface.name) == 0) {
        for (size_t i = 0; i < 8; i++) {
            if (client->outputs[i].output) continue;
            client->outputs[i].name = name;
            client->outputs[i].output = wl_registry_bind(registry, name, &wl_output_interface, 1);
            wl_output_add_listener(client->outputs[i].output, &output_listener, client);
            client->reply.output_count++;
            break;
        }
    }
}
static void global_remove(void *data, struct wl_registry *registry, uint32_t name)
{
    (void)registry;
    struct Client *client = data;
    for (size_t i = 0; i < 8; i++) {
        if (client->outputs[i].name != name || !client->outputs[i].output) continue;
        wl_output_destroy(client->outputs[i].output);
        client->outputs[i].output = NULL;
        client->reply.output_count--;
    }
}
static const struct wl_registry_listener registry_listener = { .global = global, .global_remove = global_remove };

static void create_window(struct Client *client, int id, uint32_t state)
{
    struct Window *window = &client->window;
    client->reply.id = id;
    window->client = client;
    window->width = 240;
    window->height = 160;
    window->surface = wl_compositor_create_surface(client->compositor);
    window->xdg = xdg_wm_base_get_xdg_surface(client->wm, window->surface);
    xdg_surface_add_listener(window->xdg, &surface_listener, window);
    window->toplevel = xdg_surface_get_toplevel(window->xdg);
    xdg_toplevel_add_listener(window->toplevel, &toplevel_listener, window);
    char name[64];
    snprintf(name, sizeof(name), "org.pollywm.test.%d", id);
    xdg_toplevel_set_app_id(window->toplevel, name);
    xdg_toplevel_set_title(window->toplevel, name);
    xdg_toplevel_set_min_size(window->toplevel, 120, 80);
    xdg_toplevel_set_max_size(window->toplevel, 600, 400);
    if (state & 1) xdg_toplevel_set_maximized(window->toplevel);
    if (state & 2) xdg_toplevel_set_fullscreen(window->toplevel, NULL);
    wl_surface_commit(window->surface);
}

static struct xdg_positioner *popup_position(struct Client *client, struct Window *parent, int corner)
{
    struct xdg_positioner *position = xdg_wm_base_create_positioner(client->wm);
    xdg_positioner_set_size(position, 80, 40);
    xdg_positioner_set_anchor_rect(position, corner ? parent->width - 4 : 0,
                                   corner ? parent->height - 4 : 0, 4, 4);
    xdg_positioner_set_anchor(position, corner ? XDG_POSITIONER_ANCHOR_BOTTOM_RIGHT :
                                                XDG_POSITIONER_ANCHOR_TOP_LEFT);
    xdg_positioner_set_gravity(position, corner ? XDG_POSITIONER_GRAVITY_BOTTOM_RIGHT :
                                                 XDG_POSITIONER_GRAVITY_TOP_LEFT);
    xdg_positioner_set_constraint_adjustment(position,
        XDG_POSITIONER_CONSTRAINT_ADJUSTMENT_SLIDE_X | XDG_POSITIONER_CONSTRAINT_ADJUSTMENT_SLIDE_Y |
        XDG_POSITIONER_CONSTRAINT_ADJUSTMENT_RESIZE_X | XDG_POSITIONER_CONSTRAINT_ADJUSTMENT_RESIZE_Y);
    if (corner != 2) xdg_positioner_set_reactive(position);
    return position;
}

static void create_popup(struct Client *client, bool child, int corner)
{
    struct Window *popup = child ? &client->child : &client->popup;
    struct Window *parent = child ? &client->popup : &client->window;
    popup->client = client;
    popup->surface = wl_compositor_create_surface(client->compositor);
    popup->xdg = xdg_wm_base_get_xdg_surface(client->wm, popup->surface);
    xdg_surface_add_listener(popup->xdg, &surface_listener, popup);
    struct xdg_positioner *position = popup_position(client, parent, corner);
    popup->popup = xdg_surface_get_popup(popup->xdg, parent->xdg, position);
    xdg_popup_add_listener(popup->popup, &popup_listener, popup);
    xdg_positioner_destroy(position);
    wl_surface_commit(popup->surface);
}

static void destroy_window(struct Window *window)
{
    if (window->frame) wl_callback_destroy(window->frame);
    if (window->popup) xdg_popup_destroy(window->popup);
    if (window->toplevel) xdg_toplevel_destroy(window->toplevel);
    if (window->xdg) xdg_surface_destroy(window->xdg);
    if (window->surface) wl_surface_destroy(window->surface);
    memset(window, 0, sizeof(*window));
}

int main(int argc, char **argv)
{
    if (argc != 3) return 2;
    int control = atoi(argv[2]);
    struct Client client = {0};
    wl_list_init(&client.buffers);
    client.display = wl_display_connect(argv[1]);
    if (!client.display) die("connect");
    struct wl_registry *registry = wl_display_get_registry(client.display);
    wl_registry_add_listener(registry, &registry_listener, &client);
    if (wl_display_roundtrip(client.display) < 0 ||
        !client.compositor || !client.shm || !client.wm || !client.seat) die("registry");
    bool running = true;
    while (running) {
        if (wl_display_dispatch_pending(client.display) < 0 ||
            wl_display_flush(client.display) < 0) die("dispatch/flush");
        struct pollfd fds[] = {
            { .fd = control, .events = POLLIN },
            { .fd = wl_display_get_fd(client.display), .events = POLLIN },
        };
        if (poll(fds, 2, -1) < 0) { if (errno == EINTR) continue; die("poll"); }
        if (fds[1].revents & POLLIN)
            if (wl_display_dispatch(client.display) < 0) die("display disconnected");
        if (fds[0].revents & (POLLHUP | POLLERR)) break;
        if (!(fds[0].revents & POLLIN)) continue;
        struct TestRequest request;
        if (recv(control, &request, sizeof(request), 0) != sizeof(request)) die("control read");
        struct Window *window = &client.window;
        switch (request.command) {
        case TEST_QUERY: break;
        case TEST_MAP: create_window(&client, request.id, request.edges); break;
        case TEST_UNMAP:
            wl_surface_attach(window->surface, NULL, 0, 0);
            wl_surface_commit(window->surface);
            break;
        case TEST_REMAP: {
            char name[64];
            snprintf(name, sizeof(name), "org.pollywm.test.%d", client.reply.id);
            xdg_toplevel_set_app_id(window->toplevel, name);
            xdg_toplevel_set_title(window->toplevel, name);
            xdg_toplevel_set_min_size(window->toplevel, 120, 80);
            xdg_toplevel_set_max_size(window->toplevel, 600, 400);
            wl_surface_commit(window->surface);
            break;
        }
        case TEST_DESTROY:
            destroy_window(&client.child);
            destroy_window(&client.popup);
            destroy_window(window);
            break;
        case TEST_MOVE:
            xdg_toplevel_move(window->toplevel, client.seat, request.serial);
            break;
        case TEST_RESIZE:
            xdg_toplevel_resize(window->toplevel, client.seat, request.serial, request.edges);
            break;
        case TEST_MAXIMIZE: xdg_toplevel_set_maximized(window->toplevel); break;
        case TEST_UNMAXIMIZE: xdg_toplevel_unset_maximized(window->toplevel); break;
        case TEST_FULLSCREEN:
            xdg_toplevel_set_fullscreen(window->toplevel,
                request.id > 0 && request.id <= 8 ? client.outputs[request.id - 1].output : NULL);
            break;
        case TEST_UNFULLSCREEN: xdg_toplevel_unset_fullscreen(window->toplevel); break;
        case TEST_SMALL_FULLSCREEN: window->small_fullscreen = request.id != 0; break;
        case TEST_HOLD: window->hold = true; break;
        case TEST_APPLY_FIRST:
            if (!window->pending_count) die("no pending configure");
            apply_configure(window, window->pending[0]);
            window->pending_count--;
            memmove(window->pending, window->pending + 1,
                    window->pending_count * sizeof(window->pending[0]));
            break;
        case TEST_RELEASE:
            if (window->pending_count)
                apply_configure(window, window->pending[window->pending_count - 1]);
            window->pending_count = 0;
            window->hold = false;
            break;
        case TEST_POPUP: create_popup(&client, false, request.id); break;
        case TEST_CHILD_POPUP: create_popup(&client, true, request.id); break;
        case TEST_REPOSITION_POPUP: {
            struct xdg_positioner *position = popup_position(&client, window, request.id);
            xdg_popup_reposition(client.popup.popup, position, request.serial);
            xdg_positioner_destroy(position);
            break;
        }
        case TEST_DESTROY_POPUP:
            destroy_window(&client.child);
            destroy_window(&client.popup);
            break;
        case TEST_DESTROY_ROLE:
            xdg_toplevel_destroy(window->toplevel);
            window->toplevel = NULL;
            break;
        case TEST_QUIT: running = false; break;
        }
        /* A second roundtrip includes the buffer commit made by configure callbacks. */
        if (wl_display_roundtrip(client.display) < 0 ||
            wl_display_roundtrip(client.display) < 0) die("command roundtrip");
        client.reply.pending = (int)window->pending_count;
        if (send(control, &client.reply, sizeof(client.reply), MSG_NOSIGNAL) != sizeof(client.reply))
            die("control reply");
    }
    destroy_window(&client.child);
    destroy_window(&client.popup);
    destroy_window(&client.window);
    if (client.pointer) wl_pointer_destroy(client.pointer);
    if (client.keyboard) wl_keyboard_destroy(client.keyboard);
    if (client.seat) wl_seat_destroy(client.seat);
    xdg_wm_base_destroy(client.wm);
    wl_shm_destroy(client.shm);
    wl_compositor_destroy(client.compositor);
    for (size_t i = 0; i < 8; i++)
        if (client.outputs[i].output) wl_output_destroy(client.outputs[i].output);
    wl_registry_destroy(registry);
    struct Buffer *buffer, *tmp;
    wl_list_for_each_safe(buffer, tmp, &client.buffers, link)
        buffer_release(buffer, buffer->buffer);
    wl_display_flush(client.display);
    wl_display_disconnect(client.display);
    close(control);
    return 0;
}
