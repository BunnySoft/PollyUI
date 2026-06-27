#include "host/win32/window.h"
#include "script/script.h"
#include "bridge/bridge.h"
#include "layout/layout.h"
#include "render/render.h"
#include "model/node.h"
#include "core/dispatch.h"
#include "concurrency/async.h"

#include <stdint.h>
#include <stdio.h>
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
    pu_layout_calculate(body, (float)width, (float)height);
    pu_render_tree(surface, body, scale);
}

/* Click: hit-test against the last computed layout, dispatch to JS, then drain
 * any microtasks the handler queued. The window repaints afterward. */
static void app_pointer(int x, int y, PuPointerType type, void *user)
{
    PuApp *app = (PuApp *)user;
    if (type != PU_POINTER_CLICK) return;
    PuNode *target = pu_node_hit_test(pu_bridge_body(app->bridge), (float)x, (float)y);

    /* Click-to-focus: focus the nearest focusable ancestor (or blur). */
    PuNode *f = target;
    while (f && f->tab_index < 0) f = f->parent;
    pu_bridge_set_focus(app->bridge, f);

    if (target)
        pu_bridge_dispatch_event(app->bridge, target, "click");
    pu_script_pump(app->script);
}

/* Keyboard: Tab cycles focus; other keys dispatch a keydown to the focused
 * element. The window repaints afterward (the handler may mutate the DOM). */
static void app_key(const char *key, void *user)
{
    PuApp *app = (PuApp *)user;
    if (strcmp(key, "Tab") == 0)
        pu_bridge_focus_next(app->bridge);
    else
        pu_bridge_dispatch_key(app->bridge, "keydown", key);
    pu_script_pump(app->script);
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
    pu_layout_calculate(body, (float)g_test->width, (float)g_test->height);
    pu_render_tree(g_test->surface, body, 1.0f);
}

static JSValue host_render(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    /* Each render advances one animation frame so rAF is testable headlessly. */
    pu_script_flush_raf(g_test->script, pu_frame_ms());
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

    if (target)
        pu_bridge_dispatch_event(g_test->bridge, target, "click");
    pu_script_run_loop(g_test->script);
    test_render();
    return JS_NewBool(ctx, target != NULL);
}

static JSValue host_key(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    const char *key = argc >= 1 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (key) {
        if (strcmp(key, "Tab") == 0) pu_bridge_focus_next(g_test->bridge);
        else                         pu_bridge_dispatch_key(g_test->bridge, "keydown", key);
        JS_FreeCString(ctx, key);
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
    JS_SetPropertyStr(ctx, host, "key",    JS_NewCFunction(ctx, host_key, "key", 1));
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
