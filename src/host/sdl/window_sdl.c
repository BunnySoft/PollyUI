// HostEngine — SDL3 backend for PollyUI (Tier 1: macOS/Linux/Windows; mobile
// later). One file implementing the PuWindow contract from host/win32/window.h
// via SDL3. See docs/PORTING.md §4.
//
// GPU surface per platform:
//   Apple  -> Metal: SDL_Metal_CreateView -> CAMetalLayer -> pu_surface_create_metal
//   else   -> GL:    pu_surface_create_gpu (where available)
//   any    -> raster fallback: pu_surface_create + SDL_Renderer streaming blit
//
// Loop model: the existing src/main.c owns the loop (it calls pu_window_run),
// so this host runs a classic SDL_WaitEventTimeout/poll loop here rather than
// SDL's main-callbacks. That keeps main.c byte-for-byte identical across hosts.

#include "host/win32/window.h"   /* the shared HostEngine contract */
#include "render/skia_c.h"

#include <SDL3/SDL.h>

#include <stdlib.h>
#include <string.h>

#if defined(PU_METAL_BACKEND)
/* Implemented in src/render/skia_metal.mm; acquires the next drawable + wraps
 * the SkSurface before each paint. No-op for non-Metal surfaces. */
extern void pu_metal_begin_frame(PuSurface *s);
#endif

struct PuWindow {
    SDL_Window   *win;
    SDL_Renderer *renderer;   /* raster fallback only */
    SDL_Texture  *tex;        /* raster fallback only */
    PuSurface    *surface;
    int           width, height;   /* physical pixels */
    float         scale;           /* logical -> physical */
    int           running;
    int           dirty;
    int           frameless;
    int           is_metal;

    PuPaintFn   paint_fn;   void *paint_user;
    PuPointerFn pointer_fn; void *pointer_user;
    PuKeyFn     key_fn;     void *key_user;
    PuWheelFn   wheel_fn;   void *wheel_user;
    PuAsyncFn   async_fn;   void *async_user;
    PuRegionFn  region_fn;  void *region_user;
};

static Uint32 g_wake_event = (Uint32)-1;   /* registered user event for wake */

/* Map an SDL keycode to a DOM-style key name for non-text keys. Printable
 * characters arrive separately via SDL_EVENT_TEXT_INPUT, so return NULL for
 * them here to avoid double input. */
static const char *sdl_key_name(SDL_Keycode k)
{
    switch (k) {
        case SDLK_RETURN:    case SDLK_KP_ENTER: return "Enter";
        case SDLK_ESCAPE:    return "Escape";
        case SDLK_BACKSPACE: return "Backspace";
        case SDLK_TAB:       return "Tab";
        case SDLK_DELETE:    return "Delete";
        case SDLK_LEFT:      return "ArrowLeft";
        case SDLK_RIGHT:     return "ArrowRight";
        case SDLK_UP:        return "ArrowUp";
        case SDLK_DOWN:      return "ArrowDown";
        case SDLK_HOME:      return "Home";
        case SDLK_END:       return "End";
        case SDLK_PAGEUP:    return "PageUp";
        case SDLK_PAGEDOWN:  return "PageDown";
        default:             return NULL;
    }
}

static void recompute_scale(PuWindow *w)
{
    float s = SDL_GetWindowDisplayScale(w->win);
    w->scale = (s > 0.0f) ? s : 1.0f;
}

/* Render one frame and present (GPU) or blit (raster). */
static void pu_sdl_paint(PuWindow *w)
{
    if (!w->surface) return;
#if defined(PU_METAL_BACKEND)
    if (w->is_metal) pu_metal_begin_frame(w->surface);
#endif
    float scale = w->scale > 0 ? w->scale : 1.0f;
    if (w->paint_fn) {
        int lw = (int)(w->width / scale);
        int lh = (int)(w->height / scale);
        w->paint_fn(w->surface, lw, lh, scale, w->paint_user);
    } else {
        pu_surface_clear(w->surface, 0x10, 0x12, 0x18, 0xFF);
        float cw = (float)w->width, ch = (float)w->height, rw = 320.0f, rh = 200.0f;
        pu_surface_fill_rect(w->surface, (cw - rw) * 0.5f, (ch - rh) * 0.5f, rw, rh,
                             0x3b, 0x82, 0xf6, 0xFF);
    }

    if (pu_surface_is_gl(w->surface)) {
        pu_surface_present(w->surface);   /* GPU: flush + present drawable/swap */
        return;
    }

    /* Raster fallback: upload the BGRA buffer into an SDL texture and present. */
    if (w->renderer && w->tex) {
        const void *pixels = pu_surface_pixels(w->surface);
        int row = pu_surface_row_bytes(w->surface);
        if (pixels) SDL_UpdateTexture(w->tex, NULL, pixels, row);
        SDL_RenderClear(w->renderer);
        SDL_RenderTexture(w->renderer, w->tex, NULL, NULL);
        SDL_RenderPresent(w->renderer);
    }
}

static void create_surface(PuWindow *w)
{
    SDL_GetWindowSizeInPixels(w->win, &w->width, &w->height);
    if (w->width  < 1) w->width  = 1;
    if (w->height < 1) w->height = 1;

#if defined(PU_METAL_BACKEND)
    SDL_MetalView mv = SDL_Metal_CreateView(w->win);
    if (mv) {
        void *layer = SDL_Metal_GetLayer(mv);
        w->surface = pu_surface_create_metal(layer, w->width, w->height);
        if (w->surface) { w->is_metal = 1; return; }
    }
#else
    w->surface = pu_surface_create_gpu(NULL, w->width, w->height);
    if (w->surface) return;
#endif

    /* Raster fallback (CPU surface blitted via SDL_Renderer). */
    w->surface  = pu_surface_create(w->width, w->height);
    w->renderer = SDL_CreateRenderer(w->win, NULL);
    if (w->renderer)
        w->tex = SDL_CreateTexture(w->renderer, SDL_PIXELFORMAT_BGRA32,
                                   SDL_TEXTUREACCESS_STREAMING, w->width, w->height);
}

PuWindow *pu_window_create(const PuWindowConfig *cfg)
{
    if (!SDL_Init(SDL_INIT_VIDEO)) {
        SDL_Log("SDL_Init failed: %s", SDL_GetError());
        return NULL;
    }
    if (g_wake_event == (Uint32)-1) g_wake_event = SDL_RegisterEvents(1);

    PuWindow *w = (PuWindow *)calloc(1, sizeof *w);
    if (!w) return NULL;
    w->running = 1;
    w->dirty   = 1;
    w->scale   = 1.0f;

    int cw = (cfg && cfg->width  > 0) ? cfg->width  : 960;
    int ch = (cfg && cfg->height > 0) ? cfg->height : 640;
    const char *title = (cfg && cfg->title) ? cfg->title : "PollyUI";

    SDL_WindowFlags flags = SDL_WINDOW_HIGH_PIXEL_DENSITY | SDL_WINDOW_RESIZABLE;
#if defined(PU_METAL_BACKEND)
    flags |= SDL_WINDOW_METAL;
#endif
    w->win = SDL_CreateWindow(title, cw, ch, flags);
    if (!w->win) { SDL_Log("SDL_CreateWindow failed: %s", SDL_GetError()); free(w); return NULL; }

    recompute_scale(w);
    create_surface(w);
    if (!w->surface) { SDL_DestroyWindow(w->win); free(w); return NULL; }
    return w;
}

void pu_window_set_paint  (PuWindow *w, PuPaintFn   fn, void *u){ if(w){w->paint_fn=fn;   w->paint_user=u;   w->dirty=1;} }
void pu_window_set_pointer(PuWindow *w, PuPointerFn fn, void *u){ if(w){w->pointer_fn=fn; w->pointer_user=u;} }
void pu_window_set_key    (PuWindow *w, PuKeyFn     fn, void *u){ if(w){w->key_fn=fn;     w->key_user=u;} }
void pu_window_set_wheel  (PuWindow *w, PuWheelFn   fn, void *u){ if(w){w->wheel_fn=fn;   w->wheel_user=u;} }
void pu_window_set_async  (PuWindow *w, PuAsyncFn   fn, void *u){ if(w){w->async_fn=fn;   w->async_user=u;} }
void pu_window_set_region (PuWindow *w, PuRegionFn  fn, void *u){ if(w){w->region_fn=fn;  w->region_user=u;} }

/* Native hit-testing for frameless windows: ask the app (region_fn) whether a
 * point is in the draggable custom title bar (-> DRAGGABLE, like CSS
 * -webkit-app-region: drag), synthesize resize edges near the borders, and treat
 * everything else (buttons, content) as NORMAL so clicks/hover work. Coordinates
 * are in window points — the same space region_fn (DOM hit-test) expects. */
static SDL_HitTestResult SDLCALL pu_hit_test(SDL_Window *win, const SDL_Point *area, void *data)
{
    PuWindow *w = (PuWindow *)data;
    if (!w || !w->frameless) return SDL_HITTEST_NORMAL;

    int bw = 0, bh = 0;
    SDL_GetWindowSize(win, &bw, &bh);   /* points */
    const int M = 6;
    int L = area->x < M, R = area->x >= bw - M;
    int T = area->y < M, B = area->y >= bh - M;
    if (T && L) return SDL_HITTEST_RESIZE_TOPLEFT;
    if (T && R) return SDL_HITTEST_RESIZE_TOPRIGHT;
    if (B && L) return SDL_HITTEST_RESIZE_BOTTOMLEFT;
    if (B && R) return SDL_HITTEST_RESIZE_BOTTOMRIGHT;
    if (T) return SDL_HITTEST_RESIZE_TOP;
    if (B) return SDL_HITTEST_RESIZE_BOTTOM;
    if (L) return SDL_HITTEST_RESIZE_LEFT;
    if (R) return SDL_HITTEST_RESIZE_RIGHT;

    if (w->region_fn && w->region_fn(area->x, area->y, w->region_user))
        return SDL_HITTEST_DRAGGABLE;   /* custom title bar: native window drag */
    return SDL_HITTEST_NORMAL;
}

/* Frameless: hide the OS border and install the hit-test so the app's custom
 * title bar can drag/resize the window. Backdrop (Mica/Acrylic) is Win11-only. */
void pu_window_set_frameless(PuWindow *w, int frameless)
{
    if (!w) return;
    w->frameless = frameless ? 1 : 0;
    SDL_SetWindowBordered(w->win, w->frameless ? false : true);
    SDL_SetWindowHitTest(w->win, w->frameless ? pu_hit_test : NULL, w);
}
void pu_window_set_backdrop(PuWindow *w, int type) { (void)w; (void)type; }

void pu_window_minimize(PuWindow *w) { if (w) SDL_MinimizeWindow(w->win); }
void pu_window_maximize_toggle(PuWindow *w)
{
    if (!w) return;
    if (SDL_GetWindowFlags(w->win) & SDL_WINDOW_MAXIMIZED) SDL_RestoreWindow(w->win);
    else SDL_MaximizeWindow(w->win);
}
int  pu_window_is_maximized(PuWindow *w)
{ return (w && (SDL_GetWindowFlags(w->win) & SDL_WINDOW_MAXIMIZED)) ? 1 : 0; }
void pu_window_close(PuWindow *w) { if (w) w->running = 0; }

void pu_window_wake(PuWindow *w)
{
    (void)w;
    if (g_wake_event == (Uint32)-1) return;
    SDL_Event e; SDL_zero(e); e.type = g_wake_event;
    SDL_PushEvent(&e);   /* thread-safe; breaks SDL_WaitEventTimeout */
}

static void handle_event(PuWindow *w, const SDL_Event *e)
{
    /* SDL3 reports mouse/touch coordinates in logical window points (the same
     * coordinate space as our layout, which is computed at width/height in
     * points). So pass them straight through — do NOT divide by the DPI scale,
     * or clicks land at a fraction of their position on HiDPI displays. */
    switch (e->type) {
        case SDL_EVENT_QUIT:
        case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
            w->running = 0; break;

        case SDL_EVENT_MOUSE_BUTTON_DOWN:
            if (w->pointer_fn && w->pointer_fn((int)e->button.x, (int)e->button.y, PU_POINTER_DOWN, w->pointer_user) > 0) w->dirty = 1;
            break;
        case SDL_EVENT_MOUSE_BUTTON_UP:
            if (w->pointer_fn) {
                int changed = w->pointer_fn((int)e->button.x, (int)e->button.y, PU_POINTER_UP, w->pointer_user);
                changed |= w->pointer_fn((int)e->button.x, (int)e->button.y, PU_POINTER_CLICK, w->pointer_user);
                if (changed > 0) w->dirty = 1;
            }
            break;
        case SDL_EVENT_MOUSE_MOTION:
            if (w->pointer_fn && w->pointer_fn((int)e->motion.x, (int)e->motion.y, PU_POINTER_MOVE, w->pointer_user) > 0) w->dirty = 1;
            break;
        case SDL_EVENT_MOUSE_WHEEL:
            /* SDL wheel.y > 0 scrolls up; DOM deltaY > 0 scrolls down -> negate. */
            if (w->wheel_fn) {
                float mx = 0, my = 0; SDL_GetMouseState(&mx, &my);
                if (w->wheel_fn((int)mx, (int)my, -e->wheel.y * 40.0f, w->wheel_user) > 0) w->dirty = 1;
            }
            break;

        case SDL_EVENT_KEY_DOWN: {
            const char *name = sdl_key_name(e->key.key);
            if (name && w->key_fn && w->key_fn(name, 1, w->key_user) > 0) w->dirty = 1;
            break;
        }
        case SDL_EVENT_KEY_UP: {
            const char *name = sdl_key_name(e->key.key);
            if (name && w->key_fn && w->key_fn(name, 0, w->key_user) > 0) w->dirty = 1;
            break;
        }
        case SDL_EVENT_TEXT_INPUT:
            if (w->key_fn && w->key_fn(e->text.text, 1, w->key_user) > 0) w->dirty = 1;
            break;

        case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED:
        case SDL_EVENT_WINDOW_RESIZED:
            recompute_scale(w);
            SDL_GetWindowSizeInPixels(w->win, &w->width, &w->height);
            if (w->width < 1) w->width = 1;
            if (w->height < 1) w->height = 1;
            pu_surface_resize(w->surface, w->width, w->height);
            if (w->tex) {
                SDL_DestroyTexture(w->tex);
                w->tex = SDL_CreateTexture(w->renderer, SDL_PIXELFORMAT_BGRA32,
                                           SDL_TEXTUREACCESS_STREAMING, w->width, w->height);
            }
            w->dirty = 1;
            break;

        case SDL_EVENT_WINDOW_EXPOSED:
        case SDL_EVENT_WINDOW_DISPLAY_SCALE_CHANGED:
            recompute_scale(w);
            w->dirty = 1;
            break;
        default:
            break;
    }
}

int pu_window_run(PuWindow *w)
{
    if (!w) return 1;
    SDL_StartTextInput(w->win);   /* enable SDL_EVENT_TEXT_INPUT */

    while (w->running) {
        SDL_Event e;
        if (SDL_WaitEventTimeout(&e, 8)) {
            handle_event(w, &e);
            while (SDL_PollEvent(&e)) handle_event(w, &e);
        }
        if (w->async_fn && w->async_fn(w->async_user) > 0) w->dirty = 1;
        if (w->dirty) { pu_sdl_paint(w); w->dirty = 0; }
    }

    SDL_StopTextInput(w->win);
    return 0;
}

void pu_window_destroy(PuWindow *w)
{
    if (!w) return;
    if (w->surface)  pu_surface_destroy(w->surface);
    if (w->tex)      SDL_DestroyTexture(w->tex);
    if (w->renderer) SDL_DestroyRenderer(w->renderer);
    if (w->win)      SDL_DestroyWindow(w->win);
    free(w);
    SDL_Quit();
}
