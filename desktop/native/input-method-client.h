#ifndef POLLY_INPUT_METHOD_CLIENT_H
#define POLLY_INPUT_METHOD_CLIENT_H
#include "quickjs.h"
struct wl_surface;
struct zwp_input_popup_surface_v2;
int pu_input_client_install(JSContext *ctx);
int pu_input_client_pump(void);
void pu_input_client_shutdown(void);
struct zwp_input_popup_surface_v2 *pu_input_client_popup(struct wl_surface *surface);
#endif
