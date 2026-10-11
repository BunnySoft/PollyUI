#include "pollyui/context.h"
#include "quickjs.h"
#include <stdio.h>
#if !defined(PU_TEST_SDL)
#include "win32-test-window.h"
static int phase, ticks, failed;
#endif

static JSValue collect(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    JS_RunGC(JS_GetRuntime(ctx));
    return JS_UNDEFINED;
}
static int install(JSContext *ctx, PuDispatch *dispatch, int headless, void *user)
{
    (void)dispatch; (void)headless; (void)user;
    JSValue global = JS_GetGlobalObject(ctx);
    int ok = JS_SetPropertyStr(ctx, global, "fixtureGC", JS_NewCFunction(ctx, collect, "fixtureGC", 0)) >= 0;
    JS_FreeValue(ctx, global);
    return ok;
}
static int pump(void *user)
{
    (void)user;
#if !defined(PU_TEST_SDL)
    if (++ticks > 800) { fprintf(stderr, "FAIL: native Windows close-tree timed out\n"); return -1; }
    HWND owner = pu_test_find_window("Close.owner"), child = pu_test_find_window("Close.child");
    HWND grand = pu_test_find_window("Close.grand"), peer = pu_test_find_window("Close.peer");
    HWND save = pu_test_find_window("Close.save");
    if (!phase && ticks > 4 && owner && child && grand && peer) {
        if (GetWindow(child, GW_OWNER) != owner || GetWindow(grand, GW_OWNER) != child ||
            IsWindowEnabled(child) || !IsWindowEnabled(owner)) failed = 1;
        SetFocus(grand);
        SendMessageW(grand, WM_LBUTTONDOWN, MK_LBUTTON, MAKELPARAM(20, 20));
        if (GetCapture() != grand) failed = 1;
        PostMessageW(owner, WM_CLOSE, 0, 0); phase = 1;
    } else if (phase == 1 && save && !peer) {
        if (!owner || !child || !grand || IsWindowEnabled(grand) ||
            GetWindow(save, GW_OWNER) != grand || GetCapture() == grand) failed = 1;
        puts("PASS: native Windows owner retained after descendant veto; modal save prompt is native");
        DestroyWindow(save); phase = 2;
        puts("PASS: externally lost native child HWND is retired without losing its owner");
    } else if (phase == 2 && pu_test_find_window("Close.retry")) {
        if (!owner || !child || !grand || save) failed = 1;
        puts("PASS: Promise settlement and save prompt close did not retry owner close");
        PostMessageW(owner, WM_CLOSE, 0, 0); phase = 3;
    } else if (phase == 3 && !owner && !child && !grand) {
        puts("PASS: native Windows owned HWNDs retired leaf-first after accepted retry");
        phase = 4;
    }
    if (failed) { fprintf(stderr, "FAIL: native Windows close-tree relationship\n"); return -1; }
#endif
    return 0;
}
int main(int argc, char **argv)
{
    if (argc < 2) return 2;
    const PuGuiHooks hooks = { .install = install, .pump = pump };
    PuGuiConfig config = { .script = argv[1], .hooks = &hooks };
    int result = pu_gui_run(&config);
    pu_gui_shutdown();
#if !defined(PU_TEST_SDL)
    if (phase != 4 || failed) return 1;
#endif
    return result;
}
