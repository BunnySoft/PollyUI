#ifndef POLLYUI_LAYER_SHELL_H
#define POLLYUI_LAYER_SHELL_H

#include "pollyui/window.h"
#include <SDL3/SDL.h>

typedef struct PuLayer PuLayer;
struct wl_surface;
struct wl_output;
struct ext_session_lock_surface_v1;
struct zwp_input_popup_surface_v2;
typedef struct ext_session_lock_surface_v1 *(*PuLockSurfaceFn)(
    struct wl_surface *surface, struct wl_output *output);
typedef struct zwp_input_popup_surface_v2 *(*PuInputPopupFn)(struct wl_surface *surface);
/* Composition-root hooks; factories still enforce their dedicated connection. */
void pu_layer_set_role_factories(PuLockSurfaceFn lock_surface, PuInputPopupFn input_popup);
PuLayer *pu_layer_prepare(PuWindow *owner, int input_popup);
struct wl_surface *pu_layer_surface(PuLayer *layer);
int pu_layer_attach(PuLayer *layer, SDL_Window *window, const PuWindowConfig *config);
void pu_layer_unmap(PuLayer *layer);
void pu_layer_destroy(PuLayer *layer);
void pu_sdl_layer_failed(PuWindow *owner, const char *operation);

#endif
