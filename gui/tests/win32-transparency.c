#include <windows.h>
#include <dwmapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include "pollyui/context.h"
#include "pollyui/window.h"
#include "quickjs.h"
#include "host/win32/composition.h"
#include "win32-test-window.h"
#include "win32-desktop-pixel.h"

static HWND marker, framed, frameless, opaque, modal;
static ULONGLONG started;
static int stage, ticks;
static POINT origin;
static double scale;
static PuTestDesktopCapture *capture;
static JSContext *script_context;
static LARGE_INTEGER present_after;
static ULONGLONG capture_deadline;
static void begin_capture_phase(void)
{
    QueryPerformanceCounter(&present_after);
    capture_deadline = GetTickCount64() + 2000;
}
static void marker_baseline(void)
{
    RECT client;
    POINT p = {0};
    GetClientRect(marker, &client); ClientToScreen(marker, &p);
    DWORD affinity = 0;
    BOOL affinity_ok = GetWindowDisplayAffinity(marker, &affinity);
    HDC dc = GetDC(marker);
    COLORREF blue = dc ? GetPixel(dc, (int)lround(20 * scale), (int)lround(550 * scale)) : CLR_INVALID;
    COLORREF purple = dc ? GetPixel(dc, (int)lround(800 * scale), (int)lround(550 * scale)) : CLR_INVALID;
    if (dc) ReleaseDC(marker, dc);
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    printf("AUXILIARY: marker client=%ldx%ld origin=%ld,%ld dpi=%u scale=%.3f "
        "DC-blue=%02x%02x%02x DC-purple=%02x%02x%02x display-affinity=%lu query=%d "
        "pending-paint=%d qpc=%lld (not composed-output proof)\n",
        client.right, client.bottom, p.x, p.y, GetDpiForWindow(marker), scale,
        GetRValue(blue), GetGValue(blue), GetBValue(blue),
        GetRValue(purple), GetGValue(purple), GetBValue(purple), affinity, affinity_ok,
        GetUpdateRect(marker, NULL, FALSE), now.QuadPart);
}
static void desktop_identity(void)
{
    char station[160] = "", thread[160] = "", input[160] = "";
    DWORD needed, session = 0;
    GetUserObjectInformationA(GetProcessWindowStation(), UOI_NAME, station, sizeof(station), &needed);
    GetUserObjectInformationA(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, thread, sizeof(thread), &needed);
    HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
    DWORD error = desktop ? 0 : GetLastError();
    if (desktop) {
        GetUserObjectInformationA(desktop, UOI_NAME, input, sizeof(input), &needed);
        CloseDesktop(desktop);
    }
    ProcessIdToSessionId(GetCurrentProcessId(), &session);
    printf("NATIVE: station=%s thread-desktop=%s input-desktop=%s input-error=%lu session=%lu\n",
        station, thread, input, error, session);
}
static int install(JSContext *ctx, PuDispatch *dispatch, int headless, void *user)
{
    (void)dispatch; (void)headless;
    script_context = ctx;
    if (!user) return 1;
    JSValue global = JS_GetGlobalObject(ctx);
    int ok = JS_SetPropertyStr(ctx, global, "nativeAlphaEvidence", JS_NewString(ctx, user)) >= 0;
    JS_FreeValue(ctx, global);
    return ok;
}

static int fail(const char *expression, int line)
{
    fprintf(stderr, "FAIL Win32 alpha stage=%d line=%d: %s\n", stage, line, expression);
    return -1;
}
#define CHECK(c) do { if (!(c)) return fail(#c, __LINE__); } while (0)

static int fresh_capture(void)
{
    int result = pu_test_desktop_capture_refresh(capture, present_after.QuadPart);
    CHECK(result);
    if (result == 1) return 1;
    if (GetTickCount64() >= capture_deadline) {
        fprintf(stderr, "FAIL: no desktop-present image after stage=%d fence=%lld within 2000ms; "
            "pointer-only/older frames are not composition evidence\n", stage, present_after.QuadPart);
        return -1;
    }
    return 0;
}

static POINT point(HWND hwnd, int x, int y)
{
    POINT p = { (LONG)lround(x * scale), (LONG)lround(y * scale) };
    ClientToScreen(hwnd, &p);
    return p;
}
static int move_client(HWND hwnd, int x, int y, int width, int height)
{
    RECT outer, client;
    POINT current = {0};
    CHECK(GetWindowRect(hwnd, &outer) && GetClientRect(hwnd, &client) && ClientToScreen(hwnd, &current));
    int dw = outer.right - outer.left - client.right;
    int dh = outer.bottom - outer.top - client.bottom;
    CHECK(SetWindowPos(hwnd, HWND_TOPMOST, x - (current.x - outer.left), y - (current.y - outer.top),
        width ? (int)lround(width * scale) + dw : outer.right - outer.left,
        height ? (int)lround(height * scale) + dh : outer.bottom - outer.top,
        SWP_NOACTIVATE));
    return 0;
}
static int color_near(COLORREF actual, unsigned expected)
{
    return actual != CLR_INVALID &&
        abs((int)GetRValue(actual) - (int)((expected >> 16) & 255)) <= 2 &&
        abs((int)GetGValue(actual) - (int)((expected >> 8) & 255)) <= 2 &&
        abs((int)GetBValue(actual) - (int)(expected & 255)) <= 2;
}
static int sample(HWND hwnd, int x, int y, unsigned expected, int report)
{
    POINT p = point(hwnd, x, y);
    /* Never capture an unrelated app: only sample a point whose native
     * hit-test owner is our fixture HWND or its disabled modal owner. */
    HWND hit = WindowFromPoint(p);
    if (hit != hwnd && !(hwnd == opaque && hit == marker)) return 0;
    COLORREF actual = CLR_INVALID;
    if (!pu_test_desktop_pixel(capture, p.x, p.y, &actual)) return 0;
    if (report) printf("COMPOSED: HWND=%p logical=%d,%d desktop=%ld,%ld actual=%02x%02x%02x expected=%06x tolerance=2\n",
        (void *)hwnd, x, y, p.x, p.y, GetRValue(actual), GetGValue(actual), GetBValue(actual), expected);
    return color_near(actual, expected);
}
static int colors(HWND hwnd, unsigned background, unsigned half)
{
    CHECK(sample(hwnd, 20, 30, background, 1));
    CHECK(sample(hwnd, 70, 30, half, 1));
    CHECK(sample(hwnd, 130, 30, 0x20e080, 1));
    int text = 0;
    for (int y = 80; y < 116 && !text; y++) for (int x = 20; x < 120 && !text; x++)
        if (sample(hwnd, x, y, 0xffffff, 0)) { CHECK(sample(hwnd, x, y, 0xffffff, 1)); text = 1; }
    CHECK(text);
    return 0;
}
static int native_geometry(HWND hwnd, int borderless)
{
    RECT outer, client;
    POINT p = {0};
    CHECK(GetWindowRect(hwnd, &outer) && GetClientRect(hwnd, &client) && ClientToScreen(hwnd, &p));
    LONG_PTR styles = GetWindowLongPtrW(hwnd, GWL_STYLE);
    LONG_PTR extended = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    CHECK((styles & WS_THICKFRAME) && (styles & WS_CAPTION) &&
        (extended & WS_EX_NOREDIRECTIONBITMAP) && !(extended & (WS_EX_LAYERED | WS_EX_TRANSPARENT)));
    CHECK(borderless ? p.y == outer.top : p.y > outer.top);
    printf("NATIVE: HWND=%p frame=%s outer=%ld,%ld,%ld,%ld client=%ldx%ld origin=%ld,%ld dpi=%u scale=%.3f\n",
        (void *)hwnd, borderless ? "custom" : "system", outer.left, outer.top, outer.right, outer.bottom,
        client.right, client.bottom, p.x, p.y, GetDpiForWindow(hwnd), scale);
    return 0;
}
static int caption_visible(void)
{
    RECT outer;
    POINT client = {0};
    CHECK(GetWindowRect(framed, &outer) && ClientToScreen(framed, &client));
    POINT p = { client.x + (LONG)(20 * scale), outer.top + (client.y - outer.top) / 2 };
    CHECK(WindowFromPoint(p) == framed &&
        SendMessageW(framed, WM_NCHITTEST, 0, MAKELPARAM(p.x, p.y)) == HTCAPTION);
    COLORREF actual;
    CHECK(pu_test_desktop_pixel(capture, p.x, p.y, &actual) && !color_near(actual, 0x204080));
    printf("COMPOSED: system caption HWND=%p desktop=%ld,%ld actual=%02x%02x%02x (not underlying marker)\n",
        (void *)framed, p.x, p.y, GetRValue(actual), GetGValue(actual), GetBValue(actual));
    return 0;
}
static void visibility(HWND hwnd)
{
    DWORD cloaked = 0;
    HRESULT result = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    RECT bounds = {0};
    DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds));
    printf("NATIVE: HWND=%p visible=%d iconic=%d cloaked=%lu status=%08lx DWM-bounds=%ld,%ld,%ld,%ld\n",
        (void *)hwnd, IsWindowVisible(hwnd), IsIconic(hwnd), cloaked, (unsigned long)result,
        bounds.left, bounds.top, bounds.right, bounds.bottom);
}
static int pump_native(void *user)
{
    (void)user;
    CHECK(GetTickCount64() - started < 11000);
    if (stage == 0) {
        marker = pu_test_find_window("Alpha.marker");
        framed = pu_test_find_window("Alpha.framed");
        frameless = pu_test_find_window("Alpha.frameless");
        opaque = pu_test_find_window("Alpha.opaque");
        modal = pu_test_find_window("Alpha.modal");
        if (!marker || !framed || !frameless || !opaque || !modal) return 0;
        scale = GetDpiForWindow(marker) / 96.0;
        MONITORINFO monitor = { .cbSize = sizeof(monitor) };
        CHECK(GetMonitorInfoW(MonitorFromWindow(marker, MONITOR_DEFAULTTOPRIMARY), &monitor));
        origin = (POINT){ monitor.rcWork.left + 40, monitor.rcWork.top + 60 };
        CHECK(origin.x + 900 * scale <= monitor.rcWork.right &&
            origin.y + 600 * scale <= monitor.rcWork.bottom);
        capture = pu_test_desktop_capture_create(marker);
        CHECK(capture);
        begin_capture_phase();
        CHECK(move_client(marker, origin.x, origin.y, 0, 0) == 0);
        CHECK(move_client(framed, origin.x + (int)(20 * scale), origin.y + (int)(60 * scale), 0, 0) == 0);
        CHECK(move_client(frameless, origin.x + (int)(20 * scale), origin.y + (int)(290 * scale), 0, 0) == 0);
        CHECK(move_client(opaque, origin.x + (int)(700 * scale), origin.y + (int)(340 * scale), 0, 0) == 0);
        CHECK(move_client(modal, origin.x + (int)(350 * scale), origin.y + (int)(300 * scale), 0, 0) == 0);
        stage = 1; ticks = 0;
    } else if (stage == 1) {
        CHECK(SUCCEEDED(DwmFlush()));
        if (++ticks < 4) return 0;
        int fresh = fresh_capture();
        if (fresh <= 0) return fresh;
        CHECK(native_geometry(framed, 0) == 0 && native_geometry(frameless, 1) == 0);
        visibility(marker); visibility(framed); visibility(frameless);
        CHECK(GetWindow(framed, GW_OWNER) == marker && GetWindow(modal, GW_OWNER) == opaque &&
            !IsWindowEnabled(opaque) && IsWindowEnabled(marker));
        marker_baseline();
        CHECK(sample(marker, 20, 550, 0x204080, 1) && sample(marker, 800, 550, 0x802040, 1));
        CHECK(caption_visible() == 0);
        CHECK(colors(framed, 0x204080, 0x744854) == 0 && colors(frameless, 0x204080, 0x744854) == 0);
        CHECK(sample(opaque, 20, 30, 0xffffff, 1) &&
            !(GetWindowLongPtrW(opaque, GWL_EXSTYLE) & WS_EX_NOREDIRECTIONBITMAP));
        CHECK(sample(modal, 20, 30, 0x204080, 1) && sample(modal, 130, 30, 0x20e080, 1));
        begin_capture_phase();
        CHECK(move_client(framed, origin.x + (int)(480 * scale), origin.y + (int)(60 * scale), 320, 200) == 0);
        stage = 2; ticks = 0;
    } else if (stage == 2) {
        CHECK(SUCCEEDED(DwmFlush()));
        if (++ticks < 4) return 0;
        int fresh = fresh_capture();
        if (fresh <= 0) return fresh;
        CHECK(colors(framed, 0x802040, 0xa43834) == 0);
        RECT rect;
        CHECK(GetClientRect(framed, &rect) && rect.right == (int)lround(320 * scale) &&
            rect.bottom == (int)lround(200 * scale));
        CHECK(native_geometry(framed, 0) == 0);
        POINT blank = point(framed, 20, 30);
        CHECK(WindowFromPoint(blank) == framed);
        SetActiveWindow(framed); SetFocus(framed);
        CHECK(GetFocus() == framed);
        begin_capture_phase();
        SendMessageW(framed, WM_LBUTTONDOWN, MK_LBUTTON, MAKELPARAM((int)(20 * scale), (int)(30 * scale)));
        CHECK(GetCapture() == framed);
        stage = 3; ticks = 0;
    } else if (stage == 3) {
        CHECK(SUCCEEDED(DwmFlush()));
        if (++ticks < 3) return 0;
        int fresh = fresh_capture();
        if (fresh <= 0) return fresh;
        CHECK(sample(framed, 185, 25, 0xe02080, 1));
        begin_capture_phase();
        SendMessageW(framed, WM_MOUSEMOVE, MK_LBUTTON, MAKELPARAM((int)(500 * scale), (int)(380 * scale)));
        SendMessageW(framed, WM_LBUTTONUP, 0, MAKELPARAM((int)(500 * scale), (int)(380 * scale)));
        CHECK(!GetCapture());
        stage = 4; ticks = 0;
    } else if (stage == 4) {
        CHECK(SUCCEEDED(DwmFlush()));
        if (++ticks < 3) return 0;
        int fresh = fresh_capture();
        if (fresh <= 0) return fresh;
        CHECK(sample(framed, 185, 25, 0x2080e0, 1));
        stage = 5;
        SendMessageW(framed, WM_CLOSE, 0, 0);
    }
    return 0;
}
static int pump(void *user)
{
    int result = pump_native(user);
    if (result < 0) {
        JSValue global = JS_GetGlobalObject(script_context);
        JS_SetPropertyStr(script_context, global, "nativeAlphaAbort", JS_TRUE);
        JS_FreeValue(script_context, global);
    }
    return result;
}
int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    if (argc == 2 && !strcmp(argv[1], "--capture-contract")) {
        CHECK(!pu_test_desktop_frame_fresh(0, 0, 100));
        CHECK(!pu_test_desktop_frame_fresh(0, 1, 100));
        CHECK(!pu_test_desktop_frame_fresh(100, 0, 100));
        CHECK(!pu_test_desktop_frame_fresh(99, 2, 100));
        CHECK(pu_test_desktop_frame_fresh(100, 1, 100));
        CHECK(pu_test_desktop_frame_fresh(101, 2, 100));
        CHECK(pu_test_desktop_frame_fresh(101, 1, 0));
        puts("PASS: desktop frame metadata gate rejects pointer-only/stale images; not native composition proof");
        return 0;
    }
    if (argc != 2 && argc != 3) return 2;
    const PuGuiHooks hooks = { .install = install, .pump = pump };
    const PuGuiConfig config = { .script = argv[1], .hooks = &hooks, .user = argc == 3 ? argv[2] : NULL };
    puts("PRECHECK: the next two Host diagnostics exercise intentionally invalid arguments");
    CHECK(!pu_win_composition_create(NULL) && !pu_win_composition_present(NULL, NULL, 1, 1, 4));
    desktop_identity();
    started = GetTickCount64();
    int result = pu_gui_run(&config);
    pu_gui_shutdown();
    script_context = NULL;
    pu_test_desktop_capture_destroy(capture); capture = NULL;
    CHECK(!IsWindow(marker) && !IsWindow(framed) && !IsWindow(frameless) && !IsWindow(opaque) && !IsWindow(modal));
    if (pu_test_desktop_capture_denied()) {
        puts("SKIP: desktop capture access denied; native composition is NOT qualified by surface PNG/API success");
        return 77;
    }
    CHECK(!result && stage == 5);
    puts("PASS: native Windows raster/DirectComposition ordinary alpha, frame, move, resize, opaque text, input, capture and owned/modal close");
    return 0;
}
