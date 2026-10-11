#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "pollyui/window.h"
#include <stdio.h>
#include <string.h>

static int failed, capture_lost, focus_lost, activations;
static PuWindow *first;

static void check(int valid, const char *name)
{
    if (!valid) { fprintf(stderr, "FAIL: %s\n", name); failed = 1; }
    else printf("PASS: %s\n", name);
}
static int pointer(const PuPointerEvent *event, void *user)
{
    (void)user;
    if (event->type == PU_POINTER_CANCEL) {
        if (!strcmp(event->reason, "capture-lost")) capture_lost++;
        if (!strcmp(event->reason, "focus-lost")) focus_lost++;
    }
    return 0;
}
static int activation(int active, void *user)
{
    (void)user;
    check(pu_window_is_active(first) == active, "native activation query matches callback");
    activations++;
    return 0;
}
int main(void)
{
    char title[96], second_title[96];
    snprintf(title, sizeof(title), "PollyUI mouse fixture %lu", GetCurrentProcessId());
    snprintf(second_title, sizeof(second_title), "PollyUI mouse peer %lu", GetCurrentProcessId());
    PuWindowConfig config = { .title = title, .width = 240, .height = 160 };
    first = pu_window_create(&config);
    config.title = second_title;
    PuWindow *second = pu_window_create(&config);
    if (!first || !second) return 1;
    HWND hwnd = FindWindowA(NULL, title), peer = FindWindowA(NULL, second_title);
    check(hwnd && peer, "fixture windows have distinct native handles");
    if (!hwnd || !peer) return 1;
    pu_window_set_pointer(first, pointer, NULL);
    pu_window_set_activation(first, activation, NULL);
    SetFocus(hwnd);
    check(pu_window_is_active(first), "thread-local native window focus is observed");
    check(pu_window_capture_mouse(first, 1) && GetCapture() == hwnd, "SetCapture owns the native handle");
    SetCapture(peer);
    check(capture_lost == 1, "capture stolen by a peer produces exactly one cancellation");
    check(pu_window_capture_mouse(first, 0) && GetCapture() == peer, "release cannot steal another window's capture");
    ReleaseCapture();
    check(pu_window_capture_mouse(first, 1), "capture can be acquired again");
    check(pu_window_capture_mouse(first, 0) && GetCapture() == NULL, "explicit release relinquishes native capture");
    check(capture_lost == 1, "intentional release is not an external capture-loss cancellation");
    static const LPCWSTR names[] = { IDC_ARROW, IDC_IBEAM, IDC_CROSS, IDC_HAND,
        IDC_SIZEALL, IDC_SIZEWE, IDC_SIZENS, IDC_SIZENESW, IDC_SIZENWSE, IDC_NO, IDC_WAIT };
    for (int i = 0; i < PU_CURSOR_COUNT; i++) {
        check(pu_window_set_cursor(first, (PuCursor)i), "native system cursor loads");
        SendMessageW(hwnd, WM_SETCURSOR, (WPARAM)hwnd, MAKELPARAM(HTCLIENT, WM_MOUSEMOVE));
        check(GetCursor() == LoadCursorW(NULL, names[i]), "client cursor message restores the selected native shape");
    }
    pu_window_set_cursor(first, PU_CURSOR_ARROW);
    check(!pu_window_set_cursor(first, PU_CURSOR_COUNT), "invalid native cursor is rejected");
    check(pu_window_capture_mouse(first, 1), "capture is active before focus loss");
    int prior_focus_lost = focus_lost;
    SetFocus(NULL);
    check(focus_lost == prior_focus_lost + 1 && !pu_window_is_active(first) && GetCapture() == NULL,
        "native focus loss cancels and releases capture");
    check(!pu_window_capture_mouse(first, 1), "inactive window capture fails explicitly");
    check(activations >= 2, "activation and deactivation are delivered");
    pu_window_close(first);
    check(!pu_window_set_cursor(first, PU_CURSOR_ARROW), "closed window cursor is rejected");
    pu_window_destroy(first); pu_window_destroy(second);
    pu_window_system_shutdown();
    return failed;
}
