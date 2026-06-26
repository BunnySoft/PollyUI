#include "host/win32/window.h"

#include <windows.h>
#include <stdlib.h>
#include <string.h>

/* M0a: the window paints a flat clear color with GDI. In M0b this WM_PAINT
 * handler is replaced by a blit of a Skia raster surface (DESIGN.md §11). */

struct PuWindow {
    HWND     hwnd;
    COLORREF clear;          /* background clear color */
    int      width;
    int      height;
};

static const wchar_t *kClassName = L"PollyUIWindowClass";

static LRESULT CALLBACK pu_wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    PuWindow *w = (PuWindow *)GetWindowLongPtrW(hwnd, GWLP_USERDATA);

    switch (msg) {
    case WM_NCCREATE: {
        /* Stash the PuWindow* we passed to CreateWindowExW. */
        CREATESTRUCTW *cs = (CREATESTRUCTW *)lp;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)cs->lpCreateParams);
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
    case WM_SIZE:
        if (w) { w->width = LOWORD(lp); w->height = HIWORD(lp); }
        return 0;

    case WM_ERASEBKGND:
        /* We fully repaint in WM_PAINT; suppress default erase to avoid flicker. */
        return 1;

    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hwnd, &ps);
        RECT rc;
        GetClientRect(hwnd, &rc);
        HBRUSH brush = CreateSolidBrush(w ? w->clear : RGB(0, 0, 0));
        FillRect(hdc, &rc, brush);
        DeleteObject(brush);
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
    w->clear  = RGB(0x3b, 0x82, 0xf6); /* PollyUI blue (#3b82f6) */
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

    /* Grow the window so the *client* area matches the requested size. */
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
    if (w->hwnd) DestroyWindow(w->hwnd);
    free(w);
}
