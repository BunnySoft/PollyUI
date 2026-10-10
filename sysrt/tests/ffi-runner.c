#include "sysrt/ffi/ffi.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

static char *read_file(const char *path, size_t *length)
{
    FILE *file = fopen(path, "rb");
    if (!file) return NULL;
    if (fseek(file, 0, SEEK_END)) { fclose(file); return NULL; }
    long size = ftell(file);
    if (size < 0 || size > 1024 * 1024 || fseek(file, 0, SEEK_SET)) { fclose(file); return NULL; }
    char *text = malloc((size_t)size + 1);
    if (!text) { fclose(file); return NULL; }
    if (fread(text, 1, (size_t)size, file) != (size_t)size) { free(text); fclose(file); return NULL; }
    fclose(file); text[size] = 0; *length = (size_t)size;
    return text;
}

static JSModuleDef *load(JSContext *ctx, const char *name, void *user)
{
    (void)user;
    size_t length;
    char *source = read_file(name, &length);
    if (!source) { JS_ThrowReferenceError(ctx, "Cannot load fixture module: %s", name); return NULL; }
    JSValue compiled = JS_Eval(ctx, source, length, name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    free(source);
    if (JS_IsException(compiled)) return NULL;
    JSModuleDef *module = JS_VALUE_GET_PTR(compiled);
    JS_FreeValue(ctx, compiled); return module;
}

static char *normalize(JSContext *ctx, const char *base, const char *name, void *user)
{
    (void)base; (void)user;
    size_t length = strlen(name) + 1;
    char *result = js_malloc(ctx, length);
    if (result) memcpy(result, name, length);
    return result;
}

static void report(JSContext *ctx, JSValue exception)
{
    const char *message = JS_ToCString(ctx, exception);
    fprintf(stderr, "FAIL FFI: %s\n", message ? message : "exception");
    JS_FreeCString(ctx, message);
    JSValue stack = JS_GetPropertyStr(ctx, exception, "stack");
    if (!JS_IsException(stack) && !JS_IsUndefined(stack)) {
        const char *trace = JS_ToCString(ctx, stack);
        if (trace) fprintf(stderr, "%s\n", trace);
        JS_FreeCString(ctx, trace);
    }
    JS_FreeValue(ctx, stack);
    JS_FreeValue(ctx, exception);
}

static JSValue collect(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    JS_RunGC(JS_GetRuntime(ctx));
    return JS_UNDEFINED;
}

static JSClassID cached_foreign_class;
typedef struct RunnerState { SrFfi *ffi; } RunnerState;

static JSValue shutdown_native(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    RunnerState *state = JS_GetContextOpaque(ctx);
    sr_ffi_shutdown(state->ffi);
    return JS_UNDEFINED;
}

static int run(const char *script, const char *fixture, const char *child, int shutdown_early, unsigned occupied, int cached)
{
    JSRuntime *runtime = JS_NewRuntime();
    JSContext *ctx = runtime ? JS_NewContext(runtime) : NULL;
    if (!ctx) { if (runtime) JS_FreeRuntime(runtime); return 1; }
    PuDispatch *dispatcher = pu_dispatch_new();
    if (!dispatcher) { JS_FreeContext(ctx); JS_FreeRuntime(runtime); return 1; }
    JS_SetMemoryLimit(runtime, 128 * 1024 * 1024);
    /* Sanitized interpreter frames need room for realistic SDK call depth. */
    JS_SetMaxStackSize(runtime, 4 * 1024 * 1024);
    JS_SetModuleLoaderFunc(runtime, normalize, load, NULL);
    RunnerState state = {0};
    JS_SetRuntimeOpaque(runtime, &state); JS_SetContextOpaque(ctx, &state);
    int failed = 0;
    JSClassID foreign_class = 0;
    const JSClassDef foreign_definition = { .class_name = "OtherNativeClass" };
    if (cached) {
        if (JS_NewClass(runtime, cached_foreign_class, &foreign_definition) < 0) failed = 1;
        foreign_class = cached_foreign_class;
    }
    for (unsigned i = 0; i < occupied; i++) {
        JSClassID id = 0;
        JS_NewClassID(runtime, &id);
        if (JS_NewClass(runtime, id, &foreign_definition) < 0) failed = 1;
        if (!i) cached_foreign_class = id;
        foreign_class = id;
    }
    SrFfi *ffi = sr_ffi_register(ctx, dispatcher);
    state.ffi = ffi;
    if (!ffi) failed = 1;
    JSValue global = JS_GetGlobalObject(ctx);
    if (JS_SetPropertyStr(ctx, global, "fixtureLibrary", JS_NewString(ctx, fixture)) < 0) failed = 1;
    if (child && JS_SetPropertyStr(ctx, global, "processChild", JS_NewString(ctx, child)) < 0) failed = 1;
    if (JS_SetPropertyStr(ctx, global, "fixtureRun", JS_NewUint32(ctx, occupied + (unsigned)cached)) < 0) failed = 1;
    if (JS_SetPropertyStr(ctx, global, "foreignObject",
        foreign_class ? JS_NewObjectClass(ctx, foreign_class) : JS_NewObject(ctx)) < 0) failed = 1;
#ifdef _WIN32
    uint32_t pid = GetCurrentProcessId();
#else
    uint32_t pid = (uint32_t)getpid();
#endif
    if (JS_SetPropertyStr(ctx, global, "expectedProcessId", JS_NewUint32(ctx, pid)) < 0) failed = 1;
    if (JS_SetPropertyStr(ctx, global, "collect", JS_NewCFunction(ctx, collect, "collect", 0)) < 0) failed = 1;
    if (JS_SetPropertyStr(ctx, global, "shutdownNative",
        JS_NewCFunction(ctx, shutdown_native, "shutdownNative", 0)) < 0) failed = 1;
    JS_FreeValue(ctx, global);
    size_t length = 0;
    char *source = failed ? NULL : read_file(script, &length);
    if (!source) { fprintf(stderr, "Cannot initialize FFI fixture\n"); failed = 1; }
    JSValue result = source ? JS_Eval(ctx, source, length, script, JS_EVAL_TYPE_MODULE) : JS_UNDEFINED;
    free(source);
    if (JS_IsException(result)) { report(ctx, JS_GetException(ctx)); failed = 1; }
    if (shutdown_early || failed) sr_ffi_shutdown(ffi);
    JSContext *job;
    for (;;) {
        int work;
        while ((work = JS_ExecutePendingJob(runtime, &job)) > 0) {}
        if (work < 0) { report(job, JS_GetException(job)); failed = 1; break; }
        int delivered = pu_dispatch_drain(dispatcher);
        if (!pu_dispatch_pending(dispatcher)) {
            if (!delivered) break;
        } else pu_dispatch_wait(dispatcher, 100);
    }
    if (JS_PromiseState(ctx, result) == JS_PROMISE_REJECTED) {
        report(ctx, JS_PromiseResult(ctx, result)); failed = 1;
    } else if (JS_PromiseState(ctx, result) == JS_PROMISE_PENDING) {
        fprintf(stderr, "FFI fixture did not complete\n"); failed = 1;
    }
    sr_ffi_shutdown(ffi);
    if (JS_GetRuntimeOpaque(runtime) != &state || JS_GetContextOpaque(ctx) != &state) {
        fprintf(stderr, "FFI overwrote host VM opaque state\n"); failed = 1;
    }
    if (pu_dispatch_pending(dispatcher)) { fprintf(stderr, "Native calls leaked dispatcher references\n"); failed = 1; }
    JS_FreeValue(ctx, result);
    JS_FreeContext(ctx); JS_FreeRuntime(runtime);
    pu_dispatch_free(dispatcher);
    return failed;
}

int main(int argc, char **argv)
{
    if (argc != 3 && argc != 4) { fprintf(stderr, "Pass the test module, native fixture library and optional child executable\n"); return 2; }
    int shutdown_early = argc == 4 && !strcmp(argv[3], "--shutdown");
    const char *child = argc == 4 && !shutdown_early ? argv[3] : NULL;
    int failed = run(argv[1], argv[2], child, shutdown_early, 0, 0);
    failed |= run(argv[1], argv[2], child, shutdown_early, 8, 0);
    failed |= run(argv[1], argv[2], child, shutdown_early, 0, 1);
    if (!failed) puts("PASS: real libffi calls, VM isolation, memory lifetime and JS/config SDK");
    return failed;
}
