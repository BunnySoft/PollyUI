#define _GNU_SOURCE
#include "install-targets.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Small actual QuickJS/native transport harness, not an SDL rendering proof. */
static const char *root;
static struct { int id; uint64_t deadline; JSValue callback; } timers[32];
static int next_timer;
static int edge_mode, edge_samples, edge_eofs, edge_completion_samples;
static uint64_t edge_last_sample;
static bool edge_failed;

/* Compile-only adapter symbol redirects; no production API/environment switch. */
int pu_install_fixture_clock_gettime(clockid_t clock, struct timespec *value)
{
    if (!edge_mode || clock != CLOCK_MONOTONIC) return clock_gettime(clock, value);
    uint64_t now = ++edge_samples == 1 ? 1000 : 8999;
    if (edge_eofs == 2) {
        edge_completion_samples++;
        now = edge_mode == 1 ? 8999 : edge_mode == 3 ? 9000 :
            edge_mode == 4 && edge_completion_samples == 1 ? 8999 : 9001;
        if (edge_mode == 4 && edge_completion_samples == 2)
            fprintf(stderr, "DEADLINE EDGE: post-drain=8999 pre-resolve=9001\n");
    }
    edge_last_sample = now;
    value->tv_sec = (time_t)(now / 1000);
    value->tv_nsec = (long)(now % 1000) * 1000000;
    return 0;
}

ssize_t pu_install_fixture_read(int fd, void *bytes, size_t length)
{
    ssize_t result = read(fd, bytes, length);
    if (edge_mode && result == 0 && ++edge_eofs == 2) {
        siginfo_t child = {0};
        if (waitid(P_ALL, 0, &child, WEXITED | WNOWAIT) < 0) {
            fprintf(stderr, "NATIVE FIXTURE FAIL: cannot hold completed helper for boundary reap\n");
            edge_failed = true;
        }
        if (edge_last_sample != 8999) edge_failed = true;
        fprintf(stderr, "DEADLINE EDGE: start=1000 deadline=9000 pump-entry=%llu final-EOF=%d; child waitable\n",
            (unsigned long long)edge_last_sample,
            edge_mode == 1 || edge_mode == 4 ? 8999 : edge_mode == 3 ? 9000 : 9001);
    }
    return result;
}

pid_t pu_install_fixture_waitpid(pid_t pid, int *status, int options)
{
    if (edge_mode && edge_eofs < 2 && (options & WNOHANG)) return 0;
    return waitpid(pid, status, options);
}
static uint64_t now_ms(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}
static JSValue set_timeout(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    int32_t delay;
    if (argc != 2 || !JS_IsFunction(ctx, argv[0]) || JS_ToInt32(ctx, &delay, argv[1]) < 0 ||
        delay < 0 || delay > 30000) return JS_ThrowTypeError(ctx, "Expected bounded fixture timer");
    for (int i = 0; i < 32; i++) if (!timers[i].id) {
        timers[i].id = ++next_timer; timers[i].deadline = now_ms() + (uint64_t)delay;
        timers[i].callback = JS_DupValue(ctx, argv[0]);
        return JS_NewInt32(ctx, timers[i].id);
    }
    return JS_ThrowInternalError(ctx, "Fixture timer bound reached");
}
static JSValue clear_timeout(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    int32_t id;
    if (argc == 1 && JS_ToInt32(ctx, &id, argv[0]) >= 0)
        for (int i = 0; i < 32; i++) if (timers[i].id == id) {
            JS_FreeValue(ctx, timers[i].callback); timers[i].id = 0;
        }
    return JS_UNDEFINED;
}
static char *contents(const char *path, size_t *length)
{
    FILE *file = fopen(path, "rb");
    if (!file) return NULL;
    char *bytes = malloc(2 * 1024 * 1024 + 1);
    if (!bytes) { fclose(file); return NULL; }
    *length = fread(bytes, 1, 2 * 1024 * 1024, file);
    int failed = ferror(file) || !feof(file);
    fclose(file);
    if (failed) { free(bytes); return NULL; }
    bytes[*length] = 0; return bytes;
}
static char *normalize(JSContext *ctx, const char *base, const char *name, void *opaque)
{
    (void)opaque;
    char path[4096];
    if (strncmp(name, "./desktop/", 10) == 0 || strncmp(name, "./gui/sdk/js/", 5) == 0)
        snprintf(path, sizeof(path), "%s/%s", root, name + 2);
    else if (name[0] == '/') snprintf(path, sizeof(path), "%s", name);
    else {
        const char *slash = strrchr(base, '/');
        snprintf(path, sizeof(path), "%.*s/%s", slash ? (int)(slash - base) : 0, base, name);
    }
    return js_strdup(ctx, path);
}
static JSModuleDef *load(JSContext *ctx, const char *name, void *opaque)
{
    (void)opaque;
    size_t length;
    char *bytes = contents(name, &length);
    if (!bytes) { JS_ThrowReferenceError(ctx, "Cannot read fixture module: %s", name); return NULL; }
    JSValue module = JS_Eval(ctx, bytes, length, name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    free(bytes);
    if (JS_IsException(module)) return NULL;
    JSModuleDef *result = JS_VALUE_GET_PTR(module);
    JS_FreeValue(ctx, module); return result;
}
static void exception(JSContext *ctx)
{
    JSValue error = JS_GetException(ctx);
    const char *text = JS_ToCString(ctx, error);
    fprintf(stderr, "NATIVE FIXTURE FAIL: %s\n", text ? text : "unknown");
    JS_FreeCString(ctx, text); JS_FreeValue(ctx, error);
}
static int fd_count(void)
{
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) return -1;
    int count = 0;
    while (readdir(directory)) count++;
    closedir(directory); return count;
}
int main(int argc, char **argv)
{
    if (argc != 4 || getuid() != 1000) return 2;
    root = argv[1];
    edge_mode = strcmp(argv[3], "deadline-before") == 0 ? 1 :
        strcmp(argv[3], "deadline-overrun") == 0 ? 2 :
        strcmp(argv[3], "deadline-exact") == 0 ? 3 :
        strcmp(argv[3], "deadline-settle-overrun") == 0 ? 4 : 0;
    int baseline = fd_count(), failed = 0;
    int sentinel = open("/dev/null", O_RDONLY);
    if (sentinel < 0) return 2;
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = rt ? JS_NewContext(rt) : NULL;
    if (!ctx) return 2;
    JS_SetModuleLoaderFunc(rt, normalize, load, NULL);
    JSValue global = JS_GetGlobalObject(ctx), api = JS_NewObject(ctx);
    if (!pu_install_targets_install(ctx, api)) failed = 1;
    JS_SetPropertyStr(ctx, global, "desktop", api);
    JS_SetPropertyStr(ctx, global, "scenario", JS_NewString(ctx, argv[3]));
    JS_SetPropertyStr(ctx, global, "setTimeout", JS_NewCFunction(ctx, set_timeout, "setTimeout", 2));
    JS_SetPropertyStr(ctx, global, "clearTimeout", JS_NewCFunction(ctx, clear_timeout, "clearTimeout", 1));
    JS_FreeValue(ctx, global);
    size_t length;
    char *bytes = contents(argv[2], &length);
    if (!bytes) failed = 1;
    else {
        JSValue value = JS_Eval(ctx, bytes, length, argv[2], JS_EVAL_TYPE_MODULE);
        free(bytes);
        if (JS_IsException(value)) { exception(ctx); failed = 1; }
        JS_FreeValue(ctx, value);
    }
    for (int tick = 0; !failed && tick < 30000; tick++) {
        pu_install_targets_pump();
        for (int i = 0; i < 32; i++) if (timers[i].id && now_ms() >= timers[i].deadline) {
            JSValue callback = timers[i].callback; timers[i].id = 0;
            JSValue result = JS_Call(ctx, callback, JS_UNDEFINED, 0, NULL);
            if (JS_IsException(result)) { exception(ctx); failed = 1; }
            JS_FreeValue(ctx, result); JS_FreeValue(ctx, callback);
        }
        JSContext *job;
        int result;
        while ((result = JS_ExecutePendingJob(rt, &job)) > 0) {}
        if (result < 0) { exception(job); failed = 1; break; }
        JSValue object = JS_GetGlobalObject(ctx);
        JSValue done = JS_GetPropertyStr(ctx, object, "nativeFixtureDone");
        JSValue error = JS_GetPropertyStr(ctx, object, "nativeFixtureError");
        if (!JS_IsUndefined(error)) {
            const char *text = JS_ToCString(ctx, error);
            fprintf(stderr, "NATIVE FIXTURE FAIL: %s\n", text ? text : "unknown");
            JS_FreeCString(ctx, text); failed = 1;
        }
        int complete = JS_ToBool(ctx, done);
        JS_FreeValue(ctx, done); JS_FreeValue(ctx, error); JS_FreeValue(ctx, object);
        if (tick == 10 && strcmp(argv[3], "shutdown") == 0) {
            if (complete) { fprintf(stderr, "NATIVE FIXTURE FAIL: unexpected shutdown callback\n"); failed = 1; }
            pu_install_targets_shutdown();
            break;
        }
        if (failed || complete) break;
        if (tick == 29999) { fprintf(stderr, "NATIVE FIXTURE FAIL: deadline\n"); failed = 1; }
        usleep(1000);
    }
    pu_install_targets_shutdown();
    for (int i = 0; i < 32; i++) if (timers[i].id) JS_FreeValue(ctx, timers[i].callback);
    JS_FreeContext(ctx); JS_FreeRuntime(rt);
    close(sentinel);
    if (fd_count() != baseline) { fprintf(stderr, "NATIVE FIXTURE FAIL: fd leak\n"); failed = 1; }
    if (edge_mode && (edge_failed || edge_eofs != 2 ||
        (edge_mode == 4 && edge_completion_samples != 2))) {
        fprintf(stderr, "NATIVE FIXTURE FAIL: boundary did not cross inside the final EOF pump\n"); failed = 1;
    }
    errno = 0;
    if (waitpid(-1, NULL, WNOHANG) != -1 || errno != ECHILD) {
        fprintf(stderr, "NATIVE FIXTURE FAIL: unreaped child\n"); failed = 1;
    }
    if (!failed) puts("NATIVE READONLY PASS (UID1000; fixed helper; no fd/child leak)");
    return failed;
}
