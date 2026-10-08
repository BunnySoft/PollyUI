#define _GNU_SOURCE
#include "install-targets.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef PU_INSTALL_TARGETS_HELPER
#define PU_INSTALL_TARGETS_HELPER "/usr/lib/pollyui/install-targets/install/readonly-helper.py"
#endif
#define OUTPUT_LIMIT (2u * 1024u * 1024u)
#define ERROR_LIMIT 4096u
#define DEADLINE_MS 8000u
#define DEADLINE_ERROR "Fixed read-only acquisition exceeded its 8 second deadline"

static struct {
    JSContext *ctx;
    JSValue resolve, reject;
    pid_t pid;
    int output, diagnostic;
    char *bytes, diagnostics[ERROR_LIMIT + 1], error[512];
    size_t length, diagnostic_length;
    uint64_t deadline;
    int status;
    bool reaped;
} reader = { .output = -1, .diagnostic = -1 };

static uint64_t now_ms(void)
{
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) < 0) return UINT64_MAX;
    return (uint64_t)value.tv_sec * 1000u + (uint64_t)value.tv_nsec / 1000000u;
}

static void close_fd(int *fd)
{
    if (*fd >= 0) close(*fd);
    *fd = -1;
}

static int trusted_path(const char *path)
{
    char copy[PATH_MAX];
    if (!path || path[0] != '/' || strlen(path) >= sizeof(copy)) return 0;
    strcpy(copy, path);
    struct stat info;
    for (char *end = copy + 1; ; end++) {
        if (*end != '/' && *end != '\0') continue;
        char saved = *end; *end = '\0';
        int valid = lstat(copy, &info) == 0 && info.st_uid == 0 && !(info.st_mode & 0022) &&
            (saved ? S_ISDIR(info.st_mode) : S_ISREG(info.st_mode));
        *end = saved;
        if (!valid) return 0;
        if (!saved) return 1;
    }
}

static void report_exception(JSContext *ctx)
{
    JSValue error = JS_GetException(ctx);
    const char *message = JS_ToCString(ctx, error);
    fprintf(stderr, "[install-targets] Promise callback failed: %s\n", message ? message : "unknown");
    JS_FreeCString(ctx, message); JS_FreeValue(ctx, error);
}

static void abort_read(const char *message)
{
    if (!reader.error[0]) {
        snprintf(reader.error, sizeof(reader.error), "%s", message);
        fprintf(stderr, "[install-targets] %s\n", reader.error);
    }
    if (reader.pid > 0) {
        if (kill(-reader.pid, SIGKILL) < 0 && errno != ESRCH)
            fprintf(stderr, "[install-targets] Cannot terminate acquisition group: %s\n", strerror(errno));
    }
    close_fd(&reader.output); close_fd(&reader.diagnostic);
}

static void finish(void)
{
    JSContext *ctx = reader.ctx;
    JSValue value = JS_UNDEFINED;
    if (!reader.error[0]) {
        value = JS_ParseJSON(ctx, reader.bytes, reader.length, "<fixed-install-targets-helper>");
        if (JS_IsException(value)) {
            JSValue exception = JS_GetException(ctx);
            JS_FreeValue(ctx, exception);
            snprintf(reader.error, sizeof(reader.error), "Fixed read-only helper returned malformed JSON");
            fprintf(stderr, "[install-targets] %s\n", reader.error);
        }
    }
    if (reader.error[0]) {
        JS_ThrowInternalError(ctx, "%s", reader.error);
        value = JS_GetException(ctx);
    }
    bool failed = reader.error[0] != '\0';
    JSValue resolve = reader.resolve, reject = reader.reject;
    /* An exited leader must not leave a collector descendant behind. */
    if (kill(-reader.pid, SIGKILL) < 0 && errno != ESRCH)
        fprintf(stderr, "[install-targets] Cannot clean acquisition group: %s\n", strerror(errno));
    free(reader.bytes); reader.bytes = NULL;
    reader.pid = 0; reader.length = reader.diagnostic_length = 0;
    reader.error[0] = reader.diagnostics[0] = 0; reader.reaped = false;
    reader.resolve = reader.reject = JS_UNDEFINED;
    if (!failed && now_ms() >= reader.deadline) {
        JS_FreeValue(ctx, value);
        JS_ThrowInternalError(ctx, "%s", DEADLINE_ERROR);
        value = JS_GetException(ctx); failed = true;
        fprintf(stderr, "[install-targets] %s\n", DEADLINE_ERROR);
    }
    JSValue result = JS_Call(ctx, failed ? reject : resolve, JS_UNDEFINED, 1, &value);
    if (JS_IsException(result)) report_exception(ctx);
    JS_FreeValue(ctx, result); JS_FreeValue(ctx, value);
    JS_FreeValue(ctx, resolve); JS_FreeValue(ctx, reject);
}

static void drain(int *fd, bool diagnostic)
{
    for (int i = 0; *fd >= 0 && i < 16; i++) {
        char block[16384];
        ssize_t count = read(*fd, block, sizeof(block));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
        if (count < 0) { abort_read("Cannot read fixed helper transport"); break; }
        if (!count) { close_fd(fd); break; }
        size_t limit = diagnostic ? ERROR_LIMIT : OUTPUT_LIMIT;
        size_t *length = diagnostic ? &reader.diagnostic_length : &reader.length;
        if ((size_t)count > limit - *length) {
            abort_read(diagnostic ? "Fixed helper diagnostic exceeded bound" : "Fixed helper output exceeded 2 MiB");
            break;
        }
        char *bytes = diagnostic ? reader.diagnostics : reader.bytes;
        memcpy(bytes + *length, block, (size_t)count); *length += (size_t)count;
        bytes[*length] = '\0';
    }
}

static JSValue read_report(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argv;
    if (argc) return JS_ThrowTypeError(ctx, "Fixed read-only acquisition accepts no arguments");
    if (reader.pid) return JS_ThrowTypeError(ctx, "Read-only acquisition is still running or stopping");
    if (getuid() == 0 || geteuid() != getuid() || getegid() != getgid())
        return JS_ThrowTypeError(ctx, "Read-only acquisition requires an ordinary non-setid process");
    char python[PATH_MAX];
    if (!realpath("/usr/bin/python3", python) || !trusted_path(python) ||
        !trusted_path(PU_INSTALL_TARGETS_HELPER))
        return JS_ThrowTypeError(ctx, "Fixed read-only helper/interpreter deployment is missing or untrusted");
    uint64_t started = now_ms();
    if (started == UINT64_MAX)
        return JS_ThrowInternalError(ctx, "Cannot establish bounded acquisition clock");
    int output[2] = {-1, -1}, diagnostic[2] = {-1, -1};
    char *bytes = malloc(OUTPUT_LIMIT + 1);
    if (!bytes || pipe2(output, O_CLOEXEC) < 0 || pipe2(diagnostic, O_CLOEXEC) < 0 ||
        fcntl(output[0], F_SETFL, O_NONBLOCK) < 0 || fcntl(diagnostic[0], F_SETFL, O_NONBLOCK) < 0) {
        free(bytes); close_fd(&output[0]); close_fd(&output[1]);
        close_fd(&diagnostic[0]); close_fd(&diagnostic[1]);
        return JS_ThrowInternalError(ctx, "Cannot allocate fixed read-only helper transport");
    }
    JSValue callbacks[2];
    JSValue promise = JS_NewPromiseCapability(ctx, callbacks);
    if (JS_IsException(promise)) {
        free(bytes); close_fd(&output[0]); close_fd(&output[1]);
        close_fd(&diagnostic[0]); close_fd(&diagnostic[1]); return promise;
    }
    pid_t parent = getpid(), pid = fork();
    if (pid == 0) {
        if (setpgid(0, 0) < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 ||
            prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() != parent ||
            prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) < 0) _exit(126);
        int input = open("/dev/null", O_RDONLY | O_CLOEXEC);
        if (input < 0 || dup2(input, STDIN_FILENO) < 0 ||
            dup2(output[1], STDOUT_FILENO) < 0 || dup2(diagnostic[1], STDERR_FILENO) < 0) _exit(126);
#ifdef SYS_close_range
        if (syscall(SYS_close_range, 3u, UINT_MAX, 0) < 0) _exit(126);
#else
        _exit(126);
#endif
        char *const args[] = {python, "-I", "-S", "-B", PU_INSTALL_TARGETS_HELPER, NULL};
        char *const environment[] = {"PATH=/usr/bin:/bin", "LC_ALL=C", NULL};
        execve(python, args, environment);
        _exit(127);
    }
    close_fd(&output[1]); close_fd(&diagnostic[1]);
    if (pid < 0) {
        free(bytes); close_fd(&output[0]); close_fd(&diagnostic[0]);
        JS_FreeValue(ctx, promise); JS_FreeValue(ctx, callbacks[0]); JS_FreeValue(ctx, callbacks[1]);
        return JS_ThrowInternalError(ctx, "Cannot start fixed read-only helper");
    }
    reader.bytes = bytes; reader.bytes[0] = '\0';
    reader.pid = pid; reader.output = output[0]; reader.diagnostic = diagnostic[0];
    reader.resolve = callbacks[0]; reader.reject = callbacks[1];
    reader.deadline = started + DEADLINE_MS;
    if (setpgid(pid, pid) < 0 && errno != EACCES && errno != ESRCH)
        abort_read("Cannot isolate fixed helper process group");
    return promise;
}

static JSValue cancel_report(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argv;
    if (argc) return JS_ThrowTypeError(ctx, "Fixed read-only cancellation accepts no arguments");
    if (reader.pid) abort_read("Read-only acquisition cancelled; nothing was written");
    return JS_UNDEFINED;
}

int pu_install_targets_install(JSContext *ctx, JSValueConst api)
{
    if (reader.ctx) return 0;
    reader.ctx = ctx; reader.resolve = reader.reject = JS_UNDEFINED;
    JSValue service = JS_NewObject(ctx);
    if (JS_IsException(service)) return 0;
    if (JS_SetPropertyStr(ctx, service, "protocolVersion", JS_NewInt32(ctx, 1)) < 0 ||
        JS_SetPropertyStr(ctx, service, "transport", JS_NewString(ctx, "fixed-unprivileged-v1")) < 0 ||
        JS_SetPropertyStr(ctx, service, "readReport", JS_NewCFunction(ctx, read_report, "readReport", 0)) < 0 ||
        JS_SetPropertyStr(ctx, service, "cancel", JS_NewCFunction(ctx, cancel_report, "cancel", 0)) < 0) {
        JS_FreeValue(ctx, service); return 0;
    }
    return JS_SetPropertyStr(ctx, api, "installTargets", service) >= 0;
}

int pu_install_targets_pump(void)
{
    if (!reader.ctx || !reader.pid) return 0;
    if (now_ms() >= reader.deadline && !reader.error[0])
        abort_read(DEADLINE_ERROR);
    drain(&reader.output, false); drain(&reader.diagnostic, true);
    if (!reader.reaped) {
        pid_t result = waitpid(reader.pid, &reader.status, WNOHANG);
        if (result == reader.pid) reader.reaped = true;
        else if (result < 0 && errno != EINTR) {
            reader.reaped = true; abort_read("Cannot reap fixed read-only helper");
        }
    }
    if (now_ms() >= reader.deadline && !reader.error[0])
        abort_read(DEADLINE_ERROR);
    if (!reader.reaped || reader.output >= 0 || reader.diagnostic >= 0) return 0;
    if (!reader.error[0] && (!WIFEXITED(reader.status) || WEXITSTATUS(reader.status) != 0)) {
        fprintf(stderr, "[install-targets] Helper refused acquisition: %.*s\n",
            (int)reader.diagnostic_length, reader.diagnostics);
        snprintf(reader.error, sizeof(reader.error), "Fixed read-only helper refused acquisition: %.400s",
            reader.diagnostic_length ? reader.diagnostics : "exit/transport failure");
    }
    if (!reader.error[0] && reader.diagnostic_length)
        fprintf(stderr, "[install-targets] Helper diagnostic: %.*s\n", (int)reader.diagnostic_length, reader.diagnostics);
    finish();
    return 1;
}

void pu_install_targets_shutdown(void)
{
    if (!reader.ctx) return;
    if (reader.pid) {
        abort_read("Read-only transport stopped at application shutdown");
        if (!reader.reaped) {
            pid_t result;
            do { result = waitpid(reader.pid, NULL, 0); } while (result < 0 && errno == EINTR);
            if (result < 0)
                fprintf(stderr, "[install-targets] Cannot reap helper at shutdown: %s\n", strerror(errno));
        }
    }
    JS_FreeValue(reader.ctx, reader.resolve); JS_FreeValue(reader.ctx, reader.reject);
    free(reader.bytes);
    memset(&reader, 0, sizeof(reader)); reader.output = reader.diagnostic = -1;
}
