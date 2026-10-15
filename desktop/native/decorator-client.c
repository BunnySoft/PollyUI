#define _POSIX_C_SOURCE 200809L
#include "decorator-client.h"
#include "decoration-client.h"
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/signalfd.h>
#include <time.h>
#include <unistd.h>

static struct {
    struct wl_display *display;
    struct wl_registry *registry;
    struct polly_appearance_v1 *appearance;
    int wake, signals;
    sigset_t previous;
    bool masked, stopped, failed;
} client = {.wake = -1, .signals = -1};

static int failure(const char *message)
{
    if (!client.failed) fprintf(stderr, "[decorator] %s: %s\n", message,
        client.display && wl_display_get_error(client.display) ?
        strerror(wl_display_get_error(client.display)) : strerror(errno));
    client.failed = true;
    return -1;
}
static int wait_events(int timeout)
{
    if (!client.display || client.failed) return -1;
    if (client.stopped) return 1;
    if (wl_display_prepare_read(client.display)) {
        if (wl_display_dispatch_pending(client.display) < 0) return failure("Wayland dispatch failed");
        return 0;
    }
    short events = POLLIN;
    if (wl_display_flush(client.display) < 0) {
        if (errno == EAGAIN) events |= POLLOUT;
        else if (errno != EINTR) {
            wl_display_cancel_read(client.display); return failure("Wayland flush failed");
        }
    }
    struct pollfd descriptors[] = {
        {.fd = wl_display_get_fd(client.display), .events = events},
        {.fd = client.wake, .events = POLLIN},
        {.fd = client.signals, .events = POLLIN},
    };
    int result = poll(descriptors, 3, timeout);
    int error = errno;
    if (result > 0 && (descriptors[0].revents & POLLIN)) {
        if (wl_display_read_events(client.display) < 0) return failure("Wayland read failed");
    } else wl_display_cancel_read(client.display);
    if (result < 0) {
        errno = error;
        return error == EINTR ? 0 : failure("Service event wait failed");
    }
    for (unsigned i = 0; i < 3; i++)
        if (descriptors[i].revents & (POLLERR | POLLHUP | POLLNVAL))
            return failure("Service event source disconnected");
    if (descriptors[1].revents & POLLIN) {
        uint64_t value;
        ssize_t count;
        do { count = read(client.wake, &value, sizeof(value)); } while (count < 0 && errno == EINTR);
        if (count != sizeof(value) && !(count < 0 && errno == EAGAIN)) return failure("Cannot drain dispatcher wake");
    }
    if (descriptors[2].revents & POLLIN) {
        struct signalfd_siginfo info;
        ssize_t count;
        do { count = read(client.signals, &info, sizeof(info)); } while (count < 0 && errno == EINTR);
        if (count != sizeof(info)) return failure("Cannot read service shutdown signal");
        client.stopped = true;
        return 1;
    }
    if (wl_display_dispatch_pending(client.display) < 0) return failure("Wayland pending dispatch failed");
    return 0;
}
int pu_decorator_client_wait(int timeout_ms)
{
    if (pu_decoration_client_pending()) return 0;
    return wait_events(timeout_ms);
}
void pu_decorator_client_wake(void)
{
    if (client.wake < 0) return;
    uint64_t value = 1;
    ssize_t result;
    do { result = write(client.wake, &value, sizeof(value)); } while (result < 0 && errno == EINTR);
    if (result < 0 && errno != EAGAIN)
        fprintf(stderr, "[decorator] Cannot wake dispatcher: %s\n", strerror(errno));
}
static int64_t now_ms(void)
{
    struct timespec time;
    if (clock_gettime(CLOCK_MONOTONIC, &time)) return -1;
    return (int64_t)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}
static void synced(void *data, struct wl_callback *callback, uint32_t serial)
{ (void)callback; (void)serial; *(bool *)data = true; }
static const struct wl_callback_listener sync_listener = {.done = synced};
static int roundtrip(struct wl_display *display)
{
    bool complete = false;
    struct wl_callback *callback = wl_display_sync(display);
    if (!callback) return 0;
    int ok = wl_callback_add_listener(callback, &sync_listener, &complete) == 0;
    int64_t start = now_ms(), deadline = start + 3000;
    while (ok && !complete) {
        int64_t now = now_ms();
        if (now < 0 || start < 0 || now >= deadline || wait_events((int)(deadline - now))) { ok = 0; break; }
    }
    wl_callback_destroy(callback);
    return ok && complete && !client.failed;
}
static void global(void *data, struct wl_registry *registry, uint32_t name,
    const char *interface, uint32_t version)
{
    (void)data;
    if (strcmp(interface, "polly_appearance_v1")) return;
    if (version < 4 || client.appearance) {
        errno = EPROTO; failure("Paired PollyWM/Shell/decorator appearance v4 is required"); return;
    }
    client.appearance = wl_registry_bind(registry, name, &polly_appearance_v1_interface, 4);
    if (!client.appearance || polly_appearance_v1_add_listener(client.appearance,
        &pu_decoration_client_listener, NULL) < 0) failure("Cannot bind private decoration role");
}
static void removed(void *data, struct wl_registry *registry, uint32_t name)
{ (void)data; (void)registry; (void)name; errno = EPROTO; failure("Private decoration global disappeared"); }
static const struct wl_registry_listener registry_listener = {.global = global, .global_remove = removed};
static JSValue bootstrap(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    return pu_decoration_client_configure(ctx, argc, argv, client.appearance, client.display);
}
int pu_decorator_client_install(JSContext *ctx)
{
    sigset_t signals;
    sigemptyset(&signals); sigaddset(&signals, SIGTERM); sigaddset(&signals, SIGINT);
    if (sigprocmask(SIG_BLOCK, &signals, &client.previous)) {
        failure("Cannot establish shutdown wait"); return 0;
    }
    client.masked = true;
    client.signals = signalfd(-1, &signals, SFD_NONBLOCK | SFD_CLOEXEC);
    client.wake = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    if (client.signals < 0 || client.wake < 0) {
        failure("Cannot create service event sources"); return 0;
    }
    client.display = wl_display_connect(NULL);
    if (!client.display) { failure("Cannot consume private Wayland connection"); return 0; }
    client.registry = wl_display_get_registry(client.display);
    if (!client.registry || wl_registry_add_listener(client.registry, &registry_listener, NULL) < 0 ||
        !roundtrip(client.display) || !client.appearance || !roundtrip(client.display))
        { failure("Private decorator v4 role is unavailable"); return 0; }
    JSValue api = JS_NewObject(ctx), global_object = JS_GetGlobalObject(ctx);
    int ok = !JS_IsException(api) && pu_decoration_renderer_install(ctx, api);
    if (ok) ok = JS_SetPropertyStr(ctx, api, "bootstrapAppearance",
        JS_NewCFunction(ctx, bootstrap, "bootstrapAppearance", 2)) >= 0;
    if (ok) ok = JS_SetPropertyStr(ctx, global_object, "decoration", JS_DupValue(ctx, api)) >= 0;
    JS_FreeValue(ctx, api); JS_FreeValue(ctx, global_object);
    if (!ok) return 0;
    pu_decoration_client_attach(client.appearance, client.display, roundtrip);
    return 1;
}
int pu_decorator_client_pump(void)
{
    if (client.failed || !client.display) return -1;
    if (wl_display_dispatch_pending(client.display) < 0) return failure("Service dispatch failed");
    return pu_decoration_client_pump();
}
void pu_decorator_client_stop(void)
{
    client.stopped = true;
    if (client.appearance && !client.failed) {
        polly_appearance_v1_disable_renderer(client.appearance);
        if (wl_display_flush(client.display) < 0 && errno != EAGAIN && errno != EINTR)
            failure("Cannot notify renderer shutdown");
    }
    pu_decoration_client_disconnect();
}
void pu_decorator_client_close(void)
{
    pu_decoration_client_shutdown();
    if (client.appearance) polly_appearance_v1_destroy(client.appearance);
    if (client.registry) wl_registry_destroy(client.registry);
    if (client.display) wl_display_disconnect(client.display);
    client.appearance = NULL; client.registry = NULL; client.display = NULL;
}
void pu_decorator_client_dispose(void)
{
    if (client.wake >= 0) close(client.wake);
    if (client.signals >= 0) close(client.signals);
    if (client.masked && sigprocmask(SIG_SETMASK, &client.previous, NULL))
        fprintf(stderr, "[decorator] Cannot restore signal mask: %s\n", strerror(errno));
    client.wake = client.signals = -1; client.masked = false;
}
