#ifndef POLLYUI_HOST_WINDOW_H
#define POLLYUI_HOST_WINDOW_H

/* Platform-neutral HostEngine contract. Each desktop host implements this API
 * while the shared application code remains unaware of native window types. */

#include "render/skia_c.h"

typedef struct PuWindow PuWindow;

typedef enum PuBackend {
    PU_BACKEND_AUTO = 0,
    PU_BACKEND_WAYLAND,
    PU_BACKEND_X11
} PuBackend;

typedef enum PuRenderer {
    PU_RENDERER_AUTO = 0,
    PU_RENDERER_GL,
    PU_RENDERER_RASTER
} PuRenderer;

typedef struct PuWindowConfig {
    const char *title;   /* UTF-8; NULL -> "PollyUI" */
    int         width;   /* client-area width in logical pixels */
    int         height;  /* client-area height in logical pixels */
    PuBackend   backend;
    PuRenderer  renderer;
} PuWindowConfig;

/* Paint callback: draw a frame into `surface`. `width`/`height` are LOGICAL
 * (DPI-independent) pixels; `scale` maps them to the physical device pixels of
 * `surface` (e.g. 1.5 on a 150% display). */
typedef void (*PuPaintFn)(PuSurface *surface, int width, int height, float scale, void *user);

typedef enum PuPointerType {
    PU_POINTER_CLICK = 0,
    PU_POINTER_DOWN,
    PU_POINTER_UP,
    PU_POINTER_MOVE
} PuPointerType;

typedef int (*PuPointerFn)(int x, int y, PuPointerType type, void *user);
typedef int (*PuKeyFn)(const char *key, int is_down, void *user);
typedef int (*PuWheelFn)(int x, int y, float dy, void *user);
typedef int (*PuAsyncFn)(void *user);
typedef int (*PuRegionFn)(int x, int y, void *user);

PuWindow *pu_window_create(const PuWindowConfig *cfg);
void pu_window_set_paint(PuWindow *w, PuPaintFn fn, void *user);
void pu_window_set_pointer(PuWindow *w, PuPointerFn fn, void *user);
void pu_window_set_key(PuWindow *w, PuKeyFn fn, void *user);
void pu_window_set_wheel(PuWindow *w, PuWheelFn fn, void *user);
void pu_window_set_async(PuWindow *w, PuAsyncFn fn, void *user);
void pu_window_set_region(PuWindow *w, PuRegionFn fn, void *user);
void pu_window_set_frameless(PuWindow *w, int frameless);
void pu_window_set_backdrop(PuWindow *w, int type);
void pu_window_set_titlebar_style(PuWindow *w, int style);
void pu_window_minimize(PuWindow *w);
void pu_window_maximize_toggle(PuWindow *w);
int  pu_window_is_maximized(PuWindow *w);
void pu_window_close(PuWindow *w);
void pu_window_wake(PuWindow *w);
int pu_window_run(PuWindow *w);
void pu_window_destroy(PuWindow *w);

#endif /* POLLYUI_HOST_WINDOW_H */
