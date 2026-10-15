#ifndef POLLYUI_DECORATION_CLIENT_H
#define POLLYUI_DECORATION_CLIENT_H
#include "quickjs.h"
#include <wayland-client.h>
#include "polly-appearance-client.h"
extern const struct polly_appearance_v1_listener pu_decoration_client_listener;
int pu_decoration_client_install(JSContext *ctx, JSValueConst api);
int pu_decoration_client_pump(void);
void pu_decoration_client_disconnect(void);
void pu_decoration_client_shutdown(void);
JSValue pu_decoration_client_configure(JSContext *ctx, int argc, JSValueConst *argv,
    struct polly_appearance_v1 *appearance, struct wl_display *display);
#endif
