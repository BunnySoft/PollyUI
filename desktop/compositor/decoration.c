#include "decoration.h"
#include "decorator-process.h"
#include "decoration-layout.h"
#include "decoration-frame.h"
#include "appearance-document.h"
#include "server.h"
#include "polly-appearance-server.h"
#include <drm_fourcc.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wlr/interfaces/wlr_buffer.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_xdg_decoration_v1.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/edges.h>
#include <wlr/util/log.h>

struct Snapshot {
    unsigned refs;
    struct PuDecorationLayout layout;
    uint64_t generation;
    int fd;
    uint32_t length;
};
struct FrameBudget { unsigned refs; size_t bytes; };
struct FrameMapping { unsigned refs; void *data; size_t length; struct FrameBudget *budget; };
struct StripBuffer { struct wlr_buffer base; struct FrameMapping *mapping; uint32_t offset, stride; };
struct Frame {
    struct wlr_scene_tree *tree;
    struct Snapshot *snapshot;
    uint32_t meta[PU_FRAME_META_WORDS];
};
struct PuDecorations {
    struct PuDesktop *desktop;
    struct wlr_xdg_decoration_manager_v1 *manager;
    struct wl_global *appearance, *theme_feed;
    struct wl_listener new_decoration;
    struct Snapshot *snapshot;
    struct FrameBudget *budget;
    struct AppearanceClient *renderer;
    struct wl_list appearance_clients, theme_watchers;
    uint32_t theme_revision, next_token;
    bool initial_theme_consumed;
};
struct AppearanceClient {
    struct PuDecorations *state;
    struct wl_resource *resource;
    struct wl_list link;
    struct Snapshot *staged;
    uint32_t serial;
    uint64_t base_generation;
    bool renderer_role;
};
struct ThemeWatcher {
    struct PuDecorations *state;
    struct wl_resource *resource;
    struct wl_list link;
    bool notified;
};
struct PuDecoration {
    struct PuDesktopView *view;
    struct wlr_xdg_toplevel_decoration_v1 *protocol;
    struct wl_listener request_mode, destroy;
    struct wlr_scene_tree *tree;
    struct Snapshot *current, *pending, *requested;
    struct Frame *shown, *ready;
    struct wl_event_source *timeout;
    uint32_t token, revision, accepted_revision, meta[PU_FRAME_META_WORDS];
    int hover;
    bool decorated, failed;
    char *title;
};

static bool publisher_preparing(struct PuDecorations *state)
{
    struct AppearanceClient *owner;
    wl_list_for_each(owner, &state->appearance_clients, link)
        if (!owner->renderer_role && owner->staged) return true;
    return false;
}
static bool bootstrap_allowed(struct AppearanceClient *owner)
{
    struct PuDecorations *state = owner->state;
    return owner->renderer_role && state->renderer == owner &&
        !state->initial_theme_consumed && state->snapshot->fd < 0 && !publisher_preparing(state);
}
void pu_decorations_service_changed(struct PuDesktop *desktop)
{
    struct PuDecorations *state = desktop->decorations;
    if (!state || desktop->stopping) return;
    const char *message;
    uint32_t service = pu_decorator_status(desktop, &message);
    struct AppearanceClient *owner;
    wl_list_for_each(owner, &state->appearance_clients, link)
        polly_appearance_v1_send_renderer_status(owner->resource, service, bootstrap_allowed(owner), message);
}

static struct Snapshot *snapshot_ref(struct Snapshot *snapshot)
{ if (snapshot) snapshot->refs++; return snapshot; }
static void snapshot_drop(struct Snapshot *snapshot)
{
    if (!snapshot || --snapshot->refs) return;
    if (snapshot->fd >= 0) close(snapshot->fd);
    free(snapshot);
}
static void budget_drop(struct FrameBudget *budget)
{ if (!--budget->refs) free(budget); }
static void mapping_drop(struct FrameMapping *mapping)
{
    if (--mapping->refs) return;
    munmap(mapping->data, mapping->length);
    mapping->budget->bytes -= mapping->length;
    budget_drop(mapping->budget);
    free(mapping);
}
static void buffer_destroy(struct wlr_buffer *base)
{
    struct StripBuffer *buffer = wl_container_of(base, buffer, base);
    wlr_buffer_finish(base);
    mapping_drop(buffer->mapping);
    free(buffer);
}
static bool buffer_access(struct wlr_buffer *base, uint32_t flags, void **data,
    uint32_t *format, size_t *stride)
{
    struct StripBuffer *buffer = wl_container_of(base, buffer, base);
    if (flags & WLR_BUFFER_DATA_PTR_ACCESS_WRITE) return false;
    *data = (uint8_t *)buffer->mapping->data + buffer->offset;
    *format = DRM_FORMAT_ARGB8888; *stride = buffer->stride;
    return true;
}
static void buffer_end(struct wlr_buffer *base) { (void)base; }
static const struct wlr_buffer_impl buffer_impl = {
    .destroy = buffer_destroy, .begin_data_ptr_access = buffer_access, .end_data_ptr_access = buffer_end,
};
static void frame_drop(struct Frame *frame)
{
    if (!frame) return;
    wlr_scene_node_destroy(&frame->tree->node);
    snapshot_drop(frame->snapshot);
    free(frame);
}
static void stop_timeout(struct PuDecoration *d)
{ if (d->timeout) wl_event_source_remove(d->timeout); d->timeout = NULL; }
static bool server_side(struct PuDecoration *d, bool pending)
{
    return pending ? d->protocol && d->protocol->scheduled_mode ==
        WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE : d->decorated;
}
static const struct PuDecorationLayout *layout_for(struct PuDesktopView *view, bool pending)
{
    return pending ? &view->desktop->decorations->snapshot->layout : &view->decoration->current->layout;
}
void pu_decoration_inset(struct PuDesktopView *view, struct wlr_box *bounds, bool pending)
{
    if (!view->decoration || !server_side(view->decoration, pending)) return;
    const struct PuDecorationLayout *layout = layout_for(view, pending);
    bounds->x += layout->border_width; bounds->y += layout->title_height;
    bounds->width -= 2 * layout->border_width;
    bounds->height -= layout->title_height + layout->border_width;
    if (bounds->width < 1) bounds->width = 1;
    if (bounds->height < 1) bounds->height = 1;
}
void pu_decoration_schedule(struct PuDesktopView *view)
{
    if (!view->decoration) return;
    snapshot_drop(view->decoration->pending);
    view->decoration->pending = snapshot_ref(view->desktop->decorations->snapshot);
}
bool pu_decoration_mode_pending(struct PuDesktopView *view)
{
    struct PuDecoration *d = view->decoration;
    return d && d->protocol && d->protocol->scheduled_mode != d->protocol->current.mode;
}
static void show_frame(struct PuDecoration *d)
{
    if (!d->ready) return;
    frame_drop(d->shown);
    d->shown = d->ready; d->ready = NULL;
    wlr_scene_node_set_enabled(&d->shown->tree->node, true);
    wlr_scene_node_set_enabled(&d->tree->node, true);
}
void pu_decoration_present(struct PuDesktopView *view)
{
    struct PuDecoration *d = view->decoration;
    if (!d) return;
    snapshot_drop(d->current); d->current = snapshot_ref(d->pending);
    d->decorated = d->protocol && d->protocol->current.mode ==
        WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE && !view->fullscreen;
    if (d->decorated) show_frame(d);
    else {
        frame_drop(d->shown); d->shown = NULL;
        frame_drop(d->ready); d->ready = NULL;
        wlr_scene_node_set_enabled(&d->tree->node, false);
        stop_timeout(d);
    }
}
bool pu_decoration_button_box(struct PuDesktopView *view, int part, struct wlr_box *box)
{
    struct PuDecoration *d = view->decoration;
    if (!d || !d->decorated || !d->shown || part < PU_DECORATION_CLOSE || part > PU_DECORATION_MINIMIZE)
        return false;
    unsigned index = PU_FRAME_CLOSE + (part - PU_DECORATION_CLOSE) * 4;
    const uint32_t *meta = d->shown->meta;
    if (!meta[index + 2]) return false;
    *box = (struct wlr_box) { (int)meta[index] - (int)meta[PU_FRAME_BORDER],
        (int)meta[index + 1] - (int)meta[PU_FRAME_TITLE], meta[index + 2], meta[index + 3] };
    return true;
}
int pu_decoration_hit(struct PuDesktopView *view, double x, double y)
{
    struct PuDecoration *d = view->decoration;
    if (!d || !d->decorated || !d->shown || !view->mapped || view->minimized ||
        view->mode == PU_DESKTOP_FULLSCREEN) return PU_DECORATION_NONE;
    const uint32_t *meta = d->shown->meta;
    int width = meta[PU_FRAME_CLIENT_WIDTH], height = meta[PU_FRAME_CLIENT_HEIGHT];
    int border = meta[PU_FRAME_BORDER], top = meta[PU_FRAME_TITLE];
    if (x < -border || x >= width + border || y < -top || y >= height + border) return 0;
    if (x >= 0 && x < width && y >= 0 && y < height) return 0;
    if (view->mode == PU_DESKTOP_FLOATING) {
        int edges = (x < 0 ? WLR_EDGE_LEFT : x >= width ? WLR_EDGE_RIGHT : 0) |
            (y < -top + border ? WLR_EDGE_TOP : y >= height ? WLR_EDGE_BOTTOM : 0);
        if (edges) return edges;
    }
    struct wlr_box box;
    for (int part = PU_DECORATION_CLOSE; part <= PU_DECORATION_MINIMIZE; part++)
        if (pu_decoration_button_box(view, part, &box) && wlr_box_contains_point(&box, x, y)) return part;
    return y < 0 ? PU_DECORATION_TITLE : PU_DECORATION_NONE;
}
const char *pu_decoration_cursor(int part)
{
    switch (part) {
    case WLR_EDGE_TOP: return "n-resize";
    case WLR_EDGE_BOTTOM: return "s-resize";
    case WLR_EDGE_LEFT: return "w-resize";
    case WLR_EDGE_RIGHT: return "e-resize";
    case WLR_EDGE_TOP | WLR_EDGE_LEFT: return "nw-resize";
    case WLR_EDGE_TOP | WLR_EDGE_RIGHT: return "ne-resize";
    case WLR_EDGE_BOTTOM | WLR_EDGE_LEFT: return "sw-resize";
    case WLR_EDGE_BOTTOM | WLR_EDGE_RIGHT: return "se-resize";
    default: return "default";
    }
}
static void renderer_unavailable(struct PuDecoration *d, const char *message, bool failure)
{
    wlr_log(failure ? WLR_ERROR : WLR_INFO, "GUI decoration %u unavailable; retaining presented frame: %s",
        d->token, message);
    d->failed = true;
    stop_timeout(d);
    if (d->view->desktop->decorations->renderer)
        polly_appearance_v1_send_render_cancelled(d->view->desktop->decorations->renderer->resource, d->token);
    frame_drop(d->ready); d->ready = NULL;
    snapshot_drop(d->requested); d->requested = NULL;
    if (d->view->desktop->decoration_pressed == d->view) {
        d->view->desktop->decoration_pressed = NULL;
        d->view->desktop->decoration_part = 0;
    }
}
static void renderer_failed(struct PuDecoration *d, const char *message)
{
    renderer_unavailable(d, message, true);
    pu_decorator_fail(d->view->desktop, message);
}
static int render_timeout(void *data)
{
    struct PuDecoration *d = data;
    stop_timeout(d);
    renderer_failed(d, "renderer did not supply a complete frame within 1000ms");
    return 0;
}
static bool request_frame(struct PuDesktopView *view)
{
    struct PuDecoration *d = view->decoration;
    bool pending = view->geometry_pending;
    if (!d || !server_side(d, pending) || (pending ? view->fullscreen : view->mode == PU_DESKTOP_FULLSCREEN))
        return true;
    struct PuDecorations *state = view->desktop->decorations;
    if (!state->renderer || d->failed) return false;
    struct Snapshot *snapshot = pending ? d->pending : d->current;
    if (!snapshot || snapshot->fd < 0) return false;
    const struct PuDecorationLayout *layout = &snapshot->layout;
    struct wlr_box geometry = view->toplevel->base->geometry;
    uint32_t serial = view->toplevel->base->current.configure_serial;
    if (pending && !view->geometry_reuse && (int32_t)(serial - view->geometry_serial) < 0) {
        if (view->pending_box.width > 0) geometry.width = view->pending_box.width;
        if (view->pending_box.height > 0) geometry.height = view->pending_box.height;
    }
    if (geometry.width < 1 || geometry.height < 1) return false;
    uint32_t meta[PU_FRAME_META_WORDS] = {
        [PU_FRAME_TOKEN] = d->token, [PU_FRAME_REVISION] = d->revision,
        [PU_FRAME_GENERATION_LO] = (uint32_t)snapshot->generation,
        [PU_FRAME_GENERATION_HI] = (uint32_t)(snapshot->generation >> 32),
        [PU_FRAME_CLIENT_WIDTH] = geometry.width, [PU_FRAME_CLIENT_HEIGHT] = geometry.height,
        [PU_FRAME_SCALE] = pu_frame_scale_word((float)pu_desktop_view_scale(view)),
        [PU_FRAME_BORDER] = layout->border_width, [PU_FRAME_TITLE] = layout->title_height,
    };
    unsigned flags = view->desktop->focused == view && !view->desktop->focused_layer ? 1 : 0;
    if (pending ? view->maximized : view->mode == PU_DESKTOP_MAXIMIZED) flags |= 2;
    if (view->desktop->decoration_pressed == view && view->desktop->decoration_part == d->hover &&
        d->hover >= PU_DECORATION_CLOSE && d->hover <= PU_DECORATION_MINIMIZE)
        flags |= 1u << (2 + d->hover - PU_DECORATION_CLOSE);
    if (d->hover >= PU_DECORATION_CLOSE && d->hover <= PU_DECORATION_MINIMIZE)
        flags |= (unsigned)(d->hover - PU_DECORATION_CLOSE + 1) << 5;
    meta[PU_FRAME_STATE] = flags;
    int width = geometry.width + 2 * layout->border_width;
    for (int i = 0; i < 3; i++) {
        struct PuChromeBox box;
        if (!pu_decoration_layout_button(layout, width, i, &box)) continue;
        unsigned at = PU_FRAME_CLOSE + i * 4;
        meta[at] = box.x; meta[at + 1] = box.y; meta[at + 2] = box.width; meta[at + 3] = box.height;
    }
    struct PuChromeBox text;
    pu_decoration_layout_text(layout, width, &text);
    meta[PU_FRAME_TEXT] = text.x; meta[PU_FRAME_TEXT + 1] = text.y;
    meta[PU_FRAME_TEXT + 2] = text.width; meta[PU_FRAME_TEXT + 3] = text.height;
    const char *title = view->toplevel->title && *view->toplevel->title ? view->toplevel->title :
        view->toplevel->app_id && *view->toplevel->app_id ? view->toplevel->app_id : "Untitled";
    char *copy = strndup(title, 2048);
    if (!copy) { renderer_failed(d, "cannot retain caption text"); return false; }
    if (d->revision && !memcmp(meta, d->meta, sizeof(meta)) && d->title && !strcmp(copy, d->title)) {
        if (d->ready || (d->shown && !memcmp(d->shown->meta, meta, sizeof(meta)))) {
            free(copy); return true;
        }
        if (d->timeout && d->requested) { free(copy); return false; }
    }
    if (d->revision == UINT32_MAX) {
        free(copy); renderer_failed(d, "frame revision exhausted"); return false;
    }
    meta[PU_FRAME_REVISION] = ++d->revision;
    struct PuFrameStrip strips[PU_FRAME_STRIPS]; uint32_t bytes;
    if (!pu_frame_strips(meta, strips, &bytes) || snapshot->fd < 0) {
        free(copy); renderer_failed(d, "caption geometry exceeds the bounded GUI frame contract"); return false;
    }
    frame_drop(d->ready); d->ready = NULL;
    free(d->title); d->title = copy;
    memcpy(d->meta, meta, sizeof(meta));
    snapshot_drop(d->requested); d->requested = snapshot_ref(snapshot);
    struct wl_array metadata = {.size = sizeof(meta), .alloc = sizeof(meta), .data = meta};
    polly_appearance_v1_send_render_request(state->renderer->resource, &metadata, copy, snapshot->fd, snapshot->length);
    if (!d->timeout) {
        d->timeout = wl_event_loop_add_timer(wl_display_get_event_loop(state->desktop->display), render_timeout, d);
        if (!d->timeout || wl_event_source_timer_update(d->timeout, 1000) < 0)
            renderer_failed(d, "cannot monitor renderer response");
    }
    return false;
}
bool pu_decoration_ready(struct PuDesktopView *view) { return request_frame(view); }
void pu_decoration_update(struct PuDesktopView *view)
{
    if (!request_frame(view)) return;
    if (view->decoration && !view->geometry_pending) show_frame(view->decoration);
}
void pu_decoration_hover(struct PuDesktop *desktop, struct PuDesktopView *view, int part)
{
    struct PuDesktopView *item;
    wl_list_for_each(item, &desktop->views, link) {
        if (!item->decoration) continue;
        int next = item == view ? part : 0;
        if (item->decoration->hover == next) continue;
        item->decoration->hover = next; pu_decoration_update(item);
    }
}
bool pu_decoration_create(struct PuDesktopView *view)
{
    struct PuDecorations *state = view->desktop->decorations;
    if (state->next_token == UINT32_MAX) { wlr_log(WLR_ERROR, "Decoration window tokens exhausted"); return false; }
    struct PuDecoration *d = calloc(1, sizeof(*d));
    if (!d) return false;
    d->view = view; d->token = ++state->next_token;
    d->current = snapshot_ref(state->snapshot); d->pending = snapshot_ref(state->snapshot);
    d->tree = wlr_scene_tree_create(view->tree);
    if (!d->tree) { snapshot_drop(d->current); snapshot_drop(d->pending); free(d); return false; }
    wlr_scene_node_set_enabled(&d->tree->node, false);
    view->decoration = d;
    return true;
}
void pu_decoration_destroy(struct PuDesktopView *view)
{
    struct PuDecoration *d = view->decoration;
    if (!d) return;
    if (view->desktop->decorations->renderer)
        polly_appearance_v1_send_render_cancelled(view->desktop->decorations->renderer->resource, d->token);
    if (d->protocol) {
        wl_list_remove(&d->request_mode.link); wl_list_remove(&d->destroy.link); d->protocol->data = NULL;
    }
    stop_timeout(d);
    frame_drop(d->shown); frame_drop(d->ready);
    wlr_scene_node_destroy(&d->tree->node);
    snapshot_drop(d->current); snapshot_drop(d->pending); snapshot_drop(d->requested);
    free(d->title); free(d); view->decoration = NULL;
}
void pu_decoration_suspend(struct PuDesktopView *view)
{
    struct PuDecoration *d = view->decoration;
    if (!d) return;
    stop_timeout(d);
    frame_drop(d->shown); d->shown = NULL; frame_drop(d->ready); d->ready = NULL;
    snapshot_drop(d->requested); d->requested = NULL;
    free(d->title); d->title = NULL;
    d->decorated = false;
    wlr_scene_node_set_enabled(&d->tree->node, false);
    if (view->desktop->decorations->renderer)
        polly_appearance_v1_send_render_cancelled(view->desktop->decorations->renderer->resource, d->token);
}
void pu_decoration_waiting_clip(struct PuDesktopView *view, struct wlr_box *box)
{
    struct PuDecoration *d = view->decoration;
    box->width = d && d->shown ? (int)d->shown->meta[PU_FRAME_CLIENT_WIDTH] : view->presented_box.width;
    box->height = d && d->shown ? (int)d->shown->meta[PU_FRAME_CLIENT_HEIGHT] : view->presented_box.height;
    if (box->width < 0) box->width = 0;
    if (box->height < 0) box->height = 0;
}
void pu_decoration_configure(struct PuDesktopView *view)
{
    struct PuDecoration *d = view->decoration;
    if (!d || !d->protocol || !view->toplevel->base->initialized) return;
    enum wlr_xdg_toplevel_decoration_v1_mode mode =
        d->protocol->requested_mode == WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE ||
        (!pu_decorator_configured(view->desktop) && view->desktop->decorations->snapshot->fd < 0) ?
        WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE : WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE;
    wlr_xdg_toplevel_decoration_v1_set_mode(d->protocol, mode);
}
static void request_mode(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDecoration *d = wl_container_of(listener, d, request_mode);
    if (!d->view->toplevel->base->initialized) return;
    pu_decoration_configure(d->view); pu_desktop_redecorate(d->view);
}
static void decoration_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDecoration *d = wl_container_of(listener, d, destroy);
    wl_list_remove(&d->request_mode.link); wl_list_remove(&d->destroy.link);
    d->protocol->data = NULL; d->protocol = NULL;
    pu_desktop_redecorate(d->view);
}
static void new_decoration(struct wl_listener *listener, void *data)
{
    struct PuDecorations *state = wl_container_of(listener, state, new_decoration);
    struct wlr_xdg_toplevel_decoration_v1 *protocol = data;
    struct PuDesktopView *view;
    wl_list_for_each(view, &state->desktop->all_views, all_link) {
        if (view->toplevel != protocol->toplevel) continue;
        struct PuDecoration *d = view->decoration;
        d->protocol = protocol; protocol->data = d;
        d->request_mode.notify = request_mode; wl_signal_add(&protocol->events.request_mode, &d->request_mode);
        d->destroy.notify = decoration_destroyed; wl_signal_add(&protocol->events.destroy, &d->destroy);
        request_mode(&d->request_mode, NULL); return;
    }
    wl_resource_post_no_memory(protocol->resource);
}
static void appearance_destroy(struct wl_client *client, struct wl_resource *resource)
{ (void)client; wl_resource_destroy(resource); }
static void appearance_released(struct wl_resource *resource)
{
    struct AppearanceClient *owner = wl_resource_get_user_data(resource);
    struct PuDecorations *state = owner->state;
    if (state->renderer == owner) {
        state->renderer = NULL;
        struct PuDesktopView *view;
        wl_list_for_each(view, &state->desktop->all_views, all_link)
            if (view->decoration && !state->desktop->stopping &&
                (server_side(view->decoration, true) || view->decoration->decorated))
                renderer_failed(view->decoration, "Independent GUI renderer disconnected");
    }
    wl_list_remove(&owner->link); snapshot_drop(owner->staged); free(owner);
    pu_decorations_service_changed(state->desktop);
}
static void notify_theme(struct PuDecorations *state)
{
    if (!++state->theme_revision) ++state->theme_revision;
    struct ThemeWatcher *watcher;
    wl_list_for_each(watcher, &state->theme_watchers, link) {
        if (watcher->notified) continue;
        watcher->notified = true; polly_theme_manager_v1_send_changed(watcher->resource, state->theme_revision);
    }
}
static void theme_watcher_released(struct wl_resource *resource)
{
    struct ThemeWatcher *watcher = wl_resource_get_user_data(resource);
    wl_list_remove(&watcher->link); free(watcher);
}
static void theme_snapshot(struct wl_client *client, struct wl_resource *resource)
{
    (void)client;
    struct ThemeWatcher *watcher = wl_resource_get_user_data(resource);
    if (!watcher->notified) {
        wl_resource_post_error(resource, POLLY_THEME_MANAGER_V1_ERROR_UNEXPECTED_REQUEST,
            "Request a theme snapshot only after a change notification"); return;
    }
    watcher->notified = false;
    struct Snapshot *snapshot = watcher->state->snapshot;
    if (snapshot->fd >= 0)
        polly_theme_manager_v1_send_snapshot(resource, watcher->state->theme_revision, snapshot->fd, snapshot->length);
    else polly_theme_manager_v1_send_unavailable(resource, watcher->state->theme_revision);
}
static const struct polly_theme_manager_v1_interface theme_feed_impl = {
    .destroy = appearance_destroy, .get_snapshot = theme_snapshot,
};
static void theme_feed_bind(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
    struct PuDecorations *state = data;
    unsigned same_client = 0;
    struct ThemeWatcher *item;
    wl_list_for_each(item, &state->theme_watchers, link)
        if (wl_resource_get_client(item->resource) == client) same_client++;
    if (same_client >= 4 || wl_list_length(&state->theme_watchers) >= 128) {
        wl_client_post_implementation_error(client, "Theme subscription limit reached"); return;
    }
    struct ThemeWatcher *watcher = calloc(1, sizeof(*watcher));
    if (!watcher) { wl_client_post_no_memory(client); return; }
    struct wl_resource *resource = wl_resource_create(client, &polly_theme_manager_v1_interface, version, id);
    if (!resource) { free(watcher); wl_client_post_no_memory(client); return; }
    watcher->state = state; watcher->resource = resource; watcher->notified = true;
    wl_list_insert(&state->theme_watchers, &watcher->link);
    wl_resource_set_implementation(resource, &theme_feed_impl, watcher, theme_watcher_released);
    polly_theme_manager_v1_send_changed(resource, state->theme_revision);
}
static bool authorized(struct wl_client *client, struct AppearanceClient *owner)
{
    struct PuDesktop *desktop = owner->state->desktop;
    if (owner->renderer_role ? pu_decorator_allowed(desktop, client) : client == desktop->shell_client)
        return true;
    wl_resource_post_error(owner->resource, POLLY_APPEARANCE_V1_ERROR_UNAUTHORIZED, "Appearance role was revoked");
    return false;
}
static bool renderer_authorized(struct wl_client *client, struct AppearanceClient *owner)
{
    if (!authorized(client, owner)) return false;
    if (owner->renderer_role) return true;
    wl_resource_post_error(owner->resource, POLLY_APPEARANCE_V1_ERROR_UNAUTHORIZED, "The Shell cannot act as renderer");
    return false;
}
static void enable_renderer(struct wl_client *client, struct wl_resource *resource)
{
    struct AppearanceClient *owner = wl_resource_get_user_data(resource);
    if (!renderer_authorized(client, owner)) return;
    struct PuDecorations *state = owner->state;
    bool accepted = !state->renderer || state->renderer == owner;
    if (accepted) state->renderer = owner;
    polly_appearance_v1_send_renderer_enabled(resource, accepted, accepted ? "" : "A GUI renderer is already active");
    if (!accepted) return;
    pu_decorator_ready(state->desktop);
    struct PuDesktopView *view;
    wl_list_for_each(view, &state->desktop->all_views, all_link) {
        struct PuDecoration *d = view->decoration;
        if (!d) continue;
        d->failed = false;
        stop_timeout(d);
        frame_drop(d->ready); d->ready = NULL;
        snapshot_drop(d->requested); d->requested = NULL;
        free(d->title); d->title = NULL;
        pu_decoration_configure(view);
        if (state->snapshot->fd >= 0 && (d->decorated || server_side(d, true)))
            pu_desktop_redecorate(view);
    }
    pu_decorations_service_changed(state->desktop);
}
static void disable_renderer(struct wl_client *client, struct wl_resource *resource)
{
    struct AppearanceClient *owner = wl_resource_get_user_data(resource);
    if (!renderer_authorized(client, owner) || owner->state->renderer != owner) return;
    owner->state->renderer = NULL;
    snapshot_drop(owner->staged); owner->staged = NULL; owner->serial = 0;
    struct PuDesktopView *view;
    wl_list_for_each(view, &owner->state->desktop->all_views, all_link)
        if (view->decoration && (server_side(view->decoration, true) || view->decoration->decorated))
            renderer_unavailable(view->decoration, "Independent GUI renderer stopped", false);
    pu_decorator_fail(owner->state->desktop, "Independent GUI renderer stopped");
}
static void prepare_theme(struct wl_client *client, struct wl_resource *resource, uint32_t serial,
    const char *name, struct wl_array *configuration, int32_t document, uint32_t length)
{
    struct AppearanceClient *owner = wl_resource_get_user_data(resource);
    if (!authorized(client, owner)) { close(document); return; }
    snapshot_drop(owner->staged); owner->staged = NULL; owner->serial = 0;
    if (owner->renderer_role && !bootstrap_allowed(owner)) {
        close(document);
        polly_appearance_v1_send_prepared(resource, serial, 0, "Bootstrap authority is unavailable");
        pu_decorations_service_changed(owner->state->desktop);
        return;
    }
    struct PuDecorationLayout layout;
    bool valid = serial && pu_appearance_identifier(name) &&
        configuration->size == PU_APPEARANCE_WORDS * sizeof(uint32_t) &&
        pu_appearance_document_valid(document, length);
    uint32_t words[PU_APPEARANCE_WORDS];
    if (valid) { memcpy(words, configuration->data, sizeof(words)); valid = pu_appearance_decode(&layout, words); }
    if (!valid) {
        close(document);
        polly_appearance_v1_send_prepared(resource, serial, 0, "A valid sealed document and geometry schema 4 are required");
        pu_decorations_service_changed(owner->state->desktop);
        return;
    }
    owner->staged = calloc(1, sizeof(*owner->staged));
    if (!owner->staged) { close(document); wl_resource_post_no_memory(resource); return; }
    *owner->staged = (struct Snapshot) {.refs = 1, .layout = layout, .fd = document, .length = length};
    owner->base_generation = owner->state->snapshot->generation;
    if (!owner->renderer_role) {
        struct AppearanceClient *other;
        wl_list_for_each(other, &owner->state->appearance_clients, link)
            if (other->renderer_role) {
                snapshot_drop(other->staged); other->staged = NULL; other->serial = 0;
            }
    }
    owner->serial = serial; polly_appearance_v1_send_prepared(resource, serial, 1, "");
    pu_decorations_service_changed(owner->state->desktop);
}
static void commit_theme(struct wl_client *client, struct wl_resource *resource, uint32_t serial)
{
    struct AppearanceClient *owner = wl_resource_get_user_data(resource);
    struct PuDecorations *state = owner->state;
    if (!authorized(client, owner)) return;
    if (!serial || owner->serial != serial || !owner->staged || state->snapshot->generation == UINT64_MAX ||
        (owner->renderer_role && (!bootstrap_allowed(owner) || owner->base_generation != state->snapshot->generation))) {
        polly_appearance_v1_send_applied(resource, serial, 0, "No matching prepared appearance"); return;
    }
    owner->staged->generation = state->snapshot->generation + 1;
    snapshot_drop(state->snapshot); state->snapshot = owner->staged;
    state->initial_theme_consumed = true;
    owner->staged = NULL; owner->serial = 0;
    struct PuDesktopView *view;
    wl_list_for_each(view, &state->desktop->all_views, all_link) {
        if (!view->decoration) continue;
        struct PuDecoration *d = view->decoration;
        bool was_server_side = server_side(d, true) || d->decorated;
        d->failed = false;
        pu_decoration_configure(view);
        if (was_server_side || server_side(d, true)) pu_desktop_redecorate(view);
        else {
            snapshot_drop(d->current); d->current = snapshot_ref(state->snapshot);
            snapshot_drop(d->pending); d->pending = snapshot_ref(state->snapshot);
        }
    }
    notify_theme(state);
    polly_appearance_v1_send_applied(resource, serial, 1, "");
    pu_decorations_service_changed(state->desktop);
}
static void cancel_theme(struct wl_client *client, struct wl_resource *resource, uint32_t serial)
{
    struct AppearanceClient *owner = wl_resource_get_user_data(resource);
    if (!authorized(client, owner) || owner->serial != serial) return;
    snapshot_drop(owner->staged); owner->staged = NULL; owner->serial = 0;
    pu_decorations_service_changed(owner->state->desktop);
}
static struct PuDecoration *find_decoration(struct PuDecorations *state, uint32_t token)
{
    struct PuDesktopView *view;
    wl_list_for_each(view, &state->desktop->all_views, all_link)
        if (view->decoration && view->decoration->token == token) return view->decoration;
    return NULL;
}
static struct Frame *create_frame(struct PuDecoration *d, int fd, uint32_t length, struct PuFrameStrip *strips)
{
    struct FrameBudget *budget = d->view->desktop->decorations->budget;
    if (length > 128u * 1024u * 1024u - budget->bytes) return NULL;
    void *data = mmap(NULL, length, PROT_READ, MAP_PRIVATE, fd, 0);
    if (data == MAP_FAILED) return NULL;
    if (!pu_frame_validate(data, length, d->meta, strips)) { munmap(data, length); return NULL; }
    struct FrameMapping *mapping = calloc(1, sizeof(*mapping));
    struct Frame *frame = calloc(1, sizeof(*frame));
    if (!mapping || !frame) { free(mapping); free(frame); munmap(data, length); return NULL; }
    *mapping = (struct FrameMapping) {.refs = 1, .data = data, .length = length, .budget = budget};
    budget->refs++; budget->bytes += length;
    frame->tree = wlr_scene_tree_create(d->tree);
    frame->snapshot = snapshot_ref(d->requested);
    memcpy(frame->meta, d->meta, sizeof(frame->meta));
    if (!frame->tree) { snapshot_drop(frame->snapshot); free(frame); mapping_drop(mapping); return NULL; }
    wlr_scene_node_set_enabled(&frame->tree->node, false);
    int border = d->meta[PU_FRAME_BORDER], title = d->meta[PU_FRAME_TITLE];
    int width = d->meta[PU_FRAME_CLIENT_WIDTH], height = d->meta[PU_FRAME_CLIENT_HEIGHT];
    const int boxes[PU_FRAME_STRIPS][4] = {{-border, -title, width + 2 * border, title},
        {-border, 0, border, height}, {width, 0, border, height}, {-border, height, width + 2 * border, border}};
    bool valid = true;
    for (unsigned i = 0; i < PU_FRAME_STRIPS && valid; i++) {
        if (!strips[i].width || !strips[i].height) continue;
        struct StripBuffer *buffer = calloc(1, sizeof(*buffer));
        if (!buffer) { valid = false; break; }
        buffer->mapping = mapping; mapping->refs++;
        buffer->offset = strips[i].offset; buffer->stride = strips[i].stride;
        wlr_buffer_init(&buffer->base, &buffer_impl, strips[i].width, strips[i].height);
        struct wlr_scene_buffer *scene = wlr_scene_buffer_create(frame->tree, &buffer->base);
        wlr_buffer_drop(&buffer->base);
        if (!scene) { valid = false; break; }
        wlr_scene_buffer_set_dest_size(scene, boxes[i][2], boxes[i][3]);
        wlr_scene_node_set_position(&scene->node, boxes[i][0], boxes[i][1]);
    }
    mapping_drop(mapping);
    if (!valid) { frame_drop(frame); return NULL; }
    return frame;
}
static void submit_frame(struct wl_client *client, struct wl_resource *resource, uint32_t token,
    uint32_t revision, int32_t fd, uint32_t length)
{
    struct AppearanceClient *owner = wl_resource_get_user_data(resource);
    if (!renderer_authorized(client, owner)) { close(fd); return; }
    struct PuDecoration *d = find_decoration(owner->state, token);
    if (d) request_frame(d->view);
    if (owner->state->renderer != owner || !d || d->failed || d->revision != revision ||
        d->accepted_revision == revision || !d->requested || !server_side(d, d->view->geometry_pending) ||
        (d->view->geometry_pending ? d->view->fullscreen : d->view->mode == PU_DESKTOP_FULLSCREEN)) {
        close(fd); polly_appearance_v1_send_frame_result(resource, token, revision, 1, "Obsolete frame"); return;
    }
    struct PuFrameStrip strips[PU_FRAME_STRIPS];
    struct Frame *frame = pu_frame_fd_valid(fd, length) ? create_frame(d, fd, length, strips) : NULL;
    close(fd);
    if (!frame) {
        polly_appearance_v1_send_frame_result(resource, token, revision, 2, "Invalid, unsealed, oversized or unallocatable frame"); return;
    }
    frame_drop(d->ready); d->ready = frame; d->accepted_revision = revision; stop_timeout(d);
    pu_desktop_decoration_ready(d->view);
    polly_appearance_v1_send_frame_result(resource, token, revision, 0, "");
}
static void frame_failed(struct wl_client *client, struct wl_resource *resource, uint32_t token,
    uint32_t revision, const char *message)
{
    struct AppearanceClient *owner = wl_resource_get_user_data(resource);
    if (!renderer_authorized(client, owner)) return;
    struct PuDecoration *d = find_decoration(owner->state, token);
    if (owner->state->renderer == owner && d && d->revision == revision)
        renderer_failed(d, strnlen(message, 193) <= 192 ? message : "GUI painter failed");
}
static const struct polly_appearance_v1_interface appearance_impl = {
    .destroy = appearance_destroy, .prepare = prepare_theme, .commit = commit_theme, .cancel = cancel_theme,
    .enable_renderer = enable_renderer, .disable_renderer = disable_renderer,
    .submit_frame = submit_frame, .frame_failed = frame_failed,
};
static void appearance_bind(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
    struct PuDecorations *state = data;
    bool rendering = pu_decorator_allowed(state->desktop, client);
    if ((!rendering && client != state->desktop->shell_client) || version < 4) {
        wl_client_post_implementation_error(client, "Appearance requires paired PollyWM/Shell/decorator v4"); return;
    }
    struct AppearanceClient *existing;
    wl_list_for_each(existing, &state->appearance_clients, link)
        if (existing->renderer_role == rendering) {
            wl_client_post_implementation_error(client, "Appearance role is already bound"); return;
        }
    struct AppearanceClient *owner = calloc(1, sizeof(*owner));
    if (!owner) { wl_client_post_no_memory(client); return; }
    struct wl_resource *resource = wl_resource_create(client, &polly_appearance_v1_interface, version, id);
    if (!resource) { free(owner); wl_client_post_no_memory(client); return; }
    owner->state = state; owner->resource = resource; owner->renderer_role = rendering;
    wl_list_insert(&state->appearance_clients, &owner->link);
    wl_resource_set_implementation(resource, &appearance_impl, owner, appearance_released);
    pu_decorations_service_changed(state->desktop);
}
bool pu_decorations_init(struct PuDesktop *desktop)
{
    struct PuDecorations *state = calloc(1, sizeof(*state));
    if (!state) return false;
    desktop->decorations = state; state->desktop = desktop;
    wl_list_init(&state->appearance_clients); wl_list_init(&state->theme_watchers);
    state->snapshot = calloc(1, sizeof(*state->snapshot));
    if (!state->snapshot) return false;
    *state->snapshot = (struct Snapshot) {.refs = 1, .generation = 1, .fd = -1};
    state->budget = calloc(1, sizeof(*state->budget));
    if (!state->budget) return false;
    state->budget->refs = 1; state->theme_revision = 1;
    state->manager = wlr_xdg_decoration_manager_v1_create(desktop->display);
    state->appearance = wl_global_create(desktop->display, &polly_appearance_v1_interface, 4, state, appearance_bind);
    state->theme_feed = wl_global_create(desktop->display, &polly_theme_manager_v1_interface, 1, state, theme_feed_bind);
    if (!state->manager || !state->appearance || !state->theme_feed) return false;
    state->new_decoration.notify = new_decoration;
    wl_signal_add(&state->manager->events.new_toplevel_decoration, &state->new_decoration);
    return true;
}
void pu_decorations_finish(struct PuDesktop *desktop)
{
    struct PuDecorations *state = desktop->decorations;
    if (!state) return;
    if (state->new_decoration.link.next) wl_list_remove(&state->new_decoration.link);
    if (state->appearance) wl_global_destroy(state->appearance);
    if (state->theme_feed) wl_global_destroy(state->theme_feed);
    struct AppearanceClient *client, *next;
    wl_list_for_each_safe(client, next, &state->appearance_clients, link) wl_resource_destroy(client->resource);
    struct ThemeWatcher *watcher, *following;
    wl_list_for_each_safe(watcher, following, &state->theme_watchers, link) wl_resource_destroy(watcher->resource);
    snapshot_drop(state->snapshot);
    if (state->budget) budget_drop(state->budget);
    free(state); desktop->decorations = NULL;
}
