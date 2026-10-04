#include "host/win32/window.h"
#include "script/script.h"
#include "script/storage.h"
#include "net/fetch.h"
#include "bridge/bridge.h"
#include "layout/layout.h"
#include "render/render.h"
#include "model/node.h"
#include "core/dispatch.h"
#include "core/app_paths.h"
#include "concurrency/async.h"
#if defined(PU_DESKTOP_SERVICES)
#include "desktop/applications.h"
#endif

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>
#include <limits.h>

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
    struct PuApp *next;
    PuWindow *window;
    JSValue handle;
    int closed, frameless, backdrop, titlebar, is_layer, transparent;
} PuApp;

static PuApp *g_apps;
static PuScript *g_app_script;
static PuBridge *g_app_bridge;
static JSClassID g_window_class;
static int g_app_quitting, g_app_error;
static void app_redraw_all(void)
{
    for (PuApp *app = g_apps; app; app = app->next) pu_window_redraw(app->window);
}

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
        if (app->transparent) pu_render_tree_transparent(surface, body, scale);
        else pu_render_tree(surface, body, scale);
        double t2 = pu_now_ms();
        fprintf(stderr, "[perf] paint: layout %.2fms  render %.2fms  total %.2fms\n",
                t1 - t0, t2 - t1, t2 - t0);
        return;
    }
    pu_layout_calculate(body, (float)width, (float)height);
    if (app->transparent) pu_render_tree_transparent(surface, body, scale);
    else pu_render_tree(surface, body, scale);
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
        if (worked | state_changed | interaction) app_redraw_all();
        return worked | state_changed | interaction;
    }
    state_changed |= pu_bridge_dispatch_pointer(app->bridge, target, event);
    /* Repaint signal: a re-render (worked > 0) OR a native hover/focus state
     * change. A mousemove that stays within the same element returns 0 and the
     * host skips the repaint. */
    int result = pu_script_pump(app->script) | state_changed | interaction;
    if (result) app_redraw_all();
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
    int result = scrolled | pu_script_pump(app->script);
    if (result) app_redraw_all();
    return result;
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
    app_redraw_all();
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
    PuScript *script = user;
    int n = 0;
#if defined(PU_DESKTOP_SERVICES)
    n += pu_applications_pump();
#endif
    n += pu_script_flush_raf(script, pu_frame_ms());
    return n + pu_script_pump(script);
}

/* Dispatcher waker (called from worker threads): nudge the window to drain. */
static void app_wake(void *user) { (void)user; pu_window_wake(NULL); }

/* ---- windowed: custom title bar drag region + JS `window` controls -------- */
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

static PuApp *window_app(JSContext *ctx, JSValueConst value, int allow_closed)
{
    PuApp *app = JS_GetOpaque2(ctx, value, g_window_class);
    if (app && !allow_closed && (app->closed || (app->window && !pu_window_is_open(app->window)))) {
        JS_ThrowTypeError(ctx, "Window is closed");
        return NULL;
    }
    return app;
}

static void app_report(JSContext *ctx)
{
    JSValue exception = JS_GetException(ctx);
    const char *message = JS_ToCString(ctx, exception);
    fprintf(stderr, "Uncaught (in window callback) %s\n", message ? message : "error");
    JS_FreeCString(ctx, message);
    JS_FreeValue(ctx, exception);
    g_app_error = 1;
}

static void app_retire(PuApp *app, int notify)
{
    JSContext *ctx = pu_script_jsctx(app->script);
    PuApp **link = &g_apps;
    while (*link && *link != app) link = &(*link)->next;
    if (*link) *link = app->next;
    app->closed = 1;
    pu_window_destroy(app->window);
    app->window = NULL;
    if (notify) {
        JSValue callback = JS_GetPropertyStr(ctx, app->handle, "onclose");
        if (JS_IsException(callback)) app_report(ctx);
        else if (JS_IsFunction(ctx, callback)) {
            JSValue result = JS_Call(ctx, callback, app->handle, 0, NULL);
            if (JS_IsException(result)) app_report(ctx);
            JS_FreeValue(ctx, result);
        } else if (!JS_IsNull(callback) && !JS_IsUndefined(callback)) {
            JS_ThrowTypeError(ctx, "onclose must be a function or null");
            app_report(ctx);
        }
        JS_FreeValue(ctx, callback);
        app_redraw_all();
    }
    pu_bridge_release_document(app->bridge);
    app->bridge = NULL;
    JS_FreeValue(ctx, app->handle); /* May finalize app; do not access it afterward. */
}

static void app_closed(PuWindow *window, void *user)
{
    (void)window;
    app_retire(user, 1);
}

static void window_finalizer(JSRuntime *rt, JSValueConst value)
{
    (void)rt;
    free(JS_GetOpaque(value, g_window_class));
}

static PuApp *new_app(PuBridge *bridge)
{
    PuApp *app = calloc(1, sizeof(*app));
    if (!app) return NULL;
    app->script = g_app_script;
    app->bridge = bridge;
    app->frameless = app->backdrop = app->titlebar = -1;
    JSContext *ctx = pu_script_jsctx(app->script);
    app->handle = JS_NewObjectClass(ctx, g_window_class);
    if (JS_IsException(app->handle)) { free(app); return NULL; }
    JS_SetOpaque(app->handle, app);
    if (JS_DefinePropertyValueStr(ctx, app->handle, "document", pu_bridge_document(bridge),
            JS_PROP_ENUMERABLE) < 0 ||
        JS_SetPropertyStr(ctx, app->handle, "onclose", JS_NULL) < 0) {
        JS_SetOpaque(app->handle, NULL);
        JS_FreeValue(ctx, app->handle);
        free(app);
        return NULL;
    }
    app->next = g_apps;
    g_apps = app;
    return app;
}

static int open_app(PuApp *app, const PuWindowConfig *config)
{
    app->is_layer = config->layer != NULL;
    app->transparent = config->layer && config->layer->transparent;
    app->window = pu_window_create(config);
    if (!app->window) return 0;
    pu_window_set_paint(app->window, app_paint, app);
    pu_window_set_pointer(app->window, app_pointer, app);
    pu_window_set_key(app->window, app_key, app);
    pu_window_set_wheel(app->window, app_wheel, app);
    pu_window_set_region(app->window, app_region, app);
    pu_window_set_close(app->window, app_closed, app);
    if (app->frameless >= 0) pu_window_set_frameless(app->window, app->frameless);
    if (app->backdrop >= 0) pu_window_set_backdrop(app->window, app->backdrop);
    if (app->titlebar >= 0) pu_window_set_titlebar_style(app->window, app->titlebar);
    return 1;
}

static int window_integer(JSContext *ctx, JSValueConst options, const char *name, int minimum, int *value)
{
    JSValue input = JS_GetPropertyStr(ctx, options, name);
    if (JS_IsException(input)) return 0;
    if (JS_IsUndefined(input)) { JS_FreeValue(ctx, input); return 1; }
    double number;
    int ok = JS_IsNumber(input) && JS_ToFloat64(ctx, &number, input) == 0 &&
        isfinite(number) && number >= minimum && number <= INT_MAX && floor(number) == number;
    JS_FreeValue(ctx, input);
    if (!ok) { JS_ThrowTypeError(ctx, "%s must be an integer in [%d, %d]", name, minimum, INT_MAX); return 0; }
    *value = (int)number;
    return 1;
}

static int option_names(JSContext *ctx, JSValueConst options, const char *const allowed[])
{
    if (!JS_IsObject(options) || JS_IsArray(options) || JS_IsFunction(ctx, options)) {
        JS_ThrowTypeError(ctx, "Expected an options object");
        return 0;
    }
    JSPropertyEnum *properties = NULL;
    uint32_t count = 0;
    if (JS_GetOwnPropertyNames(ctx, &properties, &count, options, JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) < 0) {
        return 0;
    }
    int valid = 1;
    for (uint32_t i = 0; i < count; i++) {
        const char *key = JS_AtomToCString(ctx, properties[i].atom);
        if (!key) valid = 0;
        else {
            int found = 0;
            for (int j = 0; allowed[j]; j++) if (!strcmp(key, allowed[j])) found = 1;
            if (!found) {
                JS_ThrowTypeError(ctx, "Unknown option: %s", key);
                valid = 0;
            }
        }
        JS_FreeCString(ctx, key);
        if (!valid) break;
    }
    JS_FreePropertyEnum(ctx, properties, count);
    return valid;
}

static int choice(JSContext *ctx, JSValueConst input, const char *name, const char *const choices[])
{
    if (JS_IsException(input)) return -1;
    if (!JS_IsString(input)) { JS_ThrowTypeError(ctx, "%s must be a string", name); return -1; }
    size_t length;
    const char *text = JS_ToCStringLen(ctx, &length, input);
    if (!text) return -1;
    int result = -1;
    for (int i = 0; choices[i]; i++)
        if (strlen(choices[i]) == length && !memcmp(text, choices[i], length)) { result = i; break; }
    JS_FreeCString(ctx, text);
    if (result < 0) JS_ThrowTypeError(ctx, "Unknown %s value", name);
    return result;
}

static int layer_options(JSContext *ctx, JSValueConst options, PuLayerConfig *layer)
{
    const char *const keyboards[] = { "none", "exclusive", "on-demand", NULL };
    const char *const edges[] = { "top", "bottom", "left", "right", NULL };
    const char *const margins[] = { "top", "right", "bottom", "left", NULL };
    JSValue input = JS_GetPropertyStr(ctx, options, "transparent");
    if (JS_IsException(input)) return 0;
    if (!JS_IsUndefined(input)) {
        if (!JS_IsBool(input)) {
            JS_FreeValue(ctx, input); JS_ThrowTypeError(ctx, "transparent must be a boolean"); return 0;
        }
        layer->transparent = JS_ToBool(ctx, input);
    }
    JS_FreeValue(ctx, input);
    input = JS_GetPropertyStr(ctx, options, "keyboard");
    if (JS_IsException(input)) return 0;
    if (!JS_IsUndefined(input)) layer->keyboard = choice(ctx, input, "keyboard", keyboards);
    JS_FreeValue(ctx, input);
    if (layer->keyboard < 0 || !window_integer(ctx, options, "exclusiveZone", -1, &layer->exclusive_zone)) return 0;
    input = JS_GetPropertyStr(ctx, options, "anchors");
    if (JS_IsException(input)) return 0;
    if (!JS_IsUndefined(input)) {
        if (!JS_IsArray(input)) {
            JS_FreeValue(ctx, input); JS_ThrowTypeError(ctx, "anchors must be an array"); return 0;
        }
        JSValue length = JS_GetPropertyStr(ctx, input, "length");
        uint32_t count = 0;
        int ok = !JS_ToUint32(ctx, &count, length);
        JS_FreeValue(ctx, length);
        if (!ok || count > 4) {
            JS_FreeValue(ctx, input); JS_ThrowTypeError(ctx, "Too many anchors"); return 0;
        }
        for (uint32_t i = 0; i < count; i++) {
            JSValue edge = JS_GetPropertyUint32(ctx, input, i);
            int index = choice(ctx, edge, "anchor", edges);
            JS_FreeValue(ctx, edge);
            if (index < 0 || (layer->anchors & (1u << index))) {
                JS_FreeValue(ctx, input);
                if (index >= 0) JS_ThrowTypeError(ctx, "Duplicate anchor");
                return 0;
            }
            layer->anchors |= 1u << index;
        }
    }
    JS_FreeValue(ctx, input);
    input = JS_GetPropertyStr(ctx, options, "output");
    if (JS_IsException(input)) return 0;
    if (!JS_IsUndefined(input)) {
        double id;
        int ok = JS_IsNumber(input) && !JS_ToFloat64(ctx, &id, input) &&
            isfinite(id) && id >= 0 && id <= UINT32_MAX && floor(id) == id;
        if (!ok) { JS_FreeValue(ctx, input); JS_ThrowTypeError(ctx, "Invalid output ID"); return 0; }
        layer->output = (uint32_t)id;
    }
    JS_FreeValue(ctx, input);
    input = JS_GetPropertyStr(ctx, options, "margins");
    if (JS_IsException(input)) return 0;
    if (!JS_IsUndefined(input) &&
        (!option_names(ctx, input, margins) ||
         !window_integer(ctx, input, "top", INT_MIN, &layer->margin_top) ||
         !window_integer(ctx, input, "right", INT_MIN, &layer->margin_right) ||
         !window_integer(ctx, input, "bottom", INT_MIN, &layer->margin_bottom) ||
         !window_integer(ctx, input, "left", INT_MIN, &layer->margin_left))) {
        JS_FreeValue(ctx, input); return 0;
    }
    JS_FreeValue(ctx, input);
    return 1;
}

static JSValue jswin_create(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    if (!window_app(ctx, self, 1)) return JS_EXCEPTION;
    if (g_app_quitting) return JS_ThrowTypeError(ctx, "Application is quitting");
    JSValue options = argc ? JS_DupValue(ctx, argv[0]) : JS_NewObject(ctx);
    const char *const names[] = { "title", "width", "height", "layer", "anchors",
        "exclusiveZone", "keyboard", "output", "margins", "transparent", NULL };
    if (!option_names(ctx, options, names)) { JS_FreeValue(ctx, options); return JS_EXCEPTION; }
    PuWindowConfig config = { .width = 640, .height = 480, .title = "PollyUI" };
    PuLayerConfig layer = {0};
    JSValue layer_name = JS_GetPropertyStr(ctx, options, "layer");
    int valid = !JS_IsException(layer_name);
    if (valid && !JS_IsUndefined(layer_name)) {
        const char *const levels[] = { "background", "bottom", "top", "overlay", NULL };
        layer.layer = choice(ctx, layer_name, "layer", levels);
        valid = layer.layer >= 0 && layer_options(ctx, options, &layer);
        config.layer = &layer;
    } else if (valid) {
        for (int i = 4; names[i]; i++) {
            JSValue value = JS_GetPropertyStr(ctx, options, names[i]);
            if (JS_IsException(value)) valid = 0;
            else if (!JS_IsUndefined(value)) {
                JS_ThrowTypeError(ctx, "%s requires a layer surface", names[i]);
                valid = 0;
            }
            JS_FreeValue(ctx, value);
            if (!valid) break;
        }
    }
    JS_FreeValue(ctx, layer_name);
    if (!valid || !window_integer(ctx, options, "width", config.layer ? 0 : 1, &config.width) ||
        !window_integer(ctx, options, "height", config.layer ? 0 : 1, &config.height)) {
        JS_FreeValue(ctx, options); return JS_EXCEPTION;
    }
    if (config.layer && ((!config.width && (layer.anchors & 12) != 12) ||
                        (!config.height && (layer.anchors & 3) != 3))) {
        JS_FreeValue(ctx, options);
        return JS_ThrowTypeError(ctx, "Zero layer dimensions require opposite anchors");
    }
    JSValue title = JS_GetPropertyStr(ctx, options, "title");
    JS_FreeValue(ctx, options);
    const char *text = NULL;
    size_t length = 0;
    if (JS_IsException(title)) return JS_EXCEPTION;
    if (!JS_IsUndefined(title)) {
        if (!JS_IsString(title)) {
            JS_FreeValue(ctx, title);
            return JS_ThrowTypeError(ctx, "Window title must be a string");
        }
        text = JS_ToCStringLen(ctx, &length, title);
        if (!text) { JS_FreeValue(ctx, title); return JS_EXCEPTION; }
        if (memchr(text, 0, length)) {
            JS_FreeCString(ctx, text); JS_FreeValue(ctx, title);
            return JS_ThrowTypeError(ctx, "Window title must not contain NUL");
        }
        config.title = text;
    }
    PuBridge *bridge = pu_bridge_new_document(g_app_bridge);
    PuApp *app = bridge ? new_app(bridge) : NULL;
    int opened = app && open_app(app, &config);
    JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, title);
    if (!opened) {
        if (app) app_retire(app, 0);
        else if (bridge) pu_bridge_release_document(bridge);
        return JS_ThrowInternalError(ctx, "Cannot create native window");
    }
    return JS_DupValue(ctx, app->handle);
}

static PuApp *toplevel_app(JSContext *ctx, JSValueConst value)
{
    PuApp *app = window_app(ctx, value, 0);
    if (app && app->is_layer) {
        JS_ThrowTypeError(ctx, "Toplevel window controls do not apply to layer surfaces");
        return NULL;
    }
    return app;
}

static JSValue jswin_minimize(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ (void)n;(void)a; PuApp *app = toplevel_app(c,t); if (!app) return JS_EXCEPTION;
  pu_window_minimize(app->window); return JS_UNDEFINED; }
static JSValue jswin_maximize(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ (void)n;(void)a; PuApp *app = toplevel_app(c,t); if (!app) return JS_EXCEPTION;
  pu_window_maximize_toggle(app->window); return JS_UNDEFINED; }
static JSValue jswin_close(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ (void)n;(void)a; PuApp *app = window_app(c,t,1); if (!app) return JS_EXCEPTION;
  app->closed = 1; pu_window_close(app->window); return JS_UNDEFINED; }
static JSValue jswin_quit(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ (void)n;(void)a; if (!window_app(c,t,1)) return JS_EXCEPTION;
  g_app_quitting = 1;
  for (PuApp *app = g_apps; app; app = app->next) { app->closed = 1; pu_window_close(app->window); }
  return JS_UNDEFINED; }
static JSValue jswin_closed(JSContext *c, JSValueConst t)
{ PuApp *app = window_app(c,t,1); return app ? JS_NewBool(c, app->closed ||
    (app->window && !pu_window_is_open(app->window))) : JS_EXCEPTION; }
static JSValue jswin_ismax(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ (void)n;(void)a; PuApp *app = toplevel_app(c,t); return app ?
    JS_NewBool(c, pu_window_is_maximized(app->window)) : JS_EXCEPTION; }
static JSValue jswin_frameless(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ PuApp *app = toplevel_app(c,t); if (!app) return JS_EXCEPTION;
  app->frameless = n ? JS_ToBool(c,a[0]) : 1;
  pu_window_set_frameless(app->window, app->frameless); return JS_UNDEFINED; }
static JSValue jswin_backdrop(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{ PuApp *app = toplevel_app(c,t); if (!app) return JS_EXCEPTION;
  int32_t type = 2; if (n && JS_ToInt32(c,&type,a[0])) return JS_EXCEPTION;
  app->backdrop = type; pu_window_set_backdrop(app->window,type); return JS_UNDEFINED; }
static JSValue jswin_titlebarstyle(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{
    PuApp *app = toplevel_app(c,t);
    if (!app) return JS_EXCEPTION;
    int32_t style = 0;
    if (n && JS_IsString(a[0])) {
        const char *name = JS_ToCString(c,a[0]);
        if (!name) return JS_EXCEPTION;
        if (!strcmp(name,"overlay") || !strcmp(name,"hidden") || !strcmp(name,"hiddenInset")) style = 1;
        else if (strcmp(name,"default")) style = -1;
        JS_FreeCString(c,name);
    } else if (n && JS_ToInt32(c,&style,a[0])) return JS_EXCEPTION;
    if (style < 0 || style > 1) return JS_ThrowTypeError(c,"Unknown title bar style");
    app->titlebar = style;
    pu_window_set_titlebar_style(app->window,style);
    return JS_UNDEFINED;
}

static JSValue jswin_capture(JSContext *c, JSValueConst t, int n, JSValueConst *a)
{
    PuApp *app = window_app(c,t,0);
    if (!app) return JS_EXCEPTION;
    if (!n || !JS_IsString(a[0])) return JS_ThrowTypeError(c,"capture requires a PNG path");
    size_t length;
    const char *path = JS_ToCStringLen(c,&length,a[0]);
    if (!path) return JS_EXCEPTION;
    if (!length || memchr(path,0,length)) {
        JS_FreeCString(c,path);
        return JS_ThrowTypeError(c,"Invalid capture path");
    }
    int ok = pu_window_save_frame(app->window,path);
    JS_FreeCString(c,path);
    return ok ? JS_UNDEFINED : JS_ThrowInternalError(c,"Cannot capture this window's presented frame");
}

static JSValue jswin_displays(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)argc; (void)argv;
    if (!window_app(ctx, self, 1)) return JS_EXCEPTION;
    int count = 0;
    PuDisplayInfo *items = pu_window_displays(&count);
    if (!items) return JS_ThrowInternalError(ctx, "Cannot query displays");
    JSValue array = JS_NewArray(ctx);
    if (JS_IsException(array)) { free(items); return array; }
    for (int i = 0; i < count; i++) {
        JSValue item = JS_NewObject(ctx);
        if (JS_IsException(item)) { free(items); JS_FreeValue(ctx, array); return item; }
        JS_SetPropertyStr(ctx, item, "id", JS_NewUint32(ctx, items[i].id));
        JS_SetPropertyStr(ctx, item, "name", JS_NewString(ctx, items[i].name));
        JS_SetPropertyStr(ctx, item, "x", JS_NewInt32(ctx, items[i].x));
        JS_SetPropertyStr(ctx, item, "y", JS_NewInt32(ctx, items[i].y));
        JS_SetPropertyStr(ctx, item, "width", JS_NewInt32(ctx, items[i].width));
        JS_SetPropertyStr(ctx, item, "height", JS_NewInt32(ctx, items[i].height));
        JS_SetPropertyStr(ctx, item, "scale", JS_NewFloat64(ctx, items[i].scale));
        if (JS_SetPropertyUint32(ctx, array, (uint32_t)i, item) < 0) {
            free(items); JS_FreeValue(ctx, array); return JS_EXCEPTION;
        }
    }
    free(items);
    return array;
}

/* Install one shared realm; each native window has its own document and controls. */
static PuApp *install_window_api(JSContext *ctx)
{
    JSRuntime *runtime = JS_GetRuntime(ctx);
    if (!g_window_class) JS_NewClassID(runtime, &g_window_class);
    const JSClassDef definition = { "Window", .finalizer = window_finalizer };
    if (JS_NewClass(runtime, g_window_class, &definition) < 0) return NULL;
    JSValue win = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, win, "create", JS_NewCFunction(ctx, jswin_create, "create", 1));
    JS_SetPropertyStr(ctx, win, "quit", JS_NewCFunction(ctx, jswin_quit, "quit", 0));
    JS_SetPropertyStr(ctx, win, "capture", JS_NewCFunction(ctx, jswin_capture, "capture", 1));
    JS_SetPropertyStr(ctx, win, "displays", JS_NewCFunction(ctx, jswin_displays, "displays", 0));
    JSAtom closed = JS_NewAtom(ctx, "closed");
    JS_DefinePropertyGetSet(ctx, win, closed,
        JS_NewCFunction2(ctx, (JSCFunction *)jswin_closed, "closed", 0, JS_CFUNC_getter, 0),
        JS_UNDEFINED, JS_PROP_ENUMERABLE);
    JS_FreeAtom(ctx, closed);
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
    JS_SetClassProto(ctx, g_window_class, win);
    PuApp *app = new_app(g_app_bridge);
    if (!app) return NULL;
    JSValue g = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, g, "window", JS_DupValue(ctx, app->handle));
    JS_FreeValue(ctx, g);
    return app;
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
    if (!pu_storage_install(pu_script_jsctx(s), test_storage ? test_storage : "build/_localstorage.dat") ||
        !pu_fetch_install(pu_script_jsctx(s), disp)) {
        pu_async_shutdown(); pu_storage_shutdown();
        pu_bridge_free(b); pu_script_destroy(s); pu_dispatch_free(disp);
        return 1;
    }

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
    pu_fetch_shutdown();
    pu_storage_shutdown();
    if (host.surface) pu_surface_destroy(host.surface);
    pu_bridge_free(b);
    pu_script_destroy(s);
    pu_dispatch_free(disp);
    return rc;
}

static void install_application(JSContext *ctx, const PuAppPaths *paths, int argc, char **argv)
{
    JSValue application = JS_NewObject(ctx), arguments = JS_NewArray(ctx);
    JS_SetPropertyStr(ctx, application, "id", JS_NewString(ctx, paths->id));
    if (paths->config) JS_SetPropertyStr(ctx, application, "configDir", JS_NewString(ctx, paths->config));
    if (paths->data) JS_SetPropertyStr(ctx, application, "dataDir", JS_NewString(ctx, paths->data));
    if (paths->cache) JS_SetPropertyStr(ctx, application, "cacheDir", JS_NewString(ctx, paths->cache));
    for (int i = 0; i < argc; i++) JS_SetPropertyUint32(ctx, arguments, (uint32_t)i, JS_NewString(ctx, argv[i]));
    JS_SetPropertyStr(ctx, application, "arguments", arguments);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "application", application);
    JS_FreeValue(ctx, global);
}

static int run_app(const char *path, const char *app_id, int argc, char **argv, int desktop_mode)
{
    if (!pu_font_system_init()) return 1;
    PuAppPaths paths;
    if (!pu_app_paths_init(&paths, path, app_id)) return 1;
#if defined(__linux__)
    const char *sdl_id = getenv("SDL_APP_ID");
    if ((!sdl_id || !*sdl_id) && setenv("SDL_APP_ID", paths.id, 1) < 0) {
        perror("[paths] Cannot set application identity");
        pu_app_paths_free(&paths);
        return 1;
    }
#endif
    PuScript *s = pu_script_create();
    if (!s) {
        pu_app_paths_free(&paths);
        return 1;
    }

    PuBridge *bridge = pu_bridge_install(pu_script_jsctx(s));
    if (!bridge) { pu_script_destroy(s); pu_app_paths_free(&paths); return 1; }

    PuDispatch *disp = pu_dispatch_new();
    pu_script_set_dispatch(s, disp);
    pu_async_install(pu_script_jsctx(s), disp);
    if (!pu_storage_install(pu_script_jsctx(s), paths.storage) ||
        !pu_fetch_install(pu_script_jsctx(s), disp)) {
        pu_async_shutdown(); pu_storage_shutdown();
        pu_bridge_free(bridge); pu_script_destroy(s); pu_dispatch_free(disp);
        pu_app_paths_free(&paths);
        return 1;
    }
    g_app_script = s;
    g_app_bridge = bridge;
    g_app_quitting = g_app_error = 0;
    int host_ready = pu_window_system_init();
    PuApp *primary = host_ready ? install_window_api(pu_script_jsctx(s)) : NULL;
    install_application(pu_script_jsctx(s), &paths, argc, argv);

    int desktop_ready = 1;
#if defined(PU_DESKTOP_SERVICES)
    if (desktop_mode) desktop_ready = pu_applications_install(pu_script_jsctx(s));
#else
    (void)desktop_mode;
#endif
    int rc = primary && desktop_ready ? pu_script_run_file(s, path) : 1;
    if (!desktop_ready) fprintf(stderr, "[desktop] Cannot install desktop application APIs\n");
    if (!primary) fprintf(stderr, "[host] Failed to create application window: window system initialization\n");
    if (rc == 0)
        pu_script_pump(s);   /* drain microtasks/timers/async from setup (non-blocking) */

    if (rc == 0) {
        PuNode *body = pu_bridge_body(bridge);
        if (pu_perf_on()) {            /* debug aid: dump the initial tree (PU_PERF=1) */
            printf("--- native DOM tree ---\n");
            pu_node_dump(body, 0);
            fflush(stdout);
        }

        PuWindowConfig cfg = { .title = "PollyUI", .width = 1080, .height = 720 };
        if (primary->closed) app_retire(primary, 1);
        else if (!open_app(primary, &cfg)) {
            fprintf(stderr, "[host] Failed to create application window\n");
            rc = 1;
        }
        if (rc == 0 && g_apps) {
            pu_dispatch_set_waker(disp, app_wake, NULL);
            rc = pu_window_run_all(app_async, s);
        }
    }

    pu_async_shutdown();    /* terminate workers before tearing down the context */
    pu_fetch_shutdown();
#if defined(PU_DESKTOP_SERVICES)
    pu_applications_shutdown();
#endif
    pu_dispatch_set_waker(disp, NULL, NULL);
    g_app_quitting = 1;
    while (g_apps) app_retire(g_apps, 0);
    if (host_ready) pu_window_system_shutdown();
    if (g_app_error) rc = 1;
    g_app_script = NULL;
    g_app_bridge = NULL;
    pu_storage_shutdown();
    pu_bridge_free(bridge); /* release native JS callbacks before destroying their VM */
    pu_script_destroy(s);
    pu_dispatch_free(disp);
    pu_app_paths_free(&paths);
    return rc;
}

static int run_demo(void)
{
    PuWindowConfig cfg = {0};
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
    const char *app_id = NULL;
    int desktop_mode = 0;
    int index = 1;
    while (index < argc) {
        if (!strcmp(argv[index], "--app-id")) {
            if (index + 2 >= argc) { fprintf(stderr, "--app-id requires an ID and an application script\n"); return 2; }
            app_id = argv[index + 1]; index += 2;
        } else if (!strcmp(argv[index], "--desktop")) {
#if defined(PU_DESKTOP_SERVICES)
            desktop_mode = 1; index++;
#else
            fprintf(stderr, "Desktop application APIs are unavailable in this build\n"); return 2;
#endif
        } else break;
    }
    if (index < argc && !strcmp(argv[index], "--help")) {
        puts("Usage: pollyui [--desktop] [--app-id ID] app.js [arguments...]\n"
             "       pollyui --test test.js\n"
             "--app-id selects a stable Linux XDG storage namespace.\n"
             "--desktop explicitly enables Linux application discovery and direct process launching.");
        return 0;
    }
    if (index < argc && !strcmp(argv[index], "--test")) {
        if (app_id || desktop_mode || index + 1 >= argc) { fprintf(stderr, "--test requires a script and does not accept desktop options\n"); return 2; }
        rc = run_test(argv[index + 1]);
    } else if (index < argc && argv[index][0] == '-') {
        fprintf(stderr, "Unknown option: %s\n", argv[index]); return 2;
    } else if (index < argc)
        rc = run_app(argv[index], app_id, argc - index - 1, argv + index + 1, desktop_mode);
    else
        if (desktop_mode) { fprintf(stderr, "--desktop requires an application script\n"); return 2; }
        else rc = run_demo();
    pu_render_shutdown();
    return rc;
}
