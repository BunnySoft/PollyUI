#include "pollyui/window.h"
#include "render/skia_c.h"
#include "host/drag_internal.h"

int pu_window_drag_supported(PuWindow *w) { (void)w; return 0; }
PuDragSession *pu_window_start_drag(PuWindow *w, PuDragInput *input,
    const PuDragItem *items, size_t count, PuDragFn callback, void *user)
{
    (void)w; (void)input; (void)items; (void)count; (void)callback; (void)user;
    pu_drag_fail("Native COPY drag is unsupported by the Win32 host");
    return NULL;
}
#include "host/window_contract.h"

/* Need Windows 10 APIs (per-monitor DPI v2, GetDpiForWindow, ...). */
#ifndef WINVER
#define WINVER 0x0A00
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <windows.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>
#include <math.h>
#include <shellscalingapi.h>

/* M0b: the window now paints by clearing a Skia raster surface and blitting its
 * BGRA pixels to the client area (replacing the M0a GDI FillRect). The host
 * touches Skia only through the extern "C" API in render/skia_c.h. */

#ifndef DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
#define DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 ((DPI_AWARENESS_CONTEXT)-4)
#endif

struct PuWindow {
    struct PuWindow *next;
    struct PuWindow *parent;
    PuPopup popup;
    int modal, modal_count, modal_restore;
    unsigned children, borrows;
    int closing, request_active;
    int close_pending, close_external, close_hook_done, native_retired;
    int destroy_requested, destroying;
    PuWindowLimits limits;
    PuWindowState reported_state;
    int state_reported;
    PuWindowStateFn state_fn;
    void *state_user;
    HWND       hwnd;
    PuSurface *surface;      /* Skia raster surface, sized to the client (physical px) */
    int        width;        /* client width  in PHYSICAL pixels */
    int        height;       /* client height in PHYSICAL pixels */
    float      scale;        /* physical / logical (DPI scale), e.g. 1.5 at 150% */
    PuPaintFn   paint_fn;     /* optional per-frame draw callback */
    void       *paint_user;
    PuPointerFn pointer_fn;   /* optional mouse callback */
    void       *pointer_user;
    PuKeyFn     key_fn;       /* optional keyboard callback */
    void       *key_user;
    int         suppress_text;
    int         click_counts[5];
    int         mouse_capture, active;
    HCURSOR     cursor;
    PuActivationFn activation_fn;
    void       *activation_user;
    wchar_t     pending_surrogate;
    PuWheelFn   wheel_fn;     /* optional wheel callback */
    void       *wheel_user;
    PuAsyncFn   async_fn;     /* optional async pump callback */
    void       *async_user;
    int         frameless;    /* 1 = OS title bar hidden, app draws its own */
    PuRegionFn  region_fn;    /* hit-region query for the custom title bar drag area */
    void       *region_user;
    PuCloseFn close_fn;
    void *close_user;
    PuCloseRequestFn close_request_fn;
    void *close_request_user;
    int running, registered, close_notified, exit_code, presented;
};

static PuWindow *g_windows;
static DWORD g_ui_thread;
static int g_loop_running, g_pumping, g_exit_code, g_keep_alive;
static PuAsyncFn g_frame;
static void *g_frame_user;
#include "host/window_close.h"
static void pump_windows(void);
static void retire_native(PuWindow *w);

unsigned pu_window_capabilities(void)
{ return PU_WINDOW_OWNED | PU_WINDOW_POPUP | PU_WINDOW_MODAL | PU_WINDOW_LIMITS; }

int pu_window_get_state(PuWindow *w, PuWindowState *state)
{
    if (!w || !w->hwnd || !w->running || !state) {
        fprintf(stderr, "Window state requires a live native window\n"); return 0;
    }
    memset(state, 0, sizeof(*state));
    RECT rect;
    if (!GetClientRect(w->hwnd, &rect)) {
        fprintf(stderr, "Cannot query client size: %lu\n", GetLastError()); return 0;
    }
    state->scale = w->scale > 0 ? w->scale : 1.0f;
    state->pixel_width = rect.right; state->pixel_height = rect.bottom;
    state->width = (int)(rect.right / state->scale);
    state->height = (int)(rect.bottom / state->scale);
    state->minimized = IsIconic(w->hwnd) != 0;
    state->maximized = IsZoomed(w->hwnd) != 0;
    state->active = w->active;
    return 1;
}

void pu_window_set_state(PuWindow *w, PuWindowStateFn fn, void *user)
{ if (w) { w->state_fn = fn; w->state_user = user; w->state_reported = 0; } }

static void notify_state(void)
{
    size_t count;
    PuWindow **windows = borrow_window_snapshot(&count);
    for (size_t i = 0; i < count; i++) {
        PuWindow *w = windows[i];
        PuWindowState state;
        if (w->running && w->state_fn && pu_window_get_state(w, &state) &&
            (!w->state_reported || memcmp(&state, &w->reported_state, sizeof(state)))) {
            w->reported_state = state; w->state_reported = 1;
            w->state_fn(&state, w->state_user);
        }
    }
    release_window_snapshot(windows, count);
}

static SIZE frame_size(PuWindow *w, HWND hwnd)
{
    UINT dpi = GetDpiForWindow(hwnd);
    if (!dpi) dpi = (UINT)(w->scale * 96);
    RECT frame = {0};
    AdjustWindowRectExForDpi(&frame, (DWORD)GetWindowLongPtrW(hwnd, GWL_STYLE), FALSE,
        (DWORD)GetWindowLongPtrW(hwnd, GWL_EXSTYLE), dpi);
    if (w->frameless) frame.top = 0;
    return (SIZE){ frame.right - frame.left, frame.bottom - frame.top };
}

int pu_window_system_init(void)
{
    if (g_windows && g_ui_thread != GetCurrentThreadId()) {
        fprintf(stderr, "Window system belongs to another UI thread\n");
        return 0;
    }
    g_ui_thread = GetCurrentThreadId();
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    return 1;
}

void pu_window_system_shutdown(void) { if (!g_windows) { g_ui_thread = 0; g_keep_alive = 0; } }
void pu_window_keep_alive(int enabled) { g_keep_alive = enabled != 0; }

struct DisplayList { PuDisplayInfo *items; int count; };
static BOOL CALLBACK display_info(HMONITOR monitor, HDC dc, LPRECT bounds, LPARAM data)
{
    (void)dc; (void)bounds;
    struct DisplayList *list = (struct DisplayList *)data;
    MONITORINFOEXW info;
    memset(&info, 0, sizeof(info));
    info.cbSize = sizeof(info);
    UINT xdpi, ydpi;
    if (!GetMonitorInfoW(monitor, (MONITORINFO *)&info) ||
        FAILED(GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &xdpi, &ydpi))) return FALSE;
    PuDisplayInfo *grown = realloc(list->items, ((size_t)list->count + 1) * sizeof(*grown));
    if (!grown) return FALSE;
    list->items = grown;
    PuDisplayInfo *item = &grown[list->count];
    memset(item, 0, sizeof(*item));
    item->id = (uint32_t)list->count + 1;
    item->x = info.rcMonitor.left; item->y = info.rcMonitor.top;
    item->width = info.rcMonitor.right - info.rcMonitor.left;
    item->height = info.rcMonitor.bottom - info.rcMonitor.top;
    item->scale = xdpi / 96.0f;
    if (!WideCharToMultiByte(CP_UTF8, 0, info.szDevice, -1, item->name, sizeof(item->name), NULL, NULL))
        return FALSE;
    list->count++;
    return TRUE;
}

PuDisplayInfo *pu_window_displays(int *count)
{
    struct DisplayList list = {0};
    *count = 0;
    if (!EnumDisplayMonitors(NULL, NULL, display_info, (LPARAM)&list)) {
        fprintf(stderr, "Cannot enumerate native display information\n");
        free(list.items);
        return NULL;
    }
    *count = list.count;
    return list.items ? list.items : calloc(1, sizeof(PuDisplayInfo));
}
#define PU_WM_WAKE (WM_APP + 1)   /* posted by pu_window_wake */

/* Map a non-character virtual key to a DOM key name, or NULL. */
static const char *pu_vk_name(WPARAM vk)
{
    switch (vk) {
    case VK_BACK:   return "Backspace";
    case VK_RETURN: return "Enter";
    case VK_TAB:    return "Tab";
    case VK_ESCAPE: return "Escape";
    case VK_DELETE: return "Delete";
    case VK_LEFT:   return "ArrowLeft";
    case VK_RIGHT:  return "ArrowRight";
    case VK_UP:     return "ArrowUp";
    case VK_DOWN:   return "ArrowDown";
    case VK_HOME:   return "Home";
    case VK_END:    return "End";
    case VK_PRIOR: return "PageUp"; case VK_NEXT: return "PageDown";
    case VK_INSERT: return "Insert";
    case VK_SHIFT: case VK_LSHIFT: case VK_RSHIFT: return "Shift";
    case VK_CONTROL: case VK_LCONTROL: case VK_RCONTROL: return "Control";
    case VK_MENU: case VK_LMENU: case VK_RMENU: return "Alt";
    case VK_LWIN: case VK_RWIN: return "Meta";
    case VK_CAPITAL: return "CapsLock"; case VK_NUMLOCK: return "NumLock";
    case VK_SNAPSHOT: return "PrintScreen"; case VK_PAUSE: return "Pause";
    case VK_CLEAR: return "Clear"; case VK_APPS: return "ContextMenu";
    default:        return NULL;
    }
}

static unsigned key_modifiers(void)
{
    return ((GetKeyState(VK_SHIFT) & 0x8000) ? PU_MOD_SHIFT : 0) |
           ((GetKeyState(VK_CONTROL) & 0x8000) ? PU_MOD_CTRL : 0) |
           ((GetKeyState(VK_MENU) & 0x8000) ? PU_MOD_ALT : 0) |
           (((GetKeyState(VK_LWIN) | GetKeyState(VK_RWIN)) & 0x8000) ? PU_MOD_META : 0) |
           ((GetKeyState(VK_CAPITAL) & 1) ? PU_MOD_CAPS : 0) |
           ((GetKeyState(VK_NUMLOCK) & 1) ? PU_MOD_NUM : 0);
}

static unsigned mouse_buttons(WPARAM state)
{
    return ((state & MK_LBUTTON) ? 1 : 0) | ((state & MK_RBUTTON) ? 2 : 0) |
           ((state & MK_MBUTTON) ? 4 : 0) | ((state & MK_XBUTTON1) ? 8 : 0) |
           ((state & MK_XBUTTON2) ? 16 : 0);
}

static const char *key_code(WPARAM vk, LPARAM lp, char *buffer, size_t size)
{
    unsigned scan = ((unsigned long)lp >> 16) & 255;
    int extended = ((unsigned long)lp >> 24) & 1;
    char letter = 0;
    if (scan >= 0x10 && scan <= 0x19) letter = "QWERTYUIOP"[scan - 0x10];
    if (scan >= 0x1e && scan <= 0x26) letter = "ASDFGHJKL"[scan - 0x1e];
    if (scan >= 0x2c && scan <= 0x32) letter = "ZXCVBNM"[scan - 0x2c];
    if (letter) { snprintf(buffer, size, "Key%c", letter); return buffer; }
    if (scan >= 2 && scan <= 11) {
        snprintf(buffer, size, "Digit%c", "1234567890"[scan - 2]); return buffer;
    }
    if (vk >= VK_F1 && vk <= VK_F24) { snprintf(buffer, size, "F%d", (int)(vk - VK_F1 + 1)); return buffer; }
    if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9) {
        snprintf(buffer, size, "Numpad%d", (int)(vk - VK_NUMPAD0)); return buffer;
    }
    if (!extended && scan >= 0x47 && scan <= 0x53) {
        const char *keypad[] = { "Numpad7", "Numpad8", "Numpad9", "NumpadSubtract",
            "Numpad4", "Numpad5", "Numpad6", "NumpadAdd", "Numpad1", "Numpad2",
            "Numpad3", "Numpad0", "NumpadDecimal" };
        return keypad[scan - 0x47];
    }
    switch (scan) {
    case 0x2a: return "ShiftLeft"; case 0x36: return "ShiftRight";
    case 0x1d: return extended ? "ControlRight" : "ControlLeft";
    case 0x38: return extended ? "AltRight" : "AltLeft";
    case 0x1c: return extended ? "NumpadEnter" : "Enter";
    case 0x39: return "Space";
    case 0x0c: return "Minus"; case 0x0d: return "Equal";
    case 0x1a: return "BracketLeft"; case 0x1b: return "BracketRight";
    case 0x27: return "Semicolon"; case 0x28: return "Quote";
    case 0x29: return "Backquote"; case 0x2b: return "Backslash";
    case 0x33: return "Comma"; case 0x34: return "Period";
    case 0x35: return extended ? "NumpadDivide" : "Slash";
    case 0x37: if (!extended) return "NumpadMultiply"; break;
    default: break;
    }
    if (vk == VK_LWIN) return "MetaLeft";
    if (vk == VK_RWIN) return "MetaRight";
    const char *name = pu_vk_name(vk);
    return name ? name : "Unidentified";
}

static const char *key_name(WPARAM vk, LPARAM lp, char *buffer, int size)
{
    const char *name = pu_vk_name(vk);
    if (name) return name;
    if (vk >= VK_F1 && vk <= VK_F24) {
        snprintf(buffer, size, "F%d", (int)(vk - VK_F1 + 1)); return buffer;
    }
    BYTE state[256];
    if (!GetKeyboardState(state)) return "Unidentified";
    wchar_t chars[8];
    int count = ToUnicodeEx((UINT)vk, ((UINT)lp >> 16) & 255, state, chars, 8,
                            4 /* do not change dead-key state */, GetKeyboardLayout(0));
    if (count < 0) return "Dead";
    if (count > 0 && chars[0] < 0x20) {
        state[VK_CONTROL] = state[VK_LCONTROL] = state[VK_RCONTROL] = 0;
        count = ToUnicodeEx((UINT)vk, ((UINT)lp >> 16) & 255, state, chars, 8, 4, GetKeyboardLayout(0));
    }
    if (count > 0 && chars[0] >= 0x20) {
        int length = WideCharToMultiByte(CP_UTF8, 0, chars, count, buffer, size - 1, NULL, NULL);
        if (length) { buffer[length] = 0; return buffer; }
    }
    return "Unidentified";
}

static const wchar_t *kClassName = L"PollyUIWindowClass";

/* Render one frame into the Skia surface and blit it to hdc. */
static int pu_paint(PuWindow *w, HDC hdc, const char *capture_path)
{
    if (!w->surface || !w->running) return 0;
    if (!pu_surface_make_current(w->surface)) { w->running = 0; w->exit_code = 1; return 0; }

    float scale = w->scale > 0 ? w->scale : 1.0f;
    if (w->paint_fn) {
        int lw = (int)(w->width / scale);
        int lh = (int)(w->height / scale);
        w->paint_fn(w->surface, lw, lh, scale, w->paint_user);
    } else {
        /* Built-in demo (M0b): dark slate + centered PollyUI-blue card. */
        pu_surface_clear(w->surface, 0x10, 0x12, 0x18, 0xFF);
        float cw = (float)w->width, ch = (float)w->height;
        float rw = 320.0f, rh = 200.0f;
        pu_surface_fill_rect(w->surface, (cw - rw) * 0.5f, (ch - rh) * 0.5f, rw, rh,
                             0x3b, 0x82, 0xf6, 0xFF);
    }

    if (!pu_surface_make_current(w->surface)) { w->running = 0; w->exit_code = 1; return 0; }
    int captured = !capture_path || pu_surface_save_png(w->surface, capture_path);
    if (!captured) fprintf(stderr, "Cannot capture rendered frame to %s\n", capture_path);
    w->presented = 1;
    if (pu_surface_is_gl(w->surface)) {
        static int perf = -1;
        if (perf < 0) { const char *p = getenv("PU_PERF"); perf = (p && p[0] && p[0] != '0') ? 1 : 0; }
        if (perf) {
            LARGE_INTEGER f, a, b; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&a);
            pu_surface_present(w->surface);
            QueryPerformanceCounter(&b);
            fprintf(stderr, "[perf] present (flush+swap): %.2fms\n", (double)(b.QuadPart - a.QuadPart) * 1000.0 / (double)f.QuadPart);
        } else {
            pu_surface_present(w->surface); /* GPU: flush + swap buffers */
        }
        return captured;
    }

    /* Raster fallback: blit the pixel buffer to the window. */
    const void *pixels = pu_surface_pixels(w->surface);
    int sw = pu_surface_width(w->surface);
    int sh = pu_surface_height(w->surface);
    if (!pixels || sw <= 0 || sh <= 0) return 0;

    BITMAPINFO bmi;
    memset(&bmi, 0, sizeof(bmi));
    bmi.bmiHeader.biSize        = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth       = sw;
    bmi.bmiHeader.biHeight      = -sh;           /* top-down */
    bmi.bmiHeader.biPlanes      = 1;
    bmi.bmiHeader.biBitCount    = 32;
    bmi.bmiHeader.biCompression = BI_RGB;        /* BGRA in memory */

    StretchDIBits(hdc,
                  0, 0, sw, sh,
                  0, 0, sw, sh,
                  pixels, &bmi, DIB_RGB_COLORS, SRCCOPY);
    return captured;
}

static LRESULT dispatch_window_message(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    PuWindow *w = (PuWindow *)GetWindowLongPtrW(hwnd, GWLP_USERDATA);

    switch (msg) {
    case WM_NCCREATE: {
        CREATESTRUCTW *cs = (CREATESTRUCTW *)lp;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)cs->lpCreateParams);
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
    case WM_GETMINMAXINFO: {
        if (!w) break;
        MINMAXINFO *mmi = (MINMAXINFO *)lp;
        float sc = w->scale > 0 ? w->scale : 1.0f;
        SIZE frame = frame_size(w, hwnd);
        if (w->limits.min_width) mmi->ptMinTrackSize.x = (LONG)ceil(w->limits.min_width * (double)sc) + frame.cx;
        if (w->limits.min_height) mmi->ptMinTrackSize.y = (LONG)ceil(w->limits.min_height * (double)sc) + frame.cy;
        if (w->limits.max_width) {
            mmi->ptMaxTrackSize.x = (LONG)floor(w->limits.max_width * (double)sc) + frame.cx;
            mmi->ptMaxSize.x = mmi->ptMaxTrackSize.x;
            if (mmi->ptMinTrackSize.x > mmi->ptMaxTrackSize.x)
                mmi->ptMinTrackSize.x = mmi->ptMaxTrackSize.x;
        }
        if (w->limits.max_height) {
            mmi->ptMaxTrackSize.y = (LONG)floor(w->limits.max_height * (double)sc) + frame.cy;
            mmi->ptMaxSize.y = mmi->ptMaxTrackSize.y;
            if (mmi->ptMinTrackSize.y > mmi->ptMaxTrackSize.y)
                mmi->ptMinTrackSize.y = mmi->ptMaxTrackSize.y;
        }
        return 0;
    }
    case WM_ACTIVATE:
        if (w && w->registered && w->popup == PU_POPUP_MENU && LOWORD(wp) == WA_INACTIVE)
            pu_window_close(w);
        break;

    case WM_NCCALCSIZE:
        /* Frameless: extend the client area over the OS title bar (so the app
         * draws its own), while keeping the resizable WS_THICKFRAME border. When
         * maximized, inset by the frame so content isn't clipped off-screen. */
        if (w && w->frameless && wp) {
            NCCALCSIZE_PARAMS *p = (NCCALCSIZE_PARAMS *)lp;
            LONG topBefore = p->rgrc[0].top;
            /* Keep the standard, DWM-buffered window frame so live-resize stays
             * smooth — fully removing the non-client area (return 0) drops DWM's
             * resize frame buffer and exposes the GPU swapchain's resize stretch
             * ("rolling shutter"). Let DefWindowProc compute the framed client,
             * then reclaim only the title-bar caption as client (custom title bar),
             * keeping the thin L/R/B resize frame that DWM buffers. */
            LRESULT ret = DefWindowProcW(hwnd, WM_NCCALCSIZE, wp, lp);
            if (IsZoomed(hwnd)) {
                /* Maximized: a maximized window's frame hangs off every screen
                 * edge by the frame thickness, so DefWindowProc insets the top by
                 * frame + caption — leaving the caption as a (visible) OS title
                 * bar. Reclaim the caption by pulling the client top up to the
                 * monitor edge (topBefore + frame), dropping only the caption. */
                UINT dpi = GetDpiForWindow(hwnd);
                int frameY = GetSystemMetricsForDpi(SM_CYFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
                p->rgrc[0].top = topBefore + frameY;
            } else {
                p->rgrc[0].top = topBefore; /* reclaim the whole caption */
            }
            return ret;
        }
        break;

    case WM_NCHITTEST:
        if (w && w->popup == PU_POPUP_TOOLTIP) return HTTRANSPARENT;
        /* Frameless: synthesize resize edges, and ask the app whether the point
         * is in a draggable title-bar region (HTCAPTION) vs interactive (HTCLIENT). */
        if (w && w->frameless) {
            POINT pt = { (short)LOWORD(lp), (short)HIWORD(lp) };
            ScreenToClient(hwnd, &pt);
            RECT rc; GetClientRect(hwnd, &rc);
            float sc = (w->scale > 0) ? w->scale : 1.0f;
            /* Resize edges only when restored — a maximized window can't resize,
             * and the top edge band would otherwise eat clicks on the title-bar
             * controls that now sit flush at the screen top. */
            if (!IsZoomed(hwnd)) {
                int b = (int)(6 * sc); /* resize border thickness */
                int L = pt.x < b, R = pt.x >= rc.right - b, T = pt.y < b, B = pt.y >= rc.bottom - b;
                if (T && L) return HTTOPLEFT;    if (T && R) return HTTOPRIGHT;
                if (B && L) return HTBOTTOMLEFT; if (B && R) return HTBOTTOMRIGHT;
                if (L) return HTLEFT; if (R) return HTRIGHT; if (T) return HTTOP; if (B) return HTBOTTOM;
            }
            if (w->region_fn && w->region_fn((int)(pt.x / sc), (int)(pt.y / sc), w->region_user))
                return HTCAPTION; /* draggable title-bar area (double-click maximizes) */
            return HTCLIENT;
        }
        break;

    case WM_SIZE:
        if (w && wp != SIZE_MINIMIZED) {
            w->width  = LOWORD(lp);
            w->height = HIWORD(lp);
            pu_surface_resize(w->surface, w->width, w->height);
            /* Repaint SYNCHRONOUSLY during resize: deferring to a later WM_PAINT
             * makes live-resize lag/jitter (the window shows a stale frame at the
             * new size). UpdateWindow forces an immediate WM_PAINT.
             *
             * We pump TWO frames. ANGLE resizes its D3D11 swapchain lazily, only
             * at eglSwapBuffers, so the first frame still renders into the old-
             * sized backbuffer (and its swap is what triggers ANGLE to resize the
             * swapchain to the new client size). The second frame then renders
             * cleanly into the now-correctly-sized backbuffer, which is the frame
             * the user actually sees. Without this, every live-resize step shows a
             * one-frame-stale (stretched / top-gapped) image. */
            InvalidateRect(hwnd, NULL, FALSE);
            UpdateWindow(hwnd);
            if (pu_surface_is_gl(w->surface)) {
                InvalidateRect(hwnd, NULL, FALSE);
                UpdateWindow(hwnd);
            }
        }
        return 0;

    case WM_LBUTTONDOWN:
    case WM_LBUTTONUP:
    case WM_LBUTTONDBLCLK:
    case WM_RBUTTONDOWN:
    case WM_RBUTTONUP:
    case WM_RBUTTONDBLCLK:
    case WM_MBUTTONDOWN:
    case WM_MBUTTONUP:
    case WM_MBUTTONDBLCLK:
    case WM_XBUTTONDOWN:
    case WM_XBUTTONUP:
    case WM_XBUTTONDBLCLK:
    case WM_MOUSEMOVE:
        if (w && w->pointer_fn) {
            float scale = w->scale > 0 ? w->scale : 1.0f;
            PuPointerEvent event = {
                .x = (short)LOWORD(lp) / scale, .y = (short)HIWORD(lp) / scale,
                .button = -1, .buttons = mouse_buttons(wp), .modifiers = key_modifiers(),
            };
            int changed = 0;
            if (msg == WM_MOUSEMOVE) {
                TRACKMOUSEEVENT track = { sizeof(track), TME_LEAVE, hwnd, 0 };
                TrackMouseEvent(&track);
                event.type = PU_POINTER_MOVE;
                changed = w->pointer_fn(&event, w->pointer_user);
            } else {
                event.button = (msg == WM_LBUTTONDOWN || msg == WM_LBUTTONUP || msg == WM_LBUTTONDBLCLK) ? 0 :
                    (msg == WM_MBUTTONDOWN || msg == WM_MBUTTONUP || msg == WM_MBUTTONDBLCLK) ? 1 :
                    (msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP || msg == WM_RBUTTONDBLCLK) ? 2 :
                    (GET_XBUTTON_WPARAM(wp) == XBUTTON1 ? 3 : 4);
                int twice = msg == WM_LBUTTONDBLCLK || msg == WM_MBUTTONDBLCLK ||
                            msg == WM_RBUTTONDBLCLK || msg == WM_XBUTTONDBLCLK;
                int down = msg == WM_LBUTTONDOWN || msg == WM_MBUTTONDOWN ||
                           msg == WM_RBUTTONDOWN || msg == WM_XBUTTONDOWN || twice;
                if (down) w->click_counts[event.button] = twice ? 2 : 1;
                event.detail = w->click_counts[event.button];
                event.type = down ? PU_POINTER_DOWN : PU_POINTER_UP;
                changed = w->pointer_fn(&event, w->pointer_user);
                if (!down) {
                    event.type = event.button == 0 ? PU_POINTER_CLICK :
                                 event.button == 2 ? PU_POINTER_CONTEXT_MENU : PU_POINTER_AUXCLICK;
                    changed |= w->pointer_fn(&event, w->pointer_user);
                    if (event.button == 0 && event.detail == 2) {
                        event.type = PU_POINTER_DOUBLE_CLICK;
                        changed |= w->pointer_fn(&event, w->pointer_user);
                    }
                }
            }
            /* Repaint only when the handler actually changed the DOM, and do it
             * SYNCHRONOUSLY (UpdateWindow) so feedback isn't deferred behind
             * queued input. This kills the per-mousemove repaint storm: a hover
             * that changes nothing now costs ~0 instead of a full ~5ms
             * relayout+repaint, and a click paints immediately. */
            if (changed) { InvalidateRect(hwnd, NULL, FALSE); UpdateWindow(hwnd); }
        }
        return (msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP || msg == WM_XBUTTONDBLCLK) ? TRUE : 0;

    case WM_MOUSEWHEEL:
    case WM_MOUSEHWHEEL:
        if (w && w->wheel_fn) {
            float scale = w->scale > 0 ? w->scale : 1.0f;
            POINT pt = { (short)LOWORD(lp), (short)HIWORD(lp) }; /* screen coords */
            ScreenToClient(hwnd, &pt);
            float delta = (float)GET_WHEEL_DELTA_WPARAM(wp) / WHEEL_DELTA * 40.0f;
            PuWheelEvent event = {
                .x = pt.x / scale, .y = pt.y / scale,
                .delta_x = msg == WM_MOUSEHWHEEL ? delta : 0,
                .delta_y = msg == WM_MOUSEWHEEL ? -delta : 0,
                .modifiers = key_modifiers(),
            };
            int changed = w->wheel_fn(&event, w->wheel_user);
            if (changed) { InvalidateRect(hwnd, NULL, FALSE); UpdateWindow(hwnd); }
        }
        return 0;

    case WM_DPICHANGED:
        if (w) {
            w->scale = LOWORD(wp) / 96.0f; /* new DPI in wParam */
            RECT *rc = (RECT *)lp;         /* OS-suggested window rect */
            SIZE frame = frame_size(w, hwnd);
            int width = pu_window_clamp((int)((rc->right - rc->left - frame.cx) / w->scale),
                w->limits.min_width, w->limits.max_width);
            int height = pu_window_clamp((int)((rc->bottom - rc->top - frame.cy) / w->scale),
                w->limits.min_height, w->limits.max_height);
            SetWindowPos(hwnd, NULL, rc->left, rc->top,
                         (int)(width * w->scale) + frame.cx, (int)(height * w->scale) + frame.cy,
                         SWP_NOZORDER | SWP_NOACTIVATE);
            InvalidateRect(hwnd, NULL, FALSE);
        }
        return 0;

    case WM_KEYDOWN: case WM_KEYUP:
    case WM_SYSKEYDOWN: case WM_SYSKEYUP: {
        if (w && w->key_fn) {
            char name[40], code[32];
            int down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            PuKeyEvent event = {
                .type = down ? PU_KEY_DOWN : PU_KEY_UP,
                .key = key_name(wp, lp, name, sizeof(name)),
                .code = key_code(wp, lp, code, sizeof(code)),
                .modifiers = key_modifiers(),
                .repeat = down && ((unsigned long)lp & (1UL << 30)),
            };
            int result = w->key_fn(&event, w->key_user);
            if (down && wp == VK_ESCAPE && w->popup == PU_POPUP_MENU &&
                !(result & PU_INPUT_PREVENT_DEFAULT)) pu_window_close(w);
            w->suppress_text = down && (result & PU_INPUT_PREVENT_DEFAULT);
            if (result & PU_INPUT_REDRAW) { InvalidateRect(hwnd, NULL, FALSE); UpdateWindow(hwnd); }
            if (msg == WM_KEYDOWN || msg == WM_KEYUP || (result & PU_INPUT_PREVENT_DEFAULT)) return 0;
        }
        break; /* Preserve native system-key handling, including Alt+F4. */
    }

    case WM_CHAR:
        if (w && w->key_fn) {
            wchar_t c = (wchar_t)wp;
            if (c >= 0xd800 && c <= 0xdbff) { w->pending_surrogate = c; return 0; }
            wchar_t chars[2] = { c, 0 };
            int count = 1;
            if (c >= 0xdc00 && c <= 0xdfff) {
                if (w->pending_surrogate) { chars[0] = w->pending_surrogate; chars[1] = c; count = 2; }
                else chars[0] = 0xfffd;
            }
            w->pending_surrogate = 0;
            if (!w->suppress_text && c >= 0x20 && c != 0x7F) {
                char utf8[12] = {0};
                WideCharToMultiByte(CP_UTF8, 0, chars, count, utf8, sizeof(utf8) - 1, NULL, NULL);
                PuKeyEvent event = { .type = PU_KEY_TEXT, .text = utf8, .modifiers = key_modifiers() };
                if (w->key_fn(&event, w->key_user) & PU_INPUT_REDRAW) { InvalidateRect(hwnd, NULL, FALSE); UpdateWindow(hwnd); }
            }
            w->suppress_text = 0;
        }
        return 0;

    case WM_SETFOCUS:
    case WM_KILLFOCUS:
        if (w) {
            int active = msg == WM_SETFOCUS;
            w->active = active;
            if (!active) {
                w->pending_surrogate = 0; w->suppress_text = 0;
                PuPointerEvent event = { .type = PU_POINTER_CANCEL, .button = -1, .reason = "focus-lost" };
                if (w->pointer_fn) w->pointer_fn(&event, w->pointer_user);
                if (w->mouse_capture) pu_window_capture_mouse(w, 0);
            }
            if (w->activation_fn && w->activation_fn(active, w->activation_user)) pu_window_redraw(w);
        }
        break;
    case WM_CANCELMODE:
    case WM_CAPTURECHANGED:
        if (w && (msg == WM_CANCELMODE || w->mouse_capture)) {
            w->mouse_capture = 0;
            PuPointerEvent event = { .type = PU_POINTER_CANCEL, .button = -1,
                .reason = msg == WM_CANCELMODE ? "host-cancelled" : "capture-lost" };
            if (w->pointer_fn) w->pointer_fn(&event, w->pointer_user);
            if (GetCapture() == hwnd) ReleaseCapture();
        }
        break;
    case WM_SETCURSOR:
        if (w && LOWORD(lp) == HTCLIENT && w->cursor) {
            SetCursor(w->cursor);
            return TRUE;
        }
        break;
    case WM_MOUSELEAVE:
        if (w && w->pointer_fn) {
            PuPointerEvent event = { .type = PU_POINTER_MOVE, .x = -1, .y = -1, .button = -1 };
            if (w->pointer_fn(&event, w->pointer_user)) pu_window_redraw(w);
        }
        return 0;
    case PU_WM_WAKE:
        pump_windows();
        return 0;

    case WM_ERASEBKGND:
        return 1; /* fully repainted in WM_PAINT; suppress flicker */

    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hwnd, &ps);
        if (w) pu_paint(w, hdc, NULL);
        EndPaint(hwnd, &ps);
        return 0;
    }
    case WM_CLOSE:
        if (w) pu_window_request_close(w);
        return 0;
    case WM_DESTROY:
        if (w) { w->running = 0; w->hwnd = NULL; }
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

static LRESULT CALLBACK pu_wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    PuWindow *w = (PuWindow *)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    if (w) w->borrows++;
    LRESULT result = dispatch_window_message(hwnd, msg, wp, lp);
    if (w) release_close_borrow(w);
    return result;
}

PuWindow *pu_window_create(const PuWindowConfig *cfg)
{
    if (!pu_window_config_valid(cfg)) { fprintf(stderr, "Invalid native window contract\n"); return NULL; }
    if (cfg->layer || cfg->input_popup || cfg->lock_output) {
        fprintf(stderr, "Dedicated Wayland roles are unavailable on this Host\n"); return NULL;
    }
    if (cfg->transparent) {
        fprintf(stderr, "Ordinary per-pixel transparency is unavailable on this Host\n"); return NULL;
    }
    if (g_windows && g_ui_thread != GetCurrentThreadId()) {
        fprintf(stderr, "All windows must be created on the same UI thread\n");
        return NULL;
    }
    if (cfg->parent) {
        PuWindow *parent = g_windows;
        while (parent && parent != cfg->parent) parent = parent->next;
        if (!parent || !parent->running || !parent->hwnd ||
            (parent->closing && !parent->request_active) || (!cfg->popup && parent->popup)) {
            fprintf(stderr, "Parent must be a live compatible window in this Host\n"); return NULL;
        }
    }

    /* Per-monitor DPI awareness: render crisply at physical resolution and do
     * the logical->physical scaling ourselves (see pu_paint). */
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    PuWindow *w = (PuWindow *)calloc(1, sizeof(PuWindow));
    if (!w) return NULL;
    w->borrows = 1;
    w->width  = cfg->width;
    w->height = cfg->height;
    w->running = 1;
    w->parent = cfg->parent; w->popup = cfg->popup; w->modal = cfg->modal; w->limits = cfg->limits;
    if (w->parent) w->parent->children++;
    g_ui_thread = GetCurrentThreadId();

    HINSTANCE hinst = GetModuleHandleW(NULL);

    WNDCLASSEXW wc;
    memset(&wc, 0, sizeof(wc));
    wc.cbSize        = sizeof(wc);
    wc.style         = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;
    wc.lpfnWndProc   = pu_wndproc;
    wc.hInstance     = hinst;
    wc.hCursor       = LoadCursorW(NULL, IDC_ARROW);
    wc.lpszClassName = kClassName;
    RegisterClassExW(&wc); /* harmless if already registered */

    const char *title = cfg->title ? cfg->title : "PollyUI";
    int title_length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, title, -1, NULL, 0);
    wchar_t *wtitle = title_length ? malloc((size_t)title_length * sizeof(*wtitle)) : NULL;
    if (!wtitle || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, title, -1, wtitle, title_length)) {
        fprintf(stderr, "Cannot create UTF-16 window title\n");
        free(wtitle);
        discard_window_creation(w);
        return NULL;
    }

    /* Treat the requested size as LOGICAL pixels; scale to physical for the
     * current system DPI so the window is the intended on-screen size. */
    float s0 = (cfg->parent ? GetDpiForWindow(cfg->parent->hwnd) : GetDpiForSystem()) / 96.0f;
    if (s0 <= 0.0f) s0 = 1.0f;
    w->scale = s0;
    int width = pu_window_clamp(cfg->width, cfg->limits.min_width, cfg->limits.max_width);
    int height = pu_window_clamp(cfg->height, cfg->limits.min_height, cfg->limits.max_height);
    if (cfg->width <= 0 || cfg->height <= 0 ||
        (double)width * s0 > INT_MAX - 256 || (double)height * s0 > INT_MAX - 256 ||
        (double)cfg->limits.min_width * s0 > INT_MAX - 256 ||
        (double)cfg->limits.min_height * s0 > INT_MAX - 256 ||
        (double)cfg->limits.max_width * s0 > INT_MAX - 256 ||
        (double)cfg->limits.max_height * s0 > INT_MAX - 256 ||
        fabs((double)cfg->popup_x * s0) > INT_MAX / 2 ||
        fabs((double)cfg->popup_y * s0) > INT_MAX / 2) {
        fprintf(stderr, "Window dimensions exceed the native coordinate range\n");
        free(wtitle); discard_window_creation(w);
        return NULL;
    }
    RECT rc = { 0, 0, (int)(width * s0), (int)(height * s0) };
    DWORD style = cfg->popup ? WS_POPUP : WS_OVERLAPPEDWINDOW;
    DWORD extended = cfg->popup ? WS_EX_TOOLWINDOW : 0;
    if (cfg->popup == PU_POPUP_TOOLTIP) extended |= WS_EX_NOACTIVATE | WS_EX_TRANSPARENT;
    AdjustWindowRectExForDpi(&rc, style, FALSE, extended, (UINT)(s0 * 96));
    POINT position = { CW_USEDEFAULT, CW_USEDEFAULT };
    if (cfg->popup) {
        position = (POINT){ (LONG)(cfg->popup_x * s0), (LONG)(cfg->popup_y * s0) };
        if (!ClientToScreen(cfg->parent->hwnd, &position)) {
            fprintf(stderr, "Cannot position native popup: %lu\n", GetLastError());
            free(wtitle); discard_window_creation(w); return NULL;
        }
    }

    HWND hwnd = CreateWindowExW(
        extended, kClassName, wtitle, style,
        position.x, position.y,
        rc.right - rc.left, rc.bottom - rc.top,
        cfg->parent ? cfg->parent->hwnd : NULL, NULL, hinst, w);
    free(wtitle);
    if (!hwnd) {
        fprintf(stderr, "Native window creation failed: %lu\n", GetLastError());
        discard_window_creation(w);
        return NULL;
    }
    w->hwnd = hwnd;

    /* Actual DPI scale of the monitor the window opened on. */
    UINT dpi = GetDpiForWindow(hwnd);
    w->scale = dpi > 0 ? dpi / 96.0f : s0;

    /* Size the Skia surface to the actual client area (physical pixels). */
    RECT client;
    GetClientRect(hwnd, &client);
    w->width  = client.right - client.left;
    w->height = client.bottom - client.top;
    /* Prefer a GPU surface; fall back to raster (CPU + blit) if GL is unavailable.
     * The handle is opaque (here an HWND); other host backends pass their own
     * native window handle to the same seam — see docs/PORTING.md §2. */
    w->surface = pu_surface_create_gpu((void *)hwnd, w->width, w->height);
    if (!w->surface)
        w->surface = pu_surface_create(w->width, w->height);
    if (!w->surface) {
        discard_window_creation(w);
        return NULL;
    }

    w->next = g_windows;
    g_windows = w;
    w->registered = 1;
    if (cfg->popup == PU_POPUP_TOOLTIP) EnableWindow(hwnd, FALSE);
    if (w->modal) {
        if (!w->parent->modal_count++) {
            w->parent->modal_restore = IsWindowEnabled(w->parent->hwnd) != 0;
            EnableWindow(w->parent->hwnd, FALSE);
        }
    }
    ShowWindow(hwnd, cfg->popup == PU_POPUP_TOOLTIP ? SW_SHOWNOACTIVATE : SW_SHOW);
    UpdateWindow(hwnd);
    if (!w->running || (w->parent && !w->parent->running)) {
        fprintf(stderr, "Window or owner closed during native creation\n");
        discard_window_creation(w);
        return NULL;
    }
    w->borrows--;
    return w;
}

void pu_window_set_paint(PuWindow *w, PuPaintFn fn, void *user)
{
    if (!w) return;
    w->paint_fn = fn;
    w->paint_user = user;
    if (w->hwnd) InvalidateRect(w->hwnd, NULL, FALSE);
}

void pu_window_set_pointer(PuWindow *w, PuPointerFn fn, void *user)
{
    if (!w) return;
    w->pointer_fn = fn;
    w->pointer_user = user;
}

int pu_window_capture_mouse(PuWindow *w, int enabled)
{
    if (w && !enabled && w->native_retired && !w->hwnd && !w->mouse_capture) return 1;
    if (!w || !w->hwnd || (enabled && !w->running)) {
        fprintf(stderr, "[host] Mouse capture requires a live window\n"); return 0;
    }
    if (enabled && w->popup) { fprintf(stderr, "Explicit native popup capture is unsupported\n"); return 0; }
    if (enabled) {
        if (GetFocus() != w->hwnd) {
            fprintf(stderr, "[host] Mouse capture requires the active window\n"); return 0;
        }
        SetCapture(w->hwnd);
        w->mouse_capture = GetCapture() == w->hwnd;
        if (!w->mouse_capture) fprintf(stderr, "[host] SetCapture failed\n");
        return w->mouse_capture;
    }
    w->mouse_capture = 0;
    if (GetCapture() != w->hwnd) return 1;
    int released = ReleaseCapture() != 0;
    if (!released) fprintf(stderr, "[host] ReleaseCapture failed: %lu\n", GetLastError());
    return released;
}

void pu_window_set_activation(PuWindow *w, PuActivationFn fn, void *user)
{ if (w) { w->activation_fn = fn; w->activation_user = user; } }
int pu_window_is_active(PuWindow *w) { return w && w->running && w->active; }

int pu_window_set_cursor(PuWindow *w, PuCursor cursor)
{
    static const LPCWSTR names[] = { IDC_ARROW, IDC_IBEAM, IDC_CROSS, IDC_HAND,
        IDC_SIZEALL, IDC_SIZEWE, IDC_SIZENS, IDC_SIZENESW, IDC_SIZENWSE, IDC_NO, IDC_WAIT };
    if (!w || !w->running || !w->hwnd || cursor < 0 || cursor >= PU_CURSOR_COUNT) {
        fprintf(stderr, "[host] Invalid cursor or closed window\n"); return 0;
    }
    HCURSOR handle = LoadCursorW(NULL, names[cursor]);
    if (!handle) { fprintf(stderr, "[host] LoadCursor failed: %lu\n", GetLastError()); return 0; }
    w->cursor = handle;
    POINT point;
    RECT client;
    if (w->mouse_capture || (GetCursorPos(&point) && WindowFromPoint(point) == w->hwnd &&
            ScreenToClient(w->hwnd, &point) && GetClientRect(w->hwnd, &client) && PtInRect(&client, point)))
        SetCursor(handle);
    return 1;
}

void pu_window_set_key(PuWindow *w, PuKeyFn fn, void *user)
{
    if (!w) return;
    w->key_fn = fn;
    w->key_user = user;
}

void pu_window_set_wheel(PuWindow *w, PuWheelFn fn, void *user)
{
    if (!w) return;
    w->wheel_fn = fn;
    w->wheel_user = user;
}

void pu_window_set_async(PuWindow *w, PuAsyncFn fn, void *user)
{
    if (!w) return;
    w->async_fn = fn;
    w->async_user = user;
}

void pu_window_set_region(PuWindow *w, PuRegionFn fn, void *user)
{
    if (!w) return;
    w->region_fn = fn;
    w->region_user = user;
}

void pu_window_set_close(PuWindow *w, PuCloseFn fn, void *user)
{ if (w) { w->close_fn = fn; w->close_user = user; } }
void pu_window_set_close_request(PuWindow *w, PuCloseRequestFn fn, void *user)
{ if (w) { w->close_request_fn = fn; w->close_request_user = user; } }
int pu_window_is_open(PuWindow *w) { return w && w->running; }
void pu_window_redraw(PuWindow *w) { if (w && w->running && w->hwnd) InvalidateRect(w->hwnd, NULL, FALSE); }
int pu_window_save_frame(PuWindow *w, const char *path)
{
    if (!w || !w->running || !w->presented || !pu_surface_make_current(w->surface)) {
        fprintf(stderr, "Cannot capture a closed or not-yet-presented window\n");
        return 0;
    }
    HDC dc = GetDC(w->hwnd);
    if (!dc) { fprintf(stderr, "Cannot acquire window capture DC\n"); return 0; }
    int ok = pu_paint(w, dc, path);
    ReleaseDC(w->hwnd, dc);
    return ok;
}

/* Hide/show the OS title bar at runtime. The window keeps WS_THICKFRAME so it
 * stays resizable + snappable; the title bar removal is done by the WM_NCCALCSIZE
 * handler, which we re-trigger via SWP_FRAMECHANGED. */
void pu_window_set_frameless(PuWindow *w, int frameless)
{
    if (!w || !w->hwnd || w->frameless == (frameless ? 1 : 0)) return;
    w->frameless = frameless ? 1 : 0;
    SetWindowPos(w->hwnd, NULL, 0, 0, 0, 0,
                 SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

/* Windows 11 system backdrop (Mica/Acrylic) via DWM. type: 0 auto, 1 none,
 * 2 Mica, 3 Acrylic, 4 Mica Alt. Loaded dynamically to avoid a dwmapi link dep.
 * NOTE: for the backdrop to be *visible* the app must draw with transparency
 * where it should show through (a transparent GPU surface) — see DESIGN notes;
 * this sets the correct DWM attribute regardless. */
void pu_window_set_backdrop(PuWindow *w, int type)
{
    if (!w || !w->hwnd) return;
    typedef long (__stdcall *DwmSetFn)(HWND, unsigned long, const void *, unsigned long);
    static DwmSetFn fn = NULL; static int tried = 0;
    if (!tried) { tried = 1; HMODULE m = LoadLibraryW(L"dwmapi.dll");
        if (m) fn = (DwmSetFn)(void *)GetProcAddress(m, "DwmSetWindowAttribute"); }
    if (fn) { int t = type; fn(w->hwnd, 38 /*DWMWA_SYSTEMBACKDROP_TYPE*/, &t, sizeof(t)); }
}

/* No native overlay title bar on Windows: apps use pu_window_set_frameless and
 * draw their own caption (the WinUI-style — / ▢ / ✕ controls). */
void pu_window_set_titlebar_style(PuWindow *w, int style) { (void)w; (void)style; }

void pu_window_minimize(PuWindow *w)
{
    if (w && w->popup) { fprintf(stderr, "Minimize requires an ordinary window\n"); return; }
    if (w && w->hwnd) ShowWindow(w->hwnd, SW_MINIMIZE);
}
void pu_window_maximize_toggle(PuWindow *w)
{
    if (w && w->popup) { fprintf(stderr, "Maximize requires an ordinary window\n"); return; }
    if (w && w->hwnd) ShowWindow(w->hwnd, IsZoomed(w->hwnd) ? SW_RESTORE : SW_MAXIMIZE);
}
int pu_window_is_maximized(PuWindow *w) { return (w && w->hwnd) ? IsZoomed(w->hwnd) : 0; }

void pu_window_wake(PuWindow *w)
{
    if (w && w->hwnd) PostMessageW(w->hwnd, PU_WM_WAKE, 0, 0);
    else if (g_ui_thread) PostThreadMessageW(g_ui_thread, PU_WM_WAKE, 0, 0);
}

static void notify_closed(void)
{
    for (;;) {
        progress_pending_closes();
        PuWindow *w = g_windows;
        while (w && (w->running || w->close_notified || w->children || w->borrows)) w = w->next;
        if (!w) break;
        if (w->exit_code) { g_exit_code = w->exit_code; notify_dependent_failure(w); }
        w->close_notified = 1;
        w->borrows++;
        retire_native(w);
        if (w->close_fn && !w->destroy_requested) w->close_fn(w, w->close_user);
        release_close_borrow(w);
    }
}

static void pump_windows(void)
{
    if (!g_loop_running || g_pumping) return;
    g_pumping = 1;
    if (g_frame && g_frame(g_frame_user) > 0)
        for (PuWindow *w = g_windows; w; w = w->next) pu_window_redraw(w);
    size_t count;
    PuWindow **windows = borrow_window_snapshot(&count);
    for (size_t i = 0; i < count; i++) {
        PuWindow *w = windows[i];
        if (w->running && w->async_fn && w->async_fn(w->async_user) > 0) pu_window_redraw(w);
    }
    release_window_snapshot(windows, count);
    notify_state();
    notify_closed();
    g_pumping = 0;
}

static VOID CALLBACK frame_timer(HWND hwnd, UINT msg, UINT_PTR id, DWORD time)
{
    (void)hwnd; (void)msg; (void)id; (void)time;
    pump_windows();
}

int pu_window_run(PuWindow *w) { return w ? pu_window_run_all(NULL, NULL) : 1; }

int pu_window_run_all(PuAsyncFn frame, void *user)
{
    if (g_loop_running) { fprintf(stderr, "Cannot run a nested window loop\n"); return 1; }
    UINT_PTR timer = SetTimer(NULL, 0, 16, frame_timer);
    if (!timer) { fprintf(stderr, "Cannot start window frame timer: %lu\n", GetLastError()); return 1; }
    g_loop_running = 1;
    g_exit_code = 0;
    g_frame = frame;
    g_frame_user = user;
    pump_windows();
    for (;;) {
        notify_closed();
        PuWindow *live = g_windows;
        while (live && !live->running) live = live->next;
        if (!live && !g_keep_alive) break;
        MSG msg;
        int result = GetMessageW(&msg, NULL, 0, 0);
        if (result <= 0) {
            if (result < 0) fprintf(stderr, "GetMessage failed: %lu\n", GetLastError());
            g_exit_code = result < 0 ? 1 : (int)msg.wParam;
            break;
        }
        if (msg.message == PU_WM_WAKE && !msg.hwnd) { pump_windows(); continue; }
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    KillTimer(NULL, timer);
    g_loop_running = 0;
    g_frame = NULL;
    g_frame_user = NULL;
    return g_exit_code;
}

static void retire_native(PuWindow *w)
{
    if (w->native_retired) return;
    w->native_retired = 1;
    if (w->mouse_capture) pu_window_capture_mouse(w, 0);
    if (w->cursor && GetCursor() == w->cursor) SetCursor(LoadCursorW(NULL, IDC_ARROW));
    PuWindow *parent = w->parent;
    int restore_focus = w->modal && w->hwnd && GetActiveWindow() == w->hwnd;
    if (w->registered && w->modal && parent && !--parent->modal_count &&
        parent->modal_restore && !parent->destroy_requested && parent->hwnd)
        EnableWindow(parent->hwnd, TRUE);
    w->parent = NULL;
    PuSurface *surface = w->surface;
    w->surface = NULL;
    pu_surface_destroy(surface);
    if (w->hwnd) DestroyWindow(w->hwnd);
    if (restore_focus && parent && parent->running && parent->hwnd &&
        !parent->destroy_requested && !parent->modal_count && IsWindowEnabled(parent->hwnd)) {
        SetActiveWindow(parent->hwnd);
        SetFocus(parent->hwnd);
    }
    if (parent && !--parent->children && parent->destroy_requested && !parent->borrows)
        pu_window_destroy(parent);
}

void pu_window_destroy(PuWindow *w)
{
    if (!w || w->destroying) return;
    w->destroying = 1;
    w->destroy_requested = 1;
    w->running = 0;
    w->close_notified = 1;
    w->paint_fn = NULL; w->key_fn = NULL; w->wheel_fn = NULL;
    w->async_fn = NULL; w->region_fn = NULL; w->state_fn = NULL;
    w->close_fn = NULL; w->close_request_fn = NULL;
    w->pointer_fn = NULL; w->activation_fn = NULL;
    if (w->mouse_capture) pu_window_capture_mouse(w, 0);
    if (w->cursor && GetCursor() == w->cursor) SetCursor(LoadCursorW(NULL, IDC_ARROW));
    /* Never let DestroyWindow implicitly destroy another live PuWindow. */
    if (w->children || w->borrows) { w->destroying = 0; return; }
    retire_native(w);
    w->running = 0;
    if (w->registered) {
        PuWindow **link = &g_windows;
        while (*link && *link != w) link = &(*link)->next;
        if (*link) *link = w->next;
    }
    free(w);
}
