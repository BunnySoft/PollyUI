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

#if defined(__APPLE__)
/* Implemented in src/host/sdl/macos_titlebar.mm: turn an SDL NSWindow into a
 * transparent-titlebar / full-size-content window keeping native traffic lights. */
extern void pu_macos_titlebar_overlay(void *nswindow, int on);
/* Configure the SDL content view to redraw (not stretch) during live resize. */
extern void pu_macos_tune_live_resize(void *nswindow);
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
    int           custom_chrome;   /* 1 => app draws chrome: enable drag hit-test */
    int           is_metal;
    int           exit_code;
    int           presented;

    PuPaintFn   paint_fn;   void *paint_user;
    PuPointerFn pointer_fn; void *pointer_user;
    PuKeyFn     key_fn;     void *key_user;
    PuWheelFn   wheel_fn;   void *wheel_user;
    PuAsyncFn   async_fn;   void *async_user;
    PuRegionFn  region_fn;  void *region_user;
};

static Uint32 g_wake_event = (Uint32)-1;   /* registered user event for wake */

static void fail_window(PuWindow *w, const char *operation)
{
    SDL_Log("%s failed: %s", operation, SDL_GetError());
    w->exit_code = 1;
    w->running = 0;
}

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
    } else {
        /* Raster drawing is on the CPU even if SDL uses a GPU for presentation. */
        const void *pixels = pu_surface_pixels(w->surface);
        int row = pu_surface_row_bytes(w->surface);
        if (!pixels || !w->renderer || !w->tex) {
            fail_window(w, "Raster frame resources");
            return;
        }
        if (!SDL_UpdateTexture(w->tex, NULL, pixels, row) ||
            !SDL_RenderClear(w->renderer) ||
            !SDL_RenderTexture(w->renderer, w->tex, NULL, NULL) ||
            !SDL_RenderPresent(w->renderer)) {
            fail_window(w, "SDL frame presentation");
            return;
        }
    }
    if (!w->presented) {
        w->presented = 1;
        if (getenv("PU_TRACE_STARTUP"))
            SDL_Log("PollyUI frame presented: %dx%d, driver=%s, Skia=%s",
                w->width, w->height, SDL_GetCurrentVideoDriver(),
                pu_surface_is_gl(w->surface) ? "GPU" : "raster");
    }
}

static int create_surface(PuWindow *w)
{
    if (!SDL_GetWindowSizeInPixels(w->win, &w->width, &w->height)) {
        fail_window(w, "SDL_GetWindowSizeInPixels"); return 0;
    }
    if (w->width  < 1) w->width  = 1;
    if (w->height < 1) w->height = 1;

#if defined(PU_METAL_BACKEND)
    SDL_MetalView mv = SDL_Metal_CreateView(w->win);
    if (mv) {
        void *layer = SDL_Metal_GetLayer(mv);
        w->surface = pu_surface_create_metal(layer, w->width, w->height);
        if (w->surface) { w->is_metal = 1; return 1; }
    }
#else
    w->surface = pu_surface_create_gpu(NULL, w->width, w->height);
    if (w->surface) return 1;
#endif

    /* Raster fallback (CPU surface blitted via SDL_Renderer). */
    w->surface  = pu_surface_create(w->width, w->height);
    if (!w->surface) {
        SDL_Log("Cannot allocate Skia raster surface"); return 0;
    }
    w->renderer = SDL_CreateRenderer(w->win, NULL);
    if (!w->renderer) { fail_window(w, "SDL_CreateRenderer"); return 0; }
    if (!SDL_SetRenderVSync(w->renderer, 1))
        SDL_Log("VSync unavailable for SDL presentation: %s", SDL_GetError());
    /* Match the actual presentation size, not a potentially stale resize event. */
    if (!SDL_GetCurrentRenderOutputSize(w->renderer, &w->width, &w->height)) {
        fail_window(w, "SDL_GetCurrentRenderOutputSize"); return 0;
    }
    if (w->width < 1) w->width = 1;
    if (w->height < 1) w->height = 1;
    pu_surface_resize(w->surface, w->width, w->height);
    w->tex = SDL_CreateTexture(w->renderer, SDL_PIXELFORMAT_BGRA32,
                               SDL_TEXTUREACCESS_STREAMING, w->width, w->height);
    if (!w->tex) { fail_window(w, "SDL_CreateTexture"); return 0; }
    return 1;
}

PuWindow *pu_window_create(const PuWindowConfig *cfg)
{
    if (!SDL_Init(SDL_INIT_VIDEO)) {
        SDL_Log("SDL_Init failed: %s", SDL_GetError());
        return NULL;
    }
    if (g_wake_event == (Uint32)-1) g_wake_event = SDL_RegisterEvents(1);
    if (g_wake_event == 0 || g_wake_event == (Uint32)-1) {
        SDL_Log("SDL_RegisterEvents failed: %s", SDL_GetError());
        SDL_Quit();
        g_wake_event = (Uint32)-1;
        return NULL;
    }

    PuWindow *w = (PuWindow *)calloc(1, sizeof *w);
    if (!w) { SDL_Log("Cannot allocate SDL window state"); SDL_Quit(); return NULL; }
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
    if (!w->win) { fail_window(w, "SDL_CreateWindow"); pu_window_destroy(w); return NULL; }

    recompute_scale(w);
    if (!create_surface(w)) { pu_window_destroy(w); return NULL; }
#if defined(__APPLE__)
    pu_macos_tune_live_resize(SDL_GetPointerProperty(SDL_GetWindowProperties(w->win),
                              SDL_PROP_WINDOW_COCOA_WINDOW_POINTER, NULL));
#endif
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
    if (!w || !w->custom_chrome) return SDL_HITTEST_NORMAL;

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
    w->custom_chrome = w->frameless;
    SDL_SetWindowBordered(w->win, w->frameless ? false : true);
    SDL_SetWindowHitTest(w->win, w->custom_chrome ? pu_hit_test : NULL, w);
}
void pu_window_set_backdrop(PuWindow *w, int type) { (void)w; (void)type; }

/* Overlay title bar (style 1): keep the OS window frame but make the title bar
 * transparent with full-size content, so the app draws the bar while the OS
 * keeps its native window buttons (macOS traffic lights). Dragging the custom
 * bar still uses the SDL hit-test. On non-Apple this is a no-op (use frameless +
 * a drawn caption). */
void pu_window_set_titlebar_style(PuWindow *w, int style)
{
    if (!w) return;
#if defined(__APPLE__)
    void *nswin = SDL_GetPointerProperty(SDL_GetWindowProperties(w->win),
                                         SDL_PROP_WINDOW_COCOA_WINDOW_POINTER, NULL);
    pu_macos_titlebar_overlay(nswin, style == 1 ? 1 : 0);
    w->custom_chrome = (style == 1) ? 1 : w->custom_chrome;
    SDL_SetWindowHitTest(w->win, w->custom_chrome ? pu_hit_test : NULL, w);
#else
    (void)style;
#endif
}

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

/* Re-sync the surface (and raster texture) to the window's current pixel size.
 * For the raster path we use the renderer's *actual* output size so the blit is
 * always 1:1 (no scaling/shear mid-resize). Idempotent: no-op when unchanged. */
static void pu_sync_size(PuWindow *w)
{
    recompute_scale(w);
    int pw = 0, ph = 0;
    bool sized = w->renderer ? SDL_GetCurrentRenderOutputSize(w->renderer, &pw, &ph) :
                              SDL_GetWindowSizeInPixels(w->win, &pw, &ph);
    if (!sized) { fail_window(w, "SDL resize dimensions"); return; }
    if (pw < 1) pw = 1;
    if (ph < 1) ph = 1;
    if (pw == w->width && ph == w->height) return;
    w->width = pw; w->height = ph;
    pu_surface_resize(w->surface, pw, ph);
    if (w->tex) {
        SDL_DestroyTexture(w->tex);
        w->tex = SDL_CreateTexture(w->renderer, SDL_PIXELFORMAT_BGRA32,
                                   SDL_TEXTUREACCESS_STREAMING, pw, ph);
        if (!w->tex) { fail_window(w, "SDL resize texture"); return; }
    }
    w->dirty = 1;
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
            pu_sync_size(w);
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

/* During a live window resize, macOS (and Windows) run a modal event-tracking
 * loop on the main thread, which starves our pu_window_run loop — so the window
 * would just stretch/zoom the last rendered frame until the drag ends. An SDL
 * event watch is invoked synchronously as events are pumped, *including* from
 * inside that modal loop, so we relayout + repaint here to keep content correct
 * live. */
static bool SDLCALL pu_resize_watch(void *userdata, SDL_Event *e)
{
    PuWindow *w = (PuWindow *)userdata;
    if (w && (e->type == SDL_EVENT_WINDOW_RESIZED ||
              e->type == SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED ||
              e->type == SDL_EVENT_WINDOW_EXPOSED) &&
        e->window.windowID == SDL_GetWindowID(w->win)) {
        pu_sync_size(w);
        pu_sdl_paint(w);     /* repaint live during the OS resize loop */
        w->dirty = 0;
    }
    return true;             /* keep delivering the event to the main loop */
}

int pu_window_run(PuWindow *w)
{
    if (!w) return 1;
    if (!SDL_StartTextInput(w->win)) {
        fail_window(w, "SDL_StartTextInput"); return w->exit_code;
    }
    if (!SDL_AddEventWatch(pu_resize_watch, w)) {
        fail_window(w, "SDL_AddEventWatch");
        SDL_StopTextInput(w->win);
        return w->exit_code;
    }

    while (w->running) {
        SDL_Event e;
        if (SDL_WaitEventTimeout(&e, 8)) {
            handle_event(w, &e);
            while (SDL_PollEvent(&e)) handle_event(w, &e);
        }
        if (w->async_fn && w->async_fn(w->async_user) > 0) w->dirty = 1;
        if (w->dirty && w->running) { pu_sdl_paint(w); w->dirty = 0; }
    }

    SDL_RemoveEventWatch(pu_resize_watch, w);
    SDL_StopTextInput(w->win);
    return w->exit_code;
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
    g_wake_event = (Uint32)-1;
}
