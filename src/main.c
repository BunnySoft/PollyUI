#include "host/win32/window.h"
#include "script/script.h"
#include "script/storage.h"
#include "net/fetch.h"
#include "bridge/bridge.h"
#include "layout/layout.h"
#include "render/render.h"
#include "model/node.h"
#include "core/dispatch.h"
#include "concurrency/async.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#include <dbghelp.h>
/* Print a symbolized stack trace on an unhandled crash (no debugger needed). */
static LONG WINAPI pu_crash_handler(EXCEPTION_POINTERS *ep)
{
    HANDLE proc = GetCurrentProcess();
    SymSetOptions(SYMOPT_LOAD_LINES | SYMOPT_DEFERRED_LOADS | SYMOPT_UNDNAME);
    SymInitialize(proc, NULL, TRUE);
    CONTEXT *ctx = ep->ContextRecord;
    fprintf(stderr, "\n*** CRASH code=0x%08lx at %p (thread %lu) ***\n",
            ep->ExceptionRecord->ExceptionCode,
            ep->ExceptionRecord->ExceptionAddress, GetCurrentThreadId());

    STACKFRAME64 sf;
    memset(&sf, 0, sizeof(sf));
    sf.AddrPC.Offset = ctx->Rip;    sf.AddrPC.Mode = AddrModeFlat;
    sf.AddrFrame.Offset = ctx->Rbp; sf.AddrFrame.Mode = AddrModeFlat;
    sf.AddrStack.Offset = ctx->Rsp; sf.AddrStack.Mode = AddrModeFlat;

    char buf[sizeof(SYMBOL_INFO) + 256];
    SYMBOL_INFO *sym = (SYMBOL_INFO *)buf;
    sym->SizeOfStruct = sizeof(SYMBOL_INFO);
    sym->MaxNameLen = 255;

    for (int i = 0; i < 24; i++) {
        if (!StackWalk64(IMAGE_FILE_MACHINE_AMD64, proc, GetCurrentThread(), &sf, ctx,
                         NULL, SymFunctionTableAccess64, SymGetModuleBase64, NULL))
            break;
        if (!sf.AddrPC.Offset) break;
        DWORD64 disp = 0;
        if (SymFromAddr(proc, sf.AddrPC.Offset, &disp, sym))
            fprintf(stderr, "  #%-2d %s + 0x%llx\n", i, sym->Name, (unsigned long long)disp);
        else
            fprintf(stderr, "  #%-2d 0x%llx\n", i, (unsigned long long)sf.AddrPC.Offset);
    }
    fflush(stderr);
    return EXCEPTION_EXECUTE_HANDLER;
}
#endif

/* PollyUI entry point.
 *
 *   pollyui            -> built-in render demo (M0b)
 *   pollyui app.js     -> run the script to build the DOM, then lay it out with
 *                         Yoga and paint it in a window (M1 + M2 + M3)
 */

/* ---- optional perf tracing: set env PU_PERF=1 to print per-frame timings ---- */
#ifdef _WIN32
static int    g_perf = -1;
static double g_qpc_freq = 0;
static double pu_now_ms(void)
{
    LARGE_INTEGER c; QueryPerformanceCounter(&c);
    if (g_qpc_freq == 0) { LARGE_INTEGER f; QueryPerformanceFrequency(&f); g_qpc_freq = (double)f.QuadPart; }
    return (double)c.QuadPart * 1000.0 / g_qpc_freq;
}
static int pu_perf_on(void)
{
    if (g_perf < 0) { const char *e = getenv("PU_PERF"); g_perf = (e && e[0] && e[0] != '0') ? 1 : 0; }
    return g_perf;
}
#else
static double pu_now_ms(void) { return 0; }
static int    pu_perf_on(void) { return 0; }
#endif

/* Shared state for the window callbacks. */
typedef struct PuApp {
    PuScript *script;
    PuBridge *bridge;
} PuApp;

/* Per-frame: lay out the DOM for the current (logical) size, then paint it,
 * scaling logical pixels up to physical for high-DPI displays. */
static void app_paint(PuSurface *surface, int width, int height, float scale, void *user)
{
    PuApp *app = (PuApp *)user;
    PuNode *body = pu_bridge_body(app->bridge);
    if (pu_perf_on()) {
        double t0 = pu_now_ms();
        pu_layout_calculate(body, (float)width, (float)height);
        double t1 = pu_now_ms();
        pu_render_tree(surface, body, scale);
        double t2 = pu_now_ms();
        fprintf(stderr, "[perf] paint: layout %.2fms  render %.2fms  total %.2fms\n",
                t1 - t0, t2 - t1, t2 - t0);
        return;
    }
    pu_layout_calculate(body, (float)width, (float)height);
    pu_render_tree(surface, body, scale);
}

/* Pointer: hit-test against the last computed layout and dispatch the matching
 * DOM event (mousedown/mouseup/mousemove/click), then drain queued work. */
static int app_pointer(int x, int y, PuPointerType type, void *user)
{
    PuApp *app = (PuApp *)user;
    PuNode *target = pu_node_hit_test(pu_bridge_body(app->bridge), (float)x, (float)y);

    int state_changed = 0; /* hover/focus flag changes repaint natively (no re-render) */
    if (type == PU_POINTER_DOWN) {
        /* Click-to-focus on press: focus the nearest focusable ancestor (or blur). */
        PuNode *f = target;
        while (f && f->tab_index < 0) f = f->parent;
        state_changed |= pu_bridge_set_focus(app->bridge, f);
    }

    const char *t = (type == PU_POINTER_DOWN) ? "mousedown"
                  : (type == PU_POINTER_UP)   ? "mouseup"
                  : (type == PU_POINTER_MOVE) ? "mousemove" : "click";
    if (pu_perf_on()) {
        double t0 = pu_now_ms();
        state_changed |= pu_bridge_dispatch_pointer(app->bridge, t, target, (float)x, (float)y);
        double t1 = pu_now_ms();
        int worked = pu_script_pump(app->script);
        double t2 = pu_now_ms();
        fprintf(stderr, "[perf] pointer %-9s: dispatch %.2fms  js+rerender %.2fms (worked=%d state=%d)\n",
                t, t1 - t0, t2 - t1, worked, state_changed);
        return worked | state_changed;
    }
    state_changed |= pu_bridge_dispatch_pointer(app->bridge, t, target, (float)x, (float)y);
    /* Repaint signal: a re-render (worked > 0) OR a native hover/focus state
     * change. A mousemove that stays within the same element returns 0 and the
     * host skips the repaint. */
    return pu_script_pump(app->script) | state_changed;
}

/* Wheel: hit-test, then dispatch + scroll the nearest scroll container. */
static int app_wheel(int x, int y, float dy, void *user)
{
    PuApp *app = (PuApp *)user;
    PuNode *target = pu_node_hit_test(pu_bridge_body(app->bridge), (float)x, (float)y);
    /* Native scroll is applied C-side (not reactive), so OR its "moved" signal
     * with the pump result; either alone is a reason to repaint. */
    int scrolled = pu_bridge_dispatch_wheel(app->bridge, target, (float)x, (float)y, dy);
    return scrolled | pu_script_pump(app->script);
}

/* Keyboard: Tab cycles focus; other keys dispatch keydown/keyup to the focused
 * element. Returns > 0 if the DOM changed (so the host repaints). */
static int app_key(const char *key, int is_down, void *user)
{
    PuApp *app = (PuApp *)user;
    if (is_down && strcmp(key, "Tab") == 0)
        pu_bridge_focus_next(app->bridge);
    else
        pu_bridge_dispatch_key(app->bridge, is_down ? "keydown" : "keyup", key);
    return pu_script_pump(app->script);
}

/* Monotonic millisecond clock for animation timestamps. */
static double pu_frame_ms(void)
{
#ifdef _WIN32
    return (double)GetTickCount64();
#else
    return 0.0;
#endif
}

/* Frame/wake pump: fire animation callbacks + pending UI-thread work; the
 * window repaints if anything ran (rAF callbacks typically mutate the DOM). */
static int app_async(void *user)
{
    PuApp *app = (PuApp *)user;
    int n = pu_script_flush_raf(app->script, pu_frame_ms());
    return n + pu_script_pump(app->script);
}

/* Dispatcher waker (called from worker threads): nudge the window to drain. */
static void app_wake(void *win) { pu_window_wake((PuWindow *)win); }

/* ---- headless test API (`pollyui --test t.js`) ----------------------------*/
/* Drives the UI in-process (no window, no OS input) for deterministic tests:
 * the script gets a `host` global to render, click, read pixels, and snapshot. */

typedef struct PuTestHost {
    PuScript  *script;
    PuBridge  *bridge;
    PuSurface *surface;
    int        width, height;
} PuTestHost;

static PuTestHost *g_test;

static void test_render(void)
{
    PuNode *body = pu_bridge_body(g_test->bridge);
    if (pu_perf_on()) {
        double t0 = pu_now_ms();
        pu_layout_calculate(body, (float)g_test->width, (float)g_test->height);
        double t1 = pu_now_ms();
        pu_render_tree(g_test->surface, body, 1.0f);
        double t2 = pu_now_ms();
        fprintf(stderr, "[perf] test_render: layout %.2fms  render %.2fms  total %.2fms\n",
                t1 - t0, t2 - t1, t2 - t0);
        return;
    }
    pu_layout_calculate(body, (float)g_test->width, (float)g_test->height);
    pu_render_tree(g_test->surface, body, 1.0f);
}

static JSValue host_render(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    /* Each render advances one animation frame so rAF is testable headlessly.
     * An optional explicit timestamp (ms) makes animations deterministic. */
    double ts = pu_frame_ms();
    if (argc >= 1) JS_ToFloat64(ctx, &ts, argv[0]);
    pu_script_flush_raf(g_test->script, ts);
    test_render();
    return JS_UNDEFINED;
}

static JSValue host_click(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    double x = 0, y = 0;
    if (argc >= 1) JS_ToFloat64(ctx, &x, argv[0]);
    if (argc >= 2) JS_ToFloat64(ctx, &y, argv[1]);
    PuNode *body = pu_bridge_body(g_test->bridge);
    pu_layout_calculate(body, (float)g_test->width, (float)g_test->height);
    PuNode *target = pu_node_hit_test(body, (float)x, (float)y);

    PuNode *f = target;
    while (f && f->tab_index < 0) f = f->parent;
    pu_bridge_set_focus(g_test->bridge, f); /* click-to-focus */

    /* A real click is mousedown -> mouseup -> click. */
    pu_bridge_dispatch_pointer(g_test->bridge, "mousedown", target, (float)x, (float)y);
    pu_bridge_dispatch_pointer(g_test->bridge, "mouseup",   target, (float)x, (float)y);
    pu_bridge_dispatch_pointer(g_test->bridge, "click",     target, (float)x, (float)y);
    pu_script_run_loop(g_test->script);
    test_render();
    return JS_NewBool(ctx, target != NULL);
}

/* host.mouse(type, x, y): dispatch a single pointer event (mousedown/mouseup/
 * mousemove). mousemove drives mouseenter/mouseleave hover transitions. */
static JSValue host_mouse(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    const char *type = argc >= 1 ? JS_ToCString(ctx, argv[0]) : NULL;
    double x = 0, y = 0;
    if (argc >= 2) JS_ToFloat64(ctx, &x, argv[1]);
    if (argc >= 3) JS_ToFloat64(ctx, &y, argv[2]);
    PuNode *body = pu_bridge_body(g_test->bridge);
    pu_layout_calculate(body, (float)g_test->width, (float)g_test->height);
    PuNode *target = pu_node_hit_test(body, (float)x, (float)y);
    if (type) {
        pu_bridge_dispatch_pointer(g_test->bridge, type, target, (float)x, (float)y);
        JS_FreeCString(ctx, type);
        pu_script_run_loop(g_test->script);
        test_render();
    }
    return JS_NewBool(ctx, target != NULL);
}

/* host.flush(): drain microtasks / due timers / async deliveries (e.g. to let a
 * resolved Promise's .then run). Returns how many items ran. */
static JSValue host_flush(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_NewInt32(ctx, pu_script_pump(g_test->script));
}

/* host.scroll(x, y, dy): wheel by dy logical px over the element at (x,y). */
static JSValue host_scroll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    double x = 0, y = 0, dy = 0;
    if (argc >= 1) JS_ToFloat64(ctx, &x, argv[0]);
    if (argc >= 2) JS_ToFloat64(ctx, &y, argv[1]);
    if (argc >= 3) JS_ToFloat64(ctx, &dy, argv[2]);
    PuNode *body = pu_bridge_body(g_test->bridge);
    pu_layout_calculate(body, (float)g_test->width, (float)g_test->height);
    PuNode *target = pu_node_hit_test(body, (float)x, (float)y);
    pu_bridge_dispatch_wheel(g_test->bridge, target, (float)x, (float)y, (float)dy);
    pu_script_run_loop(g_test->script);
    test_render();
    return JS_NewBool(ctx, target != NULL);
}

static JSValue host_key(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    const char *key  = argc >= 1 ? JS_ToCString(ctx, argv[0]) : NULL;
    const char *type = argc >= 2 ? JS_ToCString(ctx, argv[1]) : NULL;
    if (key) {
        const char *t = type ? type : "keydown";
        if (strcmp(t, "keydown") == 0 && strcmp(key, "Tab") == 0)
            pu_bridge_focus_next(g_test->bridge);
        else
            pu_bridge_dispatch_key(g_test->bridge, t, key);
        JS_FreeCString(ctx, key);
        if (type) JS_FreeCString(ctx, type);
        pu_script_run_loop(g_test->script);
        test_render();
    }
    return JS_UNDEFINED;
}

static JSValue host_pixel(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    int32_t x = 0, y = 0;
    if (argc >= 1) JS_ToInt32(ctx, &x, argv[0]);
    if (argc >= 2) JS_ToInt32(ctx, &y, argv[1]);
    uint8_t rgba[4];
    pu_surface_read_pixel(g_test->surface, x, y, rgba);
    char buf[8];
    snprintf(buf, sizeof(buf), "#%02X%02X%02X", rgba[0], rgba[1], rgba[2]);
    return JS_NewString(ctx, buf);
}

static JSValue host_save(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1) return JS_NewBool(ctx, 0);
    const char *path = JS_ToCString(ctx, argv[0]);
    int ok = path ? pu_surface_save_png(g_test->surface, path) : 0;
    if (path) JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, ok);
}

static void install_host(JSContext *ctx, int w, int h)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue host = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, host, "width",  JS_NewInt32(ctx, w));
    JS_SetPropertyStr(ctx, host, "height", JS_NewInt32(ctx, h));
    JS_SetPropertyStr(ctx, host, "render", JS_NewCFunction(ctx, host_render, "render", 0));
    JS_SetPropertyStr(ctx, host, "click",  JS_NewCFunction(ctx, host_click, "click", 2));
    JS_SetPropertyStr(ctx, host, "mouse",  JS_NewCFunction(ctx, host_mouse, "mouse", 3));
    JS_SetPropertyStr(ctx, host, "scroll", JS_NewCFunction(ctx, host_scroll, "scroll", 3));
    JS_SetPropertyStr(ctx, host, "flush",  JS_NewCFunction(ctx, host_flush, "flush", 0));
    JS_SetPropertyStr(ctx, host, "key",    JS_NewCFunction(ctx, host_key, "key", 2));
    JS_SetPropertyStr(ctx, host, "pixel",  JS_NewCFunction(ctx, host_pixel, "pixel", 2));
    JS_SetPropertyStr(ctx, host, "save",   JS_NewCFunction(ctx, host_save, "save", 1));
    JS_SetPropertyStr(ctx, global, "host", host);
    JS_FreeValue(ctx, global);
}

static int run_test(const char *path)
{
    PuScript *s = pu_script_create();
    if (!s) return 1;
    PuBridge *b = pu_bridge_install(pu_script_jsctx(s));
    if (!b) { pu_script_destroy(s); return 1; }

    PuDispatch *disp = pu_dispatch_new();
    pu_script_set_dispatch(s, disp);
    pu_async_install(pu_script_jsctx(s), disp);
    pu_storage_install(pu_script_jsctx(s), "build/win-clang/_localstorage.dat");
    pu_fetch_install(pu_script_jsctx(s), disp);

    PuTestHost host;
    host.script = s;
    host.bridge = b;
    host.width = 800;
    host.height = 600;
    host.surface = pu_surface_create(host.width, host.height);
    g_test = &host;

    install_host(pu_script_jsctx(s), host.width, host.height);

    int rc = pu_script_run_file(s, path);
    if (rc == 0) pu_script_run_loop(s); /* async-aware: waits for workers/tasks */

    g_test = NULL;
    pu_async_shutdown();
    pu_storage_shutdown();
    if (host.surface) pu_surface_destroy(host.surface);
    pu_script_destroy(s);
    pu_bridge_free(b);
    pu_dispatch_free(disp);
    return rc;
}

static int run_app(const char *path)
{
    PuScript *s = pu_script_create();
    if (!s)
        return 1;

    PuBridge *bridge = pu_bridge_install(pu_script_jsctx(s));
    if (!bridge) { pu_script_destroy(s); return 1; }

    PuDispatch *disp = pu_dispatch_new();
    pu_script_set_dispatch(s, disp);
    pu_async_install(pu_script_jsctx(s), disp);
    pu_storage_install(pu_script_jsctx(s), "pollyui_localstorage.dat");
    pu_fetch_install(pu_script_jsctx(s), disp);

    int rc = pu_script_run_file(s, path);
    if (rc == 0)
        pu_script_pump(s);   /* drain microtasks/timers/async from setup (non-blocking) */

    if (rc == 0) {
        PuNode *body = pu_bridge_body(bridge);
        printf("--- native DOM tree ---\n");
        pu_node_dump(body, 0);
        fflush(stdout);

        PuWindowConfig cfg;
        cfg.title  = "PollyUI";
        cfg.width  = 1080;
        cfg.height = 720;
        PuWindow *win = pu_window_create(&cfg);
        if (win) {
            PuApp app = { s, bridge };
            pu_window_set_paint(win, app_paint, &app);
            pu_window_set_pointer(win, app_pointer, &app);
            pu_window_set_key(win, app_key, &app);
            pu_window_set_wheel(win, app_wheel, &app);
            pu_window_set_async(win, app_async, &app);
            pu_dispatch_set_waker(disp, app_wake, win); /* workers wake the window */
            pu_window_run(win);
            pu_window_destroy(win);
        }
    }

    pu_async_shutdown();    /* terminate workers before tearing down the context */
    pu_script_destroy(s);   /* GC finalizers; bridge ref keeps body alive */
    pu_bridge_free(bridge); /* frees the native tree */
    pu_dispatch_free(disp);
    return rc;
}

static int run_demo(void)
{
    PuWindowConfig cfg;
    cfg.title  = "PollyUI \xE2\x80\x94 demo";
    cfg.width  = 960;
    cfg.height = 600;

    PuWindow *w = pu_window_create(&cfg);
    if (!w)
        return 1;
    int code = pu_window_run(w);
    pu_window_destroy(w);
    return code;
}

int main(int argc, char **argv)
{
#ifdef _WIN32
    SetUnhandledExceptionFilter(pu_crash_handler);
#endif
    if (argc >= 3 && strcmp(argv[1], "--test") == 0)
        return run_test(argv[2]);
    if (argc >= 2)
        return run_app(argv[1]);
    return run_demo();
}
