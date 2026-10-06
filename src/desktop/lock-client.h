#ifndef POLLYUI_LOCK_CLIENT_H
#define POLLYUI_LOCK_CLIENT_H
#include "quickjs.h"
struct wl_surface;
struct wl_output;
struct ext_session_lock_surface_v1;
int pu_lock_client_install(JSContext *ctx);
int pu_lock_client_pump(void);
void pu_lock_client_shutdown(void);
struct ext_session_lock_surface_v1 *pu_lock_client_surface(struct wl_surface *surface, struct wl_output *output);
#endif
