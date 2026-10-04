#include "wire.h"
#include "xdg-shell-client-protocol.h"
#include "layer-shell-client-protocol.h"
#include "foreign-toplevel-client.h"
#include "xdg-decoration-client.h"
#include "polly-appearance-client.h"
#include "decoration-themes.h"
#include "ext-workspace-client.h"
#include "polly-workspace-toplevel-client.h"
#include "text-input-v3-client.h"
#include "input-method-v2-client.h"
#include "virtual-keyboard-v1-client.h"

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
    struct zxdg_toplevel_decoration_v1 *decoration;
    struct xdg_popup *popup;
    struct zwlr_layer_surface_v1 *layer;
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

struct Foreign {
    struct Client *client;
    struct zwlr_foreign_toplevel_handle_v1 *handle;
    char app_id[128], title[128];
    uint32_t state;
    int outputs, done;
    struct polly_workspace_toplevel_v1 *workspace_handle;
    struct Workspace *workspace;
};
struct Workspace {
    struct Client *client;
    struct ext_workspace_handle_v1 *handle;
    uint32_t order, state;
};

struct Client {
    struct wl_display *display;
    struct wl_compositor *compositor;
    struct wl_shm *shm;
    struct xdg_wm_base *wm;
    struct zwlr_layer_shell_v1 *layer_shell;
    struct zwlr_foreign_toplevel_manager_v1 *foreign_manager;
    struct zxdg_decoration_manager_v1 *decoration_manager;
    struct polly_appearance_v1 *appearance;
    struct Foreign foreign[16];
    struct ext_workspace_manager_v1 *workspaces;
    struct ext_workspace_group_handle_v1 *workspace_group;
    struct polly_workspace_toplevel_manager_v1 *workspace_toplevels;
    struct Workspace workspace[32];
    struct wl_seat *seat;
    struct wl_keyboard *keyboard;
    struct wl_pointer *pointer;
    struct wl_subcompositor *subcompositor;
    struct wl_data_device_manager *data_manager;
    struct wl_data_device *data_device;
    struct wl_data_source *data_source;
    struct wl_data_offer *offers[32];
    size_t offer_count;
    struct wl_surface *drag_icon, *drag_child;
    struct wl_subsurface *drag_subsurface;
    struct zwp_text_input_manager_v3 *text_manager;
    struct zwp_text_input_v3 *text_input;
    struct zwp_input_method_manager_v2 *ime_manager;
    struct zwp_input_method_v2 *ime;
    struct zwp_input_method_keyboard_grab_v2 *ime_grab;
    struct zwp_virtual_keyboard_manager_v1 *virtual_manager;
    struct zwp_virtual_keyboard_v1 *virtual_keyboard;
    struct zwp_input_popup_surface_v2 *ime_popup;
    struct wl_surface *ime_surface;
    struct wl_list buffers;
    struct Window window, popup, child, extra;
    struct { uint32_t name; struct wl_output *output; } outputs[8];
    struct TestReply reply;
};

static void track_foreign(struct Foreign *foreign);

static void text_enter(void *data, struct zwp_text_input_v3 *input, struct wl_surface *surface)
{ (void)input; (void)surface; ((struct Client *)data)->reply.text_enter++; }
static void text_leave(void *data, struct zwp_text_input_v3 *input, struct wl_surface *surface)
{ (void)input; (void)surface; ((struct Client *)data)->reply.text_leave++; }
static void text_preedit(void *data, struct zwp_text_input_v3 *input, const char *text, int32_t begin, int32_t end)
{ (void)input; (void)begin; (void)end; snprintf(((struct Client *)data)->reply.text_preedit, 128, "%s", text ? text : ""); }
static void text_commit(void *data, struct zwp_text_input_v3 *input, const char *text)
{ (void)input; snprintf(((struct Client *)data)->reply.text_commit, 128, "%s", text ? text : ""); }
static void text_delete(void *data, struct zwp_text_input_v3 *input, uint32_t before, uint32_t after)
{ (void)data; (void)input; (void)before; (void)after; }
static void text_done(void *data, struct zwp_text_input_v3 *input, uint32_t serial)
{ (void)input; (void)serial; ((struct Client *)data)->reply.text_done++; }
static const struct zwp_text_input_v3_listener text_listener = {
    .enter = text_enter, .leave = text_leave, .preedit_string = text_preedit,
    .commit_string = text_commit, .delete_surrounding_text = text_delete, .done = text_done,
};
static void ime_activate(void *data, struct zwp_input_method_v2 *ime)
{ (void)ime; ((struct Client *)data)->reply.ime_active = 1; }
static void ime_deactivate(void *data, struct zwp_input_method_v2 *ime)
{ (void)ime; ((struct Client *)data)->reply.ime_active = 0; }
static void ime_surrounding(void *data, struct zwp_input_method_v2 *ime, const char *text, uint32_t cursor, uint32_t anchor)
{ (void)data; (void)ime; (void)text; (void)cursor; (void)anchor; }
static void ime_cause(void *data, struct zwp_input_method_v2 *ime, uint32_t cause)
{ (void)data; (void)ime; (void)cause; }
static void ime_content(void *data, struct zwp_input_method_v2 *ime, uint32_t hint, uint32_t purpose)
{ (void)data; (void)ime; (void)hint; (void)purpose; }
static void ime_done(void *data, struct zwp_input_method_v2 *ime)
{ (void)ime; ((struct Client *)data)->reply.ime_serial++; }
static void ime_unavailable(void *data, struct zwp_input_method_v2 *ime)
{ (void)ime; ((struct Client *)data)->reply.ime_active = -1; }
static const struct zwp_input_method_v2_listener ime_listener = {
    .activate = ime_activate, .deactivate = ime_deactivate, .surrounding_text = ime_surrounding,
    .text_change_cause = ime_cause, .content_type = ime_content, .done = ime_done, .unavailable = ime_unavailable,
};
static void ime_keymap(void *data, struct zwp_input_method_keyboard_grab_v2 *grab, uint32_t format, int32_t fd, uint32_t size)
{
    (void)grab;
    struct Client *client = data;
    zwp_virtual_keyboard_v1_keymap(client->virtual_keyboard, format, fd, size);
    close(fd);
}
static void ime_key(void *data, struct zwp_input_method_keyboard_grab_v2 *grab, uint32_t serial,
    uint32_t time, uint32_t key, uint32_t state)
{ (void)grab; (void)serial; (void)time; (void)key; (void)state; ((struct Client *)data)->reply.ime_keys++; }
static void ime_modifiers(void *data, struct zwp_input_method_keyboard_grab_v2 *grab, uint32_t serial,
    uint32_t depressed, uint32_t latched, uint32_t locked, uint32_t group)
{ (void)data; (void)grab; (void)serial; (void)depressed; (void)latched; (void)locked; (void)group; }
static void ime_repeat(void *data, struct zwp_input_method_keyboard_grab_v2 *grab, int32_t rate, int32_t delay)
{ (void)data; (void)grab; (void)rate; (void)delay; }
static const struct zwp_input_method_keyboard_grab_v2_listener ime_grab_listener = {
    .keymap = ime_keymap, .key = ime_key, .modifiers = ime_modifiers, .repeat_info = ime_repeat,
};
static void ime_rectangle(void *data, struct zwp_input_popup_surface_v2 *popup, int32_t x, int32_t y,
    int32_t width, int32_t height)
{ (void)popup; (void)width; (void)height; struct Client *client = data; client->reply.ime_rect_x = x; client->reply.ime_rect_y = y; }
static const struct zwp_input_popup_surface_v2_listener ime_popup_listener = { .text_input_rectangle = ime_rectangle };

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

static void source_target(void *data, struct wl_data_source *source, const char *mime)
{ (void)data; (void)source; (void)mime; }
static void source_send(void *data, struct wl_data_source *source, const char *mime, int32_t fd)
{ (void)data; (void)source; (void)mime; close(fd); }
static void source_cancelled(void *data, struct wl_data_source *source)
{ (void)source; ((struct Client *)data)->reply.drag_cancelled++; }
static const struct wl_data_source_listener source_listener = {
    .target = source_target, .send = source_send, .cancelled = source_cancelled,
};
static void offer_mime(void *data, struct wl_data_offer *offer, const char *mime)
{ (void)data; (void)offer; (void)mime; }
static const struct wl_data_offer_listener offer_listener = { .offer = offer_mime };
static void device_offer(void *data, struct wl_data_device *device, struct wl_data_offer *offer)
{
    (void)device;
    struct Client *client = data;
    if (client->offer_count == 32) die("too many drag offers");
    client->offers[client->offer_count++] = offer;
    wl_data_offer_add_listener(offer, &offer_listener, NULL);
}
static void device_enter(void *data, struct wl_data_device *device, uint32_t serial,
    struct wl_surface *surface, wl_fixed_t x, wl_fixed_t y, struct wl_data_offer *offer)
{ (void)data; (void)device; (void)serial; (void)surface; (void)x; (void)y; (void)offer; }
static void device_leave(void *data, struct wl_data_device *device) { (void)data; (void)device; }
static void device_motion(void *data, struct wl_data_device *device, uint32_t time, wl_fixed_t x, wl_fixed_t y)
{ (void)data; (void)device; (void)time; (void)x; (void)y; }
static void device_selection(void *data, struct wl_data_device *device, struct wl_data_offer *offer)
{ (void)data; (void)device; (void)offer; }
static const struct wl_data_device_listener device_listener = {
    .data_offer = device_offer, .enter = device_enter, .leave = device_leave,
    .motion = device_motion, .drop = device_leave, .selection = device_selection,
};

static void destroy_drag_icon(struct Client *client)
{
    if (client->drag_subsurface) wl_subsurface_destroy(client->drag_subsurface);
    if (client->drag_child) wl_surface_destroy(client->drag_child);
    if (client->drag_icon) wl_surface_destroy(client->drag_icon);
    client->drag_subsurface = NULL; client->drag_child = client->drag_icon = NULL;
}

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
    if (window->layer) zwlr_layer_surface_v1_ack_configure(window->layer, config.serial);
    else xdg_surface_ack_configure(window->xdg, config.serial);
    int width = config.width, height = config.height;
    if (window->small_fullscreen && config.fullscreen) { width = 240; height = 160; }
    if (window == &window->client->window) {
        window->client->reply.maximized = config.maximized;
        window->client->reply.fullscreen = config.fullscreen;
        window->client->reply.width = width;
        window->client->reply.height = height;
    }
    /* Nonzero geometry offsets exercise the distinction from the buffer origin. */
    if (!window->layer) {
        xdg_surface_set_window_geometry(window->xdg, 8, 12, width, height);
        width += 16;
        height += 24;
    }
    struct wl_buffer *buffer = make_buffer(window->client, width, height);
    wl_surface_attach(window->surface, buffer, 0, 0);
    wl_surface_damage_buffer(window->surface, 0, 0, width, height);
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

static void configure_layer(void *data, struct zwlr_layer_surface_v1 *layer,
                            uint32_t serial, uint32_t width, uint32_t height)
{
    (void)layer;
    struct Window *window = data;
    if (!width || !height || width > 4096 || height > 4096) die("invalid layer dimensions");
    window->width = (int)width;
    window->height = (int)height;
    window->client->reply.configured++;
    struct Configure config = { .width = (int)width, .height = (int)height, .serial = serial };
    if (window->hold) {
        if (window->pending_count == 32) die("too many pending layer configures");
        window->pending[window->pending_count++] = config;
    } else {
        apply_configure(window, config);
    }
}

static void close_layer(void *data, struct zwlr_layer_surface_v1 *layer)
{
    (void)layer;
    ((struct Window *)data)->client->reply.closed++;
}

static const struct zwlr_layer_surface_v1_listener layer_listener = {
    .configure = configure_layer, .closed = close_layer,
};

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
        if (*cap == XDG_TOPLEVEL_WM_CAPABILITIES_MINIMIZE) window->client->reply.minimize_capability = 1;
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

static void foreign_title(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle, const char *value)
{ (void)handle; snprintf(((struct Foreign *)data)->title, 128, "%s", value); }
static void foreign_app_id(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle, const char *value)
{ (void)handle; snprintf(((struct Foreign *)data)->app_id, 128, "%s", value); }
static void foreign_enter(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle, struct wl_output *output)
{ (void)handle; (void)output; ((struct Foreign *)data)->outputs++; }
static void foreign_leave(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle, struct wl_output *output)
{ (void)handle; (void)output; ((struct Foreign *)data)->outputs--; }
static void foreign_state(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle, struct wl_array *states)
{
    (void)handle;
    struct Foreign *item = data;
    item->state = 0;
    uint32_t *state;
    wl_array_for_each(state, states) if (*state < 4) item->state |= 1u << *state;
}
static void foreign_done(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle)
{ (void)handle; ((struct Foreign *)data)->done++; }
static void foreign_closed(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle)
{
    struct Foreign *item = data;
    if (item->workspace_handle) polly_workspace_toplevel_v1_destroy(item->workspace_handle);
    item->workspace_handle = NULL; item->workspace = NULL;
    zwlr_foreign_toplevel_handle_v1_destroy(handle);
    item->handle = NULL;
    item->client->reply.foreign_count--;
}
static void foreign_parent(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle,
                           struct zwlr_foreign_toplevel_handle_v1 *parent)
{ (void)data; (void)handle; (void)parent; }
static const struct zwlr_foreign_toplevel_handle_v1_listener foreign_listener = {
    .title = foreign_title, .app_id = foreign_app_id, .output_enter = foreign_enter,
    .output_leave = foreign_leave, .state = foreign_state, .done = foreign_done,
    .closed = foreign_closed, .parent = foreign_parent,
};
static void foreign_toplevel(void *data, struct zwlr_foreign_toplevel_manager_v1 *manager,
                             struct zwlr_foreign_toplevel_handle_v1 *handle)
{
    (void)manager;
    struct Client *client = data;
    for (size_t i = 0; i < 16; i++) {
        if (client->foreign[i].handle) continue;
        client->foreign[i] = (struct Foreign){ .client = client, .handle = handle };
        zwlr_foreign_toplevel_handle_v1_add_listener(handle, &foreign_listener, &client->foreign[i]);
        track_foreign(&client->foreign[i]);
        client->reply.foreign_count++;
        return;
    }
    die("too many foreign toplevels");
}
static void foreign_finished(void *data, struct zwlr_foreign_toplevel_manager_v1 *manager)
{ (void)data; (void)manager; }
static const struct zwlr_foreign_toplevel_manager_v1_listener foreign_manager_listener = {
    .toplevel = foreign_toplevel, .finished = foreign_finished,
};

static struct Foreign *find_foreign(struct Client *client, int id)
{
    char name[64];
    snprintf(name, sizeof(name), "org.pollywm.test.%d", id);
    for (size_t i = 0; i < 16; i++)
        if (client->foreign[i].handle && !strcmp(client->foreign[i].app_id, name)) return &client->foreign[i];
    die("foreign toplevel not found");
    return NULL;
}

static void membership(void *data, struct polly_workspace_toplevel_v1 *handle, struct ext_workspace_handle_v1 *workspace)
{
    (void)handle;
    ((struct Foreign *)data)->workspace = workspace ? ext_workspace_handle_v1_get_user_data(workspace) : NULL;
}
static void membership_closed(void *data, struct polly_workspace_toplevel_v1 *handle)
{
    struct Foreign *foreign = data;
    polly_workspace_toplevel_v1_destroy(handle);
    foreign->workspace_handle = NULL; foreign->workspace = NULL;
}
static const struct polly_workspace_toplevel_v1_listener membership_listener = {
    .workspace = membership, .closed = membership_closed,
};
static void track_foreign(struct Foreign *foreign)
{
    struct Client *client = foreign->client;
    if (!foreign->handle || foreign->workspace_handle || !client->workspaces || !client->workspace_toplevels) return;
    foreign->workspace_handle = polly_workspace_toplevel_manager_v1_get_toplevel(
        client->workspace_toplevels, foreign->handle, client->workspaces);
    polly_workspace_toplevel_v1_add_listener(foreign->workspace_handle, &membership_listener, foreign);
}
static void workspace_id(void *data, struct ext_workspace_handle_v1 *handle, const char *id)
{ (void)data; (void)handle; (void)id; }
static void workspace_coordinates(void *data, struct ext_workspace_handle_v1 *handle, struct wl_array *coordinates)
{
    (void)handle;
    if (coordinates->size != sizeof(uint32_t)) die("workspace coordinates");
    memcpy(&((struct Workspace *)data)->order, coordinates->data, sizeof(uint32_t));
}
static void workspace_state(void *data, struct ext_workspace_handle_v1 *handle, uint32_t state)
{ (void)handle; ((struct Workspace *)data)->state = state; }
static void workspace_caps(void *data, struct ext_workspace_handle_v1 *handle, uint32_t capabilities)
{ (void)data; (void)handle; (void)capabilities; }
static void workspace_removed(void *data, struct ext_workspace_handle_v1 *handle)
{
    struct Workspace *workspace = data;
    for (size_t i = 0; i < 16; i++)
        if (workspace->client->foreign[i].workspace == workspace) workspace->client->foreign[i].workspace = NULL;
    ext_workspace_handle_v1_destroy(handle);
    workspace->handle = NULL;
    workspace->client->reply.workspace_count--;
}
static const struct ext_workspace_handle_v1_listener workspace_listener = {
    .id = workspace_id, .name = workspace_id, .coordinates = workspace_coordinates,
    .state = workspace_state, .capabilities = workspace_caps, .removed = workspace_removed,
};
static void workspace_new(void *data, struct ext_workspace_manager_v1 *manager, struct ext_workspace_handle_v1 *handle)
{
    (void)manager;
    struct Client *client = data;
    for (size_t i = 0; i < 32; i++) {
        if (client->workspace[i].handle) continue;
        client->workspace[i] = (struct Workspace){ .client = client, .handle = handle };
        ext_workspace_handle_v1_add_listener(handle, &workspace_listener, &client->workspace[i]);
        client->reply.workspace_count++;
        return;
    }
    die("too many workspaces");
}
static void group_caps(void *data, struct ext_workspace_group_handle_v1 *group, uint32_t capabilities)
{ (void)data; (void)group; (void)capabilities; }
static void group_output(void *data, struct ext_workspace_group_handle_v1 *group, struct wl_output *output)
{ (void)data; (void)group; (void)output; }
static void group_workspace(void *data, struct ext_workspace_group_handle_v1 *group, struct ext_workspace_handle_v1 *workspace)
{ (void)data; (void)group; (void)workspace; }
static void group_removed(void *data, struct ext_workspace_group_handle_v1 *group)
{ (void)data; (void)group; die("workspace group removed"); }
static const struct ext_workspace_group_handle_v1_listener group_listener = {
    .capabilities = group_caps, .output_enter = group_output, .output_leave = group_output,
    .workspace_enter = group_workspace, .workspace_leave = group_workspace, .removed = group_removed,
};
static void group_new(void *data, struct ext_workspace_manager_v1 *manager, struct ext_workspace_group_handle_v1 *group)
{
    (void)manager;
    struct Client *client = data;
    if (client->workspace_group) die("more than one workspace group");
    client->workspace_group = group;
    ext_workspace_group_handle_v1_add_listener(group, &group_listener, client);
}
static void workspaces_done(void *data, struct ext_workspace_manager_v1 *manager)
{
    (void)manager;
    struct Client *client = data;
    client->reply.workspace_active = -1;
    for (size_t i = 0; i < 32; i++)
        if (client->workspace[i].handle && (client->workspace[i].state & EXT_WORKSPACE_HANDLE_V1_STATE_ACTIVE))
            client->reply.workspace_active = (int)client->workspace[i].order;
    client->reply.workspace_done++;
}
static void workspaces_finished(void *data, struct ext_workspace_manager_v1 *manager)
{ (void)data; (void)manager; }
static const struct ext_workspace_manager_v1_listener workspaces_listener = {
    .workspace_group = group_new, .workspace = workspace_new, .done = workspaces_done, .finished = workspaces_finished,
};
static struct Workspace *find_workspace(struct Client *client, uint32_t order)
{
    for (size_t i = 0; i < 32; i++)
        if (client->workspace[i].handle && client->workspace[i].order == order) return &client->workspace[i];
    die("workspace not found");
    return NULL;
}

static void global(void *data, struct wl_registry *registry,
                   uint32_t name, const char *interface, uint32_t version)
{
    (void)version;
    struct Client *client = data;
    if (strcmp(interface, wl_compositor_interface.name) == 0)
        client->compositor = wl_registry_bind(registry, name, &wl_compositor_interface, 4);
    else if (!strcmp(interface, zwp_text_input_manager_v3_interface.name))
        client->text_manager = wl_registry_bind(registry, name, &zwp_text_input_manager_v3_interface, 1);
    else if (!strcmp(interface, zwp_input_method_manager_v2_interface.name)) {
        client->ime_manager = wl_registry_bind(registry, name, &zwp_input_method_manager_v2_interface, 1);
        client->reply.ime_global = name;
    } else if (!strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name)) {
        client->virtual_manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
        client->reply.virtual_global = name;
    }
    else if (strcmp(interface, wl_subcompositor_interface.name) == 0)
        client->subcompositor = wl_registry_bind(registry, name, &wl_subcompositor_interface, 1);
    else if (strcmp(interface, wl_data_device_manager_interface.name) == 0)
        client->data_manager = wl_registry_bind(registry, name, &wl_data_device_manager_interface, 1);
    else if (strcmp(interface, wl_shm_interface.name) == 0)
        client->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
    else if (strcmp(interface, zxdg_decoration_manager_v1_interface.name) == 0)
        client->decoration_manager = wl_registry_bind(registry, name, &zxdg_decoration_manager_v1_interface, 1);
    else if (strcmp(interface, polly_appearance_v1_interface.name) == 0) {
        client->appearance = wl_registry_bind(registry, name, &polly_appearance_v1_interface, 1);
        client->reply.appearance_capability = 1;
    } else if (strcmp(interface, ext_workspace_manager_v1_interface.name) == 0) {
        client->workspaces = wl_registry_bind(registry, name, &ext_workspace_manager_v1_interface, 1);
        ext_workspace_manager_v1_add_listener(client->workspaces, &workspaces_listener, client);
        client->reply.workspace_capability = 1;
    } else if (strcmp(interface, polly_workspace_toplevel_manager_v1_interface.name) == 0) {
        client->workspace_toplevels = wl_registry_bind(registry, name, &polly_workspace_toplevel_manager_v1_interface, 1);
    }
    else if (strcmp(interface, zwlr_layer_shell_v1_interface.name) == 0) {
        client->layer_shell = wl_registry_bind(registry, name, &zwlr_layer_shell_v1_interface, 4);
        client->reply.layer_capability = 1;
    }
    else if (strcmp(interface, zwlr_foreign_toplevel_manager_v1_interface.name) == 0) {
        client->foreign_manager = wl_registry_bind(registry, name, &zwlr_foreign_toplevel_manager_v1_interface, 3);
        zwlr_foreign_toplevel_manager_v1_add_listener(client->foreign_manager, &foreign_manager_listener, client);
        client->reply.foreign_capability = 1;
    }
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

static void decoration_configure(void *data, struct zxdg_toplevel_decoration_v1 *decoration, uint32_t mode)
{
    (void)decoration;
    ((struct Window *)data)->client->reply.decoration_mode = (int)mode;
}
static const struct zxdg_toplevel_decoration_v1_listener decoration_listener = { .configure = decoration_configure };

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
    if (state & 8) {
        if (!client->decoration_manager) die("no decoration manager");
        window->decoration = zxdg_decoration_manager_v1_get_toplevel_decoration(client->decoration_manager,
                                                                              window->toplevel);
        zxdg_toplevel_decoration_v1_add_listener(window->decoration, &decoration_listener, window);
        if (state & 16) zxdg_toplevel_decoration_v1_set_mode(window->decoration,
            ZXDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE);
    }
    char name[64];
    snprintf(name, sizeof(name), "org.pollywm.test.%d", id);
    xdg_toplevel_set_app_id(window->toplevel, name);
    xdg_toplevel_set_title(window->toplevel, name);
    xdg_toplevel_set_min_size(window->toplevel, 120, 80);
    xdg_toplevel_set_max_size(window->toplevel, 600, 400);
    if (state & 1) xdg_toplevel_set_maximized(window->toplevel);
    if (state & 2) xdg_toplevel_set_fullscreen(window->toplevel, NULL);
    if (state & 4) xdg_toplevel_set_minimized(window->toplevel);
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
    if (parent->layer) zwlr_layer_surface_v1_get_popup(parent->layer, popup->popup);
    xdg_popup_add_listener(popup->popup, &popup_listener, popup);
    xdg_positioner_destroy(position);
    wl_surface_commit(popup->surface);
}

static void destroy_window(struct Window *window)
{
    if (window->frame) wl_callback_destroy(window->frame);
    if (window->popup) xdg_popup_destroy(window->popup);
    if (window->decoration) zxdg_toplevel_decoration_v1_destroy(window->decoration);
    if (window->toplevel) xdg_toplevel_destroy(window->toplevel);
    if (window->layer) zwlr_layer_surface_v1_destroy(window->layer);
    if (window->xdg) xdg_surface_destroy(window->xdg);
    if (window->surface) wl_surface_destroy(window->surface);
    memset(window, 0, sizeof(*window));
}

static void create_transient(struct Client *client, bool parented)
{
    struct Window *window = &client->extra;
    window->client = client; window->width = 160; window->height = 100;
    window->surface = wl_compositor_create_surface(client->compositor);
    window->xdg = xdg_wm_base_get_xdg_surface(client->wm, window->surface);
    xdg_surface_add_listener(window->xdg, &surface_listener, window);
    window->toplevel = xdg_surface_get_toplevel(window->xdg);
    xdg_toplevel_add_listener(window->toplevel, &toplevel_listener, window);
    xdg_toplevel_set_app_id(window->toplevel, "org.pollywm.test.8");
    if (parented) xdg_toplevel_set_parent(window->toplevel, client->window.toplevel);
    wl_surface_commit(window->surface);
}

static void layer_state(struct Window *window, const struct TestLayer *state)
{
    zwlr_layer_surface_v1_set_layer(window->layer, state->layer);
    zwlr_layer_surface_v1_set_size(window->layer, state->width, state->height);
    zwlr_layer_surface_v1_set_anchor(window->layer, state->anchor);
    zwlr_layer_surface_v1_set_margin(window->layer, state->top, state->right, state->bottom, state->left);
    zwlr_layer_surface_v1_set_exclusive_zone(window->layer, state->zone);
    zwlr_layer_surface_v1_set_keyboard_interactivity(window->layer, state->keyboard);
    wl_surface_commit(window->surface);
}

static void create_layer(struct Client *client, int id, const struct TestLayer *state)
{
    struct Window *window = id == 4 ? &client->extra : &client->window;
    if (!client->layer_shell || window->surface) die("layer creation state");
    window->client = client;
    if (id != 4) client->reply.id = id;
    window->surface = wl_compositor_create_surface(client->compositor);
    char name[64];
    snprintf(name, sizeof(name), "org.pollywm.layer.%d", id);
    struct wl_output *output = state->output > 0 && state->output <= 8 ?
        client->outputs[state->output - 1].output : NULL;
    window->layer = zwlr_layer_shell_v1_get_layer_surface(
        client->layer_shell, window->surface, output, state->layer, name);
    zwlr_layer_surface_v1_add_listener(window->layer, &layer_listener, window);
    layer_state(window, state);
}

int main(int argc, char **argv)
{
    if (argc != 3) return 2;
    int control = atoi(argv[2]);
    struct Client client = {0};
    wl_list_init(&client.buffers);
    client.display = wl_display_connect(strcmp(argv[1], "--trusted") == 0 ? NULL : argv[1]);
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
        struct Foreign *foreign = (request.command >= TEST_FOREIGN_QUERY && request.command <= TEST_FOREIGN_CLOSE) ||
            request.command == TEST_WORKSPACE_MOVE ?
            find_foreign(&client, request.id) : NULL;
        switch (request.command) {
        case TEST_TEXT_ENABLE:
            if (!client.text_input) {
                client.text_input = zwp_text_input_manager_v3_get_text_input(client.text_manager, client.seat);
                zwp_text_input_v3_add_listener(client.text_input, &text_listener, &client);
                if (wl_display_roundtrip(client.display) < 0) die("text input enter");
            }
            zwp_text_input_v3_enable(client.text_input);
            zwp_text_input_v3_set_surrounding_text(client.text_input, "prefix", 3, 3);
            zwp_text_input_v3_set_content_type(client.text_input, request.edges, (uint32_t)request.id);
            zwp_text_input_v3_set_cursor_rectangle(client.text_input, 20, 30, 1, 16);
            zwp_text_input_v3_commit(client.text_input);
            break;
        case TEST_TEXT_DISABLE:
            zwp_text_input_v3_disable(client.text_input);
            zwp_text_input_v3_commit(client.text_input);
            break;
        case TEST_IME_CREATE:
            if (!client.ime_manager || !client.virtual_manager) die("input method is not authorized");
            client.virtual_keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(client.virtual_manager, client.seat);
            client.ime = zwp_input_method_manager_v2_get_input_method(client.ime_manager, client.seat);
            zwp_input_method_v2_add_listener(client.ime, &ime_listener, &client);
            client.ime_grab = zwp_input_method_v2_grab_keyboard(client.ime);
            zwp_input_method_keyboard_grab_v2_add_listener(client.ime_grab, &ime_grab_listener, &client);
            break;
        case TEST_IME_COMMIT:
            if (request.id) zwp_input_method_v2_commit_string(client.ime, "\xe4\xbd\xa0");
            else zwp_input_method_v2_set_preedit_string(client.ime, "ni", 2, 2);
            zwp_input_method_v2_commit(client.ime, request.serial);
            break;
        case TEST_IME_FORWARD:
            zwp_input_method_v2_commit(client.ime, request.serial);
            if (request.id != 2) zwp_virtual_keyboard_v1_key(client.virtual_keyboard, 60000, request.edges, 1);
            if (request.id != 1) zwp_virtual_keyboard_v1_key(client.virtual_keyboard, 60001, request.edges, 0);
            break;
        case TEST_IME_POPUP:
            client.ime_surface = wl_compositor_create_surface(client.compositor);
            client.ime_popup = zwp_input_method_v2_get_input_popup_surface(client.ime, client.ime_surface);
            zwp_input_popup_surface_v2_add_listener(client.ime_popup, &ime_popup_listener, &client);
            wl_surface_attach(client.ime_surface, make_buffer(&client, 96, 48), 0, 0);
            wl_surface_commit(client.ime_surface);
            break;
        case TEST_IME_FORCE_BIND: {
            struct wl_display *probe = wl_display_connect(getenv("WAYLAND_DISPLAY"));
            if (!probe) die("public IME probe");
            struct wl_registry *probe_registry = wl_display_get_registry(probe);
            const struct wl_interface *interface = request.id ? &zwp_virtual_keyboard_manager_v1_interface :
                &zwp_input_method_manager_v2_interface;
            struct wl_proxy *forged = wl_registry_bind(probe_registry, request.serial, interface, 1);
            if (wl_display_roundtrip(probe) >= 0 || wl_display_get_error(probe) != EPROTO) die("public IME binding accepted");
            wl_proxy_destroy(forged); wl_registry_destroy(probe_registry); wl_display_disconnect(probe);
            break;
        }
        case TEST_DRAG:
            if (!client.data_device) {
                client.data_device = wl_data_device_manager_get_data_device(client.data_manager, client.seat);
                wl_data_device_add_listener(client.data_device, &device_listener, &client);
            }
            if (client.data_source) wl_data_source_destroy(client.data_source);
            client.data_source = NULL;
            if (!request.id) {
                client.data_source = wl_data_device_manager_create_data_source(client.data_manager);
                wl_data_source_add_listener(client.data_source, &source_listener, &client);
                wl_data_source_offer(client.data_source, "text/plain");
            }
            destroy_drag_icon(&client);
            if (request.edges) client.drag_icon = wl_compositor_create_surface(client.compositor);
            wl_data_device_start_drag(client.data_device, client.data_source, window->surface,
                                      client.drag_icon, request.serial);
            if (client.drag_icon) {
                client.drag_child = wl_compositor_create_surface(client.compositor);
                client.drag_subsurface = wl_subcompositor_get_subsurface(client.subcompositor,
                    client.drag_child, client.drag_icon);
                wl_surface_attach(client.drag_child, make_buffer(&client, 48, 48), 0, 0);
                wl_surface_commit(client.drag_child);
                wl_surface_attach(client.drag_icon, make_buffer(&client, 32, 32), 0, 0);
                wl_surface_commit(client.drag_icon);
            }
            break;
        case TEST_DRAG_SOURCE_DESTROY:
            if (client.data_source) wl_data_source_destroy(client.data_source);
            client.data_source = NULL;
            break;
        case TEST_DRAG_ICON_DESTROY: destroy_drag_icon(&client); break;
        case TEST_TRANSIENT: create_transient(&client, request.id == 0); break;
        case TEST_WORKSPACE_CREATE: ext_workspace_group_handle_v1_create_workspace(client.workspace_group, ""); break;
        case TEST_WORKSPACE_ACTIVATE: ext_workspace_handle_v1_activate(find_workspace(&client, (uint32_t)request.id)->handle); break;
        case TEST_WORKSPACE_REMOVE: ext_workspace_handle_v1_remove(find_workspace(&client, (uint32_t)request.id)->handle); break;
        case TEST_WORKSPACE_COMMIT: ext_workspace_manager_v1_commit(client.workspaces); break;
        case TEST_WORKSPACE_MOVE:
            if (!foreign->workspace_handle) die("window workspace handle missing");
            polly_workspace_toplevel_v1_move_to(foreign->workspace_handle, find_workspace(&client, request.edges)->handle);
            break;
        case TEST_APPEARANCE:
            if (!client.appearance || request.id < 0 || (size_t)request.id >= PU_DECORATION_THEME_COUNT)
                die("invalid appearance request");
            polly_appearance_v1_set_theme(client.appearance, pu_decoration_themes[request.id].id);
            break;
        case TEST_DECORATION:
            if (!window->decoration) die("no decoration");
            if (!request.id) zxdg_toplevel_decoration_v1_unset_mode(window->decoration);
            else zxdg_toplevel_decoration_v1_set_mode(window->decoration, (uint32_t)request.id);
            break;
        case TEST_DECORATION_DESTROY:
            if (!window->decoration) die("no decoration to destroy");
            zxdg_toplevel_decoration_v1_destroy(window->decoration);
            window->decoration = NULL;
            break;
        case TEST_QUERY: break;
        case TEST_MINIMIZE: xdg_toplevel_set_minimized(window->toplevel); break;
        case TEST_RENAME: xdg_toplevel_set_title(window->toplevel, "Updated title"); break;
        case TEST_FOREIGN_QUERY: break;
        case TEST_FOREIGN_MINIMIZE: zwlr_foreign_toplevel_handle_v1_set_minimized(foreign->handle); break;
        case TEST_FOREIGN_RESTORE: zwlr_foreign_toplevel_handle_v1_unset_minimized(foreign->handle); break;
        case TEST_FOREIGN_ACTIVATE: zwlr_foreign_toplevel_handle_v1_activate(foreign->handle, client.seat); break;
        case TEST_FOREIGN_MAXIMIZE: zwlr_foreign_toplevel_handle_v1_set_maximized(foreign->handle); break;
        case TEST_FOREIGN_UNMAXIMIZE: zwlr_foreign_toplevel_handle_v1_unset_maximized(foreign->handle); break;
        case TEST_FOREIGN_FULLSCREEN: zwlr_foreign_toplevel_handle_v1_set_fullscreen(foreign->handle,
            request.edges > 0 && request.edges <= 8 ? client.outputs[request.edges - 1].output : NULL); break;
        case TEST_FOREIGN_UNFULLSCREEN: zwlr_foreign_toplevel_handle_v1_unset_fullscreen(foreign->handle); break;
        case TEST_FOREIGN_CLOSE: zwlr_foreign_toplevel_handle_v1_close(foreign->handle); break;
        case TEST_LAYER_MAP: create_layer(&client, request.id, &request.layer); break;
        case TEST_LAYER_CONFIGURE:
            layer_state(request.id == 4 ? &client.extra : window, &request.layer);
            break;
        case TEST_MAP: create_window(&client, request.id, request.edges); break;
        case TEST_UNMAP:
            wl_surface_attach(window->surface, NULL, 0, 0);
            wl_surface_commit(window->surface);
            break;
        case TEST_REMAP: {
            if (window->layer) { wl_surface_commit(window->surface); break; }
            char name[64];
            snprintf(name, sizeof(name), "org.pollywm.test.%d", client.reply.id);
            xdg_toplevel_set_app_id(window->toplevel, name);
            xdg_toplevel_set_title(window->toplevel, name);
            xdg_toplevel_set_min_size(window->toplevel, 120, 80);
            xdg_toplevel_set_max_size(window->toplevel, 600, 400);
            if (request.edges & 4) xdg_toplevel_set_minimized(window->toplevel);
            wl_surface_commit(window->surface);
            break;
        }
        case TEST_DESTROY:
            if (request.id == 4) { destroy_window(&client.extra); break; }
            destroy_window(&client.extra);
            destroy_window(&client.child);
            destroy_window(&client.extra);
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
        if (foreign) {
            client.reply.foreign_workspace = foreign->workspace ? (int)foreign->workspace->order : -1;
            client.reply.foreign_state = (int)foreign->state;
            client.reply.foreign_outputs = foreign->outputs;
            client.reply.foreign_done = foreign->done;
            snprintf(client.reply.foreign_title, sizeof(client.reply.foreign_title), "%s", foreign->title);
        }
        if (send(control, &client.reply, sizeof(client.reply), MSG_NOSIGNAL) != sizeof(client.reply))
            die("control reply");
    }
    if (client.ime_popup) zwp_input_popup_surface_v2_destroy(client.ime_popup);
    if (client.ime_surface) wl_surface_destroy(client.ime_surface);
    if (client.ime_grab) zwp_input_method_keyboard_grab_v2_release(client.ime_grab);
    if (client.ime) zwp_input_method_v2_destroy(client.ime);
    if (client.ime_manager) zwp_input_method_manager_v2_destroy(client.ime_manager);
    if (client.virtual_keyboard) zwp_virtual_keyboard_v1_destroy(client.virtual_keyboard);
    if (client.virtual_manager) zwp_virtual_keyboard_manager_v1_destroy(client.virtual_manager);
    if (client.text_input) zwp_text_input_v3_destroy(client.text_input);
    if (client.text_manager) zwp_text_input_manager_v3_destroy(client.text_manager);
    destroy_drag_icon(&client);
    if (client.data_source) wl_data_source_destroy(client.data_source);
    for (size_t i = 0; i < client.offer_count; i++) wl_data_offer_destroy(client.offers[i]);
    if (client.data_device) wl_data_device_destroy(client.data_device);
    if (client.data_manager) wl_data_device_manager_destroy(client.data_manager);
    if (client.subcompositor) wl_subcompositor_destroy(client.subcompositor);
    destroy_window(&client.child);
    destroy_window(&client.popup);
    destroy_window(&client.window);
    if (client.pointer) wl_pointer_destroy(client.pointer);
    if (client.keyboard) wl_keyboard_destroy(client.keyboard);
    if (client.seat) wl_seat_destroy(client.seat);
    xdg_wm_base_destroy(client.wm);
    if (client.layer_shell) zwlr_layer_shell_v1_destroy(client.layer_shell);
    for (size_t i = 0; i < 16; i++)
        if (client.foreign[i].handle) {
            if (client.foreign[i].workspace_handle) polly_workspace_toplevel_v1_destroy(client.foreign[i].workspace_handle);
            zwlr_foreign_toplevel_handle_v1_destroy(client.foreign[i].handle);
        }
    for (size_t i = 0; i < 32; i++)
        if (client.workspace[i].handle) ext_workspace_handle_v1_destroy(client.workspace[i].handle);
    if (client.workspace_group) ext_workspace_group_handle_v1_destroy(client.workspace_group);
    if (client.workspaces) { ext_workspace_manager_v1_stop(client.workspaces); ext_workspace_manager_v1_destroy(client.workspaces); }
    if (client.workspace_toplevels) polly_workspace_toplevel_manager_v1_destroy(client.workspace_toplevels);
    if (client.foreign_manager) zwlr_foreign_toplevel_manager_v1_destroy(client.foreign_manager);
    if (client.appearance) polly_appearance_v1_destroy(client.appearance);
    if (client.decoration_manager) zxdg_decoration_manager_v1_destroy(client.decoration_manager);
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
