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
#include <time.h>

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
static int app_pointer(const PuPointerEvent *event, void *user)
{
    PuApp *app = (PuApp *)user;
    PuNode *target = pu_node_hit_test(pu_bridge_body(app->bridge), event->x, event->y);
    pu_node_ref(target);

    int state_changed = 0; /* hover/focus flag changes repaint natively (no re-render) */
    if (event->type == PU_POINTER_DOWN) {
        /* Click-to-focus on press: focus the nearest focusable ancestor (or blur). */
        PuNode *f = target;
        while (f && f->tab_index < 0) f = f->parent;
        state_changed |= pu_bridge_set_focus(app->bridge, f);
    }

    const char *t = pu_pointer_name(event->type);
    int interaction = event->type != PU_POINTER_MOVE || event->buttons != 0;
    if (pu_perf_on()) {
        double t0 = pu_now_ms();
        state_changed |= pu_bridge_dispatch_pointer(app->bridge, target, event);
        double t1 = pu_now_ms();
        int worked = pu_script_pump(app->script);
        double t2 = pu_now_ms();
        fprintf(stderr, "[perf] pointer %-9s: dispatch %.2fms  js+rerender %.2fms (worked=%d state=%d)\n",
                t, t1 - t0, t2 - t1, worked, state_changed);
        pu_node_unref(target);
        return worked | state_changed | interaction;
    }
    state_changed |= pu_bridge_dispatch_pointer(app->bridge, target, event);
    /* Repaint signal: a re-render (worked > 0) OR a native hover/focus state
     * change. A mousemove that stays within the same element returns 0 and the
     * host skips the repaint. */
    int result = pu_script_pump(app->script) | state_changed | interaction;
    pu_node_unref(target);
    return result;
}

/* Wheel: hit-test, then dispatch + scroll the nearest scroll container. */
static int app_wheel(const PuWheelEvent *event, void *user)
{
    PuApp *app = (PuApp *)user;
    PuNode *target = pu_node_hit_test(pu_bridge_body(app->bridge), event->x, event->y);
    /* Native scroll is applied C-side (not reactive), so OR its "moved" signal
     * with the pump result; either alone is a reason to repaint. */
    int scrolled = pu_bridge_dispatch_wheel(app->bridge, target, event);
    return scrolled | pu_script_pump(app->script);
}

/* Keyboard: Tab cycles focus; other keys dispatch keydown/keyup to the focused
 * element. Returns > 0 if the DOM changed (so the host repaints). */
static int app_key(const PuKeyEvent *event, void *user)
{
    PuApp *app = (PuApp *)user;
    int prevented = pu_bridge_dispatch_key(app->bridge, event);
    if (!prevented && event->type == PU_KEY_DOWN && strcmp(event->key, "Tab") == 0 &&
        !(event->modifiers & (PU_MOD_CTRL | PU_MOD_ALT | PU_MOD_META))) {
        pu_bridge_focus_step(app->bridge, event->modifiers & PU_MOD_SHIFT);
        prevented = 1;
    }
    pu_script_pump(app->script);
    return PU_INPUT_REDRAW | (prevented ? PU_INPUT_PREVENT_DEFAULT : 0);
}

/* Monotonic millisecond clock for animation timestamps. */
static double pu_frame_ms(void)
{
#ifdef _WIN32
    return (double)GetTickCount64();
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1000000.0;
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

/* ---- windowed: custom title bar drag region + JS `window` controls -------- */
static PuWindow *g_app_window;
static int       g_pending_frameless = -1;

/* Asked by the host (frameless mode) whether a logical-coord point is in the
 * draggable title-bar area: walk up from the hit node and return 1 if the
 * nearest `appRegion` style is "drag" (mirrors CSS -webkit-app-region: drag). */
static int app_region(int x, int y, void *user)
{
    PuApp *app = (PuApp *)user;
    PuNode *n = pu_node_hit_test(pu_bridge_body(app->bridge), (float)x, (float)y);
    for (; n; n = n->parent) {
        const char *r = pu_style_get(&n->style, "appRegion");
        if (r) return strcmp(r, "drag") == 0;
    }
    return 0;
}

static JSValue jswin_minimize(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ (void)c;(void)t;(void)n;(void)a; pu_window_minimize(g_app_window); return JS_UNDEFINED; }
static JSValue jswin_maximize(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ (void)c;(void)t;(void)n;(void)a; pu_window_maximize_toggle(g_app_window); return JS_UNDEFINED; }
static JSValue jswin_close(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ (void)c;(void)t;(void)n;(void)a; pu_window_close(g_app_window); return JS_UNDEFINED; }
static JSValue jswin_ismax(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ (void)t;(void)n;(void)a; return JS_NewBool(c, pu_window_is_maximized(g_app_window)); }
static JSValue jswin_frameless(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ (void)t; int f = n >= 1 ? JS_ToBool(c, a[0]) : 1;
  if (g_app_window) pu_window_set_frameless(g_app_window, f); else g_pending_frameless = f;
  return JS_UNDEFINED; }
static int g_pending_backdrop = -1;
static JSValue jswin_backdrop(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ (void)t; int ty = 2 /*Mica*/; if (n >= 1) { int32_t v; if (!JS_ToInt32(c, &v, a[0])) ty = v; }
  if (g_app_window) pu_window_set_backdrop(g_app_window, ty); else g_pending_backdrop = ty;
  return JS_UNDEFINED; }
static int g_pending_titlebar = -1;
/* setTitleBarStyle('default' | 'overlay'|'hidden'|'hiddenInset'); or an int. On
 * macOS 'overlay' keeps native traffic lights with app-drawn full-size content. */
static JSValue jswin_titlebarstyle(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ (void)t; int style = 0;
  if (n >= 1) {
    if (JS_IsString(a[0])) { const char *s = JS_ToCString(c, a[0]);
      if (s && (strcmp(s,"overlay")==0 || strcmp(s,"hidden")==0 || strcmp(s,"hiddenInset")==0)) style = 1;
      if (s) JS_FreeCString(c, s); }
    else { int32_t v; if (!JS_ToInt32(c, &v, a[0])) style = v; }
  }
  if (g_app_window) pu_window_set_titlebar_style(g_app_window, style); else g_pending_titlebar = style;
  return JS_UNDEFINED; }

/* Install the global `window` object (windowed app only; absent under --test). */
static void install_window_api(JSContext *ctx)
{
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue win = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, win, "minimize",     JS_NewCFunction(ctx, jswin_minimize, "minimize", 0));
    JS_SetPropertyStr(ctx, win, "maximize",      JS_NewCFunction(ctx, jswin_maximize, "maximize", 0));
    JS_SetPropertyStr(ctx, win, "close",         JS_NewCFunction(ctx, jswin_close, "close", 0));
    JS_SetPropertyStr(ctx, win, "isMaximized",   JS_NewCFunction(ctx, jswin_ismax, "isMaximized", 0));
    JS_SetPropertyStr(ctx, win, "setFrameless",  JS_NewCFunction(ctx, jswin_frameless, "setFrameless", 1));
    JS_SetPropertyStr(ctx, win, "setBackdrop",   JS_NewCFunction(ctx, jswin_backdrop, "setBackdrop", 1));
    JS_SetPropertyStr(ctx, win, "setTitleBarStyle", JS_NewCFunction(ctx, jswin_titlebarstyle, "setTitleBarStyle", 1));
    /* OS identity so apps can render OS-appropriate chrome (e.g. macOS
     * traffic-light buttons on the left vs Windows controls on the right). */
#if defined(_WIN32)
    const char *plat = "windows";
#elif defined(__APPLE__)
    const char *plat = "macos";
#else
    const char *plat = "linux";
#endif
    JS_SetPropertyStr(ctx, win, "platform", JS_NewString(ctx, plat));
    JS_SetPropertyStr(ctx, g, "window", win);
    JS_FreeValue(ctx, g);
}

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

static int input_modifiers(JSContext *ctx, JSValueConst options, unsigned *modifiers)
{
    const char *names[] = { "shiftKey", "ctrlKey", "altKey", "metaKey", "capsLock", "numLock" };
    unsigned flags[] = { PU_MOD_SHIFT, PU_MOD_CTRL, PU_MOD_ALT, PU_MOD_META, PU_MOD_CAPS, PU_MOD_NUM };
    for (int i = 0; i < 6; i++) {
        JSValue value = JS_GetPropertyStr(ctx, options, names[i]);
        if (JS_IsException(value)) return 0;
        if (JS_ToBool(ctx, value)) *modifiers |= flags[i];
        JS_FreeValue(ctx, value);
    }
    return 1;
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
    pu_node_ref(target);

    PuNode *f = target;
    while (f && f->tab_index < 0) f = f->parent;
    pu_bridge_set_focus(g_test->bridge, f); /* click-to-focus */

    /* A real click is mousedown -> mouseup -> click. */
    PuPointerEvent event = { .type = PU_POINTER_DOWN, .x = (float)x, .y = (float)y, .button = 0, .buttons = 1 };
    pu_bridge_dispatch_pointer(g_test->bridge, target, &event);
    event.type = PU_POINTER_UP; event.buttons = 0;
    pu_bridge_dispatch_pointer(g_test->bridge, target, &event);
    event.type = PU_POINTER_CLICK;
    pu_bridge_dispatch_pointer(g_test->bridge, target, &event);
    pu_node_unref(target);
    pu_script_run_loop(g_test->script);
    test_render();
    return JS_NewBool(ctx, target != NULL);
}

/* host.mouse(type, x, y): dispatch a single pointer event (mousedown/mouseup/
 * mousemove). mousemove drives mouseenter/mouseleave hover transitions. */
static JSValue host_mouse(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 3 || !JS_IsString(argv[0]) || (argc >= 4 && !JS_IsObject(argv[3])))
        return JS_ThrowTypeError(ctx, "host.mouse requires type, x, y and optional options object");
    const char *type = argc >= 1 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!type) return JS_EXCEPTION;
    double x = 0, y = 0;
    if (argc >= 2) JS_ToFloat64(ctx, &x, argv[1]);
    if (argc >= 3) JS_ToFloat64(ctx, &y, argv[2]);
    PuPointerEvent event = { .x = (float)x, .y = (float)y };
    int found = 0;
    for (int i = PU_POINTER_CLICK; i <= PU_POINTER_AUXCLICK; i++) {
        if (!strcmp(type, pu_pointer_name((PuPointerType)i))) { event.type = (PuPointerType)i; found = 1; break; }
    }
    JS_FreeCString(ctx, type);
    if (!found) return JS_ThrowTypeError(ctx, "Unsupported pointer event type");
    event.button = event.type == PU_POINTER_MOVE ? -1 : event.type == PU_POINTER_CONTEXT_MENU ? 2 : 0;
    if (argc >= 4) {
        if (!input_modifiers(ctx, argv[3], &event.modifiers)) return JS_EXCEPTION;
        JSValue value = JS_GetPropertyStr(ctx, argv[3], "button");
        if (JS_IsException(value)) return JS_EXCEPTION;
        int32_t button = event.button;
        int result = JS_IsUndefined(value) ? 0 : JS_ToInt32(ctx, &button, value);
        JS_FreeValue(ctx, value);
        if (result < 0) return JS_EXCEPTION;
        if (button < -1 || button > 4) return JS_ThrowRangeError(ctx, "button must be -1..4");
        event.button = button;
        event.buttons = event.type == PU_POINTER_DOWN ? pu_button_mask(button) : 0;
        value = JS_GetPropertyStr(ctx, argv[3], "buttons");
        if (JS_IsException(value)) return JS_EXCEPTION;
        uint32_t buttons = event.buttons;
        result = JS_IsUndefined(value) ? 0 : JS_ToUint32(ctx, &buttons, value);
        JS_FreeValue(ctx, value);
        if (result < 0) return JS_EXCEPTION;
        if (buttons > 31) return JS_ThrowRangeError(ctx, "buttons must be a five-button bitmask");
        event.buttons = buttons;
    } else if (event.type == PU_POINTER_DOWN) event.buttons = 1;
    PuNode *body = pu_bridge_body(g_test->bridge);
    pu_layout_calculate(body, (float)g_test->width, (float)g_test->height);
    PuNode *target = pu_node_hit_test(body, (float)x, (float)y);
    pu_bridge_dispatch_pointer(g_test->bridge, target, &event);
    pu_script_run_loop(g_test->script);
    test_render();
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
    double x = 0, y = 0, dy = 0, dx = 0;
    if (argc >= 1) JS_ToFloat64(ctx, &x, argv[0]);
    if (argc >= 2) JS_ToFloat64(ctx, &y, argv[1]);
    if (argc >= 3) JS_ToFloat64(ctx, &dy, argv[2]);
    if (argc >= 4) JS_ToFloat64(ctx, &dx, argv[3]);
    PuWheelEvent event = { .x = (float)x, .y = (float)y, .delta_x = (float)dx, .delta_y = (float)dy };
    if (argc >= 5) {
        if (!JS_IsObject(argv[4])) return JS_ThrowTypeError(ctx, "wheel options must be an object");
        if (!input_modifiers(ctx, argv[4], &event.modifiers)) return JS_EXCEPTION;
    }
    PuNode *body = pu_bridge_body(g_test->bridge);
    pu_layout_calculate(body, (float)g_test->width, (float)g_test->height);
    PuNode *target = pu_node_hit_test(body, (float)x, (float)y);
    pu_bridge_dispatch_wheel(g_test->bridge, target, &event);
    pu_script_run_loop(g_test->script);
    test_render();
    return JS_NewBool(ctx, target != NULL);
}

static int host_key_options(JSContext *ctx, JSValueConst options, PuKeyEvent *event,
                            const char **code, int *text)
{
    if (!input_modifiers(ctx, options, &event->modifiers)) return 0;
    const char *names[] = { "repeat", "text" };
    for (int i = 0; i < 2; i++) {
        JSValue value = JS_GetPropertyStr(ctx, options, names[i]);
        if (JS_IsException(value)) return 0;
        int on = JS_ToBool(ctx, value);
        if (i == 0) event->repeat = on;
        else if (!JS_IsUndefined(value)) *text = on;
        JS_FreeValue(ctx, value);
    }
    JSValue value = JS_GetPropertyStr(ctx, options, "code");
    if (JS_IsException(value)) return 0;
    if (!JS_IsUndefined(value)) {
        *code = JS_ToCString(ctx, value);
        JS_FreeValue(ctx, value);
        if (!*code) return 0;
    } else JS_FreeValue(ctx, value);
    event->code = *code;
    return 1;
}

static JSValue host_key(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1 || !JS_IsString(argv[0]) ||
        (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsString(argv[1])) ||
        (argc >= 3 && !JS_IsObject(argv[2])))
        return JS_ThrowTypeError(ctx, "host.key requires a key string, optional type string and options object");
    const char *key  = argc >= 1 ? JS_ToCString(ctx, argv[0]) : NULL;
    const char *type = argc >= 2 && !JS_IsUndefined(argv[1]) ? JS_ToCString(ctx, argv[1]) : NULL;
    if (!key || (argc >= 2 && JS_IsString(argv[1]) && !type)) {
        if (key) JS_FreeCString(ctx, key);
        if (type) JS_FreeCString(ctx, type);
        return JS_EXCEPTION;
    }
    if (key) {
        const char *t = type ? type : "keydown";
        if (strcmp(t, "keydown") && strcmp(t, "keyup")) {
            JS_FreeCString(ctx, key);
            if (type) JS_FreeCString(ctx, type);
            return JS_ThrowTypeError(ctx, "host.key type must be keydown or keyup");
        }
        PuKeyEvent event = { .type = !strcmp(t, "keydown") ? PU_KEY_DOWN : PU_KEY_UP, .key = key };
        const char *code = NULL;
        int text = 1;
        if (argc >= 3 && !host_key_options(ctx, argv[2], &event, &code, &text)) {
            JS_FreeCString(ctx, key);
            if (type) JS_FreeCString(ctx, type);
            if (code) JS_FreeCString(ctx, code);
            return JS_EXCEPTION;
        }
        PuApp app = { g_test->script, g_test->bridge };
        int result = app_key(&event, &app);
        /* Compatibility shortcut: host.key('a') also submits printable text.
         * Native key adapters never synthesize text from hardware keys. */
        unsigned char first = (unsigned char)key[0];
        size_t length = strlen(key);
        int printable = (length == 1 && first >= 0x20 && first != 0x7f) ||
                        (length == 2 && first >= 0xc2 && first <= 0xdf) ||
                        (length == 3 && first >= 0xe0 && first <= 0xef) ||
                        (length == 4 && first >= 0xf0 && first <= 0xf4);
        if (text && printable && event.type == PU_KEY_DOWN &&
            !(result & PU_INPUT_PREVENT_DEFAULT) &&
            !(event.modifiers & (PU_MOD_CTRL | PU_MOD_ALT | PU_MOD_META))) {
            event.type = PU_KEY_TEXT;
            event.text = key;
            app_key(&event, &app);
        }
        if (code) JS_FreeCString(ctx, code);
        JS_FreeCString(ctx, key);
        if (type) JS_FreeCString(ctx, type);
        pu_script_run_loop(g_test->script);
        test_render();
    }
    return JS_UNDEFINED;
}

static JSValue host_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "host.text requires a string");
    const char *text = JS_ToCString(ctx, argv[0]);
    if (!text) return JS_EXCEPTION;
    PuKeyEvent event = { .type = PU_KEY_TEXT, .text = text };
    PuApp app = { g_test->script, g_test->bridge };
    app_key(&event, &app);
    JS_FreeCString(ctx, text);
    pu_script_run_loop(g_test->script);
    test_render();
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
    JS_SetPropertyStr(ctx, host, "text",   JS_NewCFunction(ctx, host_text, "text", 1));
    JS_SetPropertyStr(ctx, host, "pixel",  JS_NewCFunction(ctx, host_pixel, "pixel", 2));
    JS_SetPropertyStr(ctx, host, "save",   JS_NewCFunction(ctx, host_save, "save", 1));
    JS_SetPropertyStr(ctx, global, "host", host);
    JS_FreeValue(ctx, global);
}

static int run_test(const char *path)
{
    if (!pu_font_system_init()) return 1;
    PuScript *s = pu_script_create();
    if (!s) return 1;
    PuBridge *b = pu_bridge_install(pu_script_jsctx(s));
    if (!b) { pu_script_destroy(s); return 1; }

    PuDispatch *disp = pu_dispatch_new();
    pu_script_set_dispatch(s, disp);
    pu_async_install(pu_script_jsctx(s), disp);
    const char *test_storage = getenv("PU_TEST_STORAGE");
    pu_storage_install(pu_script_jsctx(s), test_storage ? test_storage : "build/_localstorage.dat");
    pu_fetch_install(pu_script_jsctx(s), disp);

    PuTestHost host;
    host.script = s;
    host.bridge = b;
    host.width = 800;
    host.height = 600;
    { const char *e; if ((e = getenv("PU_TEST_W"))) host.width = atoi(e);
      if ((e = getenv("PU_TEST_H"))) host.height = atoi(e); }
    host.surface = pu_surface_create(host.width, host.height);
    g_test = &host;

    install_host(pu_script_jsctx(s), host.width, host.height);

    int rc = 1;
    if (host.surface) rc = pu_script_run_file(s, path);
    else fprintf(stderr, "[render] Failed to create headless surface\n");
    if (rc == 0) pu_script_run_loop(s); /* async-aware: waits for workers/tasks */

    g_test = NULL;
    pu_async_shutdown();
    pu_storage_shutdown();
    if (host.surface) pu_surface_destroy(host.surface);
    pu_bridge_free(b);
    pu_script_destroy(s);
    pu_dispatch_free(disp);
    return rc;
}

static int run_app(const char *path)
{
    if (!pu_font_system_init()) return 1;
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
    install_window_api(pu_script_jsctx(s)); /* global `window` controls */

    int rc = pu_script_run_file(s, path);
    if (rc == 0)
        pu_script_pump(s);   /* drain microtasks/timers/async from setup (non-blocking) */

    if (rc == 0) {
        PuNode *body = pu_bridge_body(bridge);
        if (pu_perf_on()) {            /* debug aid: dump the initial tree (PU_PERF=1) */
            printf("--- native DOM tree ---\n");
            pu_node_dump(body, 0);
            fflush(stdout);
        }

        PuWindowConfig cfg;
        cfg.title  = "PollyUI";
        cfg.width  = 1080;
        cfg.height = 720;
        PuWindow *win = pu_window_create(&cfg);
        if (win) {
            PuApp app = { s, bridge };
            g_app_window = win;
            pu_window_set_paint(win, app_paint, &app);
            pu_window_set_pointer(win, app_pointer, &app);
            pu_window_set_key(win, app_key, &app);
            pu_window_set_wheel(win, app_wheel, &app);
            pu_window_set_async(win, app_async, &app);
            pu_window_set_region(win, app_region, &app);     /* custom title bar drag */
            if (g_pending_frameless >= 0) pu_window_set_frameless(win, g_pending_frameless);
            if (g_pending_backdrop >= 0)  pu_window_set_backdrop(win, g_pending_backdrop);
            if (g_pending_titlebar >= 0)  pu_window_set_titlebar_style(win, g_pending_titlebar);
            pu_dispatch_set_waker(disp, app_wake, win); /* workers wake the window */
            rc = pu_window_run(win);
            pu_dispatch_set_waker(disp, NULL, NULL);
            g_app_window = NULL;
            pu_window_destroy(win);
        } else {
            fprintf(stderr, "[host] Failed to create application window\n");
            rc = 1;
        }
    }

    pu_async_shutdown();    /* terminate workers before tearing down the context */
    pu_storage_shutdown();
    pu_bridge_free(bridge); /* release native JS callbacks before destroying their VM */
    pu_script_destroy(s);
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
    int rc;
    if (argc >= 3 && strcmp(argv[1], "--test") == 0)
        rc = run_test(argv[2]);
    else if (argc >= 2)
        rc = run_app(argv[1]);
    else
        rc = run_demo();
    pu_render_shutdown();
    return rc;
}
