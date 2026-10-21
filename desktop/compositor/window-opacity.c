#include "window-opacity.h"
#include "server.h"
#include "decoration.h"
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <wlr/config.h>
#include <wlr/render/pixman.h>
#if WLR_HAS_GLES2_RENDERER
#include <wlr/render/gles2.h>
#endif
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>

static bool node_bounds(struct wlr_scene_node *node, int64_t x, int64_t y, pixman_region32_t *region)
{
    if (!node->enabled) return true;
    x += node->x;
    y += node->y;
    if (node->type == WLR_SCENE_NODE_TREE) {
        struct wlr_scene_node *child;
        struct wlr_scene_tree *tree = wlr_scene_tree_from_node(node);
        wl_list_for_each(child, &tree->children, link)
            if (!node_bounds(child, x, y, region)) return false;
        return true;
    }
    int width, height;
    if (node->type == WLR_SCENE_NODE_RECT) {
        struct wlr_scene_rect *rect = wlr_scene_rect_from_node(node);
        width = rect->width;
        height = rect->height;
    } else {
        struct wlr_scene_buffer *buffer = wlr_scene_buffer_from_node(node);
        if (!buffer->buffer) return true;
        width = buffer->dst_width;
        height = buffer->dst_height;
        if (!width || !height) {
            bool rotated = buffer->transform & 1;
            width = rotated ? buffer->buffer->height : buffer->buffer->width;
            height = rotated ? buffer->buffer->width : buffer->buffer->height;
        }
    }
    if (width <= 0 || height <= 0) return true;
    if (x < INT_MIN || y < INT_MIN || x + width > INT_MAX || y + height > INT_MAX)
        return false;
    return pixman_region32_union_rect(region, region, (int)x, (int)y, (unsigned)width, (unsigned)height);
}

bool pu_window_composition(struct wlr_scene_tree *tree, const struct wlr_box *box, float radius, float opacity)
{
    struct wlr_box bounds;
    if (!box && opacity < 1) {
        pixman_region32_t region;
        pixman_region32_init(&region);
        bool valid = true;
        struct wlr_scene_node *child;
        wl_list_for_each(child, &tree->children, link) {
            if (!node_bounds(child, 0, 0, &region)) {
                valid = false;
                break;
            }
        }
        if (valid && pixman_region32_not_empty(&region)) {
            const pixman_box32_t *extent = pixman_region32_extents(&region);
            int64_t width = (int64_t)extent->x2 - extent->x1;
            int64_t height = (int64_t)extent->y2 - extent->y1;
            valid = width <= WLR_SCENE_EFFECTS_MAX_AXIS && height <= WLR_SCENE_EFFECTS_MAX_AXIS;
            if (valid) {
                bounds = (struct wlr_box){extent->x1, extent->y1, (int)width, (int)height};
                box = &bounds;
            }
        }
        pixman_region32_fini(&region);
        if (!valid) return false;
        if (!box) opacity = 1;
    }
    return wlr_scene_tree_set_composition(tree, box, radius, opacity);
}

float pu_window_opacity(struct PuDesktopView *view)
{
    if (wl_resource_get_client(view->toplevel->base->resource) == view->desktop->shell_client)
        return 1;
    return view->desktop->window_opacity_percent / 100.0f;
}

bool pu_window_opacity_supported(struct PuDesktop *desktop)
{
    if (wlr_renderer_is_pixman(desktop->renderer)) return true;
#if WLR_HAS_GLES2_RENDERER
    if (wlr_renderer_is_gles2(desktop->renderer))
        return wlr_gles2_renderer_supports_scene_effects(desktop->renderer);
#endif
    return false;
}

static bool update(struct PuDesktopView *view, bool prepare)
{
    if (!pu_decoration_effects(view) ||
        !pu_window_composition(view->popups, NULL, 0, pu_window_opacity(view)))
        return false;
    return !prepare || (wlr_scene_tree_prepare_composition(view->effects) &&
        wlr_scene_tree_prepare_composition(view->popups));
}

bool pu_desktop_set_window_opacity(struct PuDesktop *desktop, uint32_t percent)
{
    if (percent < 50 || percent > 100) {
        wlr_log(WLR_ERROR, "Global window opacity must be an integer from 50 to 100");
        return false;
    }
    if (percent != 100 && !pu_window_opacity_supported(desktop)) {
        wlr_log(WLR_ERROR, "The active renderer cannot provide isolated window opacity");
        return false;
    }
    uint32_t previous = desktop->window_opacity_percent;
    desktop->window_opacity_percent = percent;
    struct PuDesktopView *view;
    wl_list_for_each(view, &desktop->views, link) {
        if (update(view, true)) continue;
        desktop->window_opacity_percent = previous;
        struct PuDesktopView *rollback;
        wl_list_for_each(rollback, &desktop->views, link) {
            if (!update(rollback, false))
                wlr_log(WLR_ERROR, "Cannot restore the previous window-opacity geometry");
        }
        wlr_log(WLR_ERROR, "Global window opacity rejected by composition geometry or resource budget");
        return false;
    }
    desktop->window_opacity_error[0] = '\0';
    return true;
}

bool pu_window_effects_update(struct PuDesktopView *view)
{
    if (update(view, pu_window_opacity(view) < 1)) return true;
    struct PuDesktop *desktop = view->desktop;
    if (desktop->window_opacity_percent == 100) return false;
    if (!pu_desktop_set_window_opacity(desktop, 100)) return false;
    snprintf(desktop->window_opacity_error, sizeof(desktop->window_opacity_error),
        "Window transparency was disabled: new surface geometry or backing exceeded the composition budget.");
    wlr_log(WLR_ERROR, "%s", desktop->window_opacity_error);
    pu_decorations_window_opacity_status(desktop);
    return update(view, false);
}

bool pu_desktop_prepare_window_opacity(struct PuDesktop *desktop)
{
    if (desktop->window_opacity_percent == 100) return true;
    struct PuDesktopView *view;
    wl_list_for_each(view, &desktop->views, link) {
        if (!pu_window_effects_update(view)) return false;
        if (desktop->window_opacity_percent == 100) break;
    }
    return true;
}
