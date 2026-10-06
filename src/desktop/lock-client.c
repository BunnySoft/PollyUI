#define _GNU_SOURCE
#include "lock-client.h"
#include "session-lock-client.h"
#include "auth-protocol.h"
#include <SDL3/SDL.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>
#include <wayland-client.h>

static struct {
    JSContext *ctx;
    JSValue api;
    struct wl_display *display;
    struct ext_session_lock_manager_v1 *manager;
    struct ext_session_lock_v1 *lock;
    bool locked, unlocked, failed, changed;
    pid_t pid;
    int fd;
    uint32_t serial;
    struct PuAuthReply reply;
    size_t received;
    Uint64 deadline, next_attempt;
    char error[192];
} client;

static void error(const char *message)
{
    snprintf(client.error, sizeof(client.error), "%s", message);
    client.changed = true;
    fprintf(stderr, "[lock] %s\n", message);
}
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version)
{
    (void)data; (void)version;
    if (!client.manager && !strcmp(interface, "ext_session_lock_manager_v1"))
        client.manager = wl_registry_bind(registry, name, &ext_session_lock_manager_v1_interface, 1);
}
static void global_removed(void *data, struct wl_registry *registry, uint32_t name)
{ (void)data; (void)registry; (void)name; }
static const struct wl_registry_listener registry_listener = {.global = global, .global_remove = global_removed};
static void synced(void *data, struct wl_callback *callback, uint32_t serial)
{ (void)callback; (void)serial; *(bool *)data = true; }
static const struct wl_callback_listener sync_listener = {.done = synced};
static bool roundtrip(void)
{
    bool ready = false;
    struct wl_callback *callback = wl_display_sync(client.display);
    if (!callback) return false;
    wl_callback_add_listener(callback, &sync_listener, &ready);
    Uint64 deadline = SDL_GetTicks() + 3000;
    while (!ready && SDL_GetTicks() < deadline) {
        if (wl_display_flush(client.display) < 0 && errno != EAGAIN && errno != EINTR) break;
        SDL_PumpEvents();
        if (wl_display_get_error(client.display)) break;
        if (!ready) SDL_Delay(1);
    }
    wl_callback_destroy(callback);
    return ready && !wl_display_get_error(client.display);
}
static void locked(void *data, struct ext_session_lock_v1 *lock)
{ (void)data; (void)lock; client.locked = client.changed = true; }
static void finished(void *data, struct ext_session_lock_v1 *lock)
{
    (void)data; (void)lock;
    client.failed = true; error("Session lock request was not accepted");
}
static const struct ext_session_lock_v1_listener lock_listener = {.locked = locked, .finished = finished};
static JSValue state(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    JSValue value = JS_NewObject(ctx);
    if (JS_IsException(value)) return value;
    if (JS_SetPropertyStr(ctx, value, "locked", JS_NewBool(ctx, client.locked)) < 0 ||
        JS_SetPropertyStr(ctx, value, "unlocked", JS_NewBool(ctx, client.unlocked)) < 0 ||
        JS_SetPropertyStr(ctx, value, "busy", JS_NewBool(ctx, client.pid != 0)) < 0 ||
        JS_SetPropertyStr(ctx, value, "retryMs", JS_NewUint32(ctx,
            client.next_attempt > SDL_GetTicks() ? (uint32_t)(client.next_attempt - SDL_GetTicks()) : 0)) < 0 ||
        JS_SetPropertyStr(ctx, value, "error", JS_NewString(ctx, client.error)) < 0) {
        JS_FreeValue(ctx, value); return JS_EXCEPTION;
    }
    return value;
}
static void auth_cleanup(bool terminate)
{
    if (client.fd >= 0) close(client.fd);
    client.fd = -1;
    if (terminate && client.pid) {
        if (kill(client.pid, SIGKILL) < 0 && errno != ESRCH) error("Cannot stop authentication helper");
        int status;
        while (waitpid(client.pid, &status, 0) < 0) {
            if (errno == EINTR) continue;
            if (errno != ECHILD) error("Cannot reap authentication helper");
            break;
        }
    }
    client.pid = 0;
}
static JSValue authenticate(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc != 1 || !JS_IsString(argv[0]) || !client.locked || client.unlocked || client.failed)
        return JS_ThrowTypeError(ctx, "Authentication requires an active lock and a password");
    if (client.pid || SDL_GetTicks() < client.next_attempt)
        return JS_ThrowTypeError(ctx, "Authentication is busy or waiting before retry");
    size_t length;
    const char *password = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!password) return JS_EXCEPTION;
    if (!length || length > PU_AUTH_PASSWORD_LIMIT || memchr(password, 0, length)) {
        JS_FreeCString(ctx, password); return JS_ThrowTypeError(ctx, "Invalid password length");
    }
    char executable[PATH_MAX];
    ssize_t count = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (count <= 0 || count >= (ssize_t)sizeof(executable) - 1) {
        JS_FreeCString(ctx, password); return JS_ThrowInternalError(ctx, "Cannot locate authentication helper");
    }
    executable[count] = 0;
    char *slash = strrchr(executable, '/');
    if (!slash || (size_t)(slash - executable) + sizeof("/polly-auth-check") > sizeof(executable)) {
        JS_FreeCString(ctx, password); return JS_ThrowInternalError(ctx, "Invalid helper location");
    }
    strcpy(slash, "/polly-auth-check");
    int sockets[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets)) {
        JS_FreeCString(ctx, password); return JS_ThrowInternalError(ctx, "Cannot create authentication channel");
    }
    posix_spawn_file_actions_t actions;
    bool ready = false;
    int failure = posix_spawn_file_actions_init(&actions);
    if (!failure) {
        ready = true;
        failure = posix_spawn_file_actions_addclose(&actions, sockets[0]);
        if (!failure) failure = posix_spawn_file_actions_adddup2(&actions, sockets[1], 3);
        if (!failure && sockets[1] != 3) failure = posix_spawn_file_actions_addclose(&actions, sockets[1]);
    }
    char *arguments[] = {executable, NULL};
    char *environment[] = {"PATH=/usr/sbin:/usr/bin:/sbin:/bin", NULL};
    if (!failure) failure = posix_spawn(&client.pid, executable, &actions, NULL, arguments, environment);
    if (ready) posix_spawn_file_actions_destroy(&actions);
    close(sockets[1]);
    if (failure) {
        close(sockets[0]); client.pid = 0; JS_FreeCString(ctx, password);
        return JS_ThrowInternalError(ctx, "Cannot start authentication helper: %s", strerror(failure));
    }
    client.fd = sockets[0];
    if (!++client.serial) ++client.serial;
    struct PuAuthRequest request = {PU_AUTH_MAGIC, client.serial, (uint32_t)length};
    unsigned char bytes[sizeof(request) + PU_AUTH_PASSWORD_LIMIT];
    memcpy(bytes, &request, sizeof(request)); memcpy(bytes + sizeof(request), password, length);
    JS_FreeCString(ctx, password);
    ssize_t sent = send(client.fd, bytes, sizeof(request) + length, MSG_NOSIGNAL | MSG_DONTWAIT);
    explicit_bzero(bytes, sizeof(bytes));
    if (sent != (ssize_t)(sizeof(request) + length) || fcntl(client.fd, F_SETFL, O_NONBLOCK)) {
        auth_cleanup(true); return JS_ThrowInternalError(ctx, "Cannot submit authentication request");
    }
    client.received = 0; memset(&client.reply, 0, sizeof(client.reply));
    client.deadline = SDL_GetTicks() + 32000;
    client.error[0] = 0; client.changed = true;
    return JS_UNDEFINED;
}
struct ext_session_lock_surface_v1 *pu_lock_client_surface(struct wl_surface *surface, struct wl_output *output)
{
    if (!client.lock || client.failed || client.unlocked || !output) {
        SDL_SetError("Lock surface requires the dedicated active lock service"); return NULL;
    }
    return ext_session_lock_v1_get_lock_surface(client.lock, surface, output);
}
int pu_lock_client_install(JSContext *ctx)
{
    client.ctx = ctx; client.fd = -1;
    struct rlimit no_core = {0, 0};
    if (setrlimit(RLIMIT_CORE, &no_core) || prctl(PR_SET_DUMPABLE, 0)) {
        error("Cannot disable lock-service memory dumps"); return 0;
    }
    client.display = SDL_GetPointerProperty(SDL_GetGlobalProperties(), SDL_PROP_GLOBAL_VIDEO_WAYLAND_WL_DISPLAY_POINTER, NULL);
    if (!client.display) { error("Session locking requires Wayland"); return 0; }
    struct wl_registry *registry = wl_display_get_registry(client.display);
    if (!registry) return 0;
    wl_registry_add_listener(registry, &registry_listener, NULL);
    bool ok = roundtrip() && client.manager;
    wl_registry_destroy(registry);
    if (!ok) { error("This connection is not authorized as the lock service"); return 0; }
    client.lock = ext_session_lock_manager_v1_lock(client.manager);
    if (!client.lock || ext_session_lock_v1_add_listener(client.lock, &lock_listener, NULL) < 0) return 0;
    client.api = JS_NewObject(ctx);
    if (JS_IsException(client.api)) return 0;
    if (JS_SetPropertyStr(ctx, client.api, "state", JS_NewCFunction(ctx, state, "state", 0)) < 0 ||
        JS_SetPropertyStr(ctx, client.api, "authenticate", JS_NewCFunction(ctx, authenticate, "authenticate", 1)) < 0 ||
        JS_SetPropertyStr(ctx, client.api, "onChanged", JS_NULL) < 0) return 0;
    JSValue global = JS_GetGlobalObject(ctx);
    int result = JS_SetPropertyStr(ctx, global, "sessionLock", JS_DupValue(ctx, client.api));
    JS_FreeValue(ctx, global);
    return result >= 0;
}
int pu_lock_client_pump(void)
{
    if (!client.ctx) return 0;
    if (client.failed || wl_display_get_error(client.display)) {
        if (!client.failed) error("Lock compositor connection was lost");
        client.failed = true; return -1;
    }
    if (client.pid) {
        while (client.received < sizeof(client.reply)) {
            ssize_t count = recv(client.fd, (char *)&client.reply + client.received,
                sizeof(client.reply) - client.received, 0);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) break;
            client.received += (size_t)count;
        }
        int status;
        pid_t ended = waitpid(client.pid, &status, WNOHANG);
        if (ended < 0 && errno != EINTR) {
            auth_cleanup(false); error("Authentication helper state was lost");
        } else if (ended > 0) {
            auth_cleanup(false);
            client.next_attempt = SDL_GetTicks() + 2000;
            if (!WIFEXITED(status) || WEXITSTATUS(status) != 0 || client.received != sizeof(client.reply) ||
                client.reply.magic != PU_AUTH_MAGIC || client.reply.serial != client.serial) {
                error("Authentication service did not return a valid result");
            } else if (client.reply.result == PU_AUTH_ACCEPTED) {
                ext_session_lock_v1_unlock_and_destroy(client.lock); client.lock = NULL;
                if (!roundtrip()) { client.failed = true; error("Could not confirm the unlock request"); return -1; }
                client.unlocked = true; client.locked = false; client.changed = true;
            } else error(client.reply.result == PU_AUTH_DENIED ? "Password was not accepted" : "Authentication is unavailable for this account");
        } else if (SDL_GetTicks() >= client.deadline) {
            auth_cleanup(true); error("Authentication request timed out");
            client.next_attempt = SDL_GetTicks() + 2000;
        }
    }
    if (!client.changed) return 0;
    client.changed = false;
    JSValue callback = JS_GetPropertyStr(client.ctx, client.api, "onChanged"), result = JS_UNDEFINED;
    if (JS_IsException(callback)) result = JS_EXCEPTION;
    else if (JS_IsFunction(client.ctx, callback)) result = JS_Call(client.ctx, callback, client.api, 0, NULL);
    else if (!JS_IsNull(callback) && !JS_IsUndefined(callback))
        result = JS_ThrowTypeError(client.ctx, "Lock callback must be a function");
    JS_FreeValue(client.ctx, callback);
    if (JS_IsException(result)) {
        JSValue exception = JS_GetException(client.ctx);
        const char *message = JS_ToCString(client.ctx, exception);
        fprintf(stderr, "[lock] UI callback failed: %s\n", message ? message : "unknown");
        JS_FreeCString(client.ctx, message); JS_FreeValue(client.ctx, exception);
        client.failed = true; return -1;
    }
    JS_FreeValue(client.ctx, result);
    return 1;
}
void pu_lock_client_shutdown(void)
{
    if (!client.ctx) return;
    auth_cleanup(true);
    if (client.lock) wl_proxy_destroy((struct wl_proxy *)client.lock);
    if (client.manager) ext_session_lock_manager_v1_destroy(client.manager);
    JS_FreeValue(client.ctx, client.api);
    memset(&client, 0, sizeof(client));
}
