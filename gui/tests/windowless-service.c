#define _POSIX_C_SOURCE 200809L
#include "pollyui/context.h"
#include "quickjs.h"
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/eventfd.h>
#include <unistd.h>

struct State { int fd, done, waits, finite, infinite, phase, failed; };
static struct State state = {.fd = -1};
static JSValue finish(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (state.done) return JS_ThrowTypeError(ctx, "Service completion duplicated");
    state.done = 1;
    return JS_UNDEFINED;
}
static int install(JSContext *ctx, PuDispatch *dispatch, int headless, void *user)
{
    (void)dispatch; (void)user;
    if (headless) return 0;
    state.fd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    if (state.fd < 0) return 0;
    JSValue global = JS_GetGlobalObject(ctx);
    int ok = JS_SetPropertyStr(ctx, global, "finishService", JS_NewCFunction(ctx, finish, "finishService", 0)) >= 0;
    JS_FreeValue(ctx, global);
    return ok;
}
static void wake(void *user)
{
    (void)user;
    uint64_t value = 1;
    ssize_t count;
    do { count = write(state.fd, &value, sizeof(value)); } while (count < 0 && errno == EINTR);
    if (count < 0 && errno != EAGAIN) state.failed = 1;
}
static int wait_service(int timeout, void *user)
{
    (void)user;
    if (state.done) return 1;
    state.waits++;
    if (timeout < 0) state.infinite++; else state.finite++;
    if (state.waits > 20) { fprintf(stderr, "Windowless service spun without work\n"); return -1; }
    struct pollfd descriptor = {.fd = state.fd, .events = POLLIN};
    int result;
    do { result = poll(&descriptor, 1, timeout); } while (result < 0 && errno == EINTR);
    if (result < 0 || descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) return -1;
    if (descriptor.revents & POLLIN) {
        uint64_t value;
        if (read(state.fd, &value, sizeof(value)) != sizeof(value)) return -1;
    }
    return 0;
}
static void stop(void *user) { (void)user; if (state.phase++ != 0) state.failed = 1; }
static void closed(void *user) { (void)user; if (state.phase++ != 1) state.failed = 1; }
static void dispose(void *user)
{
    (void)user;
    if (state.phase++ != 2) state.failed = 1;
    if (state.fd >= 0) close(state.fd);
}
int main(int argc, char **argv)
{
    if (argc != 2) return 2;
    const PuGuiHooks hooks = {.install = install, .wait = wait_service, .wake = wake,
        .stop = stop, .windows_closed = closed, .dispose = dispose};
    const PuGuiConfig config = {.script = argv[1], .hooks = &hooks};
    int result = pu_gui_service(&config);
    pu_gui_shutdown();
    if (result || !state.done || !state.waits || !state.finite || state.phase != 3 || state.failed) {
        fprintf(stderr, "Windowless service failed: rc=%d done=%d waits=%d finite=%d phase=%d\n",
            result, state.done, state.waits, state.finite, state.phase);
        return 1;
    }
    puts("PASS: production windowless Document, detached Canvas, timer/task wake and ordered teardown");
    return 0;
}
