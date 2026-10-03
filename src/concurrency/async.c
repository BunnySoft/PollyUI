#include "concurrency/async.h"
#include "core/thread.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

/* ---- shared UI-thread state ------------------------------------------------*/

static JSContext  *g_ui_ctx;
static PuDispatch *g_disp;
static JSClassID   g_worker_class;

static char *dup_str(const char *s)
{
    if (!s) return NULL;
    size_t n = strlen(s) + 1;
    char *p = (char *)malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}

static char *read_file(const char *path, size_t *out_len)
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

static void report(JSContext *ctx, const char *where)
{
    JSValue e = JS_GetException(ctx);
    const char *s = JS_ToCString(ctx, e);
    fprintf(stderr, "[%s] uncaught: %s\n", where, s ? s : "error");
    if (s) JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, e);
}

static void drain_jobs(JSRuntime *rt)
{
    JSContext *c;
    int r;
    do { r = JS_ExecutePendingJob(rt, &c); if (r < 0) report(c, "job"); } while (r > 0);
}

/* Serialize a value to a heap JSON string ("null" on failure). */
static char *to_json(JSContext *ctx, JSValueConst v)
{
    JSValue s = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
    char *out = NULL;
    if (JS_IsString(s)) {
        const char *c = JS_ToCString(ctx, s);
        if (c) { out = dup_str(c); JS_FreeCString(ctx, c); }
    }
    JS_FreeValue(ctx, s);
    return out ? out : dup_str("null");
}

static JSValue from_json(JSContext *ctx, const char *json)
{
    return JS_ParseJSON(ctx, json, strlen(json), "<message>");
}

/* Invoke obj.onmessage({data: value}); consumes `value`. */
static void call_onmessage(JSContext *ctx, JSValueConst obj, JSValue value)
{
    JSValue held = JS_DupValue(ctx, obj);
    JSValue onmsg = JS_GetPropertyStr(ctx, obj, "onmessage");
    if (JS_IsFunction(ctx, onmsg)) {
        JSValue ev = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, ev, "data", value); /* consumes value */
        JSValue r = JS_Call(ctx, onmsg, obj, 1, &ev);
        if (JS_IsException(r)) report(ctx, "onmessage");
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, ev);
    } else {
        JS_FreeValue(ctx, value);
    }
    JS_FreeValue(ctx, onmsg);
    JS_FreeValue(ctx, held);
}

/* ---- (A) Worker ------------------------------------------------------------*/

typedef struct WMsg { char *json; struct WMsg *next; } WMsg;
typedef struct UiMsg UiMsg;

typedef struct PuWorker {
    PuThread *thread;
    PuMutex  *in_mtx;
    PuCond   *in_cond;
    WMsg     *in_head, *in_tail;
    volatile int running;
    int       terminated;
    JSValue   ui_obj;            /* UI-side wrapper (duped: keep-alive) */
    char     *path;
    UiMsg    *out_head;
    struct PuWorker *next;       /* global list */
} PuWorker;

static PuWorker *g_workers;

/* worker -> UI message delivery (runs on the UI thread). */
struct UiMsg { PuWorker *w; char *json; UiMsg *next, *previous; };

static void unlink_ui_message(UiMsg *m)
{
    if (m->previous) m->previous->next = m->next; else m->w->out_head = m->next;
    if (m->next) m->next->previous = m->previous;
}

static void deliver_worker_to_ui(void *ctx)
{
    UiMsg *m = (UiMsg *)ctx;
    pu_mutex_lock(m->w->in_mtx);
    unlink_ui_message(m);
    pu_mutex_unlock(m->w->in_mtx);
    if (!m->w->terminated) {
        JSValue val = from_json(g_ui_ctx, m->json);
        call_onmessage(g_ui_ctx, m->w->ui_obj, val);
    }
    free(m->json);
    free(m);
}

/* postMessage() inside the worker (worker thread). */
static JSValue jsw_worker_post(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    PuWorker *w = (PuWorker *)JS_GetContextOpaque(ctx);
    UiMsg *m = (UiMsg *)calloc(1, sizeof(UiMsg));
    if (!m) return JS_ThrowOutOfMemory(ctx);
    m->w = w;
    m->json = to_json(ctx, argc >= 1 ? argv[0] : JS_UNDEFINED);
    if (!m->json) { free(m); return JS_ThrowOutOfMemory(ctx); }
    pu_mutex_lock(w->in_mtx);
    m->next = w->out_head;
    if (w->out_head) w->out_head->previous = m;
    w->out_head = m;
    pu_mutex_unlock(w->in_mtx);
    if (!pu_dispatch_post(g_disp, deliver_worker_to_ui, m)) {
        pu_mutex_lock(w->in_mtx); unlink_ui_message(m); pu_mutex_unlock(w->in_mtx);
        free(m->json); free(m); return JS_ThrowOutOfMemory(ctx);
    }
    return JS_UNDEFINED;
}

static JSValue jsw_worker_log(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    for (int i = 0; i < argc; i++) {
        if (i) fputc(' ', stdout);
        const char *s = JS_ToCString(ctx, argv[i]);
        if (s) { fputs(s, stdout); JS_FreeCString(ctx, s); }
    }
    fputc('\n', stdout);
    fflush(stdout);
    return JS_UNDEFINED;
}

static int worker_interrupt(JSRuntime *rt, void *user)
{
    (void)rt;
    PuWorker *worker = user;
    pu_mutex_lock(worker->in_mtx);
    int stop = !worker->running;
    pu_mutex_unlock(worker->in_mtx);
    return stop;
}

static void worker_thread_main(void *arg)
{
    PuWorker *w = (PuWorker *)arg;
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = rt ? JS_NewContext(rt) : NULL;
    if (!ctx) { if (rt) JS_FreeRuntime(rt); return; }
    JS_SetInterruptHandler(rt, worker_interrupt, w);
    JS_SetContextOpaque(ctx, w);

    /* worker globals: postMessage, console.log, self */
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "postMessage", JS_NewCFunction(ctx, jsw_worker_post, "postMessage", 1));
    JSValue console = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, console, "log", JS_NewCFunction(ctx, jsw_worker_log, "log", 1));
    JS_SetPropertyStr(ctx, global, "console", console);
    JS_SetPropertyStr(ctx, global, "self", JS_DupValue(ctx, global));
    JS_FreeValue(ctx, global);

    size_t len = 0;
    char *src = read_file(w->path, &len);
    if (src) {
        JSValue r = JS_Eval(ctx, src, len, w->path, JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(r)) {
            if (worker_interrupt(rt, w)) JS_FreeValue(ctx, JS_GetException(ctx));
            else report(ctx, "worker");
        }
        JS_FreeValue(ctx, r);
        free(src);
    } else {
        fprintf(stderr, "[worker] cannot read %s\n", w->path);
    }
    if (!worker_interrupt(rt, w)) drain_jobs(rt);

    for (;;) {
        pu_mutex_lock(w->in_mtx);
        while (!w->in_head && w->running) pu_cond_wait(w->in_cond, w->in_mtx);
        if (!w->running) { pu_mutex_unlock(w->in_mtx); break; }
        WMsg *msg = w->in_head;
        w->in_head = msg->next;
        if (!w->in_head) w->in_tail = NULL;
        pu_mutex_unlock(w->in_mtx);

        JSValue gl = JS_GetGlobalObject(ctx);
        call_onmessage(ctx, gl, from_json(ctx, msg->json));
        JS_FreeValue(ctx, gl);
        free(msg->json);
        free(msg);
        drain_jobs(rt);
    }

    WMsg *m = w->in_head;
    while (m) { WMsg *n = m->next; free(m->json); free(m); m = n; }
    w->in_head = w->in_tail = NULL;
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

/* worker.postMessage() on the UI side (UI -> worker). */
static JSValue jsw_ui_post(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    if (ctx != g_ui_ctx || !g_disp) return JS_ThrowInternalError(ctx, "worker service is not running");
    PuWorker *w = (PuWorker *)JS_GetOpaque(this_val, g_worker_class);
    if (!w || w->terminated) return JS_UNDEFINED;
    WMsg *m = (WMsg *)malloc(sizeof(WMsg));
    if (!m) return JS_UNDEFINED;
    m->json = to_json(ctx, argc >= 1 ? argv[0] : JS_UNDEFINED);
    m->next = NULL;
    pu_mutex_lock(w->in_mtx);
    if (w->in_tail) w->in_tail->next = m; else w->in_head = m;
    w->in_tail = m;
    pu_cond_signal(w->in_cond);
    pu_mutex_unlock(w->in_mtx);
    return JS_UNDEFINED;
}

static void worker_terminate(PuWorker *w)
{
    if (w->terminated) return;
    w->terminated = 1;
    pu_mutex_lock(w->in_mtx);
    w->running = 0;
    pu_cond_signal(w->in_cond);
    pu_mutex_unlock(w->in_mtx);
    pu_thread_join(w->thread);
    w->thread = NULL;
    free(w->path);
    w->path = NULL;
    if (!JS_IsUndefined(w->ui_obj)) { JS_FreeValue(g_ui_ctx, w->ui_obj); w->ui_obj = JS_UNDEFINED; }
    pu_dispatch_unref(g_disp);
}

static JSValue jsw_ui_terminate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    if (ctx != g_ui_ctx || !g_disp) return JS_ThrowInternalError(ctx, "worker service is not running");
    (void)ctx; (void)argc; (void)argv;
    PuWorker *w = (PuWorker *)JS_GetOpaque(this_val, g_worker_class);
    if (w) worker_terminate(w);
    return JS_UNDEFINED;
}

static void worker_finalizer(JSRuntime *rt, JSValueConst val) { (void)rt; (void)val; }

static JSValue js_worker_ctor(JSContext *ctx, JSValueConst new_target, int argc, JSValueConst *argv)
{
    if (ctx != g_ui_ctx || !g_disp) return JS_ThrowInternalError(ctx, "worker service is not running");
    (void)new_target;
    const char *path = argc >= 1 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path) return JS_ThrowTypeError(ctx, "Worker(path) requires a path");

    PuWorker *w = (PuWorker *)calloc(1, sizeof(PuWorker));
    if (!w) { JS_FreeCString(ctx, path); return JS_ThrowOutOfMemory(ctx); }
    w->path = dup_str(path);
    JS_FreeCString(ctx, path);
    w->in_mtx = pu_mutex_new();
    w->in_cond = pu_cond_new();
    if (!w->path || !w->in_mtx || !w->in_cond) {
        free(w->path); pu_mutex_free(w->in_mtx); pu_cond_free(w->in_cond); free(w);
        return JS_ThrowOutOfMemory(ctx);
    }
    w->running = 1;
    w->ui_obj = JS_UNDEFINED;

    JSValue obj = JS_NewObjectClass(ctx, g_worker_class);
    if (JS_IsException(obj)) { pu_mutex_free(w->in_mtx); pu_cond_free(w->in_cond); free(w->path); free(w); return obj; }
    JS_SetOpaque(obj, w);
    w->ui_obj = JS_DupValue(ctx, obj);

    pu_dispatch_ref(g_disp);

    w->thread = pu_thread_start(worker_thread_main, w);
    if (!w->thread) {
        JS_SetOpaque(obj, NULL);
        JS_FreeValue(ctx, w->ui_obj); JS_FreeValue(ctx, obj);
        pu_mutex_free(w->in_mtx); pu_cond_free(w->in_cond); free(w->path); free(w);
        pu_dispatch_unref(g_disp);
        return JS_ThrowInternalError(ctx, "cannot start worker thread");
    }
    w->next = g_workers;
    g_workers = w;
    return obj;
}

/* ---- (B) native async task -------------------------------------------------*/

typedef struct PuTask {
    long    n_in;
    long    n_out;
    JSValue cb;
    PuThread *thread;
    PuMutex *mutex;
    int cancelled;
    struct PuTask *next, *previous;
} PuTask;

static PuTask *g_tasks;

static void unlink_task(PuTask *task)
{
    if (task->previous) task->previous->next = task->next; else g_tasks = task->next;
    if (task->next) task->next->previous = task->previous;
}

static long count_primes(PuTask *task)
{
    long count = 0;
    for (long i = 2; i < task->n_in; i++) {
        if ((i & 1023) == 2) {
            pu_mutex_lock(task->mutex);
            int stop = task->cancelled;
            pu_mutex_unlock(task->mutex);
            if (stop) break;
        }
        int prime = 1;
        for (long j = 2; j <= i / j; j++) {
            if (i % j == 0) { prime = 0; break; }
        }
        if (prime) count++;
    }
    return count;
}

static void deliver_task(void *ctx)
{
    PuTask *t = (PuTask *)ctx;
    pu_thread_join(t->thread);
    unlink_task(t);
    JSValue arg = JS_NewInt64(g_ui_ctx, t->n_out);
    JSValue r = JS_Call(g_ui_ctx, t->cb, JS_UNDEFINED, 1, &arg);
    if (JS_IsException(r)) report(g_ui_ctx, "computeAsync");
    JS_FreeValue(g_ui_ctx, r);
    JS_FreeValue(g_ui_ctx, arg);
    JS_FreeValue(g_ui_ctx, t->cb);
    pu_mutex_free(t->mutex);
    free(t);
    pu_dispatch_unref(g_disp);
}

static void task_thread(void *arg)
{
    PuTask *t = (PuTask *)arg;
    t->n_out = count_primes(t);
    if (!pu_dispatch_post(g_disp, deliver_task, t)) {
        fprintf(stderr, "[computeAsync] Fatal: cannot schedule task completion\n");
        abort();
    }
}

static JSValue js_compute_async(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    if (ctx != g_ui_ctx || !g_disp) return JS_ThrowInternalError(ctx, "task service is not running");
    (void)this_val;
    if (argc < 2 || !JS_IsFunction(ctx, argv[1]))
        return JS_ThrowTypeError(ctx, "computeAsync(n, callback)");
    int64_t n = 0;
    if (JS_ToInt64(ctx, &n, argv[0]) < 0) return JS_EXCEPTION;
    if (n < 0 || n > LONG_MAX) return JS_ThrowRangeError(ctx, "computeAsync input is outside native range");
    PuTask *t = (PuTask *)calloc(1, sizeof(PuTask));
    if (!t) return JS_ThrowOutOfMemory(ctx);
    t->mutex = pu_mutex_new();
    if (!t->mutex) { free(t); return JS_ThrowOutOfMemory(ctx); }
    t->n_in = (long)n;
    t->cb = JS_DupValue(ctx, argv[1]);
    pu_dispatch_ref(g_disp);
    t->thread = pu_thread_start(task_thread, t);
    if (!t->thread) {
        pu_dispatch_unref(g_disp); JS_FreeValue(ctx, t->cb); pu_mutex_free(t->mutex); free(t);
        return JS_ThrowInternalError(ctx, "cannot start compute thread");
    }
    t->next = g_tasks;
    if (g_tasks) g_tasks->previous = t;
    g_tasks = t;
    return JS_UNDEFINED;
}

/* ---- install / shutdown ----------------------------------------------------*/

void pu_async_install(JSContext *ctx, PuDispatch *dispatch)
{
    g_ui_ctx = ctx;
    g_disp = dispatch;

    JSRuntime *rt = JS_GetRuntime(ctx);
    if (g_worker_class == 0) JS_NewClassID(rt, &g_worker_class);
    JSClassDef def = { "Worker", .finalizer = worker_finalizer };
    JS_NewClass(rt, g_worker_class, &def);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, proto, "postMessage", JS_NewCFunction(ctx, jsw_ui_post, "postMessage", 1));
    JS_SetPropertyStr(ctx, proto, "terminate",   JS_NewCFunction(ctx, jsw_ui_terminate, "terminate", 0));
    JS_SetClassProto(ctx, g_worker_class, proto);

    JSValue ctor = JS_NewCFunction2(ctx, js_worker_ctor, "Worker", 1, JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, ctor, proto);

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "Worker", ctor);
    JS_SetPropertyStr(ctx, global, "computeAsync", JS_NewCFunction(ctx, js_compute_async, "computeAsync", 2));
    JS_FreeValue(ctx, global);
}

void pu_async_shutdown(void)
{
    PuWorker *w = g_workers;
    while (w) {
        PuWorker *next = w->next;
        worker_terminate(w);
        while (w->out_head) {
            UiMsg *message = w->out_head;
            unlink_ui_message(message);
            pu_dispatch_remove(g_disp, deliver_worker_to_ui, message);
            free(message->json); free(message);
        }
        pu_mutex_free(w->in_mtx);
        pu_cond_free(w->in_cond);
        free(w);
        w = next;
    }
    g_workers = NULL;
    for (PuTask *task = g_tasks; task; task = task->next) {
        pu_mutex_lock(task->mutex); task->cancelled = 1; pu_mutex_unlock(task->mutex);
    }
    while (g_tasks) {
        PuTask *task = g_tasks;
        pu_thread_join(task->thread);
        pu_dispatch_remove(g_disp, deliver_task, task);
        unlink_task(task);
        JS_FreeValue(g_ui_ctx, task->cb);
        pu_mutex_free(task->mutex); free(task);
        pu_dispatch_unref(g_disp);
    }
    g_ui_ctx = NULL;
    g_disp = NULL;
}
