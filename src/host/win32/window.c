#include "host/window.h"
#include "host/startup.h"
#include "render/skia_c.h"

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

/* M0b: the window now paints by clearing a Skia raster surface and blitting its
 * BGRA pixels to the client area (replacing the M0a GDI FillRect). The host
 * touches Skia only through the extern "C" API in render/skia_c.h. */

#ifndef DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
#define DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 ((DPI_AWARENESS_CONTEXT)-4)
#endif

struct PuWindow {
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
    PuWheelFn   wheel_fn;     /* optional wheel callback */
    void       *wheel_user;
    PuAsyncFn   async_fn;     /* optional async pump callback */
    void       *async_user;
    int         frameless;    /* 1 = OS title bar hidden, app draws its own */
    PuRegionFn  region_fn;    /* hit-region query for the custom title bar drag area */
    void       *region_user;
};

#define PU_WM_WAKE (WM_APP + 1)   /* posted by pu_window_wake */
#define PU_FRAME_TIMER 1          /* periodic async/timer pump */

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
    default:        return NULL;
    }
}

static const wchar_t *kClassName = L"PollyUIWindowClass";

/* Render one frame into the Skia surface and blit it to hdc. */
static void pu_paint(PuWindow *w, HDC hdc)
{
    if (!w->surface) return;

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
        return;
    }

    /* Raster fallback: blit the pixel buffer to the window. */
    const void *pixels = pu_surface_pixels(w->surface);
    int sw = pu_surface_width(w->surface);
    int sh = pu_surface_height(w->surface);
    if (!pixels || sw <= 0 || sh <= 0) return;

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
}

static LRESULT CALLBACK pu_wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    PuWindow *w = (PuWindow *)GetWindowLongPtrW(hwnd, GWLP_USERDATA);

    switch (msg) {
    case WM_NCCREATE: {
        CREATESTRUCTW *cs = (CREATESTRUCTW *)lp;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)cs->lpCreateParams);
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
    case WM_GETMINMAXINFO: {
        /* keep a sane minimum so layout doesn't collapse at tiny sizes */
        MINMAXINFO *mmi = (MINMAXINFO *)lp;
        float sc = (w && w->scale > 0) ? w->scale : 1.0f;
        mmi->ptMinTrackSize.x = (LONG)(360 * sc);
        mmi->ptMinTrackSize.y = (LONG)(280 * sc);
        return 0;
    }

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
    case WM_MOUSEMOVE:
        if (w && w->pointer_fn) {
            float scale = w->scale > 0 ? w->scale : 1.0f;
            int x = (int)((short)LOWORD(lp) / scale); /* physical -> logical */
            int y = (int)((short)HIWORD(lp) / scale);
            int changed = 0;
            if (msg == WM_LBUTTONDOWN) {
                changed = w->pointer_fn(x, y, PU_POINTER_DOWN, w->pointer_user);
            } else if (msg == WM_MOUSEMOVE) {
                changed = w->pointer_fn(x, y, PU_POINTER_MOVE, w->pointer_user);
            } else { /* WM_LBUTTONUP: up then click */
                changed  = w->pointer_fn(x, y, PU_POINTER_UP, w->pointer_user);
                changed |= w->pointer_fn(x, y, PU_POINTER_CLICK, w->pointer_user);
            }
            /* Repaint only when the handler actually changed the DOM, and do it
             * SYNCHRONOUSLY (UpdateWindow) so feedback isn't deferred behind
             * queued input. This kills the per-mousemove repaint storm: a hover
             * that changes nothing now costs ~0 instead of a full ~5ms
             * relayout+repaint, and a click paints immediately. */
            if (changed) { InvalidateRect(hwnd, NULL, FALSE); UpdateWindow(hwnd); }
        }
        return 0;

    case WM_MOUSEWHEEL:
        if (w && w->wheel_fn) {
            float scale = w->scale > 0 ? w->scale : 1.0f;
            POINT pt = { (short)LOWORD(lp), (short)HIWORD(lp) }; /* screen coords */
            ScreenToClient(hwnd, &pt);
            int notches = GET_WHEEL_DELTA_WPARAM(wp) / WHEEL_DELTA; /* +1 = wheel up */
            float dy = -(float)notches * 40.0f;                    /* up -> scroll content up */
            int changed = w->wheel_fn((int)(pt.x / scale), (int)(pt.y / scale), dy, w->wheel_user);
            if (changed) { InvalidateRect(hwnd, NULL, FALSE); UpdateWindow(hwnd); }
        }
        return 0;

    case WM_DPICHANGED:
        if (w) {
            w->scale = LOWORD(wp) / 96.0f; /* new DPI in wParam */
            RECT *rc = (RECT *)lp;         /* OS-suggested window rect */
            SetWindowPos(hwnd, NULL, rc->left, rc->top,
                         rc->right - rc->left, rc->bottom - rc->top,
                         SWP_NOZORDER | SWP_NOACTIVATE);
            InvalidateRect(hwnd, NULL, FALSE);
        }
        return 0;

    case WM_KEYDOWN: {
        const char *name = pu_vk_name(wp);
        if (w && w->key_fn && name) {
            if (w->key_fn(name, 1, w->key_user)) { InvalidateRect(hwnd, NULL, FALSE); UpdateWindow(hwnd); }
            return 0;
        }
        break; /* character keys -> WM_CHAR via TranslateMessage */
    }

    case WM_KEYUP: {
        const char *name = pu_vk_name(wp);
        if (w && w->key_fn && name) {
            if (w->key_fn(name, 0, w->key_user)) { InvalidateRect(hwnd, NULL, FALSE); UpdateWindow(hwnd); }
        }
        return 0;
    }

    case WM_CHAR:
        if (w && w->key_fn) {
            wchar_t c = (wchar_t)wp;
            if (c >= 0x20 && c != 0x7F) { /* printable; control keys come via WM_KEYDOWN */
                char utf8[8] = { 0 };
                WideCharToMultiByte(CP_UTF8, 0, &c, 1, utf8, sizeof(utf8) - 1, NULL, NULL);
                if (w->key_fn(utf8, 1, w->key_user)) { InvalidateRect(hwnd, NULL, FALSE); UpdateWindow(hwnd); }
            }
        }
        return 0;

    case PU_WM_WAKE:
    case WM_TIMER:
        if (w && w->async_fn) {
            int worked = w->async_fn(w->async_user);
            if (worked > 0) InvalidateRect(hwnd, NULL, FALSE);
        }
        return 0;

    case WM_ERASEBKGND:
        return 1; /* fully repainted in WM_PAINT; suppress flicker */

    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hwnd, &ps);
        if (w) pu_paint(w, hdc);
        EndPaint(hwnd, &ps);
        return 0;
    }
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

PuWindow *pu_window_create(const PuWindowConfig *cfg)
{
    if (!cfg) return NULL;
    fprintf(stderr, "[host] requested backend=%s renderer=%s\n",
            pu_backend_name(cfg->backend), pu_renderer_name(cfg->renderer));
    if (cfg->backend != PU_BACKEND_AUTO) {
        fprintf(stderr, "[host] fatal: backend '%s' requires the SDL host\n",
                pu_backend_name(cfg->backend));
        return NULL;
    }

    /* Per-monitor DPI awareness: render crisply at physical resolution and do
     * the logical->physical scaling ourselves (see pu_paint). */
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    PuWindow *w = (PuWindow *)calloc(1, sizeof(PuWindow));
    if (!w) return NULL;
    w->width  = cfg->width;
    w->height = cfg->height;

    HINSTANCE hinst = GetModuleHandleW(NULL);

    WNDCLASSEXW wc;
    memset(&wc, 0, sizeof(wc));
    wc.cbSize        = sizeof(wc);
    wc.style         = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc   = pu_wndproc;
    wc.hInstance     = hinst;
    wc.hCursor       = LoadCursorW(NULL, IDC_ARROW);
    wc.lpszClassName = kClassName;
    RegisterClassExW(&wc); /* harmless if already registered */

    wchar_t wtitle[256];
    const char *title = cfg->title ? cfg->title : "PollyUI";
    if (MultiByteToWideChar(CP_UTF8, 0, title, -1, wtitle, 256) == 0)
        wcscpy_s(wtitle, 256, L"PollyUI");

    /* Treat the requested size as LOGICAL pixels; scale to physical for the
     * current system DPI so the window is the intended on-screen size. */
    float s0 = GetDpiForSystem() / 96.0f;
    if (s0 <= 0.0f) s0 = 1.0f;
    RECT rc = { 0, 0, (int)(cfg->width * s0), (int)(cfg->height * s0) };
    DWORD style = WS_OVERLAPPEDWINDOW;
    AdjustWindowRect(&rc, style, FALSE);

    HWND hwnd = CreateWindowExW(
        0, kClassName, wtitle, style,
        CW_USEDEFAULT, CW_USEDEFAULT,
        rc.right - rc.left, rc.bottom - rc.top,
        NULL, NULL, hinst, w);
    if (!hwnd) {
        free(w);
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
    if (cfg->renderer != PU_RENDERER_RASTER)
        w->surface = pu_surface_create_gpu((void *)hwnd, w->width, w->height);
    if (!w->surface && cfg->renderer == PU_RENDERER_GL) {
        fprintf(stderr, "[host] fatal: requested renderer 'gl' could not initialize\n");
        DestroyWindow(hwnd);
        free(w);
        return NULL;
    }
    if (!w->surface)
        w->surface = pu_surface_create(w->width, w->height);
    if (!w->surface) {
        DestroyWindow(hwnd);
        free(w);
        return NULL;
    }
    fprintf(stderr, "[host] selected backend=win32 renderer=%s\n",
            pu_surface_is_gl(w->surface) ? "gl" : "raster");

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);
    SetTimer(hwnd, PU_FRAME_TIMER, 16, NULL); /* ~60Hz async/timer pump */
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

void pu_window_minimize(PuWindow *w) { if (w && w->hwnd) ShowWindow(w->hwnd, SW_MINIMIZE); }
void pu_window_close(PuWindow *w)    { if (w && w->hwnd) PostMessageW(w->hwnd, WM_CLOSE, 0, 0); }
void pu_window_maximize_toggle(PuWindow *w)
{
    if (w && w->hwnd) ShowWindow(w->hwnd, IsZoomed(w->hwnd) ? SW_RESTORE : SW_MAXIMIZE);
}
int pu_window_is_maximized(PuWindow *w) { return (w && w->hwnd) ? IsZoomed(w->hwnd) : 0; }

void pu_window_wake(PuWindow *w)
{
    if (w && w->hwnd) PostMessageW(w->hwnd, PU_WM_WAKE, 0, 0);
}

int pu_window_run(PuWindow *w)
{
    (void)w;
    MSG msg;
    memset(&msg, 0, sizeof(msg));
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return (int)msg.wParam;
}

void pu_window_destroy(PuWindow *w)
{
    if (!w) return;
    if (w->surface) pu_surface_destroy(w->surface);
    if (w->hwnd) DestroyWindow(w->hwnd);
    free(w);
}
