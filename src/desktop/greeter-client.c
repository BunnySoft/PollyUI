#define _GNU_SOURCE
#include "greeter-client.h"
#include "greeter-protocol.h"
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pwd.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

enum Stage { STATUS, SETUP, PREPARED, COMMIT, CANCEL_SETUP, RESET_LOGIN, AUTH, START, CANCEL_LOGIN };
static struct {
    JSContext *ctx;
    JSValue api, resolve, reject;
    int fd;
    enum Stage stage;
    bool login, cancel, secret_sent, handoff;
    unsigned messages, reset_attempts;
    uint64_t deadline;
    char socket[sizeof(((struct sockaddr_un *)0)->sun_path)];
    char password[PU_GREETER_PASSWORD_LIMIT + 1];
    unsigned char output[8192], input[8193];
    size_t output_size, sent, received, expected;
} client = {.fd = -1};

static uint64_t now_ms(void)
{
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value)) return UINT64_MAX;
    return (uint64_t)value.tv_sec * 1000u + (uint64_t)value.tv_nsec / 1000000u;
}

static void callback_error(void)
{
    JSValue error = JS_GetException(client.ctx);
    JS_FreeValue(client.ctx, error);
    fprintf(stderr, "[greeter] Account UI callback failed (details withheld)\n");
}

static void progress(const char *phase)
{
    JSValue callback = JS_GetPropertyStr(client.ctx, client.api, "onProgress");
    if (JS_IsFunction(client.ctx, callback)) {
        JSValue value = JS_NewString(client.ctx, phase);
        JSValue result = JS_Call(client.ctx, callback, client.api, 1, &value);
        if (JS_IsException(result)) callback_error();
        JS_FreeValue(client.ctx, value); JS_FreeValue(client.ctx, result);
    } else if (JS_IsException(callback)) callback_error();
    JS_FreeValue(client.ctx, callback);
}

static void clear_transport(void)
{
    if (client.fd >= 0) close(client.fd);
    client.fd = -1;
    explicit_bzero(client.password, sizeof(client.password));
    explicit_bzero(client.output, sizeof(client.output));
    explicit_bzero(client.input, sizeof(client.input));
    client.output_size = client.sent = client.received = client.expected = 0;
}

static void best_effort_cancel(void)
{
    if (client.fd < 0 || client.handoff) return;
    if (client.login) {
        const char json[] = "{\"type\":\"cancel_session\"}";
        unsigned char packet[sizeof(uint32_t) + sizeof(json) - 1];
        uint32_t length = sizeof(json) - 1;
        memcpy(packet, &length, sizeof(length)); memcpy(packet + sizeof(length), json, length);
        if (send(client.fd, packet, sizeof(packet), MSG_NOSIGNAL | MSG_DONTWAIT) != (ssize_t)sizeof(packet))
            fprintf(stderr, "[greeter] Login cancellation could not be delivered; next attempt resets the session\n");
    } else if (client.stage != STATUS && client.stage != COMMIT) {
        struct PuGreeterRequest request = {PU_GREETER_MAGIC, PU_GREETER_CANCEL, 0, 0};
        if (send(client.fd, &request, sizeof(request), MSG_NOSIGNAL | MSG_DONTWAIT) != (ssize_t)sizeof(request))
            fprintf(stderr, "[greeter] Setup disconnected before cancellation acknowledgement\n");
    }
}

static void finish(const char *result, const char *code)
{
    /* Closing a login transport is not followed by a fire-and-forget cancel:
       greetd's failed write handler could otherwise cancel the next connection.
       The next attempt first waits for a confirmed reset on its own transport. */
    if (code && !client.login) best_effort_cancel();
    clear_transport();
    JSValue resolve = client.resolve, reject = client.reject;
    client.resolve = client.reject = JS_UNDEFINED;
    JSValue value;
    if (code) {
        fprintf(stderr, "[greeter] Fixed account request failed: %s\n", code);
        value = JS_NewError(client.ctx);
        JS_SetPropertyStr(client.ctx, value, "code", JS_NewString(client.ctx, code));
        JS_SetPropertyStr(client.ctx, value, "message", JS_NewString(client.ctx, "Fixed account request failed"));
    } else value = JS_NewString(client.ctx, result);
    JSValue returned = JS_Call(client.ctx, code ? reject : resolve, JS_UNDEFINED, 1, &value);
    if (JS_IsException(returned)) callback_error();
    JS_FreeValue(client.ctx, returned); JS_FreeValue(client.ctx, value);
    JS_FreeValue(client.ctx, resolve); JS_FreeValue(client.ctx, reject);
}

static bool queue(const void *data, size_t size)
{
    if (client.output_size != client.sent || size > sizeof(client.output)) return false;
    explicit_bzero(client.output, sizeof(client.output));
    memcpy(client.output, data, size);
    client.output_size = size; client.sent = 0;
    client.received = 0;
    client.expected = client.login ? sizeof(uint32_t) : sizeof(struct PuGreeterResponse);
    return true;
}

static bool setup_command(enum PuGreeterOperation operation)
{
    struct PuGreeterRequest request = {PU_GREETER_MAGIC, (uint32_t)operation, 0, 0};
    size_t received = client.received, expected = client.expected;
    bool result = queue(&request, sizeof(request));
    if (operation == PU_GREETER_CANCEL) { client.received = received; client.expected = expected; }
    return result;
}

static bool login_command(const char *json)
{
    size_t size = strlen(json);
    unsigned char packet[8192];
    if (size > sizeof(packet) - sizeof(uint32_t)) return false;
    uint32_t length = (uint32_t)size;
    memcpy(packet, &length, sizeof(length)); memcpy(packet + sizeof(length), json, size);
    bool result = queue(packet, sizeof(length) + size);
    explicit_bzero(packet, sizeof(packet));
    return result;
}

static bool password_response(void)
{
    char json[8192];
    const char prefix[] = "{\"type\":\"post_auth_message_response\",\"response\":\"";
    size_t offset = sizeof(prefix) - 1;
    memcpy(json, prefix, offset);
    for (const unsigned char *p = (unsigned char *)client.password; *p; p++) {
        if (*p == '"' || *p == '\\') { json[offset++] = '\\'; json[offset++] = (char)*p; }
        else if (*p < 32) {
            int count = snprintf(json + offset, sizeof(json) - offset, "\\u%04x", *p);
            if (count != 6) { explicit_bzero(json, sizeof(json)); return false; }
            offset += 6;
        } else json[offset++] = (char)*p;
    }
    memcpy(json + offset, "\"}", 3);
    bool result = login_command(json);
    explicit_bzero(json, sizeof(json)); explicit_bzero(client.password, sizeof(client.password));
    client.secret_sent = true;
    return result;
}

static int connect_service(const char *path, bool login)
{
    struct stat info;
    struct passwd *greeter = getpwnam("polly-greeter");
    if (!greeter || lstat("/run", &info) || !S_ISDIR(info.st_mode) || info.st_uid || (info.st_mode & 022)) return -1;
    if (!login && (lstat("/run/polly-greeter", &info) || !S_ISDIR(info.st_mode) || info.st_uid || (info.st_mode & 022))) return -1;
    if (!path || strlen(path) >= sizeof(client.socket) || lstat(path, &info) || !S_ISSOCK(info.st_mode) ||
        info.st_uid != greeter->pw_uid || (info.st_mode & 022)) return -1;
    if (login) {
        const char prefix[] = "/run/greetd-";
        if (strncmp(path, prefix, sizeof(prefix) - 1)) return -1;
        const char *p = path + sizeof(prefix) - 1, *start = p;
        while (*p >= '0' && *p <= '9') p++;
        if (p == start || strcmp(p, ".sock")) return -1;
    }
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return -1;
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    strcpy(address.sun_path, path);
    struct ucred peer;
    socklen_t size = sizeof(peer);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) ||
        getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) || peer.uid != 0) {
        close(fd); return -1;
    }
    strcpy(client.socket, path);
    return fd;
}

static JSValue begin(JSContext *ctx, enum Stage stage, int argc, JSValueConst *argv)
{
    int wanted = stage == STATUS ? 0 : stage == SETUP ? 2 : 1;
    if (argc != wanted || client.fd >= 0 || client.handoff) return JS_ThrowTypeError(ctx, "Invalid or busy fixed greeter request");
    unsigned char packet[sizeof(struct PuGreeterRequest) + PU_GREETER_PASSWORD_LIMIT * 2];
    struct PuGreeterRequest header = {PU_GREETER_MAGIC, stage == SETUP ? PU_GREETER_SETUP : PU_GREETER_STATUS, 0, 0};
    size_t offset = sizeof(header);
    for (int i = 0; i < argc; i++) {
        size_t length = 0;
        const char *password = JS_IsString(argv[i]) ? JS_ToCStringLen(ctx, &length, argv[i]) : NULL;
        if (!password || !length || length > PU_GREETER_PASSWORD_LIMIT ||
            memchr(password, 0, length) || memchr(password, '\n', length) || memchr(password, '\r', length)) {
            if (password) JS_FreeCString(ctx, password);
            explicit_bzero(packet, sizeof(packet)); explicit_bzero(client.password, sizeof(client.password));
            return JS_ThrowTypeError(ctx, "Passwords must be nonempty single-line UTF-8, at most 1024 bytes");
        }
        if (stage == AUTH) {
            memcpy(client.password, password, length); client.password[length] = 0;
        } else {
            memcpy(packet + offset, password, length); offset += length;
            if (i == 0) header.polly_length = (uint32_t)length; else header.root_length = (uint32_t)length;
        }
        JS_FreeCString(ctx, password);
    }
    client.login = stage == AUTH; client.cancel = client.secret_sent = false;
    client.messages = client.reset_attempts = 0; client.stage = client.login ? RESET_LOGIN : stage;
    client.deadline = now_ms();
    if (client.deadline == UINT64_MAX) {
        explicit_bzero(packet, sizeof(packet)); clear_transport();
        return JS_ThrowInternalError(ctx, "Cannot establish account request deadline");
    }
    client.deadline += stage == SETUP ? 100000u : 45000u;
    client.fd = connect_service(client.login ? getenv("GREETD_SOCK") : PU_GREETER_SETUP_SOCKET, client.login);
    if (client.fd < 0) {
        explicit_bzero(packet, sizeof(packet)); clear_transport();
        return JS_ThrowInternalError(ctx, "Fixed account service is unavailable or untrusted");
    }
    JSValue callbacks[2];
    JSValue promise = JS_NewPromiseCapability(ctx, callbacks);
    if (JS_IsException(promise)) { explicit_bzero(packet, sizeof(packet)); clear_transport(); return promise; }
    client.resolve = callbacks[0]; client.reject = callbacks[1];
    memcpy(packet, &header, sizeof(header));
    bool ok = client.login ? login_command("{\"type\":\"cancel_session\"}") : queue(packet, offset);
    explicit_bzero(packet, sizeof(packet));
    if (!ok) finish(NULL, "unavailable");
    return promise;
}

static JSValue status(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{ (void)self; return begin(ctx, STATUS, argc, argv); }
static JSValue setup(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{ (void)self; return begin(ctx, SETUP, argc, argv); }
static JSValue login(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{ (void)self; return begin(ctx, AUTH, argc, argv); }
static JSValue cancel(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argv;
    if (argc || client.fd < 0 || client.stage == STATUS || client.stage == COMMIT ||
        client.stage == START || client.handoff) return JS_ThrowTypeError(ctx, "No cancellable account request");
    client.cancel = true;
    explicit_bzero(client.password, sizeof(client.password));
    return JS_UNDEFINED;
}

static void setup_reply(void)
{
    struct PuGreeterResponse reply;
    memcpy(&reply, client.input, sizeof(reply));
    if (reply.magic != PU_GREETER_MAGIC) { finish(NULL, "unavailable"); return; }
    if (client.stage == STATUS) {
        if (reply.result == PU_GREETER_NEEDS_SETUP || reply.result == PU_GREETER_LOGIN)
            finish(reply.result == PU_GREETER_LOGIN ? "login" : "setup", NULL);
        else finish(NULL, "unavailable");
        return;
    }
    if (reply.result == PU_GREETER_PASSWORD_POLICY) { finish(NULL, "password-policy"); return; }
    if (reply.result == PU_GREETER_UNAVAILABLE) { finish(NULL, "unavailable"); return; }
    if (reply.result == PU_GREETER_CANCELLED && client.stage != COMMIT) { finish("cancelled", NULL); return; }
    if (reply.result == PU_GREETER_COMPLETE && client.stage == COMMIT) { finish("login", NULL); return; }
    if (reply.result == PU_GREETER_COMMITTING && client.stage == COMMIT) progress("committing");
    else if (reply.result == PU_GREETER_POLLY && (client.stage == SETUP || client.stage == CANCEL_SETUP)) {
        if (client.stage == SETUP) progress("polly");
    } else if (reply.result == PU_GREETER_ROOT && (client.stage == SETUP || client.stage == CANCEL_SETUP)) {
        if (client.stage == SETUP) progress("root");
    }
    else if (reply.result == PU_GREETER_PREPARED && (client.stage == SETUP || client.stage == CANCEL_SETUP)) {
        if (client.stage == SETUP) { client.stage = PREPARED; progress("prepared"); }
    } else { finish(NULL, "unavailable"); return; }
    client.received = 0; client.expected = sizeof(reply);
}

static void login_reply(void)
{
    JSContext *ctx = client.ctx;
    client.input[client.expected] = 0;
    JSValue value = JS_ParseJSON(ctx, (char *)client.input + sizeof(uint32_t),
                                client.expected - sizeof(uint32_t), "<greetd>");
    if (JS_IsException(value)) { callback_error(); finish(NULL, "unavailable"); return; }
    JSValue property = JS_GetPropertyStr(ctx, value, "type");
    const char *type = JS_ToCString(ctx, property);
    bool ok = false, done = false;
    const char *code = NULL;
    if (!type || ++client.messages > 24) code = "unavailable";
    else if (client.cancel && client.stage != CANCEL_LOGIN) {
        client.stage = CANCEL_LOGIN;
        ok = login_command("{\"type\":\"cancel_session\"}");
    } else if (!strcmp(type, "error") && client.stage == RESET_LOGIN && !client.reset_attempts++) {
        fprintf(stderr, "[greeter] Retrying a failed session reset; login still requires a confirmed clean session\n");
        ok = login_command("{\"type\":\"cancel_session\"}");
    } else if (!strcmp(type, "error")) {
        JSValue kind = JS_GetPropertyStr(ctx, value, "error_type");
        const char *text = JS_ToCString(ctx, kind);
        code = text && !strcmp(text, "auth_error") ? "denied" : "unavailable";
        JS_FreeCString(ctx, text); JS_FreeValue(ctx, kind);
    } else if (!strcmp(type, "success")) {
        if (client.stage == RESET_LOGIN) {
            client.stage = AUTH;
            ok = login_command("{\"type\":\"create_session\",\"username\":\"polly\"}");
        } else if (client.stage == AUTH) {
            if (!client.secret_sent) code = "unavailable";
            else {
                client.stage = START;
                progress("handoff");
                ok = login_command("{\"type\":\"start_session\",\"cmd\":[\"/usr/bin/polly-installed-session\"],"
                                   "\"env\":[\"XDG_SESSION_TYPE=wayland\",\"XDG_CURRENT_DESKTOP=Polly\"]}");
            }
        } else if (client.stage == START) { client.handoff = true; done = true; }
        else if (client.stage == CANCEL_LOGIN) done = true;
        else code = "unavailable";
    } else if (!strcmp(type, "auth_message") && client.stage == AUTH) {
        JSValue kind = JS_GetPropertyStr(ctx, value, "auth_message_type");
        const char *text = JS_ToCString(ctx, kind);
        if (text && !strcmp(text, "secret") && !client.secret_sent) ok = password_response();
        else if (text && (!strcmp(text, "info") || !strcmp(text, "error")))
            ok = login_command("{\"type\":\"post_auth_message_response\",\"response\":null}");
        else code = "unavailable";
        JS_FreeCString(ctx, text); JS_FreeValue(ctx, kind);
    } else code = "unavailable";
    JS_FreeCString(ctx, type); JS_FreeValue(ctx, property); JS_FreeValue(ctx, value);
    if (done) finish(client.handoff ? "handoff" : "cancelled", NULL);
    else if (code || !ok) finish(NULL, code ? code : "unavailable");
}

int pu_greeter_client_install(JSContext *ctx)
{
    struct passwd *greeter = getpwnam("polly-greeter");
    struct rlimit no_core = {0, 0};
    if (client.ctx || !greeter || !greeter->pw_uid || greeter->pw_uid >= 1000 ||
        getuid() != greeter->pw_uid || geteuid() != getuid() || getgid() != greeter->pw_gid ||
        getegid() != getgid() || setrlimit(RLIMIT_CORE, &no_core) || prctl(PR_SET_DUMPABLE, 0)) return 0;
    client.ctx = ctx; client.resolve = client.reject = JS_UNDEFINED;
    client.api = JS_NewObject(ctx);
    if (JS_IsException(client.api)) return 0;
    if (JS_SetPropertyStr(ctx, client.api, "status", JS_NewCFunction(ctx, status, "status", 0)) < 0 ||
        JS_SetPropertyStr(ctx, client.api, "setup", JS_NewCFunction(ctx, setup, "setup", 2)) < 0 ||
        JS_SetPropertyStr(ctx, client.api, "login", JS_NewCFunction(ctx, login, "login", 1)) < 0 ||
        JS_SetPropertyStr(ctx, client.api, "cancel", JS_NewCFunction(ctx, cancel, "cancel", 0)) < 0 ||
        JS_SetPropertyStr(ctx, client.api, "onProgress", JS_NULL) < 0) return 0;
    JSValue global = JS_GetGlobalObject(ctx);
    int result = JS_SetPropertyStr(ctx, global, "graphicalAuth", JS_DupValue(ctx, client.api));
    JS_FreeValue(ctx, global);
    return result >= 0;
}

int pu_greeter_client_pump(void)
{
    if (!client.ctx || client.fd < 0) return 0;
    if (now_ms() >= client.deadline) { finish(NULL, "unavailable"); return 0; }
    if (!client.login && client.output_size == client.sent) {
        if (client.cancel && client.stage != CANCEL_SETUP && client.stage != COMMIT) {
            client.stage = CANCEL_SETUP;
            if (!setup_command(PU_GREETER_CANCEL)) { finish(NULL, "unavailable"); return 0; }
        } else if (client.stage == PREPARED) {
            client.stage = COMMIT;
            progress("committing");
            if (!setup_command(PU_GREETER_COMMIT)) { finish(NULL, "unavailable"); return 0; }
        }
    }
    if (client.sent < client.output_size) {
        ssize_t count = send(client.fd, client.output + client.sent, client.output_size - client.sent, MSG_NOSIGNAL);
        if (count < 0 && (errno == EAGAIN || errno == EINTR)) return 0;
        if (count <= 0) { finish(NULL, "unavailable"); return 0; }
        explicit_bzero(client.output + client.sent, (size_t)count);
        client.sent += (size_t)count;
        if (client.sent < client.output_size) return 0;
    }
    for (int i = 0; i < 8 && client.fd >= 0; i++) {
        ssize_t count = recv(client.fd, client.input + client.received, client.expected - client.received, 0);
        if (count < 0 && (errno == EAGAIN || errno == EINTR)) break;
        if (count <= 0) { finish(NULL, "unavailable"); break; }
        client.received += (size_t)count;
        if (client.received != client.expected) continue;
        if (client.login && client.expected == sizeof(uint32_t)) {
            uint32_t length;
            memcpy(&length, client.input, sizeof(length));
            if (!length || length > sizeof(client.input) - sizeof(length) - 1) { finish(NULL, "unavailable"); break; }
            client.expected += length;
            continue;
        }
        if (client.login) login_reply(); else setup_reply();
        break;
    }
    return 0;
}

void pu_greeter_client_shutdown(void)
{
    if (!client.ctx) return;
    best_effort_cancel(); clear_transport();
    JS_FreeValue(client.ctx, client.resolve); JS_FreeValue(client.ctx, client.reject);
    JS_FreeValue(client.ctx, client.api);
    client.ctx = NULL;
}
