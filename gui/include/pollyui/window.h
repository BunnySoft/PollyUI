#ifndef POLLYUI_HOST_WINDOW_H
#define POLLYUI_HOST_WINDOW_H

/* Shared Win32/SDL HostEngine contract: UI-thread windows and one event loop. */

#include <stdint.h>
#include "pollyui/input.h"

typedef struct PuSurface PuSurface;

typedef struct PuWindow PuWindow;

typedef enum PuPopup {
    PU_POPUP_NONE, PU_POPUP_MENU, PU_POPUP_TOOLTIP
} PuPopup;

typedef struct PuWindowLimits {
    int min_width, min_height, max_width, max_height; /* Logical client pixels; zero = unset. */
} PuWindowLimits;

typedef struct PuWindowState {
    int width, height;           /* Actual logical client size, not the creation request. */
    int pixel_width, pixel_height;
    float scale;
    int minimized, maximized, active;
} PuWindowState;

enum PuWindowCapability {
    PU_WINDOW_OWNED = 1, PU_WINDOW_POPUP = 2, PU_WINDOW_MODAL = 4,
    PU_WINDOW_LIMITS = 8, PU_WINDOW_TRANSPARENT = 16
};

typedef struct PuLayerConfig {
    int layer;                  /* background=0, bottom=1, top=2, overlay=3 */
    unsigned anchors;           /* top=1, bottom=2, left=4, right=8 */
    int exclusive_zone;
    int keyboard;               /* none=0, exclusive=1, on-demand=2 */
    uint32_t output;            /* current display ID, or 0 for compositor choice */
    int margin_top, margin_right, margin_bottom, margin_left;
    int transparent;
} PuLayerConfig;

typedef struct PuDisplayInfo {
    uint32_t id;
    int x, y, width, height;
    float scale;
    char name[128];
} PuDisplayInfo;

typedef struct PuWindowConfig {
    const char *title;   /* UTF-8; NULL -> "PollyUI" */
    int         width;   /* requested client-area width in logical pixels */
    int         height;  /* requested client-area height in logical pixels */
    const PuLayerConfig *layer; /* Linux Wayland only; borrowed during creation */
    int input_popup; /* Dedicated trusted Wayland input-method surface. */
    uint32_t lock_output; /* Dedicated session-lock role on this output, or zero. */
    PuWindow *parent;     /* Live ordinary window in this Host; immutable after creation. */
    PuPopup popup;        /* Native popup, never a layer/input-method surface. */
    int popup_x, popup_y;  /* Logical client coordinates relative to parent. */
    int modal;            /* Ordinary owned window; blocks native input to parent. */
    PuWindowLimits limits;
    int transparent;     /* Immutable ordinary-window per-pixel alpha; not opacity/input shape. */
} PuWindowConfig;

/* Capabilities of the current native driver/compositor; no explicit popup grab. */
unsigned pu_window_capabilities(void);
int pu_window_get_state(PuWindow *w, PuWindowState *state);
typedef void (*PuWindowStateFn)(const PuWindowState *state, void *user);
/* Delivered at a safe event-loop boundary, initially and whenever actual state changes. */
void pu_window_set_state(PuWindow *w, PuWindowStateFn fn, void *user);

int pu_window_system_init(void);
void pu_window_keep_alive(int enabled); /* SDL service loop without visible windows. */
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
#ifdef __linux__
struct wl_surface;
/* Presents the initial own layer buffer if needed; ordinary windows return NULL. */
struct wl_surface *pu_window_layer_surface(PuWindow *w);
/* Observe an owned layer without painting, mapping or dispatching callbacks. */
struct wl_surface *pu_window_layer_surface_peek(PuWindow *w);
#endif

/* Install the per-frame paint callback (and request a repaint). */
void pu_window_set_paint(PuWindow *w, PuPaintFn fn, void *user);

/* Install the pointer (mouse) callback. */
void pu_window_set_pointer(PuWindow *w, PuPointerFn fn, void *user);
/* UI-thread capture of the current mouse interaction. Failure is reported
 * by the Host and returns zero; it must not be treated as successful capture. */
int pu_window_capture_mouse(PuWindow *w, int enabled);
typedef int (*PuActivationFn)(int active, void *user);
void pu_window_set_activation(PuWindow *w, PuActivationFn fn, void *user);
int pu_window_is_active(PuWindow *w);
typedef enum PuCursor {
    PU_CURSOR_ARROW, PU_CURSOR_TEXT, PU_CURSOR_CROSSHAIR, PU_CURSOR_POINTER,
    PU_CURSOR_MOVE, PU_CURSOR_RESIZE_EW, PU_CURSOR_RESIZE_NS,
    PU_CURSOR_RESIZE_NESW, PU_CURSOR_RESIZE_NWSE, PU_CURSOR_NOT_ALLOWED,
    PU_CURSOR_WAIT, PU_CURSOR_COUNT
} PuCursor;
int pu_window_set_cursor(PuWindow *w, PuCursor cursor);

/* Physical key and committed-text events are separate. Return PuInputResult
 * flags; PREVENT_DEFAULT suppresses the key's following text submission. */
typedef int (*PuKeyFn)(const PuKeyEvent *event, void *user);
void pu_window_set_key(PuWindow *w, PuKeyFn fn, void *user);
int pu_window_set_text_input(PuWindow *window, const PuTextInputState *state, int reset);

/* Wheel callback: two-axis logical-pixel scroll. Positive deltas mean right/down.
 * Returns > 0 to repaint. */
typedef int (*PuWheelFn)(const PuWheelEvent *event, void *user);
void pu_window_set_wheel(PuWindow *w, PuWheelFn fn, void *user);

/* SDL native file/text drop delivery. Data is borrowed during the callback. */
typedef int (*PuDropFn)(const PuDropEvent *event, void *user);
void pu_window_set_drop(PuWindow *w, PuDropFn fn, void *user);

/* Async pump callback: run pending UI-thread work (microtasks, worker/task
 * deliveries, due timers). Returns > 0 if a repaint is warranted. Invoked on a
 * frame timer and whenever pu_window_wake is called. */
typedef int (*PuAsyncFn)(void *user);
void pu_window_set_async(PuWindow *w, PuAsyncFn fn, void *user);
/* Called once at a safe loop boundary after close; may destroy this window. */
typedef void (*PuCloseFn)(PuWindow *w, void *user);
void pu_window_set_close(PuWindow *w, PuCloseFn fn, void *user);
/* External close requests may be declined while an application saves/prompts. */
typedef int (*PuCloseRequestFn)(PuWindow *w, void *user);
void pu_window_set_close_request(PuWindow *w, PuCloseRequestFn fn, void *user);
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
typedef enum PuCloseResult {
    PU_CLOSE_DECLINED, PU_CLOSE_ACCEPTED, PU_CLOSE_PENDING
} PuCloseResult;
/* Explicit close bypasses this window's hook. Owned descendants are requested
 * leaf-first; PENDING keeps the owner open until native child retirement. */
int pu_window_close(PuWindow *w);
/* Native/external close also consults this window's request hook. */
int pu_window_request_close(PuWindow *w);
/* Explicit application quit is the existing forced path: no request hooks.
 * Native resources still retire leaf-first, never via implicit owner destruction. */
int pu_window_close_all(void);

/* Wake the window (thread-safe) so it drains async deliveries promptly. Used as
 * the dispatcher's waker from worker threads. NULL wakes the shared loop. */
void pu_window_wake(PuWindow *w);

/* Run the OS event loop until all windows are closed; nonzero indicates failure. */
int pu_window_run(PuWindow *w);
/* One UI-thread loop for all live windows. frame runs once per tick, regardless
 * of window count, and may create or request closing windows. */
int pu_window_run_all(PuAsyncFn frame, void *user);

/* Destroy the window. Native resources are retained until children and in-flight
 * callbacks release them. Safe to call with NULL; do not reuse destroyed pointers. */
void pu_window_destroy(PuWindow *w);

#endif /* POLLYUI_HOST_WINDOW_H */
