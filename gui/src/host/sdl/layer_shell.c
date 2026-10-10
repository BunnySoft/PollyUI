#include "host/sdl/layer_shell.h"
#include "layer-shell-client.h"
#if defined(PU_SESSION_LOCK)
#include "session-lock-client.h"
#endif
#if defined(PU_INPUT_METHOD)
#include "input-method-v2-client.h"
#endif

#include <limits.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>

static PuLockSurfaceFn lock_surface_factory;
static PuInputPopupFn input_popup_factory;

void pu_layer_set_role_factories(PuLockSurfaceFn lock_surface, PuInputPopupFn input_popup)
{
    lock_surface_factory = lock_surface;
    input_popup_factory = input_popup;
}

struct PuLayer {
    PuWindow *owner;
    SDL_Window *window;
    struct wl_display *display;
    struct wl_surface *native;
    struct zwlr_layer_shell_v1 *shell;
    struct zwlr_layer_surface_v1 *surface;
    int configured, closed, failed;
    int input_popup;
#if defined(PU_SESSION_LOCK)
    struct ext_session_lock_surface_v1 *lock_surface;
#endif
#if defined(PU_INPUT_METHOD)
    struct zwp_input_popup_surface_v2 *popup;
#endif
};

struct Registry {
    struct wl_compositor *compositor;
    struct zwlr_layer_shell_v1 *shell;
    int viewporter, fractional_scale;
};

static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version)
{
    struct Registry *state = data;
    if (!state->shell && version >= 4 && strcmp(interface, "zwlr_layer_shell_v1") == 0)
        state->shell = wl_registry_bind(registry, name, &zwlr_layer_shell_v1_interface, 4);
    if (!state->compositor && version >= 4 && strcmp(interface, "wl_compositor") == 0)
        state->compositor = wl_registry_bind(registry, name, &wl_compositor_interface, 4);
    if (strcmp(interface, "wp_viewporter") == 0) state->viewporter = 1;
    if (strcmp(interface, "wp_fractional_scale_manager_v1") == 0) state->fractional_scale = 1;
}

static void global_remove(void *data, struct wl_registry *registry, uint32_t name)
{ (void)data; (void)registry; (void)name; }

static const struct wl_registry_listener registry_listener = { global, global_remove };

static void sync_done(void *data, struct wl_callback *callback, uint32_t serial)
{ (void)callback; (void)serial; *(int *)data = 1; }
static const struct wl_callback_listener sync_listener = { .done = sync_done };

static int wait_for(PuLayer *layer, int *ready, int teardown)
{
    Uint64 start = SDL_GetTicks();
    while (!*ready && (teardown || (!layer->closed && !layer->failed))) {
        if (wl_display_flush(layer->display) < 0 && errno != EAGAIN && errno != EINTR)
            return SDL_SetError("Cannot flush layer requests: %s", strerror(errno));
        SDL_PumpEvents(); /* Queue native input without consuming another window's events. */
        if (wl_display_get_error(layer->display))
            return SDL_SetError("Wayland layer protocol connection failed");
        if (SDL_GetTicks() - start >= 3000)
            return SDL_SetError("Timed out waiting for the compositor's layer response");
        if (!*ready) SDL_Delay(1);
    }
    if (!teardown && (layer->closed || layer->failed))
        return SDL_SetError("Layer closed or failed during configuration");
    return 1;
}

static void configured(void *data, struct zwlr_layer_surface_v1 *surface,
                       uint32_t serial, uint32_t width, uint32_t height)
{
    PuLayer *layer = data;
    int current_width = 0, current_height = 0;
    if (width > INT_MAX || height > INT_MAX ||
        !SDL_GetWindowSize(layer->window, &current_width, &current_height)) {
        SDL_SetError("Invalid layer surface dimensions");
        layer->failed = 1;
        pu_sdl_layer_failed(layer->owner, "Layer configure");
        return;
    }
    zwlr_layer_surface_v1_ack_configure(surface, serial);
    if (!SDL_SetWindowSize(layer->window, width ? (int)width : current_width,
                           height ? (int)height : current_height)) {
        layer->failed = 1;
        pu_sdl_layer_failed(layer->owner, "Layer resize");
        return;
    }
    layer->configured = 1;
}

static void closed(void *data, struct zwlr_layer_surface_v1 *surface)
{
    (void)surface;
    PuLayer *layer = data;
    layer->closed = 1;
    pu_window_close(layer->owner);
}

static const struct zwlr_layer_surface_v1_listener layer_listener = { configured, closed };

#if defined(PU_SESSION_LOCK)
static void lock_configured(void *data, struct ext_session_lock_surface_v1 *surface,
                            uint32_t serial, uint32_t width, uint32_t height)
{
    PuLayer *layer = data;
    if (!width || !height || width > INT_MAX || height > INT_MAX) {
        layer->failed = 1;
        SDL_SetError("Invalid session-lock surface size");
        pu_sdl_layer_failed(layer->owner, "Lock configure");
        return;
    }
    ext_session_lock_surface_v1_ack_configure(surface, serial);
    if (!SDL_SetWindowSize(layer->window, (int)width, (int)height)) {
        layer->failed = 1;
        pu_sdl_layer_failed(layer->owner, "Lock resize");
        return;
    }
    layer->configured = 1;
}
static const struct ext_session_lock_surface_v1_listener lock_surface_listener = {.configure = lock_configured};
#endif

PuLayer *pu_layer_prepare(PuWindow *owner, int input_popup)
{
    PuLayer *layer = calloc(1, sizeof(*layer));
    if (!layer) { SDL_SetError("Cannot allocate layer surface state"); return NULL; }
    layer->owner = owner;
    layer->input_popup = input_popup;
    layer->display = SDL_GetPointerProperty(SDL_GetGlobalProperties(),
        SDL_PROP_GLOBAL_VIDEO_WAYLAND_WL_DISPLAY_POINTER, NULL);
    if (!layer->display) {
        SDL_SetError("Layer surfaces require the Wayland video driver");
        free(layer);
        return NULL;
    }
    struct Registry state = {0};
    struct wl_registry *registry = wl_display_get_registry(layer->display);
    int synchronized = 0;
    struct wl_callback *sync = registry ? wl_display_sync(layer->display) : NULL;
    if (!registry || !sync) {
        if (registry) wl_registry_destroy(registry);
        SDL_SetError("Cannot allocate Wayland registry sync");
        free(layer);
        return NULL;
    }
    wl_registry_add_listener(registry, &registry_listener, &state);
    wl_callback_add_listener(sync, &sync_listener, &synchronized);
    int ready = wait_for(layer, &synchronized, 0);
    wl_callback_destroy(sync);
    wl_registry_destroy(registry);
    if (!ready || (!input_popup && !state.shell) || !state.compositor || !state.viewporter || !state.fractional_scale) {
        if (state.shell) zwlr_layer_shell_v1_destroy(state.shell);
        if (state.compositor) wl_compositor_destroy(state.compositor);
        if (ready) SDL_SetError("Required layer-shell v4, viewporter or fractional-scale globals are unavailable or unauthorized");
        free(layer);
        return NULL;
    }
    layer->shell = state.shell;
    layer->native = wl_compositor_create_surface(state.compositor);
    wl_compositor_destroy(state.compositor);
    if (!layer->native) {
        SDL_SetError("Cannot allocate owned Wayland surface");
        pu_layer_destroy(layer);
        return NULL;
    }
    return layer;
}

struct wl_surface *pu_layer_surface(PuLayer *layer) { return layer->native; }

int pu_layer_attach(PuLayer *layer, SDL_Window *window, const PuWindowConfig *config)
{
    layer->window = window;
    SDL_PropertiesID properties = SDL_GetWindowProperties(window);
    if (SDL_GetPointerProperty(properties, SDL_PROP_WINDOW_WAYLAND_SURFACE_POINTER, NULL) != layer->native ||
        SDL_GetPointerProperty(properties, SDL_PROP_WINDOW_WAYLAND_XDG_SURFACE_POINTER, NULL))
        return SDL_SetError("SDL did not retain the external roleless surface");
    if (config->lock_output) {
#if defined(PU_SESSION_LOCK)
        if (!lock_surface_factory)
            return SDL_SetError("No authorized session-lock surface factory is installed");
        struct wl_output *output = SDL_GetPointerProperty(SDL_GetDisplayProperties(config->lock_output),
            SDL_PROP_DISPLAY_WAYLAND_WL_OUTPUT_POINTER, NULL);
        layer->lock_surface = lock_surface_factory(layer->native, output);
        if (!layer->lock_surface) return 0;
        ext_session_lock_surface_v1_add_listener(layer->lock_surface, &lock_surface_listener, layer);
        return wait_for(layer, &layer->configured, 0);
#else
        return SDL_SetError("Session-lock surfaces are unavailable in this build");
#endif
    }
    if (layer->input_popup) {
#if defined(PU_INPUT_METHOD)
        if (!input_popup_factory)
            return SDL_SetError("No authorized input-method surface factory is installed");
        layer->popup = input_popup_factory(layer->native);
        if (!layer->popup) return 0;
        wl_surface_commit(layer->native);
        return 1;
#else
        return SDL_SetError("Input-method surfaces are unavailable in this build");
#endif
    }
    struct wl_output *output = NULL;
    if (config->layer->output) {
        output = SDL_GetPointerProperty(SDL_GetDisplayProperties(config->layer->output),
            SDL_PROP_DISPLAY_WAYLAND_WL_OUTPUT_POINTER, NULL);
        if (!output) return SDL_SetError("Unknown Wayland output ID");
    }
    const PuLayerConfig *options = config->layer;
    layer->surface = zwlr_layer_shell_v1_get_layer_surface(layer->shell, layer->native, output,
        options->layer, config->title ? config->title : "org.pollyui.shell");
    zwlr_layer_shell_v1_destroy(layer->shell);
    layer->shell = NULL;
    if (!layer->surface) return SDL_SetError("Cannot create layer surface");
    zwlr_layer_surface_v1_add_listener(layer->surface, &layer_listener, layer);
    zwlr_layer_surface_v1_set_size(layer->surface, config->width, config->height);
    zwlr_layer_surface_v1_set_anchor(layer->surface, options->anchors);
    zwlr_layer_surface_v1_set_exclusive_zone(layer->surface, options->exclusive_zone);
    zwlr_layer_surface_v1_set_keyboard_interactivity(layer->surface, options->keyboard);
    zwlr_layer_surface_v1_set_margin(layer->surface, options->margin_top, options->margin_right,
                                    options->margin_bottom, options->margin_left);
    wl_surface_commit(layer->native);
    return wait_for(layer, &layer->configured, 0);
}

void pu_layer_unmap(PuLayer *layer)
{
    if (!layer) return;
    int unmapped = 0;
#if defined(PU_SESSION_LOCK)
    if (layer->lock_surface) {
        ext_session_lock_surface_v1_destroy(layer->lock_surface); layer->lock_surface = NULL; unmapped = 1;
    }
#endif
    if (layer->surface) {
        zwlr_layer_surface_v1_destroy(layer->surface); layer->surface = NULL; unmapped = 1;
    }
#if defined(PU_INPUT_METHOD)
    if (layer->popup) {
        zwp_input_popup_surface_v2_destroy(layer->popup); layer->popup = NULL; unmapped = 1;
    }
#endif
    if (unmapped) {
        /* SDL drains input leave events for its own toplevels, not external
         * roles. Keep the imported surface alive until those events arrive. */
        if (layer->window && !wl_display_get_error(layer->display)) {
            int synchronized = 0;
            struct wl_callback *sync = wl_display_sync(layer->display);
            int ok = sync && wl_callback_add_listener(sync, &sync_listener, &synchronized) >= 0;
            if (!ok) SDL_SetError("Cannot allocate Wayland layer unmap sync");
            else ok = wait_for(layer, &synchronized, 1);
            if (sync) wl_callback_destroy(sync);
            if (!ok) pu_sdl_layer_failed(layer->owner, "Layer unmap");
        }
    }
}

void pu_layer_destroy(PuLayer *layer)
{
    if (!layer) return;
    pu_layer_unmap(layer);
    if (layer->shell) zwlr_layer_shell_v1_destroy(layer->shell);
    if (layer->native) wl_surface_destroy(layer->native);
    free(layer);
}
