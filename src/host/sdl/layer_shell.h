#ifndef POLLYUI_LAYER_SHELL_H
#define POLLYUI_LAYER_SHELL_H

#include "host/win32/window.h"
#include <SDL3/SDL.h>

typedef struct PuLayer PuLayer;
struct wl_surface;
PuLayer *pu_layer_prepare(PuWindow *owner);
struct wl_surface *pu_layer_surface(PuLayer *layer);
int pu_layer_attach(PuLayer *layer, SDL_Window *window, const PuWindowConfig *config);
void pu_layer_unmap(PuLayer *layer);
void pu_layer_destroy(PuLayer *layer);
void pu_sdl_layer_failed(PuWindow *owner, const char *operation);

#endif
