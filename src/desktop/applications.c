#define _GNU_SOURCE
#include "desktop/applications.h"
#include "desktop/session-bus.h"
#include "desktop/bundles.h"
#include "core/thread.h"
#if defined(PU_LAYER_SHELL)
#include "desktop/windows.h"
#include "desktop/notifications.h"
#include "desktop/tray.h"
#include "desktop/network.h"
#include "desktop/audio.h"
#include "desktop/power.h"
#endif

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
struct AppProcess { pid_t pid; char *id; struct AppProcess *next; };
static struct AppProcess *processes;
static JSContext *context;
static JSValue desktop_api;

#define ACTIVATION_LIMIT 8
#define ACTIVATION_TIMEOUT_MS 3000
struct AppActivation {
    DBusPendingCall *pending;
    JSValue resolve, reject;
    long long deadline;
    char id[264], name[256], path[257];
    struct AppActivation *next;
};
static struct AppActivation *activations;
static unsigned activation_count;
static DBusConnection *activation_bus;
static char *activation_address;

static void report_exception(void)
{
    JSValue exception = JS_GetException(context);
    const char *message = JS_ToCString(context, exception);
    fprintf(stderr, "[applications] Exit callback failed: %s\n", message ? message : "error");
    JS_FreeCString(context, message);
    JS_FreeValue(context, exception);
}

static bool activation_target(const char *id, size_t size, char *name, char *path)
{
    if (size < 11 || size > 263 || memchr(id, 0, size) || memcmp(id + size - 8, ".desktop", 8)) return false;
    size_t length = size - 8;
    bool start = true, dot = false;
    path[0] = '/';
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char)id[i];
        if (c == '.') {
            if (start) return false;
            dot = true; start = true;
        } else {
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c == '-' ||
                  (!start && c >= '0' && c <= '9'))) return false;
            start = false;
        }
        name[i] = (char)c;
        path[i + 1] = c == '.' ? '/' : c == '-' ? '_' : (char)c;
    }
    name[length] = 0; path[length + 1] = 0;
    return dot && !start;
}

static void close_activation_bus(void)
{
    if (activation_bus) {
        dbus_connection_close(activation_bus);
        dbus_connection_unref(activation_bus);
        activation_bus = NULL;
    }
    free(activation_address); activation_address = NULL;
}

static JSValue can_activate_application(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    char *address = pu_session_bus_address();
    bool available = address && strcmp(address, "disabled:");
    free(address);
    return JS_NewBool(ctx, available);
}

static JSValue activate_application(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc != 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "activateApplication requires a desktop-file ID");
    size_t size;
    const char *id = JS_ToCStringLen(ctx, &size, argv[0]);
    if (!id) return JS_EXCEPTION;
    char name[256], path[257];
    bool valid = activation_target(id, size, name, path);
    if (!valid) {
        JS_FreeCString(ctx, id);
        return JS_ThrowTypeError(ctx, "Invalid D-Bus application desktop ID");
    }
    if (activation_count >= ACTIVATION_LIMIT) {
        JS_FreeCString(ctx, id);
        return JS_ThrowRangeError(ctx, "D-Bus application activation queue is full");
    }
    char *address = pu_session_bus_address();
    if (!address || !strcmp(address, "disabled:") ||
        (activation_address && strcmp(address, activation_address))) {
        free(address); JS_FreeCString(ctx, id);
        return JS_ThrowInternalError(ctx, "D-Bus activation requires an unchanged qualified private session bus");
    }
    if (!activation_bus) {
        char error[256];
        activation_bus = pu_session_bus_connect(error, sizeof(error));
        if (!activation_bus) {
            free(address); JS_FreeCString(ctx, id);
            return JS_ThrowInternalError(ctx, "%s", error);
        }
        activation_address = address; address = NULL;
        dbus_connection_set_max_received_size(activation_bus, 64 * 1024);
        dbus_connection_set_max_message_size(activation_bus, 16 * 1024);
        dbus_connection_set_max_received_unix_fds(activation_bus, 0);
    }
    free(address);
    struct AppActivation *request = calloc(1, sizeof(*request));
    DBusMessage *message = dbus_message_new_method_call(name, path, "org.freedesktop.Application", "Activate");
    JSValue result = JS_EXCEPTION;
    if (!request || !message) { JS_ThrowOutOfMemory(ctx); goto cleanup; }
    strcpy(request->id, id); strcpy(request->name, name); strcpy(request->path, path);
    DBusMessageIter body, dictionary;
    dbus_message_iter_init_append(message, &body);
    if (!dbus_message_iter_open_container(&body, DBUS_TYPE_ARRAY, "{sv}", &dictionary) ||
        !dbus_message_iter_close_container(&body, &dictionary)) {
        JS_ThrowOutOfMemory(ctx); goto cleanup;
    }
    dbus_message_set_auto_start(message, true);
    JSValue callbacks[2];
    result = JS_NewPromiseCapability(ctx, callbacks);
    if (JS_IsException(result)) goto cleanup;
    request->resolve = callbacks[0]; request->reject = callbacks[1];
    if (!dbus_connection_get_is_connected(activation_bus) ||
        !dbus_connection_send_with_reply(activation_bus, message, &request->pending, ACTIVATION_TIMEOUT_MS) ||
        !request->pending) {
        JS_FreeValue(ctx, result); result = JS_EXCEPTION;
        JS_FreeValue(ctx, request->resolve); JS_FreeValue(ctx, request->reject);
        JS_ThrowInternalError(ctx, "Cannot send D-Bus application activation request");
        goto cleanup;
    }
    request->deadline = pu_now_ms() + ACTIVATION_TIMEOUT_MS;
    request->next = activations; activations = request; request = NULL;
    activation_count++;
cleanup:
    if (message) dbus_message_unref(message);
    if (request && request->pending) {
        dbus_pending_call_cancel(request->pending);
        dbus_pending_call_unref(request->pending);
    }
    free(request); JS_FreeCString(ctx, id);
    if (!activations) close_activation_bus();
    return result;
}

static void complete_activation(struct AppActivation *request, DBusMessage *reply,
                                const char *code, const char *message)
{
    char failure[704];
    if (!code && !reply) {
        code = "POLLY_ACTIVATION_TIMEOUT";
        message = "D-Bus activation timed out; delivery is indeterminate (no automatic retry or Exec fallback)";
    } else if (!code && dbus_message_get_type(reply) == DBUS_MESSAGE_TYPE_ERROR) {
        code = dbus_message_get_error_name(reply);
        DBusMessageIter body;
        const char *detail = "";
        if (dbus_message_iter_init(reply, &body) && dbus_message_iter_get_arg_type(&body) == DBUS_TYPE_STRING)
            dbus_message_iter_get_basic(&body, &detail);
        bool indeterminate = code && (!strcmp(code, DBUS_ERROR_NO_REPLY) ||
            !strcmp(code, DBUS_ERROR_DISCONNECTED) || !strcmp(code, DBUS_ERROR_TIMEOUT));
        snprintf(failure, sizeof(failure), "D-Bus activation error %.255s: %.200s%s (no automatic retry or Exec fallback)",
            code ? code : "unknown", detail, indeterminate ? "; delivery is indeterminate" : "");
        message = failure;
        if (!code) code = "POLLY_ACTIVATION_INVALID_REPLY";
    } else if (!code && (dbus_message_get_type(reply) != DBUS_MESSAGE_TYPE_METHOD_RETURN ||
               !dbus_message_has_signature(reply, "") || !dbus_message_get_sender(reply) ||
               dbus_message_get_sender(reply)[0] != ':')) {
        code = "POLLY_ACTIVATION_INVALID_REPLY";
        message = "Invalid D-Bus activation reply; delivery is indeterminate (no automatic retry or Exec fallback)";
    }
    JSValue value;
    if (code) {
        fprintf(stderr, "[applications] %s: %s\n", request->id, message);
        value = JS_NewError(context);
        if (!JS_IsException(value) &&
            (JS_SetPropertyStr(context, value, "code", JS_NewString(context, code)) < 0 ||
             JS_SetPropertyStr(context, value, "message", JS_NewString(context, message)) < 0)) {
            JS_FreeValue(context, value); value = JS_EXCEPTION;
        }
    } else {
        value = JS_NewObject(context);
        if (!JS_IsException(value) &&
            (JS_SetPropertyStr(context, value, "kind", JS_NewString(context, "dbus")) < 0 ||
             JS_SetPropertyStr(context, value, "id", JS_NewString(context, request->id)) < 0 ||
             JS_SetPropertyStr(context, value, "busName", JS_NewString(context, request->name)) < 0 ||
             JS_SetPropertyStr(context, value, "objectPath", JS_NewString(context, request->path)) < 0 ||
             JS_SetPropertyStr(context, value, "acknowledged", JS_NewBool(context, true)) < 0)) {
            JS_FreeValue(context, value); value = JS_EXCEPTION;
        }
    }
    bool failed = code || JS_IsException(value);
    if (JS_IsException(value)) {
        fprintf(stderr, "[applications] Cannot allocate activation completion for %s\n", request->id);
        value = JS_GetException(context);
    }
    JSValue settled = JS_Call(context, failed ? request->reject : request->resolve, JS_UNDEFINED, 1, &value);
    if (JS_IsException(settled)) report_exception();
    JS_FreeValue(context, settled); JS_FreeValue(context, value);
    JS_FreeValue(context, request->resolve); JS_FreeValue(context, request->reject);
    dbus_pending_call_cancel(request->pending);
    dbus_pending_call_unref(request->pending);
    free(request);
}

static int pump_activations(void)
{
    if (!activations) return 0;
    const char *code = NULL, *message = NULL;
    if (!dbus_connection_read_write(activation_bus, 0)) {
        code = "POLLY_ACTIVATION_DISCONNECTED";
        message = "Private activation bus disconnected; delivery is indeterminate (no automatic retry or Exec fallback)";
    } else {
        for (unsigned i = 0; i < 64 && dbus_connection_get_dispatch_status(activation_bus) == DBUS_DISPATCH_DATA_REMAINS; i++) {
            if (dbus_connection_dispatch(activation_bus) == DBUS_DISPATCH_NEED_MEMORY) {
                code = "POLLY_ACTIVATION_DISPATCH_FAILED";
                message = "Cannot dispatch D-Bus activation reply; delivery is indeterminate (no automatic retry or Exec fallback)";
                break;
            }
        }
    }
    int worked = 0;
    struct AppActivation **slot = &activations;
    while (*slot) {
        struct AppActivation *request = *slot;
        bool done = dbus_pending_call_get_completed(request->pending);
        bool expired = pu_now_ms() >= request->deadline;
        if (!code && !done && !expired) { slot = &request->next; continue; }
        *slot = request->next; activation_count--;
        /* Without a receipt timestamp, a reply dispatched by an overdue pump cannot prove timely acknowledgement. */
        DBusMessage *reply = !expired && !code && done ? dbus_pending_call_steal_reply(request->pending) : NULL;
        complete_activation(request, reply, expired ? NULL : code, expired ? NULL : message);
        if (reply) dbus_message_unref(reply);
        worked++;
    }
    if (!activations) close_activation_bus();
    return worked;
}

static char *join(const char *a, const char *b)
{
    char *value = NULL;
    if (asprintf(&value, "%s/%s", a, b) < 0) return NULL;
    return value;
}

static int runnable_file(const char *path)
{
    struct stat status;
    return stat(path, &status) == 0 && S_ISREG(status.st_mode) && access(path, X_OK) == 0;
}

static char *resolve_executable(const char *name)
{
    if (!*name || strchr(name, '=')) return NULL;
    if (strchr(name, '/')) return name[0] == '/' && runnable_file(name) ? strdup(name) : NULL;
    const char *path = getenv("PATH");
    if (!path) return NULL;
    char *copy = strdup(path);
    if (!copy) return NULL;
    char *save;
    char *found = NULL;
    for (char *part = strtok_r(copy, ":", &save); part; part = strtok_r(NULL, ":", &save)) {
        if (part[0] != '/') continue;
        char *full = join(part, name);
        if (full && runnable_file(full)) found = full;
        else free(full);
        if (found) break;
    }
    free(copy);
    return found;
}

static int scan(JSContext *ctx, JSValue result, uint32_t *count,
                const char *directory, const char *relative, unsigned depth)
{
    if (depth > 32) { fprintf(stderr, "[applications] Directory nesting limit: %s\n", directory); return 1; }
    struct dirent **entries = NULL;
    int length = scandir(directory, &entries, NULL, alphasort);
    if (length < 0) {
        if (errno != ENOENT) fprintf(stderr, "[applications] Cannot scan %s: %s\n", directory, strerror(errno));
        return 1;
    }
    int ok = 1;
    for (int i = 0; i < length && ok; i++) {
        const char *name = entries[i]->d_name;
        if (!strcmp(name, ".") || !strcmp(name, "..")) continue;
        char *path = join(directory, name);
        char *id = *relative ? join(relative, name) : strdup(name);
        if (!path || !id) { free(path); free(id); ok = 0; break; }
        struct stat info;
        if (lstat(path, &info) < 0) {
            fprintf(stderr, "[applications] Cannot inspect %s: %s\n", path, strerror(errno));
        } else if (S_ISDIR(info.st_mode)) {
            ok = scan(ctx, result, count, path, id, depth + 1);
        } else if (strlen(name) > 8 && !strcmp(name + strlen(name) - 8, ".desktop")) {
            char *bytes = NULL;
            size_t size = 0;
            if (S_ISLNK(info.st_mode) && stat(path, &info) < 0) {
                fprintf(stderr, "[applications] Broken entry link: %s\n", path);
            } else if (S_ISREG(info.st_mode)) {
                if (info.st_size < 0 || info.st_size > 1024 * 1024) {
                    fprintf(stderr, "[applications] Entry size limit: %s\n", path);
                } else {
                    int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
                    if (fd < 0) fprintf(stderr, "[applications] Cannot read %s: %s\n", path, strerror(errno));
                    else if (fstat(fd, &info) < 0 || !S_ISREG(info.st_mode) ||
                             info.st_size < 0 || info.st_size > 1024 * 1024) {
                        fprintf(stderr, "[applications] Entry changed or is not a bounded regular file: %s\n", path);
                        close(fd);
                    } else {
                        FILE *file = fdopen(fd, "rb");
                        if (!file) {
                            fprintf(stderr, "[applications] Cannot open entry stream: %s\n", path);
                            close(fd);
                        } else {
                            bytes = malloc((size_t)info.st_size + 1);
                            if (!bytes) ok = 0;
                            else {
                                size = fread(bytes, 1, (size_t)info.st_size, file);
                                if (ferror(file)) {
                                    fprintf(stderr, "[applications] Read failed: %s\n", path);
                                    size = 0;
                                }
                            }
                            fclose(file);
                        }
                    }
                }
            }
            if (*count >= 10000) {
                fprintf(stderr, "[applications] Application count limit reached\n");
                JS_ThrowRangeError(ctx, "Application count limit reached");
                ok = 0;
            }
            if (ok) {
                /* Empty records still mask lower-priority entries with this ID. */
                for (char *p = id; *p; p++) if (*p == '/') *p = '-';
                JSValue item = JS_NewObject(ctx);
                if (JS_IsException(item)) ok = 0;
                else {
                    if (JS_SetPropertyStr(ctx, item, "id", JS_NewString(ctx, id)) < 0 ||
                        JS_SetPropertyStr(ctx, item, "path", JS_NewString(ctx, path)) < 0 ||
                        JS_SetPropertyStr(ctx, item, "contents", JS_NewStringLen(ctx, bytes ? bytes : "", size)) < 0) {
                        JS_FreeValue(ctx, item);
                        ok = 0;
                    } else if (JS_SetPropertyUint32(ctx, result, (*count)++, item) < 0) ok = 0;
                }
            }
            free(bytes);
        }
        free(path);
        free(id);
    }
    for (int i = 0; i < length; i++) free(entries[i]);
    free(entries);
    return ok;
}

static JSValue read_applications(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    const char *home = getenv("XDG_DATA_HOME");
    char *fallback = NULL;
    if (!home || !*home) {
        const char *user = getenv("HOME");
        if (!user || user[0] != '/') return JS_ThrowTypeError(ctx, "Absolute HOME or XDG_DATA_HOME is required");
        fallback = join(user, ".local/share");
        home = fallback;
    }
    if (!home) return JS_ThrowOutOfMemory(ctx);
    if (home[0] != '/') { free(fallback); return JS_ThrowTypeError(ctx, "XDG_DATA_HOME must be absolute"); }
    JSValue result = JS_NewArray(ctx);
    uint32_t count = 0;
    char *path = join(home, "applications");
    int ok = !JS_IsException(result) && path && scan(ctx, result, &count, path, "", 0);
    free(path);
    free(fallback);
    const char *dirs = getenv("XDG_DATA_DIRS");
    char *copy = strdup(dirs && *dirs ? dirs : "/usr/local/share:/usr/share");
    if (!copy) ok = 0;
    char *save;
    for (char *part = ok ? strtok_r(copy, ":", &save) : NULL; part && ok; part = strtok_r(NULL, ":", &save)) {
        if (part[0] != '/') { fprintf(stderr, "[applications] Ignoring relative data directory: %s\n", part); continue; }
        path = join(part, "applications");
        ok = path && scan(ctx, result, &count, path, "", 0);
        free(path);
    }
    free(copy);
    if (!ok) {
        JS_FreeValue(ctx, result);
        if (!JS_HasException(ctx)) JS_ThrowOutOfMemory(ctx);
        return JS_EXCEPTION;
    }
    return result;
}

static JSValue can_execute(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "canExecute requires a program name");
    size_t size;
    const char *name = JS_ToCStringLen(ctx, &size, argv[0]);
    if (!name) return JS_EXCEPTION;
    char *path = !memchr(name, 0, size) ? resolve_executable(name) : NULL;
    int ok = path != NULL;
    free(path);
    JS_FreeCString(ctx, name);
    return JS_NewBool(ctx, ok);
}

static int discard_env(const char *value)
{
    const char *keys[] = { "WAYLAND_SOCKET=", "DISPLAY=", "DBUS_SESSION_BUS_ADDRESS=",
        "DBUS_STARTER_ADDRESS=", "DBUS_STARTER_BUS_TYPE=", "DESKTOP_STARTUP_ID=",
        "XDG_ACTIVATION_TOKEN=", "SDL_APP_ID=", "PU_CAPTURE_FRAME=", "PU_TRACE_FRAMES=",
        "PU_TRACE_STARTUP=", "XDG_CURRENT_DESKTOP=", "XDG_SESSION_TYPE=", NULL };
    for (int i = 0; keys[i]; i++) if (!strncmp(value, keys[i], strlen(keys[i]))) return 1;
    return 0;
}

static JSValue spawn_application(JSContext *ctx, JSValueConst self, int argc, JSValueConst *args)
{
    (void)self;
    if (argc != 3 || !JS_IsArray(args[0]) || !JS_IsString(args[1]) || !JS_IsString(args[2]))
        return JS_ThrowTypeError(ctx, "spawnApplication requires argv, working directory and application ID");
    const char *runtime = getenv("XDG_RUNTIME_DIR"), *display = getenv("WAYLAND_DISPLAY");
    if (!runtime || runtime[0] != '/' || !display || !*display)
        return JS_ThrowTypeError(ctx, "Application launching requires a Wayland session");
    JSValue length = JS_GetPropertyStr(ctx, args[0], "length");
    uint32_t count = 0;
    int converted = JS_ToUint32(ctx, &count, length);
    JS_FreeValue(ctx, length);
    if (converted < 0) return JS_EXCEPTION;
    if (!count || count > 256) return JS_ThrowRangeError(ctx, "Application argv must contain 1-256 strings");
    char executable_path[PATH_MAX];
    ssize_t path_length = readlink("/proc/self/exe", executable_path, sizeof(executable_path) - 1);
    if (path_length <= 0 || path_length >= (ssize_t)sizeof(executable_path) - 1)
        return JS_ThrowInternalError(ctx, "Cannot locate application launch helper");
    executable_path[path_length] = 0;
    char *slash = strrchr(executable_path, '/');
    if (!slash) return JS_ThrowInternalError(ctx, "Invalid runtime executable path");
    *slash = 0;
    char *helper = join(executable_path, "pollyui-app-launcher"), *program = NULL;
    char **argv = calloc((size_t)count + 2, sizeof(*argv));
    struct AppProcess *process = calloc(1, sizeof(*process));
    const char *cwd = NULL, *id = NULL;
    char **environment = NULL;
    char *bus_environment = NULL;
    int pipefd[2] = { -1, -1 }, error = 0;
    JSValue result = JS_EXCEPTION;
    if (!helper || !argv || !process) { JS_ThrowOutOfMemory(ctx); goto cleanup; }
    argv[0] = helper;
    for (uint32_t i = 0; i < count; i++) {
        JSValue value = JS_GetPropertyUint32(ctx, args[0], i);
        size_t size;
        if (JS_IsException(value)) goto cleanup;
        if (!JS_IsString(value)) {
            JS_FreeValue(ctx, value); JS_ThrowTypeError(ctx, "Application argv entries must be strings"); goto cleanup;
        }
        argv[i + 1] = (char *)JS_ToCStringLen(ctx, &size, value);
        JS_FreeValue(ctx, value);
        if (!argv[i + 1]) goto cleanup;
        if (memchr(argv[i + 1], 0, size)) { JS_ThrowTypeError(ctx, "NUL in application argument"); goto cleanup; }
    }
    size_t cwd_size, id_size;
    cwd = JS_ToCStringLen(ctx, &cwd_size, args[1]);
    id = JS_ToCStringLen(ctx, &id_size, args[2]);
    if (!cwd || !id) goto cleanup;
    if (memchr(cwd, 0, cwd_size) || memchr(id, 0, id_size) || (*cwd && *cwd != '/')) {
        JS_ThrowTypeError(ctx, "Invalid application working directory or ID"); goto cleanup;
    }
    process->id = strdup(id);
    if (!process->id) { JS_ThrowOutOfMemory(ctx); goto cleanup; }
    program = resolve_executable(argv[1]);
    if (!program) { error = ENOENT; goto failed; }
    size_t env_count = 0, next = 0;
    while (environ[env_count]) env_count++;
    environment = calloc(env_count + 4, sizeof(*environment));
    if (!environment) { JS_ThrowOutOfMemory(ctx); goto cleanup; }
    for (size_t i = 0; i < env_count; i++)
        if (!discard_env(environ[i])) environment[next++] = environ[i];
    environment[next++] = "XDG_CURRENT_DESKTOP=Polly";
    environment[next++] = "XDG_SESSION_TYPE=wayland";
    char *bus = pu_session_bus_address();
    if (!bus) { JS_ThrowInternalError(ctx, "Invalid private session bus"); goto cleanup; }
    if (asprintf(&bus_environment, "DBUS_SESSION_BUS_ADDRESS=%s", bus) < 0) bus_environment = NULL;
    free(bus);
    if (!bus_environment) { JS_ThrowOutOfMemory(ctx); goto cleanup; }
    environment[next] = bus_environment;
    if (pipe2(pipefd, O_CLOEXEC) < 0) { error = errno; goto failed; }
    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attributes;
    bool actions_ready = false, attributes_ready = false;
    error = posix_spawn_file_actions_init(&actions);
    if (error) goto spawned;
    actions_ready = true;
    error = posix_spawnattr_init(&attributes);
    if (error) goto spawned;
    attributes_ready = true;
    sigset_t mask, defaults;
    sigemptyset(&mask); sigemptyset(&defaults);
    sigaddset(&defaults, SIGINT); sigaddset(&defaults, SIGTERM);
    sigaddset(&defaults, SIGCHLD); sigaddset(&defaults, SIGPIPE);
    if ((error = posix_spawnattr_setsigmask(&attributes, &mask)) ||
        (error = posix_spawnattr_setsigdefault(&attributes, &defaults)) ||
        (error = posix_spawnattr_setpgroup(&attributes, 0)) ||
        (error = posix_spawnattr_setflags(&attributes,
            POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETPGROUP)) ||
        (error = posix_spawn_file_actions_addclose(&actions, pipefd[0])) ||
        (error = posix_spawn_file_actions_adddup2(&actions, pipefd[1], 3)) ||
        (pipefd[1] != 3 && (error = posix_spawn_file_actions_addclose(&actions, pipefd[1]))) ||
        (error = posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)) ||
        (*cwd && (error = posix_spawn_file_actions_addchdir_np(&actions, cwd)))) goto spawned;
    char *original = argv[1];
    argv[1] = program;
    error = posix_spawn(&process->pid, helper, &actions, &attributes, argv, environment);
    argv[1] = original;
spawned:
    if (attributes_ready) posix_spawnattr_destroy(&attributes);
    if (actions_ready) posix_spawn_file_actions_destroy(&actions);
    close(pipefd[1]); pipefd[1] = -1;
    if (!error) {
        struct pollfd pollfd = { .fd = pipefd[0], .events = POLLIN };
        int available;
        long long deadline = pu_now_ms() + 5000;
        do {
            long long remaining = deadline - pu_now_ms();
            available = remaining > 0 ? poll(&pollfd, 1, (int)remaining) : 0;
        } while (available < 0 && errno == EINTR);
        if (available <= 0) {
            error = available == 0 ? ETIMEDOUT : errno;
            kill(process->pid, SIGKILL);
        } else {
            ssize_t bytes;
            do { bytes = read(pipefd[0], &error, sizeof(error)); } while (bytes < 0 && errno == EINTR);
            if (bytes < 0 || (bytes != 0 && bytes != sizeof(error))) error = EIO;
        }
        process->next = processes;
        processes = process;
        if (!error) result = JS_NewInt32(ctx, process->pid);
        process = NULL;
    }
failed:
    if (error) result = JS_ThrowInternalError(ctx, "Application exec failed: %s", strerror(error));
cleanup:
    if (pipefd[0] >= 0) close(pipefd[0]);
    if (pipefd[1] >= 0) close(pipefd[1]);
    if (argv) for (uint32_t i = 1; i <= count; i++) if (argv[i]) JS_FreeCString(ctx, argv[i]);
    JS_FreeCString(ctx, cwd); JS_FreeCString(ctx, id);
    if (process) { free(process->id); free(process); }
    free(argv); free(helper); free(program); free(environment);
    free(bus_environment);
    return result;
}

int pu_applications_install(JSContext *ctx)
{
    context = ctx;
    desktop_api = JS_NewObject(ctx);
    if (JS_IsException(desktop_api) || !pu_bundles_install(ctx, desktop_api)) return 0;
    if (JS_IsException(desktop_api)) return 0;
    JS_SetPropertyStr(ctx, desktop_api, "applicationFiles", JS_NewCFunction(ctx, read_applications, "applicationFiles", 0));
    JS_SetPropertyStr(ctx, desktop_api, "canExecute", JS_NewCFunction(ctx, can_execute, "canExecute", 1));
    JS_SetPropertyStr(ctx, desktop_api, "spawnApplication", JS_NewCFunction(ctx, spawn_application, "spawnApplication", 3));
    if (JS_SetPropertyStr(ctx, desktop_api, "canActivateApplication", JS_NewCFunction(ctx, can_activate_application, "canActivateApplication", 0)) < 0 ||
        JS_SetPropertyStr(ctx, desktop_api, "activateApplication", JS_NewCFunction(ctx, activate_application, "activateApplication", 1)) < 0) return 0;
    const char *locale = getenv("LC_ALL");
    if (!locale || !*locale) locale = getenv("LC_MESSAGES");
    if (!locale || !*locale) locale = getenv("LANG");
    JS_SetPropertyStr(ctx, desktop_api, "locale", JS_NewString(ctx, locale && *locale ? locale : "C"));
    const char *terminal = getenv("POLLY_TERMINAL");
    JS_SetPropertyStr(ctx, desktop_api, "terminal", JS_NewString(ctx, terminal && *terminal ? terminal : "foot"));
    JS_SetPropertyStr(ctx, desktop_api, "onExit", JS_NULL);
#if defined(PU_LAYER_SHELL)
    if (!pu_desktop_windows_install(ctx, desktop_api)) return 0;
    if (!pu_notifications_install(ctx, desktop_api)) return 0;
    if (!pu_tray_install(ctx, desktop_api)) return 0;
    if (!pu_network_install(ctx, desktop_api)) return 0;
    if (!pu_audio_install(ctx, desktop_api)) return 0;
    if (!pu_power_install(ctx, desktop_api)) return 0;
#endif
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "desktop", JS_DupValue(ctx, desktop_api));
    JS_FreeValue(ctx, global);
    return 1;
}

int pu_applications_pump(void)
{
    if (!context) return 0;
    int worked = pump_activations();
    struct AppProcess **link = &processes;
    while (*link) {
        struct AppProcess *process = *link;
        int status = 0;
        pid_t result = waitpid(process->pid, &status, WNOHANG);
        if (result == 0 || (result < 0 && errno == EINTR)) { link = &process->next; continue; }
        *link = process->next;
        if (result < 0) fprintf(stderr, "[applications] Cannot reap pid %ld: %s\n",
            (long)process->pid, strerror(errno));
        int code = result < 0 ? -1 : WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        if (code) fprintf(stderr, "[applications] %s (pid %ld) exited with status %d\n",
            process->id, (long)process->pid, code);
        JSValue callback = JS_GetPropertyStr(context, desktop_api, "onExit");
        if (JS_IsException(callback)) report_exception();
        else if (JS_IsFunction(context, callback)) {
            JSValue event = JS_NewObject(context);
            JS_SetPropertyStr(context, event, "id", JS_NewString(context, process->id));
            JS_SetPropertyStr(context, event, "pid", JS_NewInt32(context, process->pid));
            JS_SetPropertyStr(context, event, "status", JS_NewInt32(context, code));
            JSValue value = JS_Call(context, callback, desktop_api, 1, &event);
            if (JS_IsException(value)) report_exception();
            JS_FreeValue(context, value); JS_FreeValue(context, event);
        }
        JS_FreeValue(context, callback);
        free(process->id); free(process);
        worked++;
    }
#if defined(PU_LAYER_SHELL)
    worked += pu_desktop_windows_pump();
    worked += pu_notifications_pump();
    worked += pu_tray_pump();
    worked += pu_network_pump();
    worked += pu_audio_pump();
    worked += pu_power_pump();
#endif
    return worked;
}

void pu_applications_shutdown(void)
{
    while (activations) {
        struct AppActivation *request = activations;
        activations = request->next; activation_count--;
        complete_activation(request, NULL, "POLLY_ACTIVATION_CANCELLED",
            "Application activation cancelled at shutdown; delivery is indeterminate (no automatic retry or Exec fallback)");
    }
    close_activation_bus();
#if defined(PU_LAYER_SHELL)
    pu_power_shutdown();
    pu_audio_shutdown();
    pu_network_shutdown();
    pu_tray_shutdown();
    pu_notifications_shutdown();
    pu_desktop_windows_shutdown();
#endif
    if (context) JS_FreeValue(context, desktop_api);
    context = NULL;
    desktop_api = JS_UNDEFINED;
    while (processes) {
        struct AppProcess *next = processes->next;
        free(processes->id); free(processes);
        processes = next;
    }
}
