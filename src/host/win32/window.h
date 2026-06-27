#ifndef POLLYUI_HOST_WIN32_WINDOW_H
#define POLLYUI_HOST_WIN32_WINDOW_H

/* HostEngine (Windows) — owns the OS window and event loop (DESIGN.md §2, §3).
 * M0a: opens a window and clears it to a color via GDI. The clear is replaced
 * by a Skia raster surface blit in M0b. */

#include "render/skia_c.h"

typedef struct PuWindow PuWindow;

typedef struct PuWindowConfig {
    const char *title;   /* UTF-8; NULL -> "PollyUI" */
    int         width;   /* client-area width  in pixels */
    int         height;  /* client-area height in pixels */
} PuWindowConfig;

/* Paint callback: draw a frame into `surface` (sized width x height). Set via
 * pu_window_set_paint; when unset the window shows a built-in demo. This keeps
 * the HostEngine decoupled from the Model/Layout/Render layers. */
typedef void (*PuPaintFn)(PuSurface *surface, int width, int height, void *user);

/* Create and show the window. Returns NULL on failure. */
PuWindow *pu_window_create(const PuWindowConfig *cfg);

/* Install the per-frame paint callback (and request a repaint). */
void pu_window_set_paint(PuWindow *w, PuPaintFn fn, void *user);

/* Run the OS event loop until the window is closed.
 * Returns the process exit code (the WM_QUIT wParam). */
int pu_window_run(PuWindow *w);

/* Destroy the window and free its resources. Safe to call with NULL. */
void pu_window_destroy(PuWindow *w);

#endif /* POLLYUI_HOST_WIN32_WINDOW_H */
