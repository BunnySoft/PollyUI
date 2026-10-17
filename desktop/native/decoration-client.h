#ifndef POLLYUI_DECORATION_CLIENT_H
#define POLLYUI_DECORATION_CLIENT_H
#include "quickjs.h"
#include <stdbool.h>
#include <wayland-client.h>
#include "polly-appearance-client.h"
extern const struct polly_appearance_v1_listener pu_decoration_client_listener;
int pu_decoration_client_install(JSContext *ctx, JSValueConst api);
int pu_decoration_renderer_install(JSContext *ctx, JSValueConst api);
void pu_decoration_client_attach(struct polly_appearance_v1 *appearance, struct wl_display *display,
    int (*roundtrip)(struct wl_display *display));
uint32_t pu_decoration_client_status(bool *bootstrap, const char **message);
int pu_decoration_client_pump(void);
bool pu_decoration_client_pending(void);
void pu_decoration_client_cancel_requests(void);
void pu_decoration_client_disconnect(void);
void pu_decoration_client_shutdown(void);
JSValue pu_decoration_client_configure(JSContext *ctx, int argc, JSValueConst *argv,
    struct polly_appearance_v1 *appearance, struct wl_display *display);
JSValue pu_decoration_client_backdrop_capability(JSContext *ctx,
    struct polly_appearance_v1 *appearance, struct wl_display *display);
JSValue pu_decoration_client_shell_backdrop_capability(JSContext *ctx,
    struct polly_appearance_v1 *appearance, struct wl_display *display);
JSValue pu_decoration_client_start_backdrop_capability(JSContext *ctx,
    struct polly_appearance_v1 *appearance, struct wl_display *display);
#endif
