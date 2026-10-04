// HostEngine — SDL3 backend for PollyUI (Tier 1: macOS/Linux/Windows; mobile
// later). One file implementing the PuWindow contract from host/win32/window.h
// via SDL3. See docs/PORTING.md §4.
//
// GPU surface per platform:
//   Apple  -> Metal: SDL_Metal_CreateView -> CAMetalLayer -> pu_surface_create_metal
//   Linux  -> SDL EGL/GLES context -> Skia Ganesh (auto, gl or raster policy)
//   else   -> GL:    pu_surface_create_gpu (where available)
//   any    -> raster fallback: pu_surface_create + SDL_Renderer streaming blit
//
// One SDL_WaitEventTimeout/poll loop routes events to all native windows.
// Application-wide animation/async work is pumped once per loop tick.

#include "host/win32/window.h"   /* the shared HostEngine contract */
#include "render/skia_c.h"

#include <SDL3/SDL.h>

#include <stdlib.h>
#include <string.h>
#if defined(PU_LAYER_SHELL)
#include "host/sdl/layer_shell.h"
#endif

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
    struct PuWindow *next;
    SDL_Window   *win;
    SDL_Renderer *renderer;   /* raster fallback only */
    SDL_Texture  *tex;        /* raster fallback only */
    PuSurface    *surface;
    SDL_GLContext gl_context;
#if defined(PU_LAYER_SHELL)
    PuLayer *layer_surface;
#endif
#if defined(PU_METAL_BACKEND)
    SDL_MetalView metal_view;
#endif
    int           width, height;   /* physical pixels */
    float         scale;           /* logical -> physical */
    int           running;
    int           dirty;
    int           frameless;
    int           custom_chrome;   /* 1 => app draws chrome: enable drag hit-test */
    int           is_metal;
    int           exit_code;
    int           presented;
    int           suppress_text;
    unsigned      pressed_buttons;
    int           registered, close_notified, text_started;
    PuCloseFn     close_fn;
    void         *close_user;

    PuPaintFn   paint_fn;   void *paint_user;
    PuPointerFn pointer_fn; void *pointer_user;
    PuKeyFn     key_fn;     void *key_user;
    PuWheelFn   wheel_fn;   void *wheel_user;
    PuDropFn    drop_fn;    void *drop_user;
    char **drop_files;
    char *drop_text, *drop_source;
    const char *drop_error;
    size_t drop_count, drop_bytes, drop_text_size;
    int drop_active, drop_has_text;
    float drop_x, drop_y;
    PuAsyncFn   async_fn;   void *async_user;
    PuRegionFn  region_fn;  void *region_user;
};

static Uint32 g_wake_event = (Uint32)-1;   /* registered user event for wake */
static PuWindow *g_windows;
static int g_initialized, g_loop_running, g_system_users;
static void pu_sync_size(PuWindow *w);

static void shutdown_video(void)
{
    if (g_initialized && !g_windows && !g_loop_running && !g_system_users) {
        SDL_Quit();
        g_initialized = 0;
        g_wake_event = (Uint32)-1;
    }
}

static void fail_window(PuWindow *w, const char *operation)
{
    SDL_Log("%s failed: %s", operation, SDL_GetError());
    w->exit_code = 1;
    w->running = 0;
}

#if defined(PU_LAYER_SHELL)
void pu_sdl_layer_failed(PuWindow *w, const char *operation) { fail_window(w, operation); }
#endif

static int ensure_video(void)
{
    if (!SDL_SetHintWithPriority(SDL_HINT_QUIT_ON_LAST_WINDOW_CLOSE, "0", SDL_HINT_OVERRIDE)) {
        SDL_Log("Cannot select host-managed window lifetime: %s", SDL_GetError());
        return 0;
    }
#if defined(__linux__)
    const char *renderer = getenv("PU_RENDERER");
    if (renderer && strcmp(renderer, "auto") && strcmp(renderer, "gl") && strcmp(renderer, "raster")) {
        SDL_Log("PU_RENDERER must be auto, gl or raster");
        return 0;
    }
#endif
    if (!g_initialized && !SDL_Init(SDL_INIT_VIDEO)) {
        SDL_Log("SDL_Init failed: %s", SDL_GetError());
        return 0;
    }
    g_initialized = 1;
    if (g_wake_event == (Uint32)-1) g_wake_event = SDL_RegisterEvents(1);
    if (!g_wake_event || g_wake_event == (Uint32)-1) {
        SDL_Log("SDL_RegisterEvents failed: %s", SDL_GetError());
        shutdown_video();
        return 0;
    }
    return 1;
}

int pu_window_system_init(void)
{
    if (!ensure_video()) return 0;
    g_system_users++;
    return 1;
}

void pu_window_system_shutdown(void)
{
    if (g_system_users) g_system_users--;
    shutdown_video();
}

PuDisplayInfo *pu_window_displays(int *count)
{
    *count = 0;
    if (!ensure_video()) return NULL;
    SDL_DisplayID *ids = SDL_GetDisplays(count);
    if (!ids) { SDL_Log("Cannot enumerate displays: %s", SDL_GetError()); return NULL; }
    PuDisplayInfo *items = calloc((size_t)*count + 1, sizeof(*items));
    if (!items) { SDL_free(ids); SDL_Log("Cannot allocate display list"); return NULL; }
    for (int i = 0; i < *count; i++) {
        SDL_Rect bounds;
        const char *name = SDL_GetDisplayName(ids[i]);
        if (!name || !SDL_GetDisplayBounds(ids[i], &bounds)) {
            SDL_Log("Cannot query display: %s", SDL_GetError());
            free(items); SDL_free(ids); return NULL;
        }
        items[i].id = ids[i];
        items[i].x = bounds.x; items[i].y = bounds.y;
        items[i].width = bounds.w; items[i].height = bounds.h;
        items[i].scale = SDL_GetDisplayContentScale(ids[i]);
        if (items[i].scale <= 0) {
            SDL_Log("Cannot query display scale: %s", SDL_GetError());
            free(items); SDL_free(ids); return NULL;
        }
        SDL_utf8strlcpy(items[i].name, name, sizeof(items[i].name));
    }
    SDL_free(ids);
    return items;
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
        case SDLK_INSERT:    return "Insert";
        case SDLK_LSHIFT: case SDLK_RSHIFT: return "Shift";
        case SDLK_LCTRL: case SDLK_RCTRL: return "Control";
        case SDLK_LALT: case SDLK_RALT: return "Alt";
        case SDLK_LGUI: case SDLK_RGUI: return "Meta";
        case SDLK_CAPSLOCK: return "CapsLock";
        case SDLK_NUMLOCKCLEAR: return "NumLock";
        case SDLK_PRINTSCREEN: return "PrintScreen";
        case SDLK_PAUSE: return "Pause";
        default:             return NULL;
    }
}

static unsigned key_modifiers(SDL_Keymod mods)
{
    return ((mods & SDL_KMOD_SHIFT) ? PU_MOD_SHIFT : 0) |
           ((mods & SDL_KMOD_CTRL) ? PU_MOD_CTRL : 0) |
           ((mods & SDL_KMOD_ALT) ? PU_MOD_ALT : 0) |
           ((mods & SDL_KMOD_GUI) ? PU_MOD_META : 0) |
           ((mods & SDL_KMOD_CAPS) ? PU_MOD_CAPS : 0) |
           ((mods & SDL_KMOD_NUM) ? PU_MOD_NUM : 0);
}

static int mouse_button(Uint8 button)
{
    switch (button) {
    case SDL_BUTTON_LEFT: return 0;
    case SDL_BUTTON_MIDDLE: return 1;
    case SDL_BUTTON_RIGHT: return 2;
    case SDL_BUTTON_X1: return 3;
    case SDL_BUTTON_X2: return 4;
    default: return -1;
    }
}

static unsigned mouse_buttons(SDL_MouseButtonFlags buttons)
{
    return ((buttons & SDL_BUTTON_LMASK) ? 1 : 0) |
           ((buttons & SDL_BUTTON_RMASK) ? 2 : 0) |
           ((buttons & SDL_BUTTON_MMASK) ? 4 : 0) |
           ((buttons & SDL_BUTTON_X1MASK) ? 8 : 0) |
           ((buttons & SDL_BUTTON_X2MASK) ? 16 : 0);
}

static const char *key_code(SDL_Scancode scancode, char *buffer, size_t size)
{
    if (scancode >= SDL_SCANCODE_A && scancode <= SDL_SCANCODE_Z) {
        SDL_snprintf(buffer, size, "Key%c", 'A' + scancode - SDL_SCANCODE_A);
        return buffer;
    }
    if (scancode >= SDL_SCANCODE_1 && scancode <= SDL_SCANCODE_0) {
        SDL_snprintf(buffer, size, "Digit%c", "1234567890"[scancode - SDL_SCANCODE_1]);
        return buffer;
    }
    if (scancode >= SDL_SCANCODE_F1 && scancode <= SDL_SCANCODE_F12) {
        SDL_snprintf(buffer, size, "F%d", scancode - SDL_SCANCODE_F1 + 1); return buffer;
    }
    if (scancode >= SDL_SCANCODE_F13 && scancode <= SDL_SCANCODE_F24) {
        SDL_snprintf(buffer, size, "F%d", scancode - SDL_SCANCODE_F13 + 13); return buffer;
    }
    if (scancode >= SDL_SCANCODE_KP_1 && scancode <= SDL_SCANCODE_KP_9) {
        SDL_snprintf(buffer, size, "Numpad%d", scancode - SDL_SCANCODE_KP_1 + 1); return buffer;
    }
    switch (scancode) {
        case SDL_SCANCODE_LSHIFT: return "ShiftLeft"; case SDL_SCANCODE_RSHIFT: return "ShiftRight";
        case SDL_SCANCODE_LCTRL: return "ControlLeft"; case SDL_SCANCODE_RCTRL: return "ControlRight";
        case SDL_SCANCODE_LALT: return "AltLeft"; case SDL_SCANCODE_RALT: return "AltRight";
        case SDL_SCANCODE_LGUI: return "MetaLeft"; case SDL_SCANCODE_RGUI: return "MetaRight";
        case SDL_SCANCODE_SPACE: return "Space";
        case SDL_SCANCODE_KP_ENTER: return "NumpadEnter";
        case SDL_SCANCODE_KP_0: return "Numpad0";
        case SDL_SCANCODE_KP_PERIOD: return "NumpadDecimal";
        case SDL_SCANCODE_KP_PLUS: return "NumpadAdd";
        case SDL_SCANCODE_KP_MINUS: return "NumpadSubtract";
        case SDL_SCANCODE_KP_MULTIPLY: return "NumpadMultiply";
        case SDL_SCANCODE_KP_DIVIDE: return "NumpadDivide";
        case SDL_SCANCODE_KP_EQUALS: return "NumpadEqual";
        case SDL_SCANCODE_MINUS: return "Minus"; case SDL_SCANCODE_EQUALS: return "Equal";
        case SDL_SCANCODE_LEFTBRACKET: return "BracketLeft"; case SDL_SCANCODE_RIGHTBRACKET: return "BracketRight";
        case SDL_SCANCODE_SEMICOLON: return "Semicolon"; case SDL_SCANCODE_APOSTROPHE: return "Quote";
        case SDL_SCANCODE_GRAVE: return "Backquote"; case SDL_SCANCODE_BACKSLASH: return "Backslash";
        case SDL_SCANCODE_COMMA: return "Comma"; case SDL_SCANCODE_PERIOD: return "Period";
        case SDL_SCANCODE_SLASH: return "Slash";
        default: {
            const char *name = sdl_key_name(SDL_GetKeyFromScancode(scancode, SDL_KMOD_NONE, true));
            return name ? name : "Unidentified";
        }
    }
}

static const char *key_name(const SDL_KeyboardEvent *event, char *buffer, size_t size)
{
    const char *special = sdl_key_name(event->key);
    if (special) return special;
    if (event->scancode >= SDL_SCANCODE_KP_1 && event->scancode <= SDL_SCANCODE_KP_9) {
        int digit = event->scancode - SDL_SCANCODE_KP_1;
        const char *navigation[] = { "End", "ArrowDown", "PageDown", "ArrowLeft", "Clear",
                                     "ArrowRight", "Home", "ArrowUp", "PageUp" };
        if (!(event->mod & SDL_KMOD_NUM)) return navigation[digit];
        buffer[0] = (char)('1' + digit); buffer[1] = 0; return buffer;
    }
    switch (event->scancode) {
        case SDL_SCANCODE_KP_0: return event->mod & SDL_KMOD_NUM ? "0" : "Insert";
        case SDL_SCANCODE_KP_PERIOD: return event->mod & SDL_KMOD_NUM ? "." : "Delete";
        case SDL_SCANCODE_KP_PLUS: return "+";
        case SDL_SCANCODE_KP_MINUS: return "-";
        case SDL_SCANCODE_KP_MULTIPLY: return "*";
        case SDL_SCANCODE_KP_DIVIDE: return "/";
        case SDL_SCANCODE_KP_EQUALS: return "=";
        default: break;
    }
    if (event->scancode >= SDL_SCANCODE_F1 && event->scancode <= SDL_SCANCODE_F24) {
        const char *code = key_code(event->scancode, buffer, size);
        if (code[0] == 'F') return code;
    }
    SDL_Keycode cp = SDL_GetKeyFromScancode(event->scancode, event->mod, false);
    if (!cp) cp = event->key;
    int length;
    if (cp < 0x20 || cp == 0x7f || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
        return "Unidentified";
    if (cp < 0x80) { buffer[0] = (char)cp; length = 1; }
    else if (cp < 0x800) {
        buffer[0] = (char)(0xc0 | (cp >> 6)); buffer[1] = (char)(0x80 | (cp & 63)); length = 2;
    } else if (cp < 0x10000) {
        buffer[0] = (char)(0xe0 | (cp >> 12)); buffer[1] = (char)(0x80 | ((cp >> 6) & 63));
        buffer[2] = (char)(0x80 | (cp & 63)); length = 3;
    } else {
        buffer[0] = (char)(0xf0 | (cp >> 18)); buffer[1] = (char)(0x80 | ((cp >> 12) & 63));
        buffer[2] = (char)(0x80 | ((cp >> 6) & 63)); buffer[3] = (char)(0x80 | (cp & 63)); length = 4;
    }
    buffer[length] = 0;
    return buffer;
}

static void recompute_scale(PuWindow *w)
{
    float s = SDL_GetWindowDisplayScale(w->win);
    w->scale = (s > 0.0f) ? s : 1.0f;
}

static int make_current(PuWindow *w)
{
    if (w->gl_context && !SDL_GL_MakeCurrent(w->win, w->gl_context)) {
        fail_window(w, "SDL_GL_MakeCurrent"); return 0;
    }
    return 1;
}

static int presentation_interval(void)
{
    /* An occluded Wayland surface may receive no frame callbacks. Never stall
     * the shared UI thread waiting for one window while others need events. */
    return strcmp(SDL_GetCurrentVideoDriver(), "wayland") == 0 ? 0 : 1;
}

/* Render one frame and present (GPU) or blit (raster). */
static int pu_sdl_paint(PuWindow *w, const char *capture_path)
{
    if (w->exit_code || !make_current(w)) return 0;
#if defined(PU_METAL_BACKEND)
    if (w->is_metal) pu_metal_begin_frame(w->surface);
    if (w->is_metal && !pu_surface_valid(w->surface)) return 0;
#endif
    if (!pu_surface_valid(w->surface)) {
        fail_window(w, "Skia surface"); return 0;
    }
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

    if (!make_current(w)) return 0;
    const char *capture = capture_path;
#if defined(__linux__)
    if (!capture) capture = getenv("PU_CAPTURE_FRAME");
#endif
    int capture_ok = 1;
    if (capture && *capture && !pu_surface_save_png(w->surface, capture)) {
        SDL_Log("Cannot capture rendered frame to %s", capture);
        capture_ok = 0;
        if (!capture_path) { w->exit_code = 1; w->running = 0; return 0; }
    }
    if (pu_surface_is_gl(w->surface)) {
        pu_surface_present(w->surface);   /* GPU: flush + present drawable/swap */
        if (w->gl_context && !SDL_GL_SwapWindow(w->win)) {
            fail_window(w, "SDL_GL_SwapWindow"); return 0;
        }
    } else {
        /* Raster drawing is on the CPU even if SDL uses a GPU for presentation. */
        const void *pixels = pu_surface_pixels(w->surface);
        int row = pu_surface_row_bytes(w->surface);
        if (!pixels || !w->renderer || !w->tex) {
            fail_window(w, "Raster frame resources");
            return 0;
        }
        if (!SDL_UpdateTexture(w->tex, NULL, pixels, row) ||
            !SDL_RenderClear(w->renderer) ||
            !SDL_RenderTexture(w->renderer, w->tex, NULL, NULL) ||
            !SDL_RenderPresent(w->renderer)) {
            fail_window(w, "SDL frame presentation");
            return 0;
        }
    }
    if (!w->presented || getenv("PU_TRACE_FRAMES")) {
        w->presented = 1;
        if (getenv("PU_TRACE_STARTUP") || getenv("PU_TRACE_FRAMES"))
            SDL_Log("PollyUI frame presented: %dx%d, driver=%s, Skia=%s",
                w->width, w->height, SDL_GetCurrentVideoDriver(),
                w->gl_context ? "GLES" : pu_surface_is_gl(w->surface) ? "GPU" : "raster");
    }
    return capture_ok;
}

static int create_surface(PuWindow *w)
{
    if (!SDL_GetWindowSizeInPixels(w->win, &w->width, &w->height)) {
        fail_window(w, "SDL_GetWindowSizeInPixels"); return 0;
    }
    if (w->width  < 1) w->width  = 1;
    if (w->height < 1) w->height = 1;

#if defined(PU_METAL_BACKEND)
    w->metal_view = SDL_Metal_CreateView(w->win);
    if (w->metal_view) {
        void *layer = SDL_Metal_GetLayer(w->metal_view);
        w->surface = pu_surface_create_metal(layer, w->width, w->height);
        if (w->surface) { w->is_metal = 1; return 1; }
        SDL_Metal_DestroyView(w->metal_view);
        w->metal_view = NULL;
    }
#elif !defined(__linux__)
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
    if (!SDL_SetRenderVSync(w->renderer, presentation_interval()))
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
    if (!SDL_SetTextureBlendMode(w->tex, SDL_BLENDMODE_NONE)) {
        fail_window(w, "SDL texture copy mode"); return 0;
    }
    return 1;
}

static int create_native(PuWindow *w, const PuWindowConfig *config,
                         const char *title, int width, int height, SDL_WindowFlags flags)
{
    if (config && config->layer) {
#if defined(PU_LAYER_SHELL)
        if (strcmp(SDL_GetCurrentVideoDriver(), "wayland")) {
            SDL_SetError("Layer surfaces require the Wayland video driver");
            fail_window(w, "Layer creation");
            return 0;
        }
        w->layer_surface = pu_layer_prepare(w);
        if (!w->layer_surface) { fail_window(w, "Layer preparation"); return 0; }
        if (!SDL_GetHint(SDL_HINT_MOUSE_FOCUS_CLICKTHROUGH) &&
            !SDL_SetHint(SDL_HINT_MOUSE_FOCUS_CLICKTHROUGH, "1")) {
            fail_window(w, "Layer focus-click-through");
            return 0;
        }
        SDL_PropertiesID props = SDL_CreateProperties();
        bool ok = props &&
            SDL_SetStringProperty(props, SDL_PROP_WINDOW_CREATE_TITLE_STRING, title) &&
            SDL_SetNumberProperty(props, SDL_PROP_WINDOW_CREATE_WIDTH_NUMBER, width) &&
            SDL_SetNumberProperty(props, SDL_PROP_WINDOW_CREATE_HEIGHT_NUMBER, height) &&
            SDL_SetBooleanProperty(props, SDL_PROP_WINDOW_CREATE_HIGH_PIXEL_DENSITY_BOOLEAN, true) &&
            SDL_SetBooleanProperty(props, SDL_PROP_WINDOW_CREATE_TRANSPARENT_BOOLEAN, config->layer->transparent != 0) &&
            SDL_SetPointerProperty(props, SDL_PROP_WINDOW_CREATE_WAYLAND_WL_SURFACE_POINTER,
                pu_layer_surface(w->layer_surface)) &&
            SDL_SetBooleanProperty(props, SDL_PROP_WINDOW_CREATE_OPENGL_BOOLEAN, true);
        if (ok) w->win = SDL_CreateWindowWithProperties(props);
        if (props) SDL_DestroyProperties(props);
        if (!w->win) {
            if (!(flags & SDL_WINDOW_OPENGL)) fail_window(w, "Custom Wayland window");
            return 0;
        }
        if (!pu_layer_attach(w->layer_surface, w->win, config)) {
            fail_window(w, "Layer creation");
            return 0;
        }
#else
        SDL_SetError("Layer surfaces are not supported by this host build");
        fail_window(w, "Layer creation");
        return 0;
#endif
    } else {
        w->win = SDL_CreateWindow(title, width, height, flags);
        if (!w->win) {
            if (!(flags & SDL_WINDOW_OPENGL)) fail_window(w, "SDL_CreateWindow");
            return 0;
        }
    }
    return 1;
}

#if defined(__linux__)
static PuGlProc gl_proc(void *user, const char *name)
{
    (void)user;
    return SDL_GL_GetProcAddress(name);
}

static int create_gl(PuWindow *w, const PuWindowConfig *config, const char *title,
                     int width, int height, SDL_WindowFlags flags)
{
    if (!SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES) ||
        !SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3) ||
        !SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0) ||
        !SDL_GL_SetAttribute(SDL_GL_RED_SIZE, 8) ||
        !SDL_GL_SetAttribute(SDL_GL_GREEN_SIZE, 8) ||
        !SDL_GL_SetAttribute(SDL_GL_BLUE_SIZE, 8) ||
        !SDL_GL_SetAttribute(SDL_GL_ALPHA_SIZE, 8) ||
        !SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 8) ||
        !SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1)) return 0;
    if (!create_native(w, config, title, width, height, flags | SDL_WINDOW_OPENGL)) return 0;
    w->gl_context = SDL_GL_CreateContext(w->win);
    if (!w->gl_context || !SDL_GL_MakeCurrent(w->win, w->gl_context)) return 0;
    if (!SDL_GetWindowSizeInPixels(w->win, &w->width, &w->height)) return 0;
    w->surface = pu_surface_create_current_gl(gl_proc, NULL, w->width, w->height);
    if (!w->surface) { SDL_SetError("Skia GLES surface initialization failed"); return 0; }
    if (!SDL_GL_SetSwapInterval(presentation_interval()))
        SDL_Log("GLES VSync unavailable: %s", SDL_GetError());
    return 1;
}
#endif

PuWindow *pu_window_create(const PuWindowConfig *cfg)
{
    if (cfg && cfg->layer) {
        const PuLayerConfig *layer = cfg->layer;
        if (cfg->width < 0 || cfg->height < 0 || layer->layer < 0 || layer->layer > 3 ||
            (layer->anchors & ~15u) || layer->exclusive_zone < -1 ||
            layer->keyboard < 0 || layer->keyboard > 2 ||
            (!cfg->width && (layer->anchors & 12) != 12) ||
            (!cfg->height && (layer->anchors & 3) != 3)) {
            SDL_Log("Invalid layer surface configuration");
            return NULL;
        }
    }
#if defined(__linux__)
    const char *renderer = getenv("PU_RENDERER");
    if (!renderer) renderer = "auto";
    if (strcmp(renderer, "auto") && strcmp(renderer, "gl") && strcmp(renderer, "raster")) {
        SDL_Log("PU_RENDERER must be auto, gl or raster"); return NULL;
    }
#endif
    if (!ensure_video()) return NULL;

    PuWindow *w = (PuWindow *)calloc(1, sizeof *w);
    if (!w) { SDL_Log("Cannot allocate SDL window state"); shutdown_video(); return NULL; }
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
#if defined(__linux__)
    if (strcmp(renderer, "raster") != 0 && !create_gl(w, cfg, title, cw, ch, flags)) {
        SDL_Log("GLES initialization failed: %s", SDL_GetError());
        if (strcmp(renderer, "gl") == 0 || w->exit_code) { pu_window_destroy(w); return NULL; }
#if defined(PU_LAYER_SHELL)
        pu_layer_unmap(w->layer_surface);
#endif
        if (w->surface) { pu_surface_destroy(w->surface); w->surface = NULL; }
        if (w->gl_context) { SDL_GL_DestroyContext(w->gl_context); w->gl_context = NULL; }
        if (w->win) { SDL_DestroyWindow(w->win); w->win = NULL; }
#if defined(PU_LAYER_SHELL)
        pu_layer_destroy(w->layer_surface);
        w->layer_surface = NULL;
#endif
        SDL_Log("PU_RENDERER=auto: falling back to Skia raster");
    }
#endif
    if (!w->win) {
        if (!create_native(w, cfg, title, cw, ch, flags)) { pu_window_destroy(w); return NULL; }
    }

    recompute_scale(w);
    if (!w->surface && !create_surface(w)) { pu_window_destroy(w); return NULL; }
#if defined(__APPLE__)
    pu_macos_tune_live_resize(SDL_GetPointerProperty(SDL_GetWindowProperties(w->win),
                              SDL_PROP_WINDOW_COCOA_WINDOW_POINTER, NULL));
#endif
    w->next = g_windows;
    g_windows = w;
    w->registered = 1;
    return w;
}

void pu_window_set_paint  (PuWindow *w, PuPaintFn   fn, void *u){ if(w){w->paint_fn=fn;   w->paint_user=u;   w->dirty=1;} }
void pu_window_set_pointer(PuWindow *w, PuPointerFn fn, void *u){ if(w){w->pointer_fn=fn; w->pointer_user=u;} }
void pu_window_set_key    (PuWindow *w, PuKeyFn     fn, void *u){ if(w){w->key_fn=fn;     w->key_user=u;} }
void pu_window_set_wheel  (PuWindow *w, PuWheelFn   fn, void *u){ if(w){w->wheel_fn=fn;   w->wheel_user=u;} }
void pu_window_set_drop(PuWindow *w, PuDropFn fn, void *u)
{
    if (!w) return;
    w->drop_fn = fn; w->drop_user = u;
    if (fn) {
        SDL_SetEventEnabled(SDL_EVENT_DROP_BEGIN, true);
        SDL_SetEventEnabled(SDL_EVENT_DROP_POSITION, true);
        SDL_SetEventEnabled(SDL_EVENT_DROP_FILE, true);
        SDL_SetEventEnabled(SDL_EVENT_DROP_TEXT, true);
        SDL_SetEventEnabled(SDL_EVENT_DROP_COMPLETE, true);
    }
}
void pu_window_set_async  (PuWindow *w, PuAsyncFn   fn, void *u){ if(w){w->async_fn=fn;   w->async_user=u;} }
void pu_window_set_region (PuWindow *w, PuRegionFn  fn, void *u){ if(w){w->region_fn=fn;  w->region_user=u;} }
void pu_window_set_close(PuWindow *w, PuCloseFn fn, void *u) { if (w) { w->close_fn = fn; w->close_user = u; } }
int pu_window_is_open(PuWindow *w) { return w && w->running; }
void pu_window_redraw(PuWindow *w) { if (w && w->running) w->dirty = 1; }
int pu_window_save_frame(PuWindow *w, const char *path)
{
    if (w && w->is_metal) { SDL_Log("Frame capture is not implemented for Metal windows"); return 0; }
    if (!w || !w->running || !w->presented || !make_current(w)) {
        SDL_Log("Cannot capture a closed or not-yet-presented window");
        return 0;
    }
    pu_sync_size(w);
    return pu_sdl_paint(w, path);
}

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
    if (!make_current(w)) return;
    pu_surface_resize(w->surface, pw, ph);
    if (!w->is_metal && !pu_surface_valid(w->surface)) { fail_window(w, "Skia resize"); return; }
    if (w->tex) {
        SDL_DestroyTexture(w->tex);
        w->tex = SDL_CreateTexture(w->renderer, SDL_PIXELFORMAT_BGRA32,
                                   SDL_TEXTUREACCESS_STREAMING, pw, ph);
        if (!w->tex) { fail_window(w, "SDL resize texture"); return; }
        if (!SDL_SetTextureBlendMode(w->tex, SDL_BLENDMODE_NONE)) {
            fail_window(w, "SDL resized texture copy mode"); return;
        }
    }
    w->dirty = 1;
}

static void clear_drop(PuWindow *w)
{
    for (size_t i = 0; i < w->drop_count; i++) free(w->drop_files[i]);
    free(w->drop_files); free(w->drop_text); free(w->drop_source);
    w->drop_files = NULL; w->drop_text = w->drop_source = NULL;
    w->drop_count = w->drop_bytes = w->drop_text_size = 0;
    w->drop_has_text = w->drop_active = 0; w->drop_error = NULL;
}

static void deliver_drop(PuWindow *w, PuDropType type)
{
    if (!w->drop_fn) return;
    PuDropEvent event = { .type = type, .x = w->drop_x, .y = w->drop_y,
        .files = (const char *const *)w->drop_files, .file_count = w->drop_count,
        .text = w->drop_has_text ? w->drop_text : NULL, .source = w->drop_source, .error = w->drop_error };
    if (w->drop_fn(&event, w->drop_user)) w->dirty = 1;
}

static void receive_drop(PuWindow *w, const SDL_DropEvent *event)
{
    bool entering = event->type == SDL_EVENT_DROP_BEGIN || !w->drop_active;
    if (entering) {
        clear_drop(w); w->drop_active = 1;
    }
    w->drop_x = event->x; w->drop_y = event->y;
    if (!w->drop_source && event->source) {
        if (strlen(event->source) > 1024) w->drop_error = "Drop source metadata exceeds supported limits";
        else {
            w->drop_source = strdup(event->source);
            if (!w->drop_source) w->drop_error = "Cannot allocate drop metadata";
        }
    }
    if (entering) deliver_drop(w, PU_DROP_ENTER);
    if (!w->drop_error && event->data &&
        (event->type == SDL_EVENT_DROP_FILE || event->type == SDL_EVENT_DROP_TEXT)) {
        size_t size = strlen(event->data);
        size_t extra = 1;
        if (w->drop_bytes > 16u * 1024u * 1024u || extra > 16u * 1024u * 1024u - w->drop_bytes ||
            size > 16u * 1024u * 1024u - w->drop_bytes - extra ||
            (event->type == SDL_EVENT_DROP_FILE && w->drop_count >= 1024))
            w->drop_error = "Drop payload exceeds supported limits";
        else if (event->type == SDL_EVENT_DROP_FILE) {
            char **files = realloc(w->drop_files, (w->drop_count + 1) * sizeof(*files));
            if (!files) w->drop_error = "Cannot allocate dropped file list";
            else {
                w->drop_files = files;
                files[w->drop_count] = strdup(event->data);
                if (!files[w->drop_count]) w->drop_error = "Cannot allocate dropped file name";
                else { w->drop_count++; w->drop_bytes += size + 1; }
            }
        } else {
            size_t previous = w->drop_text_size;
            char *text = realloc(w->drop_text, previous + size + 2);
            if (!text) w->drop_error = "Cannot allocate dropped text";
            else {
                w->drop_text = text;
                if (w->drop_has_text) text[previous++] = '\n';
                memcpy(text + previous, event->data, size + 1);
                w->drop_text_size = previous + size;
                w->drop_bytes += size + 1; w->drop_has_text = 1;
            }
        }
    }
    if (event->type == SDL_EVENT_DROP_POSITION) deliver_drop(w, PU_DROP_MOTION);
    if (event->type == SDL_EVENT_DROP_COMPLETE) {
        if (w->drop_error) { SDL_Log("%s", w->drop_error); deliver_drop(w, PU_DROP_ERROR); }
        else deliver_drop(w, w->drop_count || w->drop_has_text ? PU_DROP_DATA : PU_DROP_LEAVE);
        clear_drop(w);
    }
}

static void handle_event(PuWindow *w, const SDL_Event *e)
{
    /* SDL3 reports mouse/touch coordinates in logical window points (the same
     * coordinate space as our layout, which is computed at width/height in
     * points). So pass them straight through — do NOT divide by the DPI scale,
     * or clicks land at a fraction of their position on HiDPI displays. */
    switch (e->type) {
        case SDL_EVENT_DROP_BEGIN:
        case SDL_EVENT_DROP_POSITION:
        case SDL_EVENT_DROP_FILE:
        case SDL_EVENT_DROP_TEXT:
        case SDL_EVENT_DROP_COMPLETE:
            receive_drop(w, &e->drop);
            break;
        case SDL_EVENT_QUIT:
        case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
            w->running = 0; break;

        case SDL_EVENT_MOUSE_BUTTON_DOWN:
        case SDL_EVENT_MOUSE_BUTTON_UP: {
            int button = mouse_button(e->button.button);
            if (button < 0) { SDL_Log("Unsupported mouse button %u", e->button.button); break; }
            int down = e->type == SDL_EVENT_MOUSE_BUTTON_DOWN;
            if (down) w->pressed_buttons |= pu_button_mask(button);
            else w->pressed_buttons &= ~pu_button_mask(button);
            PuPointerEvent event = {
                .type = down ? PU_POINTER_DOWN : PU_POINTER_UP,
                .x = e->button.x, .y = e->button.y, .button = button,
                .buttons = w->pressed_buttons, .modifiers = key_modifiers(SDL_GetModState()),
            };
            if (w->pointer_fn) {
                int changed = w->pointer_fn(&event, w->pointer_user);
                if (!down) {
                    event.type = button == 0 ? PU_POINTER_CLICK :
                                 button == 2 ? PU_POINTER_CONTEXT_MENU : PU_POINTER_AUXCLICK;
                    changed |= w->pointer_fn(&event, w->pointer_user);
                }
                if (changed > 0) w->dirty = 1;
            }
            break;
        }
        case SDL_EVENT_MOUSE_MOTION: {
            w->pressed_buttons = mouse_buttons(e->motion.state);
            PuPointerEvent event = {
                .type = PU_POINTER_MOVE, .x = e->motion.x, .y = e->motion.y,
                .button = -1, .buttons = w->pressed_buttons, .modifiers = key_modifiers(SDL_GetModState()),
            };
            if (w->pointer_fn && w->pointer_fn(&event, w->pointer_user) > 0) w->dirty = 1;
            break;
        }
        case SDL_EVENT_MOUSE_WHEEL:
            /* SDL wheel.y > 0 scrolls up; DOM deltaY > 0 scrolls down -> negate. */
            if (w->wheel_fn) {
                PuWheelEvent event = {
                    .x = e->wheel.mouse_x, .y = e->wheel.mouse_y,
                    .delta_x = e->wheel.x * 40.0f, .delta_y = -e->wheel.y * 40.0f,
                    .modifiers = key_modifiers(SDL_GetModState()),
                };
                if (w->wheel_fn(&event, w->wheel_user) > 0) w->dirty = 1;
            }
            break;

        case SDL_EVENT_KEY_DOWN:
        case SDL_EVENT_KEY_UP: {
            char name[32], code[32];
            PuKeyEvent event = {
                .type = e->type == SDL_EVENT_KEY_DOWN ? PU_KEY_DOWN : PU_KEY_UP,
                .key = key_name(&e->key, name, sizeof(name)),
                .code = key_code(e->key.scancode, code, sizeof(code)),
                .modifiers = key_modifiers(e->key.mod),
                .repeat = e->key.repeat,
            };
            int result = w->key_fn ? w->key_fn(&event, w->key_user) : 0;
            w->suppress_text = event.type == PU_KEY_DOWN && (result & PU_INPUT_PREVENT_DEFAULT);
            if (result & PU_INPUT_REDRAW) w->dirty = 1;
            break;
        }
        case SDL_EVENT_TEXT_INPUT: {
            PuKeyEvent event = { .type = PU_KEY_TEXT, .text = e->text.text,
                                .modifiers = key_modifiers(SDL_GetModState()) };
            if (!w->suppress_text && w->key_fn &&
                (w->key_fn(&event, w->key_user) & PU_INPUT_REDRAW)) w->dirty = 1;
            w->suppress_text = 0;
            break;
        }
        case SDL_EVENT_WINDOW_FOCUS_LOST:
            w->suppress_text = 0;
            w->pressed_buttons = 0;
            break;
        case SDL_EVENT_WINDOW_MOUSE_LEAVE:
            if (w->pointer_fn) {
                PuPointerEvent event = { .type = PU_POINTER_MOVE, .x = -1, .y = -1, .button = -1 };
                if (w->pointer_fn(&event, w->pointer_user)) w->dirty = 1;
            }
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
#if !defined(__linux__)
static bool SDLCALL pu_resize_watch(void *userdata, SDL_Event *e)
{
    (void)userdata;
    PuWindow *w = g_windows;
    while (w && (!w->running || e->window.windowID != SDL_GetWindowID(w->win))) w = w->next;
    if (w && (e->type == SDL_EVENT_WINDOW_RESIZED ||
              e->type == SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED ||
              e->type == SDL_EVENT_WINDOW_EXPOSED) &&
        e->window.windowID == SDL_GetWindowID(w->win)) {
        pu_sync_size(w);
        pu_sdl_paint(w, NULL);     /* repaint live during the OS resize loop */
        w->dirty = 0;
    }
    return true;             /* keep delivering the event to the main loop */
}
#endif

int pu_window_run(PuWindow *w)
{
    return w ? pu_window_run_all(NULL, NULL) : 1;
}

static void route_event(const SDL_Event *e)
{
    if (e->type == SDL_EVENT_QUIT) {
        for (PuWindow *w = g_windows; w; w = w->next) pu_window_close(w);
        return;
    }
    SDL_Window *target = SDL_GetWindowFromEvent(e);
    if (!target) return;
    for (PuWindow *w = g_windows; w; w = w->next) {
        if (w->running && w->win == target) { handle_event(w, e); return; }
    }
}

int pu_window_run_all(PuAsyncFn frame, void *user)
{
    if (g_loop_running || !g_initialized) {
        SDL_Log("Cannot run an uninitialized or nested window loop");
        return 1;
    }
    int result = 0;
    g_loop_running = 1;
#if !defined(__linux__)
    if (!SDL_AddEventWatch(pu_resize_watch, NULL)) {
        SDL_Log("SDL_AddEventWatch failed: %s", SDL_GetError());
        g_loop_running = 0;
        return 1;
    }
#endif

    /* Wayland must finish SDL's configure/ack processing before presenting.
     * Rendering reentrantly from a resize watch can commit the wrong size. */
    for (;;) {
        for (PuWindow *w = g_windows; w; w = w->next) {
            if (w->running && !w->text_started) {
                if (!SDL_StartTextInput(w->win)) fail_window(w, "SDL_StartTextInput");
                else w->text_started = 1;
            }
        }
        /* Closing callbacks may remove themselves or create replacement windows. */
        for (;;) {
            PuWindow *closed = g_windows;
            while (closed && (closed->running || closed->close_notified)) closed = closed->next;
            if (!closed) break;
            if (closed->exit_code) result = closed->exit_code;
            closed->close_notified = 1;
            if (closed->text_started) SDL_StopTextInput(closed->win);
            SDL_HideWindow(closed->win);
            if (closed->close_fn) closed->close_fn(closed, closed->close_user);
        }
        PuWindow *live = g_windows;
        while (live && !live->running) live = live->next;
        if (!live) break;
        SDL_Event e;
        if (SDL_WaitEventTimeout(&e, 8)) {
            route_event(&e);
            while (SDL_PollEvent(&e)) route_event(&e);
        }
        if (frame && frame(user) > 0)
            for (PuWindow *w = g_windows; w; w = w->next) pu_window_redraw(w);
        for (PuWindow *w = g_windows; w; w = w->next) {
            if (w->running && w->async_fn && w->async_fn(w->async_user) > 0) w->dirty = 1;
            if (w->dirty && w->running) { pu_sdl_paint(w, NULL); w->dirty = 0; }
        }
    }

#if !defined(__linux__)
    SDL_RemoveEventWatch(pu_resize_watch, NULL);
#endif
    g_loop_running = 0;
    shutdown_video();
    return result;
}

void pu_window_destroy(PuWindow *w)
{
    if (!w) return;
    if (w->registered) {
        PuWindow **link = &g_windows;
        while (*link && *link != w) link = &(*link)->next;
        if (*link) *link = w->next;
    }
#if defined(PU_LAYER_SHELL)
    pu_layer_unmap(w->layer_surface);
#endif
    if (w->gl_context) SDL_GL_MakeCurrent(w->win, w->gl_context);
    if (w->surface)  pu_surface_destroy(w->surface);
    if (w->gl_context) SDL_GL_DestroyContext(w->gl_context);
    if (w->tex)      SDL_DestroyTexture(w->tex);
    if (w->renderer) SDL_DestroyRenderer(w->renderer);
#if defined(PU_METAL_BACKEND)
    if (w->metal_view) SDL_Metal_DestroyView(w->metal_view);
#endif
    if (w->win)      SDL_DestroyWindow(w->win);
#if defined(PU_LAYER_SHELL)
    pu_layer_destroy(w->layer_surface);
#endif
    clear_drop(w);
    free(w);
    shutdown_video();
}
