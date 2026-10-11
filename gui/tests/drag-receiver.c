#define _GNU_SOURCE
#include "drag-wire.h"
#include "xdg-shell-client-protocol.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>
#include <wayland-client.h>

static struct
{
    struct wl_display *display;
    struct wl_compositor *compositor;
    struct wl_shm *shm;
    struct wl_seat *seat;
    struct wl_data_device_manager *manager;
    struct wl_data_device *device;
    struct xdg_wm_base *wm;
    struct wl_surface *surface;
    struct xdg_surface *xdg;
    struct xdg_toplevel *top;
    struct wl_buffer *buffer;
    struct wl_data_offer *offer, *finished_offer;
    int binary, read_fd, hold_read, hold_finish, refuse, quit, failed, expected, abort_read;
    unsigned char bytes[262148];
    size_t size;
    struct DragReceipt report;
} r;
static void offered(void *data, struct wl_data_offer *offer, const char *mime)
{
    (void)data;
    (void)offer;
    if (!strcmp(mime, "application/x-polly-copy-test"))
        r.binary = 1;
}
static void actions(void *data, struct wl_data_offer *offer, uint32_t action)
{
    (void)data;
    (void)offer;
    (void)action;
}
static const struct wl_data_offer_listener offer_listener = { offered, actions, actions };
static void new_offer(void *data, struct wl_data_device *device, struct wl_data_offer *offer)
{
    (void)data;
    (void)device;
    r.binary = 0;
    wl_data_offer_add_listener(offer, &offer_listener, NULL);
}
static void enter(void *data, struct wl_data_device *device, uint32_t serial, struct wl_surface *surface, wl_fixed_t x,
    wl_fixed_t y, struct wl_data_offer *offer)
{
    (void)data;
    (void)device;
    (void)surface;
    (void)x;
    (void)y;
    r.offer = offer;
    wl_data_offer_accept(offer, serial,
        r.refuse       ? NULL
            : r.binary ? "application/x-polly-copy-test"
                       : "text/plain;charset=utf-8");
    wl_data_offer_set_actions(offer, r.refuse ? 0 : WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY,
        r.refuse ? 0 : WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY);
}
static void leave(void *data, struct wl_data_device *device)
{
    (void)data;
    (void)device;
    if (r.offer && r.offer != r.finished_offer)
        wl_data_offer_destroy(r.offer);
    r.offer = NULL;
}
static void motion(void *data, struct wl_data_device *device, uint32_t time, wl_fixed_t x, wl_fixed_t y)
{
    (void)data;
    (void)device;
    (void)time;
    (void)x;
    (void)y;
}
static void drop(void *data, struct wl_data_device *device)
{
    (void)data;
    (void)device;
    int fds[2];
    if (pipe2(fds, O_NONBLOCK | O_CLOEXEC) < 0)
    {
        r.failed = 1;
        return;
    }
    r.read_fd = fds[0];
    r.size = 0;
    r.finished_offer = r.offer;
    wl_data_offer_receive(r.offer, r.binary ? "application/x-polly-copy-test" : "text/plain;charset=utf-8", fds[1]);
    close(fds[1]);
    if (r.abort_read)
    {
        close(r.read_fd);
        r.read_fd = -1;
    }
}
static void selection(void *data, struct wl_data_device *device, struct wl_data_offer *offer)
{
    (void)data;
    (void)device;
    if (offer)
        wl_data_offer_destroy(offer);
}
static const struct wl_data_device_listener device_listener = { new_offer, enter, leave, motion, drop, selection };
static void ping(void *data, struct xdg_wm_base *wm, uint32_t serial)
{
    (void)data;
    xdg_wm_base_pong(wm, serial);
}
static const struct xdg_wm_base_listener wm_listener = { ping };
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version)
{
    (void)data;
    if (!strcmp(interface, "wl_compositor"))
        r.compositor = wl_registry_bind(registry, name, &wl_compositor_interface, 4);
    if (!strcmp(interface, "wl_shm"))
        r.shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
    if (!strcmp(interface, "wl_seat"))
        r.seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
    if (!strcmp(interface, "wl_data_device_manager") && version >= 3)
        r.manager = wl_registry_bind(registry, name, &wl_data_device_manager_interface, 3);
    if (!strcmp(interface, "xdg_wm_base"))
    {
        r.wm = wl_registry_bind(registry, name, &xdg_wm_base_interface, 1);
        xdg_wm_base_add_listener(r.wm, &wm_listener, NULL);
    }
}
static void removed(void *data, struct wl_registry *registry, uint32_t name)
{
    (void)data;
    (void)registry;
    (void)name;
}
static const struct wl_registry_listener registry_listener = { global, removed };
static void configure(void *data, struct xdg_surface *xdg, uint32_t serial)
{
    (void)data;
    xdg_surface_ack_configure(xdg, serial);
    wl_surface_attach(r.surface, r.buffer, 0, 0);
    wl_surface_damage(r.surface, 0, 0, 360, 280);
    wl_surface_commit(r.surface);
}
static const struct xdg_surface_listener xdg_listener = { configure };
static void top_configure(void *data, struct xdg_toplevel *top, int32_t w, int32_t h, struct wl_array *states)
{
    (void)data;
    (void)top;
    (void)w;
    (void)h;
    (void)states;
}
static void top_close(void *data, struct xdg_toplevel *top)
{
    (void)data;
    (void)top;
    r.quit = 1;
}
static const struct xdg_toplevel_listener top_listener = { top_configure, top_close };
static void receive(void)
{
    if (r.read_fd < 0 || r.hold_read)
        return;
    ssize_t n;
    do
    {
        n = read(
            r.read_fd, r.binary ? r.bytes : r.bytes + r.size, r.binary ? sizeof(r.bytes) : sizeof(r.bytes) - r.size);
        if (n > 0)
        {
            if (r.binary)
                for (size_t i = 0; i < (size_t)n; i++)
                    if (r.bytes[i] != (unsigned char)((r.size + i) % 251))
                        r.failed = 1;
            r.size += (size_t)n;
        }
    } while (n > 0 && (r.binary || r.size < sizeof(r.bytes)));
    if (n == 0)
    {
        close(r.read_fd);
        r.read_fd = -1;
        int ok;
        if (r.binary)
        {
            ok = r.size == (size_t)r.expected && !r.failed;
        }
        else
        {
            const char *text = "Polly COPY \xe4\xb8\xad\xe6\x96\x87";
            ok = r.size == strlen(text) && !memcmp(text, r.bytes, r.size);
        }
        if (!ok)
        {
            fprintf(stderr, "FAIL receiver bytes=%zu binary=%d\n", r.size, r.binary);
            r.failed = 1;
        }
        else
        {
            r.report.received++;
            r.report.bytes = (int)r.size;
        }
        if (!r.hold_finish && r.finished_offer)
        {
            wl_data_offer_finish(r.finished_offer);
            wl_data_offer_destroy(r.finished_offer);
            r.finished_offer = NULL;
        }
    }
    else if (n < 0 && errno != EAGAIN && errno != EINTR)
        r.failed = 1;
}
int pu_test_drag_receiver(int fd)
{
    r.read_fd = -1;
    r.expected = 262144;
    r.display = wl_display_connect(NULL);
    if (!r.display)
        return 2;
    struct wl_registry *registry = wl_display_get_registry(r.display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    if (wl_display_roundtrip(r.display) < 0 || !r.manager || !r.wm)
        return 2;
    r.device = wl_data_device_manager_get_data_device(r.manager, r.seat);
    wl_data_device_add_listener(r.device, &device_listener, NULL);
    r.surface = wl_compositor_create_surface(r.compositor);
    int mem = memfd_create("polly-copy-test", MFD_CLOEXEC);
    size_t size = 360u * 280u * 4u;
    if (mem < 0 || ftruncate(mem, (off_t)size) < 0)
        return 2;
    uint32_t *pixels = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, mem, 0);
    if (pixels == MAP_FAILED)
        return 2;
    for (size_t i = 0; i < size / 4; i++)
        pixels[i] = 0xff204060;
    struct wl_shm_pool *pool = wl_shm_create_pool(r.shm, mem, (int32_t)size);
    r.buffer = wl_shm_pool_create_buffer(pool, 0, 360, 280, 1440, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);
    munmap(pixels, size);
    close(mem);
    r.xdg = xdg_wm_base_get_xdg_surface(r.wm, r.surface);
    xdg_surface_add_listener(r.xdg, &xdg_listener, NULL);
    r.top = xdg_surface_get_toplevel(r.xdg);
    xdg_toplevel_add_listener(r.top, &top_listener, NULL);
    xdg_toplevel_set_title(r.top, "Drag.native");
    wl_surface_commit(r.surface);
    while (!r.quit && !r.failed)
    {
        if (wl_display_dispatch_pending(r.display) < 0)
            break;
        receive();
        struct DragRequest request;
        if (recv(fd, &request, sizeof(request), MSG_DONTWAIT) == sizeof(request))
        {
            if (request.command == DRAG_QUIT)
                r.quit = 1;
            if (request.command == DRAG_HOLD_READ)
                r.hold_read = request.mode;
            if (request.command == DRAG_HOLD_FINISH)
                r.hold_finish = request.mode;
            if (request.command == DRAG_REFUSE)
                r.refuse = request.mode;
            if (request.command == DRAG_EXPECT_SIZE)
                r.expected = request.mode;
            if (request.command == DRAG_ABORT_READ)
                r.abort_read = request.mode;
            if (request.command == DRAG_FINISH && r.finished_offer)
            {
                wl_data_offer_finish(r.finished_offer);
                wl_data_offer_destroy(r.finished_offer);
                r.finished_offer = NULL;
            }
            r.report.heartbeat++;
            if (send(fd, &r.report, sizeof(r.report), MSG_NOSIGNAL) != sizeof(r.report))
                break;
        }
        wl_display_flush(r.display);
        struct pollfd fds[] = { { wl_display_get_fd(r.display), POLLIN, 0 }, { fd, POLLIN, 0 } };
        if (poll(fds, 2, 5) > 0 && (fds[0].revents & POLLIN))
            if (wl_display_dispatch(r.display) < 0)
                break;
    }
    if (r.read_fd >= 0)
        close(r.read_fd);
    if (r.finished_offer)
        wl_data_offer_destroy(r.finished_offer);
    if (r.offer && r.offer != r.finished_offer)
        wl_data_offer_destroy(r.offer);
    xdg_toplevel_destroy(r.top);
    xdg_surface_destroy(r.xdg);
    wl_surface_destroy(r.surface);
    wl_buffer_destroy(r.buffer);
    wl_data_device_release(r.device);
    wl_data_device_manager_destroy(r.manager);
    wl_seat_destroy(r.seat);
    wl_shm_destroy(r.shm);
    wl_compositor_destroy(r.compositor);
    xdg_wm_base_destroy(r.wm);
    wl_registry_destroy(registry);
    wl_display_flush(r.display);
    wl_display_disconnect(r.display);
    return r.failed;
}
