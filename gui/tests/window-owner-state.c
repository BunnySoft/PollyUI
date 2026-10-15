#include "pollyui/context.h"
#include "quickjs.h"
#include <stdio.h>
#include <string.h>
#if defined(PU_TEST_SDL)
#include <SDL3/SDL.h>
#else
#include "win32-test-window.h"
#endif

static JSValue collect(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    JS_RunGC(JS_GetRuntime(ctx));
    return JS_UNDEFINED;
}
static JSValue foreign_view(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc != 1) return JS_ThrowTypeError(ctx, "A document is required");
    JSContext *other = JS_NewContext(JS_GetRuntime(ctx));
    if (!other) return JS_ThrowOutOfMemory(ctx);
    JSValue view = JS_GetPropertyStr(other, argv[0], "defaultView");
    bool rejected = JS_IsNull(view);
    if (JS_IsException(view)) {
        JSValue error = JS_GetException(other);
        JS_FreeValue(other, error);
    }
    JS_FreeValue(other, view);
    JSValue global = JS_GetGlobalObject(other);
    if (JS_SetPropertyStr(other, global, "foreignDocument", JS_DupValue(other, argv[0])) < 0)
        rejected = false;
    JS_FreeValue(other, global);
    const char source[] =
        "(()=>{const d=foreignDocument,p=Object.getOwnPropertyDescriptor(d,'defaultView');"
        "let define=false,del=false;try{Object.defineProperty(d,'defaultView',{value:{}})}catch(e){define=e instanceof TypeError}"
        "try{del=!Reflect.deleteProperty(d,'defaultView')}catch(e){}"
        "return p.value===null&&!p.writable&&!p.configurable&&p.get===undefined&&"
        "Reflect.get(d,'defaultView',d)===null&&Reflect.get(d,'defaultView',{})===null&&"
        "Object.keys(d).includes('defaultView')&&define&&del})()";
    JSValue reflected = JS_Eval(other, source, sizeof(source) - 1, "foreign-document-test", JS_EVAL_TYPE_GLOBAL);
    rejected = rejected && JS_ToBool(other, reflected) == 1;
    if (JS_IsException(reflected)) {
        JSValue error = JS_GetException(other); JS_FreeValue(other, error);
    }
    JS_FreeValue(other, reflected); JS_FreeContext(other);
    return JS_NewBool(ctx, rejected);
}
static JSValue resize_window(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    int width, height, dpi = 0;
    if (argc < 3 || JS_ToInt32(ctx, &width, argv[1]) || JS_ToInt32(ctx, &height, argv[2]) ||
        width < 100 || height < 80 || width > 1600 || height > 1200 ||
        (argc > 3 && JS_ToInt32(ctx, &dpi, argv[3])))
        return JS_ThrowTypeError(ctx, "A title and bounded native client size are required");
    const char *title = JS_ToCString(ctx, argv[0]);
    if (!title) return JS_EXCEPTION;
    bool changed = false;
#if defined(PU_TEST_SDL)
    int count = 0;
    SDL_Window **windows = SDL_GetWindows(&count);
    for (int i = 0; windows && i < count; i++)
        if (!strcmp(SDL_GetWindowTitle(windows[i]), title)) changed = SDL_SetWindowSize(windows[i], width, height);
    SDL_free(windows);
#else
    HWND window = pu_test_find_window(title);
    if (window) {
        RECT outer, client;
        GetWindowRect(window, &outer); GetClientRect(window, &client);
        UINT window_dpi = dpi ? (UINT)dpi : GetDpiForWindow(window);
        changed = SetWindowPos(window, NULL, 0, 0, MulDiv(width, window_dpi, 96) + outer.right - outer.left - client.right,
            MulDiv(height, window_dpi, 96) + outer.bottom - outer.top - client.bottom,
            SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER) != 0;
        if (changed && dpi) {
            GetWindowRect(window, &outer);
            SendMessageW(window, WM_DPICHANGED, MAKEWPARAM(dpi, dpi), (LPARAM)&outer);
        }
    }
#endif
    JS_FreeCString(ctx, title);
    return changed ? JS_UNDEFINED : JS_ThrowInternalError(ctx, "Cannot resize the fixture-owned native window");
}
static int install(JSContext *ctx, PuDispatch *dispatch, int headless, void *user)
{
    (void)dispatch; (void)headless;
    JSValue test = JS_NewObject(ctx), global = JS_GetGlobalObject(ctx);
    bool ok = JS_SetPropertyStr(ctx, test, "gc", JS_NewCFunction(ctx, collect, "gc", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, test, "foreignViewRejected", JS_NewCFunction(ctx, foreign_view, "foreignViewRejected", 1)) >= 0 &&
        JS_SetPropertyStr(ctx, test, "resize", JS_NewCFunction(ctx, resize_window, "resize", 3)) >= 0 &&
        JS_SetPropertyStr(ctx, test, "directory", JS_NewString(ctx, user ? user : "")) >= 0;
#if defined(PU_TEST_SDL)
    ok = ok && JS_SetPropertyStr(ctx, test, "nativeDpiMessage", JS_FALSE) >= 0;
#else
    ok = ok && JS_SetPropertyStr(ctx, test, "nativeDpiMessage", JS_TRUE) >= 0;
#endif
    if (ok) ok = JS_SetPropertyStr(ctx, global, "ownerTest", JS_DupValue(ctx, test)) >= 0;
    JS_FreeValue(ctx, test); JS_FreeValue(ctx, global);
    return ok;
}
int main(int argc, char **argv)
{
    if (argc < 2 || argc > 3) return 2;
    const PuGuiHooks hooks = {.install = install};
    PuGuiConfig config = {.script = argv[1], .hooks = &hooks, .user = argc > 2 ? argv[2] : NULL};
    int result = pu_gui_run(&config);
    pu_gui_shutdown();
    return result;
}
