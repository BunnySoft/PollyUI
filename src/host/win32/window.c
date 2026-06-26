#include "host/win32/window.h"
#include "render/skia_c.h"

#include <windows.h>
#include <stdlib.h>
#include <string.h>

/* M0b: the window now paints by clearing a Skia raster surface and blitting its
 * BGRA pixels to the client area (replacing the M0a GDI FillRect). The host
 * touches Skia only through the extern "C" API in render/skia_c.h. */

struct PuWindow {
    HWND       hwnd;
    PuSurface *surface;      /* Skia raster surface, sized to the client area */
    int        width;
    int        height;
};

static const wchar_t *kClassName = L"PollyUIWindowClass";

/* Render one frame into the Skia surface and blit it to hdc. */
static void pu_paint(PuWindow *w, HDC hdc)
{
    if (!w->surface) return;

    /* Clear to a dark slate, then draw a PollyUI-blue card — proves both
     * SkCanvas::clear and drawRect through the shim. */
    pu_surface_clear(w->surface, 0x10, 0x12, 0x18, 0xFF);
    float cw = (float)w->width, ch = (float)w->height;
    float rw = 320.0f, rh = 200.0f;
    pu_surface_fill_rect(w->surface, (cw - rw) * 0.5f, (ch - rh) * 0.5f, rw, rh,
                         0x3b, 0x82, 0xf6, 0xFF);

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
    case WM_SIZE:
        if (w) {
            w->width  = LOWORD(lp);
            w->height = HIWORD(lp);
            pu_surface_resize(w->surface, w->width, w->height);
            InvalidateRect(hwnd, NULL, FALSE);
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

    RECT rc = { 0, 0, cfg->width, cfg->height };
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

    /* Size the Skia surface to the actual client area. */
    RECT client;
    GetClientRect(hwnd, &client);
    w->width  = client.right - client.left;
    w->height = client.bottom - client.top;
    w->surface = pu_surface_create(w->width, w->height);
    if (!w->surface) {
        DestroyWindow(hwnd);
        free(w);
        return NULL;
    }

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);
    return w;
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
