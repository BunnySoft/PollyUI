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
    JS_FreeValue(ctx, exception);
}

static JSValue collect(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    JS_RunGC(JS_GetRuntime(ctx));
    return JS_UNDEFINED;
}

static JSClassID cached_foreign_class;

static int run(const char *script, const char *fixture, unsigned occupied, int cached)
{
    JSRuntime *runtime = JS_NewRuntime();
    JSContext *ctx = runtime ? JS_NewContext(runtime) : NULL;
    if (!ctx) { if (runtime) JS_FreeRuntime(runtime); return 1; }
    JS_SetMemoryLimit(runtime, 128 * 1024 * 1024);
    /* Sanitized interpreter frames need room for realistic SDK call depth. */
    JS_SetMaxStackSize(runtime, 4 * 1024 * 1024);
    JS_SetModuleLoaderFunc(runtime, normalize, load, NULL);
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
    if (!sr_ffi_register(ctx)) failed = 1;
    JSValue global = JS_GetGlobalObject(ctx);
    if (JS_SetPropertyStr(ctx, global, "fixtureLibrary", JS_NewString(ctx, fixture)) < 0) failed = 1;
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
    JS_FreeValue(ctx, global);
    size_t length = 0;
    char *source = failed ? NULL : read_file(script, &length);
    if (!source) { fprintf(stderr, "Cannot initialize FFI fixture\n"); failed = 1; }
    JSValue result = source ? JS_Eval(ctx, source, length, script, JS_EVAL_TYPE_MODULE) : JS_UNDEFINED;
    free(source);
    if (JS_IsException(result)) { report(ctx, JS_GetException(ctx)); failed = 1; }
    JSContext *job;
    int work;
    while ((work = JS_ExecutePendingJob(runtime, &job)) > 0) {}
    if (work < 0) { report(job, JS_GetException(job)); failed = 1; }
    if (JS_PromiseState(ctx, result) == JS_PROMISE_REJECTED) {
        report(ctx, JS_PromiseResult(ctx, result)); failed = 1;
    } else if (JS_PromiseState(ctx, result) == JS_PROMISE_PENDING) {
        fprintf(stderr, "FFI fixture did not complete\n"); failed = 1;
    }
    JS_FreeValue(ctx, result);
    JS_FreeContext(ctx); JS_FreeRuntime(runtime);
    return failed;
}

int main(int argc, char **argv)
{
    if (argc != 3) { fprintf(stderr, "Pass the FFI test module and native fixture library\n"); return 2; }
    int failed = run(argv[1], argv[2], 0, 0);
    failed |= run(argv[1], argv[2], 8, 0);
    failed |= run(argv[1], argv[2], 0, 1);
    if (!failed) puts("PASS: real libffi calls, VM isolation, memory lifetime and JS/config SDK");
    return failed;
}
