#ifndef POLLYUI_DESKTOP_WINDOWS_H
#define POLLYUI_DESKTOP_WINDOWS_H
#include "quickjs.h"

int pu_desktop_windows_install(JSContext *ctx, JSValueConst api);
int pu_desktop_windows_pump(void);
void pu_desktop_windows_shutdown(void);
int pu_desktop_windows_ready(JSContext *ctx);
int pu_desktop_windows_roundtrip(void);
struct wl_display;
int pu_desktop_wayland_roundtrip(struct wl_display *display);

#endif
