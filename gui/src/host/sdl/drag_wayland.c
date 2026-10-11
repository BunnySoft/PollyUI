#define _GNU_SOURCE
#include "host/drag_internal.h"
#include "shared/thread.h"
#include <SDL3/SDL.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wayland-client.h>

typedef struct Display Display;
typedef struct Seat Seat;
typedef struct Owner Owner;
typedef struct Offer Offer;
typedef struct Source Source;
typedef struct Send Send;
struct Owner
{
    Owner *next;
    PuDragOwner *owner;
};
struct Offer
{
    Offer *next;
    struct wl_data_offer *proxy;
    int retire, selection;
};
struct Seat
{
    Seat *next;
    Display *display;
    uint32_t name;
    struct wl_seat *proxy;
    struct wl_pointer *pointer;
    struct wl_data_device *device;
    Owner *focus;
    unsigned buttons;
    int removed;
    Offer *offers, *drag;
};
struct Send
{
    Send *next;
    Source *source;
    int fd;
    const unsigned char *bytes;
    size_t size, offset;
};
struct Source
{
    Source *next;
    Display *display;
    Seat *seat;
    PuDragSession *session;
    struct wl_data_source *proxy;
    PuDragStatus status;
    char reason[192];
    uint32_t action;
};
struct Display
{
    Display *next;
    struct wl_display *proxy;
    struct wl_registry *registry;
    struct wl_data_device_manager *manager;
    struct wl_event_queue *queue;
    PuThread *thread;
    PuMutex *mutex;
    Seat *seats;
    Owner *owners;
    Source *sources;
    Send *sends;
    int stop, failed, initialized, synchronized;
    uint32_t manager_name;
};
static Display *displays;
static int pumping;

static void source_finish(Source *source, PuDragStatus status, const char *reason)
{
    if (source->status != PU_DRAG_PENDING)
        return;
    source->status = status;
    if (reason)
        snprintf(source->reason, sizeof(source->reason), "%s", reason);
}
static void target(void *data, struct wl_data_source *proxy, const char *mime)
{
    (void)data;
    (void)proxy;
    (void)mime;
}
static void send_data(void *data, struct wl_data_source *proxy, const char *type, int32_t fd)
{
    (void)proxy;
    Source *source = data;
    if (source->status != PU_DRAG_PENDING)
    {
        close(fd);
        return;
    }
    const PuDragItem *item = NULL;
    for (size_t i = 0; i < source->session->count; i++)
        if (!strcmp(source->session->items[i].type, type))
            item = &source->session->items[i];
    Send *send = item ? calloc(1, sizeof(*send)) : NULL;
    if (!send || fcntl(fd, F_SETFL, O_NONBLOCK) < 0 || fcntl(fd, F_SETFD, FD_CLOEXEC) < 0)
    {
        close(fd);
        free(send);
        source_finish(source, PU_DRAG_ERROR, "Cannot provide requested native drag format");
        return;
    }
    send->fd = fd;
    send->source = source;
    send->bytes = item->data;
    send->size = item->size;
    send->next = source->display->sends;
    source->display->sends = send;
}
static void cancelled(void *data, struct wl_data_source *proxy)
{
    (void)proxy;
    source_finish(data, PU_DRAG_CANCELLED, "native-cancelled");
}
static void dropped(void *data, struct wl_data_source *proxy)
{
    (void)data;
    (void)proxy;
} /* Physical release is not a terminal event. */
static void finished(void *data, struct wl_data_source *proxy)
{
    (void)proxy;
    Source *source = data;
    source_finish(source, source->action == WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY ? PU_DRAG_COPIED : PU_DRAG_ERROR,
        source->action == WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY ? NULL
                                                                 : "Native recipient finished without negotiated COPY");
}
static void action(void *data, struct wl_data_source *proxy, uint32_t value)
{
    (void)proxy;
    Source *source = data;
    source->action = value;
    if (value && value != WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY)
        source_finish(source, PU_DRAG_ERROR, "Native recipient selected an unsupported action");
}
static const struct wl_data_source_listener source_listener
    = { target, send_data, cancelled, dropped, finished, action };
static void send_tick(Display *display)
{
    size_t budget = 65536; /* Scheduling budget, not a payload quota. */
    for (Send **slot = &display->sends; *slot && budget;)
    {
        Send *send = *slot;
        size_t left = send->size - send->offset;
        size_t amount = left < budget ? left : budget;
        if (amount > 8192)
            amount = 8192;
        ssize_t n = amount ? write(send->fd, send->bytes + send->offset, amount) : 0;
        if (n > 0)
        {
            send->offset += (size_t)n;
            budget -= (size_t)n;
        }
        if (n < 0 && (errno == EAGAIN || errno == EINTR))
        {
            slot = &send->next;
            continue;
        }
        if (n < 0)
        {
            char message[192];
            snprintf(message, sizeof(message), "Native drag send failed: %s", strerror(errno));
            if (send->source->status == PU_DRAG_COPIED)
                send->source->status = PU_DRAG_PENDING;
            source_finish(send->source, PU_DRAG_ERROR, message);
        }
        if (send->offset == send->size || n < 0)
        {
            *slot = send->next;
            close(send->fd);
            free(send);
        }
        else
            slot = &send->next;
    }
}
static void worker(void *data)
{
    Display *display = data;
    sigset_t blocked;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGPIPE);
    if (pthread_sigmask(SIG_BLOCK, &blocked, NULL) != 0)
    {
        pu_mutex_lock(display->mutex);
        display->failed = 1;
        pu_mutex_unlock(display->mutex);
        fprintf(stderr, "[drag] Cannot block sender SIGPIPE\n");
        return;
    }
    for (;;)
    {
        pu_mutex_lock(display->mutex);
        if (display->stop || display->failed)
        {
            pu_mutex_unlock(display->mutex);
            break;
        }
        if (wl_display_dispatch_queue_pending(display->proxy, display->queue) < 0)
            display->failed = 1;
        send_tick(display);
        int send_fd = display->sends ? display->sends->fd : -1;
        pu_mutex_unlock(display->mutex);
        if (wl_display_prepare_read_queue(display->proxy, display->queue) != 0)
        {
            if (wl_display_get_error(display->proxy))
            {
                pu_mutex_lock(display->mutex);
                display->failed = 1;
                pu_mutex_unlock(display->mutex);
                break;
            }
            continue;
        }
        struct pollfd fds[] = { { wl_display_get_fd(display->proxy), POLLIN, 0 }, { send_fd, POLLOUT, 0 } };
        int ready = poll(fds, 2, 5);
        if (ready > 0 && (fds[0].revents & POLLIN))
        {
            if (wl_display_read_events(display->proxy) < 0)
            {
                pu_mutex_lock(display->mutex);
                display->failed = 1;
                pu_mutex_unlock(display->mutex);
                break;
            }
        }
        else
        {
            wl_display_cancel_read(display->proxy);
            if ((ready < 0 && errno != EINTR) || (fds[0].revents & (POLLERR | POLLHUP | POLLNVAL)))
            {
                pu_mutex_lock(display->mutex);
                display->failed = 1;
                pu_mutex_unlock(display->mutex);
                break;
            }
        }
    }
}
static void mime(void *data, struct wl_data_offer *proxy, const char *type)
{
    (void)data;
    (void)proxy;
    (void)type;
}
static void source_actions(void *data, struct wl_data_offer *proxy, uint32_t value)
{
    (void)data;
    (void)proxy;
    (void)value;
}
static const struct wl_data_offer_listener offer_listener = { mime, source_actions, source_actions };
static Offer *find_offer(Seat *seat, struct wl_data_offer *proxy)
{
    for (Offer *offer = seat->offers; offer; offer = offer->next)
        if (offer->proxy == proxy)
            return offer;
    return NULL;
}
static void new_offer(void *data, struct wl_data_device *device, struct wl_data_offer *proxy)
{
    (void)device;
    Seat *seat = data;
    Offer *offer = calloc(1, sizeof(*offer));
    if (!offer)
    {
        pu_drag_fail("Cannot retain passive native drag offer");
        pu_mutex_lock(seat->display->mutex);
        seat->display->failed = 1;
        pu_mutex_unlock(seat->display->mutex);
        /* Allocation failure deliberately aborts this backend. Destruction is
         * not the passive-success path and cannot be mistaken for completion. */
        wl_data_offer_destroy(proxy);
        return;
    }
    offer->proxy = proxy;
    offer->next = seat->offers;
    seat->offers = offer;
    wl_data_offer_add_listener(proxy, &offer_listener, NULL);
}
static void enter(void *data, struct wl_data_device *device, uint32_t serial, struct wl_surface *surface, wl_fixed_t x,
    wl_fixed_t y, struct wl_data_offer *proxy)
{
    (void)device;
    (void)serial;
    (void)surface;
    (void)x;
    (void)y;
    Seat *seat = data;
    seat->drag = find_offer(seat, proxy);
}
static void leave(void *data, struct wl_data_device *device)
{
    (void)device;
    Seat *seat = data;
    if (seat->drag)
        seat->drag->retire = 1;
    seat->drag = NULL;
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
    leave(data, device);
}
static void selection(void *data, struct wl_data_device *device, struct wl_data_offer *proxy)
{
    (void)device;
    Seat *seat = data;
    for (Offer *offer = seat->offers; offer; offer = offer->next)
        if (offer->selection)
            offer->retire = 1;
    Offer *offer = find_offer(seat, proxy);
    if (offer)
        offer->selection = 1;
}
static const struct wl_data_device_listener device_listener = { new_offer, enter, leave, motion, drop, selection };
static void pointer_enter(
    void *data, struct wl_pointer *pointer, uint32_t serial, struct wl_surface *surface, wl_fixed_t x, wl_fixed_t y)
{
    (void)pointer;
    (void)serial;
    (void)x;
    (void)y;
    Seat *seat = data;
    seat->focus = NULL;
    for (Owner *owner = seat->display->owners; owner; owner = owner->next)
        if (owner->owner->native == surface)
            seat->focus = owner;
}
static void pointer_leave(void *data, struct wl_pointer *pointer, uint32_t serial, struct wl_surface *surface)
{
    (void)pointer;
    (void)serial;
    (void)surface;
    Seat *seat = data;
    if (seat->focus)
        pu_drag_invalidate(seat->focus->owner);
    seat->focus = NULL;
}
static void pointer_motion(void *data, struct wl_pointer *pointer, uint32_t time, wl_fixed_t x, wl_fixed_t y)
{
    (void)data;
    (void)pointer;
    (void)time;
    (void)x;
    (void)y;
}
static void pointer_button(
    void *data, struct wl_pointer *pointer, uint32_t serial, uint32_t time, uint32_t button, uint32_t pressed)
{
    (void)pointer;
    (void)time;
    (void)button;
    Seat *seat = data;
    if (pressed)
        seat->buttons++;
    else if (seat->buttons)
        seat->buttons--;
    if (!seat->focus)
        return;
    pu_drag_invalidate(seat->focus->owner);
    if (pressed && seat->buttons == 1 && !seat->removed)
        pu_drag_input_new(seat->focus->owner, seat, serial);
}
static void axis(void *data, struct wl_pointer *pointer, uint32_t time, uint32_t axis, wl_fixed_t value)
{
    (void)data;
    (void)pointer;
    (void)time;
    (void)axis;
    (void)value;
}
static void pointer_frame(void *data, struct wl_pointer *pointer)
{
    (void)data;
    (void)pointer;
}
static void axis_source(void *data, struct wl_pointer *pointer, uint32_t value)
{
    (void)data;
    (void)pointer;
    (void)value;
}
static void axis_stop(void *data, struct wl_pointer *pointer, uint32_t time, uint32_t axis)
{
    (void)data;
    (void)pointer;
    (void)time;
    (void)axis;
}
static void axis_discrete(void *data, struct wl_pointer *pointer, uint32_t axis, int32_t value)
{
    (void)data;
    (void)pointer;
    (void)axis;
    (void)value;
}
static const struct wl_pointer_listener pointer_listener = { .enter = pointer_enter,
    .leave = pointer_leave,
    .motion = pointer_motion,
    .button = pointer_button,
    .axis = axis,
    .frame = pointer_frame,
    .axis_source = axis_source,
    .axis_stop = axis_stop,
    .axis_discrete = axis_discrete };
static void invalidate_seat(Seat *seat)
{
    seat->removed = 1;
    seat->buttons = 0;
    seat->focus = NULL;
    for (Owner *owner = seat->display->owners; owner; owner = owner->next)
        if (owner->owner->input && owner->owner->input->seat == seat)
            pu_drag_invalidate(owner->owner);
    for (Source *source = seat->display->sources; source; source = source->next)
        if (source->seat == seat)
            source_finish(source, PU_DRAG_ERROR, "Native drag seat is unavailable");
}
static void capabilities(void *data, struct wl_seat *proxy, uint32_t caps)
{
    Seat *seat = data;
    if ((caps & WL_SEAT_CAPABILITY_POINTER) && !seat->pointer)
    {
        seat->removed = 0;
        seat->pointer = wl_seat_get_pointer(proxy);
        wl_pointer_add_listener(seat->pointer, &pointer_listener, seat);
    }
    else if (!(caps & WL_SEAT_CAPABILITY_POINTER))
    {
        pu_mutex_lock(seat->display->mutex);
        invalidate_seat(seat);
        pu_mutex_unlock(seat->display->mutex);
        if (seat->pointer)
        {
            wl_pointer_release(seat->pointer);
            seat->pointer = NULL;
        }
    }
}
static void name(void *data, struct wl_seat *proxy, const char *value)
{
    (void)data;
    (void)proxy;
    (void)value;
}
static const struct wl_seat_listener seat_listener = { capabilities, name };
static void globals(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version)
{
    Display *display = data;
    pu_mutex_lock(display->mutex);
    if (!strcmp(interface, "wl_data_device_manager") && version >= 3 && !display->manager)
    {
        display->manager = wl_registry_bind(registry, name, &wl_data_device_manager_interface, 3);
        display->manager_name = name;
    }
    else if (!strcmp(interface, "wl_seat") && version >= 5)
    {
        Seat *seat = calloc(1, sizeof(*seat));
        if (!seat)
        {
            pu_drag_fail("Cannot allocate native seat observer");
            display->failed = 1;
            pu_mutex_unlock(display->mutex);
            return;
        }
        seat->display = display;
        seat->name = name;
        seat->proxy = wl_registry_bind(registry, name, &wl_seat_interface, 5);
        wl_seat_add_listener(seat->proxy, &seat_listener, seat);
        seat->next = display->seats;
        display->seats = seat;
        if (display->initialized && display->manager)
        {
            seat->device = wl_data_device_manager_get_data_device(display->manager, seat->proxy);
            wl_data_device_add_listener(seat->device, &device_listener, seat);
        }
    }
    pu_mutex_unlock(display->mutex);
}
static void global_remove(void *data, struct wl_registry *registry, uint32_t name)
{
    (void)registry;
    Display *display = data;
    pu_mutex_lock(display->mutex);
    if (name == display->manager_name)
        display->failed = 1;
    for (Seat *seat = display->seats; seat; seat = seat->next)
        if (seat->name == name)
            invalidate_seat(seat);
    pu_mutex_unlock(display->mutex);
}
static const struct wl_registry_listener registry_listener = { globals, global_remove };
static void synchronized(void *data, struct wl_callback *callback, uint32_t serial)
{
    (void)callback;
    (void)serial;
    ((Display *)data)->synchronized = 1;
}
static const struct wl_callback_listener sync_listener = { synchronized };
static int sync_display(Display *display)
{
    display->synchronized = 0;
    struct wl_callback *sync = wl_display_sync(display->proxy);
    if (!sync)
        return pu_drag_fail("Cannot synchronize native drag registry");
    wl_callback_add_listener(sync, &sync_listener, display);
    long long start = pu_now_ms();
    while (!display->synchronized && !display->failed)
    {
        if (wl_display_flush(display->proxy) < 0 && errno != EAGAIN)
            break;
        SDL_PumpEvents();
        if (wl_display_get_error(display->proxy) || pu_now_ms() - start >= 3000)
            break;
        if (!display->synchronized)
            SDL_Delay(1);
    }
    wl_callback_destroy(sync);
    if (!display->synchronized)
    {
        display->failed = 1;
        return pu_drag_fail("Native drag registry failed or timed out");
    }
    return 1;
}
void pu_wayland_drag_attach(PuDragOwner *owner, void *native_display, void *surface)
{
    if (!native_display || !surface)
        return;
    Display *display;
    for (display = displays; display; display = display->next)
        if (display->proxy == native_display)
            break;
    if (!display)
    {
        display = calloc(1, sizeof(*display));
        if (!display)
        {
            pu_drag_fail("Cannot allocate native drag display");
            return;
        }
        display->mutex = pu_mutex_new();
        if (!display->mutex)
        {
            free(display);
            pu_drag_fail("Cannot allocate native drag lock");
            return;
        }
        display->proxy = native_display;
        display->registry = wl_display_get_registry(display->proxy);
        display->queue = wl_display_create_queue(display->proxy);
        display->next = displays;
        displays = display;
        if (!display->registry || !display->queue)
        {
            display->failed = 1;
            pu_drag_fail("Cannot allocate native drag proxies");
            return;
        }
        wl_registry_add_listener(display->registry, &registry_listener, display);
        if (!sync_display(display))
            return;
        for (Seat *seat = display->seats; seat && display->manager; seat = seat->next)
        {
            seat->device = wl_data_device_manager_get_data_device(display->manager, seat->proxy);
            wl_data_device_add_listener(seat->device, &device_listener, seat);
        }
        if (!sync_display(display))
            return;
        display->initialized = 1;
        display->thread = pu_thread_start(worker, display);
        if (!display->thread)
        {
            display->failed = 1;
            pu_drag_fail("Cannot start native drag worker");
        }
    }
    Owner *entry = calloc(1, sizeof(*entry));
    if (!entry)
    {
        pu_drag_fail("Cannot register native drag window");
        return;
    }
    entry->owner = owner;
    entry->next = display->owners;
    display->owners = entry;
    owner->backend = display;
    owner->native = surface;
}
int pu_wayland_drag_supported(PuDragOwner *owner)
{
    Display *display = owner ? owner->backend : NULL;
    if (!display || !owner->open || !owner->native || !display->initialized)
        return 0;
    pu_mutex_lock(display->mutex);
    int ready = !display->failed && !wl_display_get_error(display->proxy) && display->manager != NULL;
    pu_mutex_unlock(display->mutex);
    int pointers = 0;
    for (Seat *seat = display->seats; seat; seat = seat->next)
        if (!seat->removed && seat->pointer && seat->device)
            pointers++;
    /* Fail closed on multiple pointer seats; SDL's queued event has no seat
     * provenance. Never guess which seat produced a same-window mouse event. */
    return ready && pointers == 1;
}
PuDragSession *pu_wayland_drag_start(
    PuDragOwner *owner, PuDragInput *input, const PuDragItem *items, size_t count, PuDragFn callback, void *user)
{
    if (!pu_wayland_drag_supported(owner))
    {
        pu_drag_fail("Native COPY drag is unavailable on this window/seat");
        return NULL;
    }
    Display *display = owner->backend;
    Seat *seat = input ? input->seat : NULL;
    if (!input || input->owner != owner || !input->valid || input->used || !seat || seat->display != display
        || seat->removed || seat->buttons != 1 || !seat->focus || seat->focus->owner != owner)
    {
        pu_drag_fail("Drag credential is stale, consumed or belongs to another native window");
        return NULL;
    }
    PuDragSession *session = pu_drag_copy(owner, input, items, count, callback, user);
    if (!session)
        return NULL;
    Source *source = calloc(1, sizeof(*source));
    if (!source)
    {
        session->references = 1;
        pu_drag_release(session);
        pu_drag_fail("Cannot allocate native drag source");
        return NULL;
    }
    pu_mutex_lock(display->mutex);
    for (Source *active = display->sources; active; active = active->next)
    {
        if (active->status == PU_DRAG_PENDING)
        {
            pu_mutex_unlock(display->mutex);
            free(source);
            session->references = 1;
            pu_drag_release(session);
            pu_drag_fail("A native drag is already active");
            return NULL;
        }
    }
    /* A wrapper assigns the queue before the constructor creates the proxy;
     * assigning after creation can race a worker reading a source event. */
    struct wl_proxy *wrapper = wl_proxy_create_wrapper(display->manager);
    if (wrapper)
        wl_proxy_set_queue(wrapper, display->queue);
    source->proxy
        = wrapper ? wl_data_device_manager_create_data_source((struct wl_data_device_manager *)wrapper) : NULL;
    if (wrapper)
        wl_proxy_wrapper_destroy(wrapper);
    if (!source->proxy)
    {
        pu_mutex_unlock(display->mutex);
        free(source);
        session->references = 1;
        pu_drag_release(session);
        pu_drag_fail("Cannot allocate native data source");
        return NULL;
    }
    source->display = display;
    source->seat = seat;
    source->session = session;
    wl_data_source_add_listener(source->proxy, &source_listener, source);
    for (size_t i = 0; i < session->count; i++)
        wl_data_source_offer(source->proxy, session->items[i].type);
    wl_data_source_set_actions(source->proxy, WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY);
    wl_data_device_start_drag(seat->device, source->proxy, owner->native, NULL, input->serial);
    input->used = 1;
    input->valid = 0;
    session->native = source;
    source->next = display->sources;
    display->sources = source;
    pu_mutex_unlock(display->mutex);
    return session;
}
static void remove_source(Display *display, Source *source)
{
    if (!source->session->owner->input || source->session->owner->input->used)
    {
        source->seat->buttons = 0;
        pu_drag_invalidate(source->session->owner);
    }
    for (Send **slot = &display->sends; *slot;)
    {
        Send *send = *slot;
        if (send->source != source)
        {
            slot = &send->next;
            continue;
        }
        *slot = send->next;
        close(send->fd);
        free(send);
    }
    wl_data_source_destroy(source->proxy);
    source->session->native = NULL;
}
void pu_wayland_drag_suspend(PuDragOwner *owner)
{
    Display *display = owner ? owner->backend : NULL;
    if (!display)
        return;
    pu_mutex_lock(display->mutex);
    pu_drag_invalidate(owner);
    for (Source *source = display->sources; source; source = source->next)
        if (source->session->owner == owner)
            source_finish(source, PU_DRAG_CANCELLED, "window-unavailable");
    pu_mutex_unlock(display->mutex);
}
void pu_wayland_drag_close(PuDragOwner *owner)
{
    Display *display = owner ? owner->backend : NULL;
    if (!display)
    {
        pu_drag_owner_close(owner);
        return;
    }
    pu_mutex_lock(display->mutex);
    for (Source *source = display->sources; source; source = source->next)
        if (source->session->owner == owner)
            source_finish(source, PU_DRAG_CANCELLED, "window-closed");
    for (Seat *seat = display->seats; seat; seat = seat->next)
        if (seat->focus && seat->focus->owner == owner)
        {
            seat->focus = NULL;
            seat->buttons = 0;
        }
    for (Owner **slot = &display->owners; *slot; slot = &(*slot)->next)
    {
        if ((*slot)->owner == owner)
        {
            Owner *entry = *slot;
            *slot = entry->next;
            free(entry);
            break;
        }
    }
    pu_drag_owner_close(owner);
    owner->backend = NULL;
    pu_mutex_unlock(display->mutex);
}
void pu_wayland_drag_pump(void)
{
    if (pumping)
        return;
    pumping = 1;
    PuDragSession *deliveries = NULL;
    for (Display *display = displays; display; display = display->next)
    {
        pu_mutex_lock(display->mutex);
        if (wl_display_get_error(display->proxy))
            display->failed = 1;
        for (Owner *entry = display->owners; entry; entry = entry->next)
            if (display->failed)
                pu_drag_invalidate(entry->owner);
        /* Only after SDL has completely dispatched its native event queue. */
        for (Seat *seat = display->seats; seat; seat = seat->next)
        {
            for (Offer **slot = &seat->offers; *slot;)
            {
                Offer *offer = *slot;
                if (!offer->retire)
                {
                    slot = &offer->next;
                    continue;
                }
                *slot = offer->next;
                wl_data_offer_destroy(offer->proxy);
                free(offer);
            }
        }
        for (Source **slot = &display->sources; *slot;)
        {
            Source *source = *slot;
            PuDragSession *session = source->session;
            if (display->failed && source->status != PU_DRAG_COPIED)
            {
                source->status = PU_DRAG_ERROR;
                snprintf(source->reason, sizeof(source->reason), "Native drag connection is unavailable");
            }
            if (session->cancel_requested)
                source_finish(source, PU_DRAG_CANCELLED, "cancelled");
            if (source->status == PU_DRAG_PENDING)
            {
                slot = &source->next;
                continue;
            }
            if (source->status == PU_DRAG_COPIED)
            {
                int pending = 0;
                for (Send *send = display->sends; send; send = send->next)
                    if (send->source == source)
                        pending = 1;
                if (pending && !session->cancel_requested)
                {
                    slot = &source->next;
                    continue;
                }
                if (pending)
                {
                    source->status = PU_DRAG_CANCELLED;
                    snprintf(source->reason, sizeof(source->reason), "cancelled-during-transfer");
                }
            }
            pu_drag_finish(session, source->status, *source->reason ? source->reason : NULL);
            *slot = source->next;
            remove_source(display, source);
            free(source);
            session->next = deliveries;
            deliveries = session;
        }
        pu_mutex_unlock(display->mutex);
    }
    while (deliveries)
    {
        PuDragSession *session = deliveries;
        deliveries = session->next;
        pu_drag_deliver(session);
    }
    pumping = 0;
}
void pu_wayland_drag_shutdown(void)
{
    /* Called before SDL_Quit disconnects the borrowed display. No worker can
     * enter JS or retain a window; source result delivery remains on the UI. */
    for (Display *display = displays; display; display = display->next)
    {
        pu_mutex_lock(display->mutex);
        display->stop = 1;
        pu_mutex_unlock(display->mutex);
        pu_thread_join(display->thread);
        display->thread = NULL;
        for (Source *source = display->sources; source; source = source->next)
            source_finish(source, PU_DRAG_CANCELLED, "host-shutdown");
    }
    pu_wayland_drag_pump();
    while (displays)
    {
        Display *display = displays;
        displays = display->next;
        while (display->owners)
        {
            Owner *entry = display->owners;
            display->owners = entry->next;
            pu_drag_owner_close(entry->owner);
            entry->owner->backend = NULL;
            free(entry);
        }
        while (display->seats)
        {
            Seat *seat = display->seats;
            display->seats = seat->next;
            while (seat->offers)
            {
                Offer *offer = seat->offers;
                seat->offers = offer->next;
                wl_data_offer_destroy(offer->proxy);
                free(offer);
            }
            if (seat->device)
                wl_data_device_release(seat->device);
            if (seat->pointer)
                wl_pointer_release(seat->pointer);
            wl_seat_release(seat->proxy);
            free(seat);
        }
        if (display->manager)
            wl_data_device_manager_destroy(display->manager);
        if (display->registry)
            wl_registry_destroy(display->registry);
        if (display->queue)
            wl_event_queue_destroy(display->queue);
        pu_mutex_free(display->mutex);
        free(display);
    }
}
