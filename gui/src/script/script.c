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
    int64_t  due_ms;       /* absolute fire time */
    int      interval_ms;  /* 0 = one-shot (setTimeout); >0 = repeating (setInterval) */
    JSValue  func;         /* owned (duped) callback */
    int      active;
} PuTimer;

typedef struct PuRaf {
    int     id;
    JSValue func;          /* owned (duped) callback */
} PuRaf;

struct PuScript {
    JSRuntime  *rt;
    JSContext  *ctx;
    PuTimer    *timers;
    int         ntimers;
    int         cap;
    int         next_id;
    PuRaf      *rafs;       /* pending requestAnimationFrame callbacks */
    int         nraf;
    int         rafcap;
    int         raf_id;
    PuDispatch *dispatch;   /* optional: async deliveries from worker threads */
    JSValue entry;
    int failed;
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

static int pu_timer_add(PuScript *s, JSValue func, int64_t delay_ms, int64_t interval_ms)
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
    t->id          = id;
    t->due_ms      = pu_now_ms() + (delay_ms < 0 ? 0 : delay_ms);
    t->interval_ms = (interval_ms < 0) ? 0 : (int)interval_ms;
    t->func        = func; /* takes ownership */
    t->active      = 1;
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
    int id = pu_timer_add(s, JS_DupValue(ctx, argv[0]), (int64_t)delay, 0);
    if (id < 0) return JS_ThrowOutOfMemory(ctx);
    return JS_NewInt32(ctx, id);
}

static JSValue js_set_interval(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    PuScript *s = (PuScript *)JS_GetContextOpaque(ctx);
    if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
        return JS_ThrowTypeError(ctx, "setInterval: a callback function is required");
    double delay = 0;
    if (argc >= 2) JS_ToFloat64(ctx, &delay, argv[1]);
    if (delay < 1) delay = 1; /* avoid a zero-delay spin */
    int id = pu_timer_add(s, JS_DupValue(ctx, argv[0]), (int64_t)delay, (int64_t)delay);
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

/* ---- requestAnimationFrame -------------------------------------------------*/

static JSValue js_request_anim_frame(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    PuScript *s = (PuScript *)JS_GetContextOpaque(ctx);
    if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
        return JS_ThrowTypeError(ctx, "requestAnimationFrame: a callback is required");
    if (s->nraf == s->rafcap) {
        int ncap = s->rafcap ? s->rafcap * 2 : 8;
        PuRaf *r = (PuRaf *)realloc(s->rafs, (size_t)ncap * sizeof(PuRaf));
        if (!r) return JS_ThrowOutOfMemory(ctx);
        s->rafs = r;
        s->rafcap = ncap;
    }
    int id = ++s->raf_id;
    s->rafs[s->nraf].id   = id;
    s->rafs[s->nraf].func = JS_DupValue(ctx, argv[0]);
    s->nraf++;
    return JS_NewInt32(ctx, id);
}

static JSValue js_cancel_anim_frame(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    PuScript *s = (PuScript *)JS_GetContextOpaque(ctx);
    int32_t id = 0;
    if (argc >= 1) JS_ToInt32(ctx, &id, argv[0]);
    for (int i = 0; i < s->nraf; i++) {
        if (s->rafs[i].id == id) {
            JS_FreeValue(ctx, s->rafs[i].func);
            memmove(&s->rafs[i], &s->rafs[i + 1], (size_t)(s->nraf - i - 1) * sizeof(PuRaf));
            s->nraf--;
            break;
        }
    }
    return JS_UNDEFINED;
}

/* Fire every pending rAF callback once with `ts` (ms). Callbacks that
 * re-register go into the now-empty list for the next frame. */
int pu_script_flush_raf(PuScript *s, double ts)
{
    if (!s || s->nraf == 0) return 0;
    int n = s->nraf;
    PuRaf *batch = (PuRaf *)malloc((size_t)n * sizeof(PuRaf));
    if (!batch) return 0;
    memcpy(batch, s->rafs, (size_t)n * sizeof(PuRaf));
    s->nraf = 0; /* new registrations during callbacks append fresh */

    JSValue arg = JS_NewFloat64(s->ctx, ts);
    for (int i = 0; i < n; i++) {
        JSValue ret = JS_Call(s->ctx, batch[i].func, JS_UNDEFINED, 1, &arg);
        if (JS_IsException(ret)) pu_dump_error(s->ctx);
        JS_FreeValue(s->ctx, ret);
        JS_FreeValue(s->ctx, batch[i].func);
    }
    JS_FreeValue(s->ctx, arg);
    free(batch);
    return n;
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
    JS_SetPropertyStr(ctx, global, "setInterval",
        JS_NewCFunction(ctx, js_set_interval, "setInterval", 2));
    JS_SetPropertyStr(ctx, global, "clearInterval",
        JS_NewCFunction(ctx, js_clear_timeout, "clearInterval", 1));
    JS_SetPropertyStr(ctx, global, "requestAnimationFrame",
        JS_NewCFunction(ctx, js_request_anim_frame, "requestAnimationFrame", 1));
    JS_SetPropertyStr(ctx, global, "cancelAnimationFrame",
        JS_NewCFunction(ctx, js_cancel_anim_frame, "cancelAnimationFrame", 1));

    JS_FreeValue(ctx, global);
}

JSContext *pu_script_jsctx(PuScript *s)
{
    return s ? s->ctx : NULL;
}

static char *pu_read_file(const char *path, size_t *out_len);

/* ES module support: names resolve relative to the working directory (identity
 * normalize), and each module is compiled from its file on demand. */
static char *pu_module_normalize(JSContext *ctx, const char *base_name,
                                 const char *name, void *opaque)
{
    (void)base_name; (void)opaque;
    size_t n = strlen(name) + 1;
    char *p = (char *)js_malloc(ctx, n);
    if (p) memcpy(p, name, n);
    return p;
}

static JSModuleDef *pu_module_loader(JSContext *ctx, const char *module_name, void *opaque)
{
    (void)opaque;
    size_t len = 0;
    char *buf = pu_read_file(module_name, &len);
    if (!buf) {
        JS_ThrowReferenceError(ctx, "could not load module '%s'", module_name);
        return NULL;
    }
    JSValue func = JS_Eval(ctx, buf, len, module_name,
                           JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    free(buf);
    if (JS_IsException(func)) return NULL;
    JSModuleDef *m = (JSModuleDef *)JS_VALUE_GET_PTR(func);
    JS_FreeValue(ctx, func);
    return m;
}

PuScript *pu_script_create(void)
{
    PuScript *s = (PuScript *)calloc(1, sizeof(PuScript));
    if (!s) return NULL;
    s->entry = JS_UNDEFINED;

    s->rt = JS_NewRuntime();
    if (!s->rt) { free(s); return NULL; }
    s->ctx = JS_NewContext(s->rt);
    if (!s->ctx) { JS_FreeRuntime(s->rt); free(s); return NULL; }

    JS_SetContextOpaque(s->ctx, s);
    JS_SetModuleLoaderFunc(s->rt, pu_module_normalize, pu_module_loader, NULL);
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

int pu_script_failed(PuScript *s)
{
    if (!JS_IsUndefined(s->entry)) {
        JSPromiseStateEnum state = JS_PromiseState(s->ctx, s->entry);
        if (state == JS_PROMISE_REJECTED) {
            JS_Throw(s->ctx, JS_PromiseResult(s->ctx, s->entry));
            pu_dump_error(s->ctx);
            s->failed = 1;
        }
        if (state != JS_PROMISE_PENDING) {
            JS_FreeValue(s->ctx, s->entry);
            s->entry = JS_UNDEFINED;
        }
    }
    return s->failed;
}

int pu_script_finish(PuScript *s)
{
    pu_script_failed(s);
    if (!JS_IsUndefined(s->entry)) {
        fprintf(stderr, "Uncaught: module evaluation did not complete before exit\n");
        s->failed = 1;
    }
    return s->failed;
}

int pu_script_run_file(PuScript *s, const char *path)
{
    size_t len = 0;
    char *src = pu_read_file(path, &len);
    if (!src) {
        fprintf(stderr, "pollyui: cannot read script '%s'\n", path);
        return 1;
    }
    /* `.mjs` runs as an ES module (import/export); `.js` stays a global script. */
    size_t plen = strlen(path);
    int is_module = plen >= 4 && strcmp(path + plen - 4, ".mjs") == 0;
    int eval_flags = is_module ? JS_EVAL_TYPE_MODULE : JS_EVAL_TYPE_GLOBAL;

    JSValue val = JS_Eval(s->ctx, src, len, path, eval_flags);
    free(src);
    if (JS_IsException(val)) {
        pu_dump_error(s->ctx);
        JS_FreeValue(s->ctx, val);
        s->failed = 1;
        return 1;
    }
    if (is_module && JS_PromiseState(s->ctx, val) != JS_PROMISE_NOT_A_PROMISE) {
        JS_FreeValue(s->ctx, s->entry);
        s->entry = val;
        return pu_script_failed(s);
    }
    JS_FreeValue(s->ctx, val);
    return 0;
}

void pu_script_set_dispatch(PuScript *s, PuDispatch *d)
{
    if (s) s->dispatch = d;
}

static void pu_fire_timer(PuScript *s, int idx)
{
    /* Hold our own ref across the call: a callback that calls clearInterval(self)
     * frees the timer's ref to a function that is still executing — without this
     * dup that's a use-after-free. Also don't hold a PuTimer* across JS_Call: the
     * callback may realloc s->timers by adding timers. */
    JSValue func     = JS_DupValue(s->ctx, s->timers[idx].func);
    int     interval = s->timers[idx].interval_ms;
    if (interval > 0) {
        s->timers[idx].due_ms = pu_now_ms() + interval; /* reschedule, stays active */
    } else {
        s->timers[idx].active = 0;
        JS_FreeValue(s->ctx, s->timers[idx].func);      /* release the timer's ref */
        s->timers[idx].func   = JS_UNDEFINED;
    }
    JSValue ret = JS_Call(s->ctx, func, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(ret)) pu_dump_error(s->ctx);
    JS_FreeValue(s->ctx, ret);
    JS_FreeValue(s->ctx, func);                          /* release our temporary ref */
}

int pu_script_pump(PuScript *s)
{
    int total = 0, did;
    do {
        did = 0;

        /* microtasks / promise jobs */
        JSContext *jctx;
        int r;
        do {
            r = JS_ExecutePendingJob(s->rt, &jctx);
            if (r < 0) pu_dump_error(jctx);
            if (r > 0) did++;
        } while (r > 0);

        /* async deliveries (worker messages, task callbacks) */
        if (s->dispatch) did += pu_dispatch_drain(s->dispatch);

        /* a single due timer (re-loop picks up the rest) */
        int idx = pu_next_timer(s);
        if (idx >= 0 && s->timers[idx].due_ms <= pu_now_ms()) { pu_fire_timer(s, idx); did++; }

        total += did;
    } while (did > 0);
    pu_script_failed(s);
    return total;
}

void pu_script_run_loop(PuScript *s)
{
    for (;;) {
        pu_script_pump(s);
        if (pu_script_failed(s)) break;

        int idx = pu_next_timer(s);
        int pending = s->dispatch ? pu_dispatch_pending(s->dispatch) : 0;
        if (idx < 0 && pending == 0) break; /* fully idle */

        if (idx < 0) {
            /* only async work outstanding -> block until a delivery arrives */
            pu_dispatch_wait(s->dispatch, 1000);
            continue;
        }

        int64_t wait = s->timers[idx].due_ms - pu_now_ms();
        if (wait > 0) {
            if (s->dispatch && pending > 0) pu_dispatch_wait(s->dispatch, (int)wait);
            else                            pu_sleep_ms(wait);
        }
    }
}

void pu_script_destroy(PuScript *s)
{
    if (!s) return;
    for (int i = 0; i < s->ntimers; i++) {
        if (s->timers[i].active) JS_FreeValue(s->ctx, s->timers[i].func);
    }
    free(s->timers);
    for (int i = 0; i < s->nraf; i++) JS_FreeValue(s->ctx, s->rafs[i].func);
    free(s->rafs);
    JS_FreeValue(s->ctx, s->entry);
    if (s->ctx) JS_FreeContext(s->ctx);
    if (s->rt)  JS_FreeRuntime(s->rt);
    free(s);
}
