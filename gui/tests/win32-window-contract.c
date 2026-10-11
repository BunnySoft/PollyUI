#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include "pollyui/window.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "win32-test-window.h"

static int failed, states, closes, requests;
static PuWindow *sized, *modal, *popup;
static int creation_cancelled;

static void check(int valid, const char *message)
{
    printf("%s: %s\n", valid ? "PASS" : "FAIL", message);
    if (!valid) failed = 1;
}
static HWND handle(const char *title) { return pu_test_find_window(title); }
static void state(const PuWindowState *value, void *user)
{
    PuWindowState actual;
    check(pu_window_get_state(user, &actual) && !memcmp(value, &actual, sizeof(actual)),
        "state notification agrees with native client query");
    states++;
}
static int request(PuWindow *window, void *user)
{ (void)window; (void)user; return ++requests > 1; }
static void closed(PuWindow *window, void *user)
{ (void)user; closes++; pu_window_destroy(window); popup = NULL; }
static int frame(void *user)
{
    (void)user;
    if (states) { pu_window_close(sized); pu_window_close(popup); }
    return 0;
}
static int cancel_creation(int active, void *user)
{
    if (!active && !creation_cancelled++) pu_window_destroy(user);
    return 0;
}
int main(void)
{
    PuWindowConfig config = { .title = "Contract Win32 owner", .width = 300, .height = 220 };
    PuWindow *owner = pu_window_create(&config);
    check(owner != NULL, "ordinary owner created");
    if (!owner) return 1;
    HWND hwnd = handle(config.title);
    PuWindowState ordinary;
    check(pu_window_get_state(owner, &ordinary) && ordinary.width == 300 && ordinary.height == 220,
        "ordinary windows have no forced PollyUI minimum size");
    PuWindowConfig owned_config = config;
    owned_config.title = "Contract Win32 owned"; owned_config.parent = owner;
    PuWindow *owned = pu_window_create(&owned_config);
    check(owned && GetWindow(handle(owned_config.title), GW_OWNER) == hwnd && IsWindowEnabled(hwnd) &&
        !(GetWindowLongPtrW(handle(owned_config.title), GWL_STYLE) & WS_CHILD),
        "ordinary ownership is a native toplevel owner relation, not modality or embedding");
    pu_window_destroy(owned);
    PuWindowConfig rollback_config = { .title = "Contract rollback owner", .width = 240, .height = 160 };
    PuWindow *rollback_owner = pu_window_create(&rollback_config);
    HWND rollback_hwnd = handle(rollback_config.title);
    check(rollback_owner != NULL, "creation reentrancy fixture owner exists");
    SetFocus(rollback_hwnd);
    pu_window_set_activation(rollback_owner, cancel_creation, rollback_owner);
    rollback_config.title = "Contract rollback child"; rollback_config.parent = rollback_owner;
    rollback_config.modal = 1;
    PuWindow *rollback_child = pu_window_create(&rollback_config);
    check(creation_cancelled == 1 && !rollback_child && !IsWindow(rollback_hwnd),
        "owner teardown from native focus callback safely rolls back child creation and releases retained owner");
    if (rollback_child) pu_window_destroy(rollback_child);
    PuWindowConfig invalid = config;
    invalid.parent = (PuWindow *)&invalid;
    check(!pu_window_create(&invalid), "foreign C parent pointers are rejected before dereference");
    config.title = "Contract Win32 sized"; config.width = 80; config.height = 80;
    config.limits = (PuWindowLimits){ 200, 140, 420, 300 };
    sized = pu_window_create(&config);
    check(sized != NULL, "opt-in constrained native window created");
    if (!sized) return 1;
    HWND resize = handle(config.title);
    PuWindowState actual;
    check(pu_window_get_state(sized, &actual) && actual.width >= 200 && actual.width <= 420 &&
        actual.height >= 140 && actual.height <= 300, "initial client is clamped in logical pixels");
    printf("NATIVE: Win32 client logical=%dx%d pixel=%dx%d scale=%.3f\n",
        actual.width, actual.height, actual.pixel_width, actual.pixel_height, actual.scale);
    MINMAXINFO limits = {0};
    SendMessageW(resize, WM_GETMINMAXINFO, 0, (LPARAM)&limits);
    RECT outer, client;
    GetWindowRect(resize, &outer); GetClientRect(resize, &client);
    int frame_width = outer.right - outer.left - client.right;
    int frame_height = outer.bottom - outer.top - client.bottom;
    check(limits.ptMinTrackSize.x == (int)ceil(200 * actual.scale) + frame_width &&
        limits.ptMinTrackSize.y == (int)ceil(140 * actual.scale) + frame_height &&
        limits.ptMaxTrackSize.x == (int)floor(420 * actual.scale) + frame_width &&
        limits.ptMaxTrackSize.y == (int)floor(300 * actual.scale) + frame_height,
        "WM_GETMINMAXINFO applies logical client limits plus native DPI frame");
    ShowWindow(resize, SW_MAXIMIZE);
    check(pu_window_get_state(sized, &actual) && actual.maximized &&
        actual.width <= 420 && actual.height <= 300, "native maximize respects opt-in client maximum");
    ShowWindow(resize, SW_RESTORE);
    pu_window_set_frameless(sized, 1);
    memset(&limits, 0, sizeof(limits));
    SendMessageW(resize, WM_GETMINMAXINFO, 0, (LPARAM)&limits);
    GetWindowRect(resize, &outer); GetClientRect(resize, &client);
    check(limits.ptMinTrackSize.y == (int)ceil(140 * actual.scale) +
        outer.bottom - outer.top - client.bottom,
        "frameless limits include only the actual native nonclient frame");
    pu_window_set_frameless(sized, 0);
    pu_window_set_state(sized, state, sized);
    config = (PuWindowConfig){ .title = "Contract Win32 modal", .width = 260, .height = 180,
        .parent = owner, .modal = 1 };
    modal = pu_window_create(&config);
    SetActiveWindow(handle(config.title)); SetFocus(handle(config.title));
    check(modal && GetWindow(handle(config.title), GW_OWNER) == hwnd && !IsWindowEnabled(hwnd),
        "modal is a native owned HWND and disables only its parent");
    printf("NATIVE: owner=%p modal=%p GW_OWNER=%p owner-enabled=%d peer-enabled=%d\n",
        (void *)hwnd, (void *)handle(config.title), (void *)GetWindow(handle(config.title), GW_OWNER),
        IsWindowEnabled(hwnd), IsWindowEnabled(resize));
    check(IsWindowEnabled(resize), "unrelated native window remains enabled");
    pu_window_set_close_request(modal, request, NULL);
    SendMessageW(handle(config.title), WM_CLOSE, 0, 0);
    check(pu_window_is_open(modal) && requests == 1 && !IsWindowEnabled(hwnd),
        "vetoed native modal close preserves input blocking");
    SendMessageW(handle(config.title), WM_CLOSE, 0, 0);
    check(!pu_window_is_open(modal) && requests == 2, "accepted native close is observed");
    pu_window_destroy(modal); modal = NULL;
    check(IsWindowEnabled(hwnd) && IsWindow(hwnd), "modal teardown restores live owner input");
    check(GetFocus() == hwnd, "closing the active native modal restores keyboard focus to its owner");
    config = (PuWindowConfig){ .title = "Contract Win32 popup", .width = 120, .height = 70,
        .parent = owner, .popup = PU_POPUP_MENU, .popup_x = 30, .popup_y = 40 };
    popup = pu_window_create(&config);
    HWND native_popup = handle(config.title);
    check(popup && GetWindow(native_popup, GW_OWNER) == hwnd &&
        (GetWindowLongPtrW(native_popup, GWL_STYLE) & WS_POPUP) &&
        !(GetWindowLongPtrW(native_popup, GWL_STYLE) & WS_CHILD), "popup has a real native owned popup role");
    check(!pu_window_capture_mouse(popup, 1), "native popup cannot acquire an explicit input grab");
    PuWindowConfig tooltip_config = config;
    tooltip_config.title = "Contract Win32 tooltip"; tooltip_config.popup = PU_POPUP_TOOLTIP;
    PuWindow *tooltip = pu_window_create(&tooltip_config);
    HWND native_tooltip = handle(tooltip_config.title);
    check(tooltip && !IsWindowEnabled(native_tooltip) &&
        (GetWindowLongPtrW(native_tooltip, GWL_EXSTYLE) & WS_EX_NOACTIVATE) &&
        SendMessageW(native_tooltip, WM_NCHITTEST, 0, 0) == HTTRANSPARENT,
        "native tooltip cannot receive input or activation");
    pu_window_destroy(tooltip);
    POINT origin = {0}; ClientToScreen(hwnd, &origin); GetWindowRect(native_popup, &outer);
    check(outer.left == origin.x + (int)(30 * GetDpiForWindow(hwnd) / 96.0f) &&
        outer.top == origin.y + (int)(40 * GetDpiForWindow(hwnd) / 96.0f),
        "popup uses logical parent-client coordinates");
    pu_window_set_close_request(popup, request, NULL);
    pu_window_set_close(popup, closed, NULL);
    SetActiveWindow(resize);
    check(!pu_window_is_open(popup) && requests == 2, "native popup deactivation dismisses without business veto");
    pu_window_close(owner);
    int result = pu_window_run_all(frame, NULL);
    check(!result && states && closes == 1 && !popup, "safe-boundary state and one-shot popup close delivered");
    pu_window_destroy(sized); pu_window_destroy(owner);
    pu_window_system_shutdown();
    return failed;
}
