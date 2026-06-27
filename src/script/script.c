#include "script/script.h"

#include "quickjs.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#ifdef _WIN32
#  include <windows.h>
static int64_t pu_now_ms(void)      { return (int64_t)GetTickCount64(); }
static void    pu_sleep_ms(int64_t m){ if (m > 0) Sleep((DWORD)m); }
#else
#  include <time.h>
static int64_t pu_now_ms(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static void pu_sleep_ms(int64_t m) {
    if (m <= 0) return;
    struct timespec ts = { (time_t)(m / 1000), (long)((m % 1000) * 1000000) };
    nanosleep(&ts, NULL);
}
#endif

typedef struct PuTimer {
    int      id;
    int64_t  due_ms;   /* absolute fire time */
    JSValue  func;     /* owned (duped) callback */
    int      active;
} PuTimer;

struct PuScript {
    JSRuntime *rt;
    JSContext *ctx;
    PuTimer   *timers;
    int        ntimers;
    int        cap;
    int        next_id;
};

/* ---- error reporting -------------------------------------------------------*/

static void pu_dump_error(JSContext *ctx)
{
    JSValue exc = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, exc);
    fprintf(stderr, "Uncaught %s\n", msg ? msg : "(unknown error)");
    if (msg) JS_FreeCString(ctx, msg);

    if (JS_IsError(exc)) {
        JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
        if (!JS_IsUndefined(stack)) {
            const char *s = JS_ToCString(ctx, stack);
            if (s) { fprintf(stderr, "%s\n", s); JS_FreeCString(ctx, s); }
        }
        JS_FreeValue(ctx, stack);
    }
    fflush(stderr);
    JS_FreeValue(ctx, exc);
}

/* ---- console ---------------------------------------------------------------*/

static JSValue js_console_print(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv, int magic)
{
    FILE *out = magic ? stderr : stdout; /* magic=1 -> warn/error */

    /* Build the whole line (so it survives to the debugger in windowed mode). */
    char  *line = NULL;
    size_t len = 0, cap = 0;
    for (int i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);
        if (!s) continue;
        size_t sl = strlen(s);
        size_t need = len + (i ? 1 : 0) + sl + 1;
        if (need > cap) {
            size_t ncap = need * 2;
            char *n = (char *)realloc(line, ncap);
            if (n) { line = n; cap = ncap; }
        }
        if (line && cap >= len + (i ? 1 : 0) + sl + 1) {
            if (i) line[len++] = ' ';
            memcpy(line + len, s, sl);
            len += sl;
            line[len] = '\0';
        }
        JS_FreeCString(ctx, s);
    }

    if (line) fputs(line, out);
    fputc('\n', out);
    fflush(out);
#if defined(_WIN32) && defined(PU_WINDOWED)
    /* No console in windowed builds — mirror to the debugger output. */
    OutputDebugStringA(line ? line : "");
    OutputDebugStringA("\n");
#endif
    free(line);
    return JS_UNDEFINED;
}

/* ---- timers ----------------------------------------------------------------*/

static int pu_timer_add(PuScript *s, JSValue func, int64_t delay_ms)
{
    if (s->ntimers == s->cap) {
        int ncap = s->cap ? s->cap * 2 : 8;
        PuTimer *t = (PuTimer *)realloc(s->timers, (size_t)ncap * sizeof(PuTimer));
        if (!t) { JS_FreeValue(s->ctx, func); return -1; }
        s->timers = t;
        s->cap = ncap;
    }
    int id = ++s->next_id;
    PuTimer *t = &s->timers[s->ntimers++];
    t->id     = id;
    t->due_ms = pu_now_ms() + (delay_ms < 0 ? 0 : delay_ms);
    t->func   = func; /* takes ownership */
    t->active = 1;
    return id;
}

static JSValue js_set_timeout(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    PuScript *s = (PuScript *)JS_GetContextOpaque(ctx);
    if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
        return JS_ThrowTypeError(ctx, "setTimeout: a callback function is required");
    double delay = 0;
    if (argc >= 2) JS_ToFloat64(ctx, &delay, argv[1]);
    int id = pu_timer_add(s, JS_DupValue(ctx, argv[0]), (int64_t)delay);
    if (id < 0) return JS_ThrowOutOfMemory(ctx);
    return JS_NewInt32(ctx, id);
}

static JSValue js_clear_timeout(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    PuScript *s = (PuScript *)JS_GetContextOpaque(ctx);
    int32_t id = 0;
    if (argc >= 1) JS_ToInt32(ctx, &id, argv[0]);
    for (int i = 0; i < s->ntimers; i++) {
        if (s->timers[i].active && s->timers[i].id == id) {
            s->timers[i].active = 0;
            JS_FreeValue(ctx, s->timers[i].func);
            s->timers[i].func = JS_UNDEFINED;
            break;
        }
    }
    return JS_UNDEFINED;
}

/* Index of the soonest active timer, or -1 if none. */
static int pu_next_timer(PuScript *s)
{
    int idx = -1;
    for (int i = 0; i < s->ntimers; i++) {
        if (!s->timers[i].active) continue;
        if (idx < 0 || s->timers[i].due_ms < s->timers[idx].due_ms) idx = i;
    }
    return idx;
}

/* ---- public API ------------------------------------------------------------*/

static void pu_register_globals(PuScript *s)
{
    JSContext *ctx = s->ctx;
    JSValue global = JS_GetGlobalObject(ctx);

    JSValue console = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, console, "log",
        JS_NewCFunctionMagic(ctx, js_console_print, "log", 1, JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, console, "info",
        JS_NewCFunctionMagic(ctx, js_console_print, "info", 1, JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, console, "warn",
        JS_NewCFunctionMagic(ctx, js_console_print, "warn", 1, JS_CFUNC_generic_magic, 1));
    JS_SetPropertyStr(ctx, console, "error",
        JS_NewCFunctionMagic(ctx, js_console_print, "error", 1, JS_CFUNC_generic_magic, 1));
    JS_SetPropertyStr(ctx, global, "console", console);

    JS_SetPropertyStr(ctx, global, "setTimeout",
        JS_NewCFunction(ctx, js_set_timeout, "setTimeout", 2));
    JS_SetPropertyStr(ctx, global, "clearTimeout",
        JS_NewCFunction(ctx, js_clear_timeout, "clearTimeout", 1));

    JS_FreeValue(ctx, global);
}

JSContext *pu_script_jsctx(PuScript *s)
{
    return s ? s->ctx : NULL;
}

PuScript *pu_script_create(void)
{
    PuScript *s = (PuScript *)calloc(1, sizeof(PuScript));
    if (!s) return NULL;

    s->rt = JS_NewRuntime();
    if (!s->rt) { free(s); return NULL; }
    s->ctx = JS_NewContext(s->rt);
    if (!s->ctx) { JS_FreeRuntime(s->rt); free(s); return NULL; }

    JS_SetContextOpaque(s->ctx, s);
    pu_register_globals(s);
    return s;
}

static char *pu_read_file(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    if (n < 0) { fclose(f); return NULL; }
    fseek(f, 0, SEEK_SET);
    char *buf = (char *)malloc((size_t)n + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t rd = fread(buf, 1, (size_t)n, f);
    fclose(f);
    buf[rd] = '\0';
    if (out_len) *out_len = rd;
    return buf;
}

int pu_script_run_file(PuScript *s, const char *path)
{
    size_t len = 0;
    char *src = pu_read_file(path, &len);
    if (!src) {
        fprintf(stderr, "pollyui: cannot read script '%s'\n", path);
        return 1;
    }
    JSValue val = JS_Eval(s->ctx, src, len, path, JS_EVAL_TYPE_GLOBAL);
    free(src);
    if (JS_IsException(val)) {
        pu_dump_error(s->ctx);
        JS_FreeValue(s->ctx, val);
        return 1;
    }
    JS_FreeValue(s->ctx, val);
    return 0;
}

void pu_script_run_loop(PuScript *s)
{
    for (;;) {
        /* 1. Drain promise jobs / microtasks. */
        JSContext *jctx;
        int r;
        do {
            r = JS_ExecutePendingJob(s->rt, &jctx);
            if (r < 0) pu_dump_error(jctx);
        } while (r > 0);

        /* 2. Next due timer, if any. */
        int idx = pu_next_timer(s);
        if (idx < 0) break; /* no jobs, no timers -> idle */

        int64_t now = pu_now_ms();
        int64_t due = s->timers[idx].due_ms;
        if (due > now) pu_sleep_ms(due - now);

        JSValue func = s->timers[idx].func;
        s->timers[idx].active = 0;
        s->timers[idx].func = JS_UNDEFINED;

        JSValue ret = JS_Call(s->ctx, func, JS_UNDEFINED, 0, NULL);
        if (JS_IsException(ret)) pu_dump_error(s->ctx);
        JS_FreeValue(s->ctx, ret);
        JS_FreeValue(s->ctx, func);
    }
}

void pu_script_destroy(PuScript *s)
{
    if (!s) return;
    for (int i = 0; i < s->ntimers; i++) {
        if (s->timers[i].active) JS_FreeValue(s->ctx, s->timers[i].func);
    }
    free(s->timers);
    if (s->ctx) JS_FreeContext(s->ctx);
    if (s->rt)  JS_FreeRuntime(s->rt);
    free(s);
}
