#ifndef PU_WIN32_TEST_WINDOW_H
#define PU_WIN32_TEST_WINDOW_H
#include <windows.h>
#include <string.h>
struct PuTestWindowLookup { const char *title; HWND window; };
static BOOL CALLBACK pu_test_window_lookup(HWND window, LPARAM data)
{
    struct PuTestWindowLookup *lookup = (struct PuTestWindowLookup *)data;
    DWORD pid;
    char title[160], name[80];
    GetWindowThreadProcessId(window, &pid);
    if (pid == GetCurrentProcessId() && GetClassNameA(window, name, sizeof(name)) &&
        !strcmp(name, "PollyUIWindowClass") && GetWindowTextA(window, title, sizeof(title)) &&
        !strcmp(title, lookup->title)) { lookup->window = window; return FALSE; }
    return TRUE;
}
static HWND pu_test_find_window(const char *title)
{
    struct PuTestWindowLookup lookup = { title, NULL };
    EnumWindows(pu_test_window_lookup, (LPARAM)&lookup);
    return lookup.window;
}
#endif
