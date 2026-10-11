#include "cursor.h"
#include "server.h"
#include "session-lock.h"
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_cursor.h>
#include <wlr/types/wlr_cursor_shape_v1.h>
#include <wlr/types/wlr_data_device.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_xcursor_manager.h>
#include <wlr/util/log.h>
#include <linux/input-event-codes.h>

#define SHAPE_LAST WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_ZOOM_OUT
static const char *actions[] = {"motion", "press", "click", "drag",
    "drag-copy", "drag-move", "drag-no-drop"};

struct CursorOwner {
    struct PuCursor *state;
    struct wlr_surface *surface, *image;
    struct wl_list link;
    struct wl_listener destroy, image_destroy;
    uint32_t enter_serial;
    enum wp_cursor_shape_device_v1_shape shape;
    int32_t hotspot_x, hotspot_y;
    bool custom;
};

struct PuCursor {
    struct PuDesktop *desktop;
    struct wlr_cursor_shape_manager_v1 *shapes;
    struct wl_listener shape, surface_request, focus;
    struct wl_list owners;
    struct wlr_surface *drag_origin;
    struct wl_event_source *timer;
    char root[PATH_MAX], classic[PATH_MAX];
    const char *hover, *selected;
    uint64_t motion_until, click_until;
    uint32_t buttons[16];
    size_t button_count;
    double press_x, press_y;
    bool moved, static_mode, classic_mode, timer_armed;
};

static uint64_t now_ms(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void unlisten(struct wl_listener *listener)
{
    if (listener->link.next) wl_list_remove(&listener->link);
    wl_list_init(&listener->link);
}

static void listen(struct wl_signal *signal, struct wl_listener *listener, wl_notify_func_t notify)
{
    listener->notify = notify;
    wl_signal_add(signal, listener);
}

static uint32_t word(const uint8_t *p)
{ return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }

static void destroy_cursor(struct wlr_xcursor *cursor)
{
    if (!cursor) return;
    for (unsigned i = 0; i < cursor->image_count; i++) {
        free(cursor->images[i]->buffer);
        free(cursor->images[i]);
    }
    free(cursor->images); free(cursor->name); free(cursor);
}

/* Read only bounded Xcursor image chunks from our explicit directory. This
 * avoids process-global search-path changes and wlroots' implicit rabbit
 * fallback for a missing precision shape. Runtime never decodes artwork. */
static struct wlr_xcursor *load_cursor(const char *root, const char *name, int size, bool still)
{
    char path[PATH_MAX];
    if (snprintf(path, sizeof(path), "%s/cursors/%s", root, name) >= (int)sizeof(path)) return NULL;
    FILE *file = fopen(path, "rb");
    if (!file) {
        if (errno != ENOENT) wlr_log(WLR_ERROR, "Cannot read cursor %s: %s", path, strerror(errno));
        return NULL;
    }
    uint8_t *raw = NULL;
    struct wlr_xcursor *cursor = NULL;
    if (fseek(file, 0, SEEK_END)) goto bad;
    long length = ftell(file);
    if (length < 16 || length > 4 * 1024 * 1024 || fseek(file, 0, SEEK_SET)) goto bad;
    raw = malloc((size_t)length);
    if (!raw || fread(raw, 1, (size_t)length, file) != (size_t)length) goto bad;
    uint32_t header = word(raw + 4), count = word(raw + 12);
    if (word(raw) != 0x72756358 || word(raw + 8) != 0x10000 ||
        header < 16 || header > (uint32_t)length || count > 512 ||
        count > ((uint32_t)length - header) / 12) goto bad;
    uint32_t best = 0;
    for (uint32_t i = 0; i < count; i++) {
        const uint8_t *toc = raw + header + i * 12;
        uint32_t candidate = word(toc + 4);
        uint32_t pos = word(toc + 8);
        if (pos > (uint32_t)length - 16 || word(raw + pos + 4) != word(toc) ||
            word(raw + pos + 8) != candidate) goto bad;
        if (word(toc) == 0xfffd0002 && candidate > 0 && candidate <= 256 &&
            (!best || abs((int)candidate - size) < abs((int)best - size))) best = candidate;
    }
    if (!best) goto bad;
    cursor = calloc(1, sizeof(*cursor));
    if (!cursor) goto bad;
    cursor->name = strdup(name);
    cursor->images = calloc(count, sizeof(*cursor->images));
    if (!cursor->name || !cursor->images) goto bad;
    for (uint32_t i = 0; i < count; i++) {
        const uint8_t *toc = raw + header + i * 12;
        if (word(toc) != 0xfffd0002 || word(toc + 4) != best) continue;
        uint32_t pos = word(toc + 8);
        if (pos > (uint32_t)length - 36) goto bad;
        const uint8_t *chunk = raw + pos;
        uint32_t h = word(chunk), w = word(chunk + 16), y = word(chunk + 20);
        uint32_t hx = word(chunk + 24), hy = word(chunk + 28), delay = word(chunk + 32);
        if (h < 36 || h > (uint32_t)length - pos || word(chunk + 4) != 0xfffd0002 ||
            word(chunk + 8) != best || word(chunk + 12) != 1 ||
            !w || !y || w > 256 || y > 256 || hx >= w || hy >= y ||
            w * y > ((uint32_t)length - pos - h) / 4 || delay > 1000 ||
            cursor->image_count >= 64) goto bad;
        if (cursor->image_count) {
            struct wlr_xcursor_image *first = cursor->images[0];
            if (first->width != w || first->height != y || first->hotspot_x != hx ||
                first->hotspot_y != hy || delay < 16 || first->delay < 16) goto bad;
        }
        struct wlr_xcursor_image *image = calloc(1, sizeof(*image));
        if (!image) goto bad;
        cursor->images[cursor->image_count++] = image;
        image->width = w; image->height = y; image->hotspot_x = hx; image->hotspot_y = hy;
        image->delay = still ? 0 : delay;
        image->buffer = malloc(w * y * 4);
        if (!image->buffer) goto bad;
        for (uint32_t p = 0; p < w * y; p++) {
            uint32_t pixel = word(chunk + h + p * 4);
            uint32_t alpha = pixel >> 24;
            if ((pixel >> 16 & 255) > alpha || (pixel >> 8 & 255) > alpha ||
                (pixel & 255) > alpha) goto bad;
            memcpy(image->buffer + p * 4, &pixel, 4);
        }
        cursor->total_delay += image->delay;
        if (still) break;
    }
    if (!cursor->image_count) goto bad;
    free(raw); fclose(file);
    return cursor;
bad:
    wlr_log(WLR_ERROR, "Invalid or unreadable Xcursor %s", path);
    destroy_cursor(cursor); free(raw); fclose(file);
    return NULL;
}

static struct wlr_xcursor *clone_cursor(struct wlr_xcursor *source, const char *name)
{
    if (!source) return NULL;
    struct wlr_xcursor *cursor = calloc(1, sizeof(*cursor));
    if (!cursor) return NULL;
    cursor->name = strdup(name);
    cursor->images = calloc(source->image_count, sizeof(*cursor->images));
    if (!cursor->name || !cursor->images) { destroy_cursor(cursor); return NULL; }
    for (unsigned i = 0; i < source->image_count; i++) {
        struct wlr_xcursor_image *image = malloc(sizeof(*image));
        if (!image) { destroy_cursor(cursor); return NULL; }
        *image = *source->images[i];
        image->buffer = malloc(image->width * image->height * 4);
        cursor->images[cursor->image_count++] = image;
        if (!image->buffer) { destroy_cursor(cursor); return NULL; }
        memcpy(image->buffer, source->images[i]->buffer, image->width * image->height * 4);
        cursor->total_delay += image->delay;
    }
    return cursor;
}

static const char *conventional_name(unsigned shape)
{
    switch (shape) {
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_TEXT: return "xterm";
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_VERTICAL_TEXT: return "xterm";
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_E_RESIZE:
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_W_RESIZE:
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_COL_RESIZE: return "ew-resize";
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_N_RESIZE:
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_S_RESIZE:
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_ROW_RESIZE: return "ns-resize";
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_NE_RESIZE:
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_SW_RESIZE: return "nesw-resize";
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_NW_RESIZE:
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_SE_RESIZE: return "nwse-resize";
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_NOT_ALLOWED:
    case WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_NO_DROP: return "not-allowed";
    default: return wlr_cursor_shape_v1_name(shape);
    }
}

bool pu_cursor_load_scale(struct PuDesktop *desktop, float scale)
{
    struct PuCursor *state = desktop->cursor_state;
    if (!state) return false;
    struct wlr_xcursor_manager_theme *entry;
    wl_list_for_each(entry, &desktop->cursor_theme->scaled_themes, link)
        if (entry->scale == scale) return true;
    if (!isfinite(scale) || scale <= 0 || scale > 8) {
        wlr_log(WLR_ERROR, "Invalid cursor output scale %g", scale); return false;
    }
    entry = calloc(1, sizeof(*entry));
    struct wlr_xcursor_theme *theme = calloc(1, sizeof(*theme));
    struct wlr_xcursor_theme *fallback = NULL;
    bool default_missing = false;
    if (!entry || !theme) goto fail;
    entry->theme = theme; entry->scale = scale;
    theme->size = (int)(32 * scale);
    theme->name = strdup(state->root);
    theme->cursors = calloc(SHAPE_LAST + sizeof(actions) / sizeof(actions[0]), sizeof(*theme->cursors));
    if (!theme->name || !theme->cursors) goto fail;
    for (unsigned shape = 1; shape <= SHAPE_LAST; shape++) {
        const char *name = wlr_cursor_shape_v1_name(shape);
        struct wlr_xcursor *cursor = load_cursor(state->root, name, theme->size,
            state->static_mode || shape == WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT);
        if (!cursor) {
            if (shape == WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT) default_missing = true;
            wlr_log(WLR_ERROR, "Cursor theme %s missing/invalid %s at scale %g; conventional fallback",
                state->root, name, scale);
            cursor = load_cursor(state->classic, name, theme->size, true);
            if (!cursor) {
                if (!fallback) fallback = wlr_xcursor_theme_load(NULL, theme->size);
                cursor = clone_cursor(fallback ? wlr_xcursor_theme_get_cursor(fallback,
                    conventional_name(shape)) : NULL, name);
            }
        }
        /* A wrong default is unsafe for precision targets: fail explicitly if
         * even the conventional matching family cannot be obtained. */
        if (!cursor) goto fail;
        theme->cursors[theme->cursor_count++] = cursor;
    }
    for (size_t i = 0; i < sizeof(actions) / sizeof(actions[0]); i++) {
        bool indicator = i >= 4;
        struct wlr_xcursor *cursor = default_missing || state->classic_mode ||
            (state->static_mode && !indicator) ? NULL :
            load_cursor(state->root, actions[i], theme->size, state->static_mode);
        if (state->classic_mode && indicator) {
            unsigned shape = i == 4 ? WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_COPY :
                i == 5 ? WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_MOVE : WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_NO_DROP;
            cursor = clone_cursor(theme->cursors[shape - 1], actions[i]);
        }
        if (!cursor) {
            if (!state->static_mode && !state->classic_mode)
                wlr_log(WLR_ERROR, "Cursor action %s missing/invalid; theme default fallback", actions[i]);
            cursor = clone_cursor(theme->cursors[0], actions[i]);
        }
        if (!cursor) goto fail;
        theme->cursors[theme->cursor_count++] = cursor;
    }
    if (fallback) wlr_xcursor_theme_destroy(fallback);
    wl_list_insert(&desktop->cursor_theme->scaled_themes, &entry->link);
    return true;
fail:
    wlr_log(WLR_ERROR, "Cannot load complete cursor theme at scale %g", scale);
    if (fallback) wlr_xcursor_theme_destroy(fallback);
    if (theme) wlr_xcursor_theme_destroy(theme);
    free(entry);
    return false;
}

static struct CursorOwner *owner(struct PuCursor *state, struct wlr_surface *surface)
{
    struct CursorOwner *entry;
    wl_list_for_each(entry, &state->owners, link)
        if (entry->surface == surface) return entry;
    return NULL;
}

static void clear_actions(struct PuCursor *state)
{
    state->motion_until = state->click_until = 0;
    state->button_count = 0; state->moved = false;
}

static void image_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct CursorOwner *entry = wl_container_of(listener, entry, image_destroy);
    unlisten(&entry->image_destroy);
    entry->image = NULL; /* Destroyed explicit image stays hidden, not inherited. */
    pu_cursor_refresh(entry->state->desktop);
}

static void owner_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct CursorOwner *entry = wl_container_of(listener, entry, destroy);
    struct PuCursor *state = entry->state;
    bool current = state->drag_origin == entry->surface ||
        state->desktop->seat->pointer_state.focused_surface == entry->surface;
    unlisten(&entry->destroy); unlisten(&entry->image_destroy);
    wl_list_remove(&entry->link);
    if (state->drag_origin == entry->surface) state->drag_origin = NULL;
    free(entry);
    if (current) clear_actions(state);
    pu_cursor_refresh(state->desktop);
}

static struct CursorOwner *ensure_owner(struct PuCursor *state, struct wlr_surface *surface)
{
    if (!surface) return NULL;
    struct CursorOwner *entry = owner(state, surface);
    if (entry) return entry;
    entry = calloc(1, sizeof(*entry));
    if (!entry) {
        wlr_log(WLR_ERROR, "Cannot allocate cursor owner");
        wl_client_post_no_memory(wl_resource_get_client(surface->resource));
        return NULL;
    }
    entry->state = state; entry->surface = surface;
    entry->shape = WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT;
    wl_list_init(&entry->image_destroy.link);
    listen(&surface->events.destroy, &entry->destroy, owner_destroyed);
    wl_list_insert(&state->owners, &entry->link);
    return entry;
}

static struct CursorOwner *admit(struct PuCursor *state, struct wlr_seat_client *client, uint32_t serial)
{
    struct PuDesktop *desktop = state->desktop;
    struct wlr_surface *surface = desktop->seat->pointer_state.focused_surface;
    if (desktop->stopping || desktop->grab != PU_DESKTOP_PASSTHROUGH || !client ||
        client->seat != desktop->seat || !wlr_seat_client_validate_event_serial(client, serial)) goto reject;
    bool drag = state->drag_origin && desktop->seat->drag &&
        desktop->seat->drag->seat_client == client;
    if (drag) surface = state->drag_origin;
    else if (client != desktop->seat->pointer_state.focused_client) goto reject;
    if (pu_session_lock_active(desktop) && !pu_session_lock_surface(desktop, surface)) goto reject;
    struct CursorOwner *entry = owner(state, surface);
    if (!entry || (serial != entry->enter_serial && !(drag && serial == desktop->seat->drag_serial)))
        goto reject;
    return entry;
reject:
    wlr_log(WLR_DEBUG, "Ignoring cursor request without current owner and valid enter/drag serial (%u)", serial);
    return NULL;
}

static void shape_requested(struct wl_listener *listener, void *data)
{
    struct PuCursor *state = wl_container_of(listener, state, shape);
    struct wlr_cursor_shape_manager_v1_request_set_shape_event *event = data;
    if (event->device_type != WLR_CURSOR_SHAPE_MANAGER_V1_DEVICE_TYPE_POINTER ||
        event->shape < 1 || event->shape > SHAPE_LAST) {
        wlr_log(WLR_DEBUG, "Ignoring unsupported cursor shape/device"); return;
    }
    struct CursorOwner *entry = admit(state, event->seat_client, event->serial);
    if (!entry) return;
    unlisten(&entry->image_destroy); entry->image = NULL;
    entry->custom = false; entry->shape = event->shape;
    if (entry->shape != WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT) clear_actions(state);
    pu_cursor_refresh(state->desktop);
}

static void surface_requested(struct wl_listener *listener, void *data)
{
    struct PuCursor *state = wl_container_of(listener, state, surface_request);
    struct wlr_seat_pointer_request_set_cursor_event *event = data;
    struct CursorOwner *entry = admit(state, event->seat_client, event->serial);
    if (!entry) return;
    unlisten(&entry->image_destroy);
    entry->custom = true; entry->image = event->surface;
    entry->hotspot_x = event->hotspot_x; entry->hotspot_y = event->hotspot_y;
    if (entry->image) listen(&entry->image->events.destroy, &entry->image_destroy, image_destroyed);
    clear_actions(state);
    pu_cursor_refresh(state->desktop);
}

static void focus_changed(struct wl_listener *listener, void *data)
{
    struct PuCursor *state = wl_container_of(listener, state, focus);
    struct wlr_seat_pointer_focus_change_event *event = data;
    struct CursorOwner *entry = ensure_owner(state, event->new_surface);
    /* wlroots emits focus_change immediately after issuing pointer.enter. */
    if (entry) entry->enter_serial = wl_display_get_serial(state->desktop->display);
    if (!state->drag_origin) clear_actions(state);
    state->hover = "default";
    pu_cursor_refresh(state->desktop);
}

static void arm_timer(struct PuCursor *state, uint64_t deadline)
{
    if (!deadline) {
        if (state->timer_armed) wl_event_source_timer_update(state->timer, 0);
        state->timer_armed = false;
        return;
    }
    uint64_t now = now_ms();
    int delay = deadline > now ? (int)(deadline - now) : 1;
    if (wl_event_source_timer_update(state->timer, delay) < 0) {
        wlr_log(WLR_ERROR, "Cannot arm cursor action deadline");
        state->desktop->failed = true;
        wl_display_terminate(state->desktop->display);
        return;
    }
    state->timer_armed = true;
}

void pu_cursor_refresh(struct PuDesktop *desktop)
{
    struct PuCursor *state = desktop->cursor_state;
    if (!state || desktop->stopping) return;
    uint64_t now = now_ms(), deadline = 0;
    struct CursorOwner *entry = owner(state, state->drag_origin ?
        state->drag_origin : desktop->seat->pointer_state.focused_surface);
    const char *name = state->hover;
    if (desktop->grab == PU_DESKTOP_RESIZE) name = wlr_xcursor_get_resize_name(desktop->grab_edges);
    else if (desktop->grab == PU_DESKTOP_MOVE) name = "drag";
    else if (entry && entry->custom) {
        state->selected = entry->image ? "client-surface" : "hidden";
        wlr_cursor_set_surface(desktop->cursor, entry->image, entry->hotspot_x, entry->hotspot_y);
        arm_timer(state, 0);
        return;
    } else if (entry) name = wlr_cursor_shape_v1_name(entry->shape);
    bool normal = !strcmp(name, "default") && !pu_session_lock_active(desktop);
    if (normal && !state->static_mode && !state->classic_mode) {
        if (state->drag_origin || (state->button_count && state->moved)) name = "drag";
        else if (state->button_count) name = "press";
        else if (state->click_until > now) { name = "click"; deadline = state->click_until; }
        else if (state->motion_until > now) { name = "motion"; deadline = state->motion_until; }
    }
    if (!normal) state->motion_until = state->click_until = 0;
    if (normal && state->drag_origin && desktop->seat->drag) {
        struct wlr_data_source *source = desktop->seat->drag->source;
        if (source && source->current_dnd_action == WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY) name = "drag-copy";
        else if (source && source->current_dnd_action == WL_DATA_DEVICE_MANAGER_DND_ACTION_MOVE) name = "drag-move";
        else if (source && !source->accepted && desktop->seat->drag->focus) name = "drag-no-drop";
        /* wlroots exposes source action as state, not an action-change signal.
         * Sample only during the confirmed native drag, never idle/JS polling. */
        deadline = now + 80;
    }
    if (state->static_mode || state->classic_mode) {
        if (!strcmp(name, "drag") || !strcmp(name, "motion") || !strcmp(name, "press") || !strcmp(name, "click"))
            name = "default";
    }
    state->selected = name;
    wlr_cursor_set_xcursor(desktop->cursor, desktop->cursor_theme, name);
    arm_timer(state, deadline);
}

static int timer_fired(void *data)
{
    struct PuCursor *state = data;
    state->timer_armed = false;
    pu_cursor_refresh(state->desktop);
    return 0;
}

void pu_cursor_motion(struct PuDesktop *desktop)
{
    struct PuCursor *state = desktop->cursor_state;
    if (!state || pu_session_lock_active(desktop)) return;
    double dx = desktop->cursor->x - state->press_x, dy = desktop->cursor->y - state->press_y;
    if (state->button_count && dx * dx + dy * dy > 25) state->moved = true;
    state->motion_until = now_ms() + 120;
    pu_cursor_refresh(desktop);
}

void pu_cursor_button(struct PuDesktop *desktop, uint32_t button, bool pressed)
{
    struct PuCursor *state = desktop->cursor_state;
    if (!state || pu_session_lock_active(desktop)) return;
    size_t i = 0;
    while (i < state->button_count && state->buttons[i] != button) i++;
    if (pressed && i == state->button_count) {
        if (state->button_count == sizeof(state->buttons) / sizeof(state->buttons[0])) {
            wlr_log(WLR_ERROR, "Too many held cursor buttons"); pu_cursor_cancel(desktop); return;
        }
        if (!state->button_count) {
            state->press_x = desktop->cursor->x; state->press_y = desktop->cursor->y;
            state->moved = false;
        }
        state->buttons[state->button_count++] = button;
        state->click_until = 0;
    } else if (!pressed && i < state->button_count) {
        state->buttons[i] = state->buttons[--state->button_count];
        if (!state->button_count && !state->moved && button == BTN_LEFT && !state->drag_origin) {
            struct wlr_xcursor *click = wlr_xcursor_manager_get_xcursor(desktop->cursor_theme, "click", 1);
            state->click_until = now_ms() + (click ? click->total_delay : 0);
        }
    }
    pu_cursor_refresh(desktop);
}

void pu_cursor_cancel(struct PuDesktop *desktop)
{
    if (!desktop->cursor_state) return;
    clear_actions(desktop->cursor_state);
    pu_cursor_refresh(desktop);
}

void pu_cursor_compositor(struct PuDesktop *desktop, const char *name)
{
    struct PuCursor *state = desktop->cursor_state;
    if (!state) return;
    bool known = false;
    for (unsigned shape = 1; shape <= SHAPE_LAST; shape++)
        if (name && !strcmp(name, wlr_cursor_shape_v1_name(shape))) known = true;
    if (!known) { wlr_log(WLR_ERROR, "Invalid compositor cursor name"); return; }
    state->hover = name;
    pu_cursor_refresh(desktop);
}

void pu_cursor_drag(struct PuDesktop *desktop, struct wlr_surface *origin)
{
    struct PuCursor *state = desktop->cursor_state;
    if (!state) return;
    state->drag_origin = origin;
    if (origin) ensure_owner(state, origin);
    clear_actions(state);
    pu_cursor_refresh(desktop);
}

bool pu_cursor_init(struct PuDesktop *desktop)
{
    struct PuCursor *state = calloc(1, sizeof(*state));
    if (!state) return false;
    desktop->cursor_state = state; state->desktop = desktop;
    wl_list_init(&state->owners);
    state->hover = state->selected = "default";
    char executable[PATH_MAX], base[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (n < 0) { wlr_log(WLR_ERROR, "Cannot locate cursor resource root"); return false; }
    executable[n] = '\0';
    char *slash = strrchr(executable, '/');
    if (!slash) return false;
    *slash = '\0';
    const char *root = !strncmp(executable, PU_CURSOR_BUILD_DIR, strlen(PU_CURSOR_BUILD_DIR)) &&
        (executable[strlen(PU_CURSOR_BUILD_DIR)] == '/' || executable[strlen(PU_CURSOR_BUILD_DIR)] == '\0') ?
        PU_CURSOR_SOURCE_DIR : NULL;
    if (!root) {
        if (snprintf(base, sizeof(base), "%s/%s", executable, PU_CURSOR_FROM_BIN) >= (int)sizeof(base)) return false;
        root = base;
    }
    if (snprintf(state->classic, sizeof(state->classic), "%s/PollyClassic", root) >= (int)sizeof(state->classic))
        return false;
    const char *setting = getenv("POLLY_CURSOR_THEME");
    state->classic_mode = setting && !strcmp(setting, "classic");
    if (setting && !state->classic_mode && strcmp(setting, "PollyRabbit") && setting[0] != '/') {
        wlr_log(WLR_ERROR, "POLLY_CURSOR_THEME must be PollyRabbit, classic or an absolute theme directory");
        return false;
    }
    if (setting && setting[0] == '/') n = snprintf(state->root, sizeof(state->root), "%s", setting);
    else n = snprintf(state->root, sizeof(state->root), "%s/%s", root,
        state->classic_mode ? "PollyClassic" : "PollyRabbit");
    if (n >= (ssize_t)sizeof(state->root)) return false;
    const char *mode = getenv("POLLY_CURSOR_STATIC");
    if (mode && strcmp(mode, "0") && strcmp(mode, "1")) {
        wlr_log(WLR_ERROR, "POLLY_CURSOR_STATIC must be 0 or 1"); return false;
    }
    state->static_mode = mode && !strcmp(mode, "1");
    desktop->cursor_theme = wlr_xcursor_manager_create(NULL, 32);
    if (!desktop->cursor_theme || !pu_cursor_load_scale(desktop, 1)) return false;
    state->timer = wl_event_loop_add_timer(wl_display_get_event_loop(desktop->display), timer_fired, state);
    state->shapes = wlr_cursor_shape_manager_v1_create(desktop->display, 1);
    if (!state->timer || !state->shapes) return false;
    listen(&state->shapes->events.request_set_shape, &state->shape, shape_requested);
    listen(&desktop->seat->events.request_set_cursor, &state->surface_request, surface_requested);
    listen(&desktop->seat->pointer_state.events.focus_change, &state->focus, focus_changed);
    wlr_log(WLR_INFO, "Cursor theme %s, 32 logical pixels, animation %s", state->root,
        state->static_mode || state->classic_mode ? "static" : "enabled");
    return true;
}

void pu_cursor_finish(struct PuDesktop *desktop)
{
    struct PuCursor *state = desktop->cursor_state;
    if (!state) return;
    if (state->timer) wl_event_source_remove(state->timer);
    unlisten(&state->shape); unlisten(&state->surface_request); unlisten(&state->focus);
    struct CursorOwner *entry, *tmp;
    wl_list_for_each_safe(entry, tmp, &state->owners, link) {
        unlisten(&entry->destroy); unlisten(&entry->image_destroy);
        wl_list_remove(&entry->link); free(entry);
    }
    if (desktop->cursor) wlr_cursor_unset_image(desktop->cursor);
    wlr_xcursor_manager_destroy(desktop->cursor_theme); desktop->cursor_theme = NULL;
    free(state); desktop->cursor_state = NULL;
}

const char *pu_cursor_selected(struct PuDesktop *desktop)
{ return desktop->cursor_state ? desktop->cursor_state->selected : NULL; }
bool pu_cursor_timer_active(struct PuDesktop *desktop)
{ return desktop->cursor_state && desktop->cursor_state->timer_armed; }
