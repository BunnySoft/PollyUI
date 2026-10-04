#ifndef POLLYUI_OUTPUT_CLIENT_H
#define POLLYUI_OUTPUT_CLIENT_H
#include "quickjs.h"
#include <stdint.h>
struct wl_display;
struct wl_registry;
int pu_output_client_install(JSContext *ctx, JSValueConst api);
int pu_output_client_bind(struct wl_display *display, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version);
int pu_output_client_pump(void);
void pu_output_client_shutdown(void);
#endif
