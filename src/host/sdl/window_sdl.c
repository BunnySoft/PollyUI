// HostEngine — SDL3 backend for PollyUI (Tier 1: macOS/Linux/Windows; mobile
// later). One file implementing the PuWindow contract from host/window.h
// via SDL3. See docs/PORTING.md §4.
//
// GPU surface per platform:
//   Apple  -> Metal: SDL_Metal_CreateView -> CAMetalLayer -> pu_surface_create_metal
//   Linux -> GL: SDL context + platform-neutral current-framebuffer Skia wrapper
//   any    -> raster fallback: pu_surface_create + SDL_Renderer streaming blit
//
// Loop model: the existing src/main.c owns the loop (it calls pu_window_run),
// so this host runs a classic SDL_WaitEventTimeout/poll loop here rather than
// SDL's main-callbacks. That keeps main.c byte-for-byte identical across hosts.

#include "host/window.h"
#include "host/startup.h"
#include "render/skia_c.h"

#include <SDL3/SDL.h>

#include <stdio.h>
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
    SDL_GLContext gl_context; /* Linux Ganesh GL only; SDL owns presentation */
#if defined(PU_METAL_BACKEND)
    SDL_MetalView metal_view;
#endif
    PuSurface    *surface;
    int           width, height;   /* physical pixels */
    float         scale;           /* logical -> physical */
    int           running;
    int           dirty;
    int           frameless;
    int           custom_chrome;   /* 1 => app draws chrome: enable drag hit-test */
    int           is_metal;
    int           is_gl;

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
#if defined(PU_SKIA_GL_BACKEND)
    if (w->gl_context && !SDL_GL_MakeCurrent(w->win, w->gl_context)) {
        SDL_Log("SDL_GL_MakeCurrent failed while painting: %s", SDL_GetError());
        return;
    }
#endif
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
        pu_surface_present(w->surface);
#if defined(PU_SKIA_GL_BACKEND)
        if (w->gl_context) SDL_GL_SwapWindow(w->win);
#endif
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

static int create_raster_surface(PuWindow *w)
{
    SDL_GetWindowSizeInPixels(w->win, &w->width, &w->height);
    if (w->width  < 1) w->width  = 1;
    if (w->height < 1) w->height = 1;

    w->surface  = pu_surface_create(w->width, w->height);
    if (!w->surface) {
        SDL_Log("could not create the Skia raster surface");
        return 0;
    }
    w->renderer = SDL_CreateRenderer(w->win, NULL);
    if (!w->renderer) {
        SDL_Log("SDL_CreateRenderer failed for raster presentation: %s", SDL_GetError());
        return 0;
    }
    SDL_SetRenderVSync(w->renderer, 1);
    SDL_GetCurrentRenderOutputSize(w->renderer, &w->width, &w->height);
    if (w->width < 1) w->width = 1;
    if (w->height < 1) w->height = 1;
    pu_surface_resize(w->surface, w->width, w->height);
    w->tex = SDL_CreateTexture(w->renderer, SDL_PIXELFORMAT_BGRA32,
                               SDL_TEXTUREACCESS_STREAMING, w->width, w->height);
    if (!w->tex) {
        SDL_Log("SDL_CreateTexture failed for raster presentation: %s", SDL_GetError());
        return 0;
    }
    return 1;
}

static void destroy_window_resources(PuWindow *w)
{
    if (!w) return;
    if (w->surface) { pu_surface_destroy(w->surface); w->surface = NULL; }
    if (w->tex) { SDL_DestroyTexture(w->tex); w->tex = NULL; }
    if (w->renderer) { SDL_DestroyRenderer(w->renderer); w->renderer = NULL; }
#if defined(PU_METAL_BACKEND)
    if (w->metal_view) { SDL_Metal_DestroyView(w->metal_view); w->metal_view = NULL; }
#endif
    if (w->gl_context) { SDL_GL_DestroyContext(w->gl_context); w->gl_context = NULL; }
    if (w->win) { SDL_DestroyWindow(w->win); w->win = NULL; }
    w->is_gl = 0;
    w->is_metal = 0;
}

static int init_video_backend(PuBackend requested, PuRenderer renderer)
{
    const char *driver = requested == PU_BACKEND_AUTO ? NULL : pu_backend_name(requested);
    SDL_ResetHint(SDL_HINT_VIDEO_DRIVER);
#if defined(PU_SKIA_GL_BACKEND)
    SDL_ResetHint(SDL_HINT_VIDEO_FORCE_EGL);
    if (renderer != PU_RENDERER_RASTER)
        SDL_SetHintWithPriority(SDL_HINT_VIDEO_FORCE_EGL, "1", SDL_HINT_OVERRIDE);
#else
    (void)renderer;
#endif
    if (driver &&
        !SDL_SetHintWithPriority(SDL_HINT_VIDEO_DRIVER, driver, SDL_HINT_OVERRIDE)) {
        SDL_Log("could not force SDL video driver '%s'", driver);
        return 0;
    }
    if (!SDL_Init(SDL_INIT_VIDEO)) {
        SDL_Log("SDL_Init failed for video driver '%s': %s",
                driver ? driver : "default", SDL_GetError());
        return 0;
    }
    const char *active = SDL_GetCurrentVideoDriver();
    if (driver && (!active || strcmp(active, driver) != 0)) {
        SDL_Log("SDL selected video driver '%s' instead of requested '%s'",
                active ? active : "none", driver);
        SDL_Quit();
        return 0;
    }
    return 1;
}

static SDL_Window *create_sdl_window(const PuWindowConfig *cfg, SDL_WindowFlags extra)
{
    int cw = (cfg && cfg->width  > 0) ? cfg->width  : 960;
    int ch = (cfg && cfg->height > 0) ? cfg->height : 640;
    const char *title = (cfg && cfg->title) ? cfg->title : "PollyUI";
    SDL_WindowFlags flags = SDL_WINDOW_HIGH_PIXEL_DENSITY | SDL_WINDOW_RESIZABLE;
    return SDL_CreateWindow(title, cw, ch, flags | extra);
}

#if defined(PU_SKIA_GL_BACKEND)
static PuGLProc pu_sdl_gl_get_proc(void *user, const char *name)
{
    (void)user;
    return (PuGLProc)SDL_GL_GetProcAddress(name);
}
#endif

static int create_gl_surface(PuWindow *w, const PuWindowConfig *cfg)
{
#if defined(PU_SKIA_GL_BACKEND)
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
    SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
    SDL_GL_SetAttribute(SDL_GL_RED_SIZE, 8);
    SDL_GL_SetAttribute(SDL_GL_GREEN_SIZE, 8);
    SDL_GL_SetAttribute(SDL_GL_BLUE_SIZE, 8);
    SDL_GL_SetAttribute(SDL_GL_ALPHA_SIZE, 8);
    SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 8);

    w->win = create_sdl_window(cfg, SDL_WINDOW_OPENGL);
    if (!w->win) {
        SDL_Log("SDL_CreateWindow(OpenGL) failed: %s", SDL_GetError());
        return 0;
    }
    w->gl_context = SDL_GL_CreateContext(w->win);
    if (!w->gl_context) {
        SDL_Log("SDL_GL_CreateContext failed: %s", SDL_GetError());
        return 0;
    }
    if (!SDL_GL_MakeCurrent(w->win, w->gl_context)) {
        SDL_Log("SDL_GL_MakeCurrent failed: %s", SDL_GetError());
        return 0;
    }
    const char *vsync = getenv("PU_VSYNC");
    int interval = (vsync && vsync[0]) ? atoi(vsync) : 1;
    if (!SDL_GL_SetSwapInterval(interval))
        SDL_Log("SDL_GL_SetSwapInterval(%d) failed: %s", interval, SDL_GetError());

    SDL_GetWindowSizeInPixels(w->win, &w->width, &w->height);
    if (w->width < 1) w->width = 1;
    if (w->height < 1) w->height = 1;
    w->surface = pu_surface_create_current_gl(pu_sdl_gl_get_proc, NULL,
                                               w->width, w->height);
    if (!w->surface) return 0;
    w->is_gl = 1;
    return 1;
#else
    (void)w; (void)cfg;
    SDL_Log("this build has no Skia Ganesh GL support");
    return 0;
#endif
}

static int create_metal_surface(PuWindow *w, const PuWindowConfig *cfg)
{
#if defined(PU_METAL_BACKEND)
    w->win = create_sdl_window(cfg, SDL_WINDOW_METAL);
    if (!w->win) {
        SDL_Log("SDL_CreateWindow(Metal) failed: %s", SDL_GetError());
        return 0;
    }
    SDL_GetWindowSizeInPixels(w->win, &w->width, &w->height);
    if (w->width < 1) w->width = 1;
    if (w->height < 1) w->height = 1;
    w->metal_view = SDL_Metal_CreateView(w->win);
    if (!w->metal_view) {
        SDL_Log("SDL_Metal_CreateView failed: %s", SDL_GetError());
        return 0;
    }
    w->surface = pu_surface_create_metal(SDL_Metal_GetLayer(w->metal_view),
                                         w->width, w->height);
    if (!w->surface) return 0;
    w->is_metal = 1;
    return 1;
#else
    (void)w; (void)cfg;
    return 0;
#endif
}

static int create_requested_renderer(PuWindow *w, const PuWindowConfig *cfg,
                                     PuRenderer requested)
{
    int renderer_ok = 0;
#if defined(__APPLE__)
    if (requested == PU_RENDERER_GL) {
        SDL_Log("renderer=gl is not supported by the Apple SDL host; use auto or raster");
    } else if (requested == PU_RENDERER_AUTO) {
        renderer_ok = create_metal_surface(w, cfg);
    }
#else
    if (requested != PU_RENDERER_RASTER)
        renderer_ok = create_gl_surface(w, cfg);
#endif
    if (!renderer_ok && requested != PU_RENDERER_GL) {
        if (requested == PU_RENDERER_AUTO)
            fprintf(stderr, "[host] GL/GPU renderer unavailable; falling back to raster\n");
        destroy_window_resources(w);
        w->win = create_sdl_window(cfg, 0);
        if (w->win) renderer_ok = create_raster_surface(w);
    }
    return renderer_ok;
}

PuWindow *pu_window_create(const PuWindowConfig *cfg)
{
    PuBackend requested_backend = cfg ? cfg->backend : PU_BACKEND_AUTO;
    PuRenderer requested_renderer = cfg ? cfg->renderer : PU_RENDERER_AUTO;
    fprintf(stderr, "[host] requested backend=%s renderer=%s\n",
            pu_backend_name(requested_backend), pu_renderer_name(requested_renderer));

    PuBackend attempts[3];
#if defined(__linux__)
    size_t attempt_count = pu_backend_plan(requested_backend,
                                            getenv("WAYLAND_DISPLAY"),
                                            getenv("DISPLAY"), attempts);
#else
    if (requested_backend != PU_BACKEND_AUTO) {
        fprintf(stderr, "[host] fatal: backend '%s' is only available on Linux\n",
                pu_backend_name(requested_backend));
        return NULL;
    }
    attempts[0] = PU_BACKEND_AUTO;
    size_t attempt_count = 1;
#endif

    PuWindow *w = (PuWindow *)calloc(1, sizeof *w);
    if (!w) return NULL;
    w->running = 1;
    w->dirty   = 1;
    w->scale   = 1.0f;

    int initialized = 0;
    for (size_t i = 0; i < attempt_count; ++i) {
        if (init_video_backend(attempts[i], requested_renderer) &&
            create_requested_renderer(w, cfg, requested_renderer)) {
            initialized = 1;
            break;
        }
        destroy_window_resources(w);
        SDL_Quit();
        if (requested_backend != PU_BACKEND_AUTO) break;
        if (i + 1 < attempt_count)
            SDL_Log("automatic backend attempt '%s' could not create the requested "
                    "window/renderer; trying fallback",
                    pu_backend_name(attempts[i]));
    }
    if (!initialized) {
        fprintf(stderr,
                "[host] fatal: backend '%s' with renderer '%s' could not initialize\n",
                pu_backend_name(requested_backend),
                pu_renderer_name(requested_renderer));
        free(w);
        return NULL;
    }

    const char *active_driver = SDL_GetCurrentVideoDriver();
    fprintf(stderr, "[host] selected backend=%s (SDL video driver=%s)\n",
            active_driver ? active_driver : "unknown",
            active_driver ? active_driver : "none");
    if (g_wake_event == (Uint32)-1) g_wake_event = SDL_RegisterEvents(1);

    recompute_scale(w);
    fprintf(stderr, "[host] selected renderer=%s\n",
            w->is_gl ? "gl" : (w->is_metal ? "metal" : "raster"));
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
    if (w->renderer) SDL_GetCurrentRenderOutputSize(w->renderer, &pw, &ph);
    else             SDL_GetWindowSizeInPixels(w->win, &pw, &ph);
    if (pw < 1) pw = 1;
    if (ph < 1) ph = 1;
    if (pw == w->width && ph == w->height) return;
    w->width = pw; w->height = ph;
#if defined(PU_SKIA_GL_BACKEND)
    if (w->gl_context && !SDL_GL_MakeCurrent(w->win, w->gl_context)) {
        SDL_Log("SDL_GL_MakeCurrent failed while resizing: %s", SDL_GetError());
        return;
    }
#endif
    pu_surface_resize(w->surface, pw, ph);
    if (w->tex) {
        SDL_Texture *next = SDL_CreateTexture(w->renderer, SDL_PIXELFORMAT_BGRA32,
                                              SDL_TEXTUREACCESS_STREAMING, pw, ph);
        if (!next) {
            SDL_Log("SDL_CreateTexture failed while resizing: %s", SDL_GetError());
            w->running = 0;
            return;
        }
        SDL_DestroyTexture(w->tex);
        w->tex = next;
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
    SDL_StartTextInput(w->win);   /* enable SDL_EVENT_TEXT_INPUT */
    SDL_AddEventWatch(pu_resize_watch, w);

    while (w->running) {
        SDL_Event e;
        if (SDL_WaitEventTimeout(&e, 8)) {
            handle_event(w, &e);
            while (SDL_PollEvent(&e)) handle_event(w, &e);
        }
        if (w->async_fn && w->async_fn(w->async_user) > 0) w->dirty = 1;
        if (w->dirty) { pu_sdl_paint(w); w->dirty = 0; }
    }

    SDL_RemoveEventWatch(pu_resize_watch, w);
    SDL_StopTextInput(w->win);
    return 0;
}

void pu_window_destroy(PuWindow *w)
{
    if (!w) return;
    destroy_window_resources(w);
    free(w);
    SDL_Quit();
}
