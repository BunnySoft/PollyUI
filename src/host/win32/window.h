#ifndef POLLYUI_HOST_WIN32_WINDOW_H
#define POLLYUI_HOST_WIN32_WINDOW_H

/* Shared Win32/SDL HostEngine contract: UI-thread windows and one event loop. */

#include "render/skia_c.h"
#include "host/input.h"

typedef struct PuWindow PuWindow;

typedef struct PuLayerConfig {
    int layer;                  /* background=0, bottom=1, top=2, overlay=3 */
    unsigned anchors;           /* top=1, bottom=2, left=4, right=8 */
    int exclusive_zone;
    int keyboard;               /* none=0, exclusive=1, on-demand=2 */
    uint32_t output;            /* current display ID, or 0 for compositor choice */
    int margin_top, margin_right, margin_bottom, margin_left;
} PuLayerConfig;

typedef struct PuDisplayInfo {
    uint32_t id;
    int x, y, width, height;
    float scale;
    char name[128];
} PuDisplayInfo;

typedef struct PuWindowConfig {
    const char *title;   /* UTF-8; NULL -> "PollyUI" */
    int         width;   /* client-area width  in pixels */
    int         height;  /* client-area height in pixels */
    const PuLayerConfig *layer; /* Linux Wayland only; borrowed during creation */
} PuWindowConfig;

int pu_window_system_init(void);
void pu_window_system_shutdown(void);
/* Caller frees the returned array. IDs are valid only in the current session. */
PuDisplayInfo *pu_window_displays(int *count);

/* Paint callback: draw a frame into `surface`. `width`/`height` are LOGICAL
 * (DPI-independent) pixels; `scale` maps them to the physical device pixels of
 * `surface` (e.g. 1.5 on a 150% display). Set via pu_window_set_paint; when
 * unset the window shows a built-in demo. Keeps the host decoupled from the
 * Model/Layout/Render layers. */
typedef void (*PuPaintFn)(PuSurface *surface, int width, int height, float scale, void *user);

/* Pointer callback at LOGICAL (DPI-independent) client coords (x, y).
 * Returns > 0 if the handler mutated the DOM (so the host repaints); 0 lets the
 * host skip a needless repaint (e.g. a mousemove that changed nothing). */
typedef int (*PuPointerFn)(const PuPointerEvent *event, void *user);

/* Create and show the window. Returns NULL on failure. */
PuWindow *pu_window_create(const PuWindowConfig *cfg);

/* Install the per-frame paint callback (and request a repaint). */
void pu_window_set_paint(PuWindow *w, PuPaintFn fn, void *user);

/* Install the pointer (mouse) callback. */
void pu_window_set_pointer(PuWindow *w, PuPointerFn fn, void *user);

/* Physical key and committed-text events are separate. Return PuInputResult
 * flags; PREVENT_DEFAULT suppresses the key's following text submission. */
typedef int (*PuKeyFn)(const PuKeyEvent *event, void *user);
void pu_window_set_key(PuWindow *w, PuKeyFn fn, void *user);

/* Wheel callback: two-axis logical-pixel scroll. Positive deltas mean right/down.
 * Returns > 0 to repaint. */
typedef int (*PuWheelFn)(const PuWheelEvent *event, void *user);
void pu_window_set_wheel(PuWindow *w, PuWheelFn fn, void *user);

/* Async pump callback: run pending UI-thread work (microtasks, worker/task
 * deliveries, due timers). Returns > 0 if a repaint is warranted. Invoked on a
 * frame timer and whenever pu_window_wake is called. */
typedef int (*PuAsyncFn)(void *user);
void pu_window_set_async(PuWindow *w, PuAsyncFn fn, void *user);
/* Called once at a safe loop boundary after close; may destroy this window. */
typedef void (*PuCloseFn)(PuWindow *w, void *user);
void pu_window_set_close(PuWindow *w, PuCloseFn fn, void *user);
int  pu_window_is_open(PuWindow *w);
void pu_window_redraw(PuWindow *w);
int  pu_window_save_frame(PuWindow *w, const char *path);

/* Custom title bar / frameless window. `region_fn` is asked, at LOGICAL client
 * coords, whether a point is in the draggable title-bar area (returns nonzero =
 * draggable, like CSS `-webkit-app-region: drag`). */
typedef int (*PuRegionFn)(int x, int y, void *user);
void pu_window_set_region(PuWindow *w, PuRegionFn fn, void *user);
void pu_window_set_frameless(PuWindow *w, int frameless); /* hide/show OS title bar */
void pu_window_set_backdrop(PuWindow *w, int type);       /* Win11 Mica(2)/Acrylic(3) */

/* Title-bar style for the custom-chrome app window:
 *   0 = default (system title bar / the host's normal frame)
 *   1 = overlay: keep the window framed but make the title bar transparent and
 *       let app content fill it, while the OS still draws its native window
 *       buttons (macOS traffic lights). On Windows/Linux this is a no-op (use
 *       pu_window_set_frameless + draw your own caption). */
void pu_window_set_titlebar_style(PuWindow *w, int style);
void pu_window_minimize(PuWindow *w);
void pu_window_maximize_toggle(PuWindow *w);
int  pu_window_is_maximized(PuWindow *w);
void pu_window_close(PuWindow *w);

/* Wake the window (thread-safe) so it drains async deliveries promptly. Used as
 * the dispatcher's waker from worker threads. NULL wakes the shared loop. */
void pu_window_wake(PuWindow *w);

/* Run the OS event loop until all windows are closed; nonzero indicates failure. */
int pu_window_run(PuWindow *w);
/* One UI-thread loop for all live windows. frame runs once per tick, regardless
 * of window count, and may create or request closing windows. */
int pu_window_run_all(PuAsyncFn frame, void *user);

/* Destroy the window and free its resources. Safe to call with NULL. */
void pu_window_destroy(PuWindow *w);

#endif /* POLLYUI_HOST_WIN32_WINDOW_H */
