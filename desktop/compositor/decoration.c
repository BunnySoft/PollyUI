#include "decoration.h"
#include "decoration-themes.h"
#include "server.h"
#include "polly-appearance-server.h"

#include <drm_fourcc.h>
#include <fontconfig/fontconfig.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <wlr/interfaces/wlr_buffer.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_xdg_decoration_v1.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/edges.h>
#include <wlr/util/log.h>

struct PuDecorations {
    struct PuDesktop *desktop;
    struct wlr_xdg_decoration_manager_v1 *manager;
    struct wl_global *appearance;
    struct wl_listener new_decoration;
    FT_Library freetype;
    FcConfig *fonts;
    FT_Face faces[16];
    int face_count;
    unsigned theme;
};

struct PuDecoration {
    struct PuDesktopView *view;
    struct wlr_xdg_toplevel_decoration_v1 *protocol;
    struct wl_listener request_mode, destroy;
    struct wlr_scene_tree *tree;
    struct wlr_scene_buffer *title;
    struct wlr_scene_rect *left, *right, *bottom;
    unsigned theme, pending_theme;
    bool decorated, last_active, last_maximized;
    int width, height, hover, last_hover;
    double scale;
    char *last_title;
};

struct TitleBuffer {
    struct wlr_buffer base;
    uint32_t *pixels;
};

static void buffer_destroy(struct wlr_buffer *base)
{
    struct TitleBuffer *buffer = wl_container_of(base, buffer, base);
    wlr_buffer_finish(base);
    free(buffer->pixels);
    free(buffer);
}

static bool buffer_access(struct wlr_buffer *base, uint32_t flags, void **data,
                          uint32_t *format, size_t *stride)
{
    struct TitleBuffer *buffer = wl_container_of(base, buffer, base);
    if (flags & WLR_BUFFER_DATA_PTR_ACCESS_WRITE) return false;
    *data = buffer->pixels;
    *format = DRM_FORMAT_ARGB8888;
    *stride = (size_t)base->width * 4;
    return true;
}

static void buffer_end(struct wlr_buffer *base) { (void)base; }
static const struct wlr_buffer_impl buffer_impl = {
    .destroy = buffer_destroy, .begin_data_ptr_access = buffer_access, .end_data_ptr_access = buffer_end,
};

static const struct PuDecorationTheme *theme_for(struct PuDesktopView *view, bool pending)
{
    return &pu_decoration_themes[pending ? view->desktop->decorations->theme : view->decoration->theme];
}

static bool server_side(struct PuDecoration *decoration, bool pending)
{
    return pending ? decoration->protocol && decoration->protocol->scheduled_mode ==
        WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE : decoration->decorated;
}

void pu_decoration_inset(struct PuDesktopView *view, struct wlr_box *bounds, bool pending)
{
    if (!view->decoration || !server_side(view->decoration, pending)) return;
    const struct PuDecorationTheme *theme = theme_for(view, pending);
    bounds->x += theme->border_width;
    bounds->y += theme->title_height;
    bounds->width -= 2 * theme->border_width;
    bounds->height -= theme->title_height + theme->border_width;
    if (bounds->width < 1) bounds->width = 1;
    if (bounds->height < 1) bounds->height = 1;
}

void pu_decoration_schedule(struct PuDesktopView *view)
{
    if (view->decoration) view->decoration->pending_theme = view->desktop->decorations->theme;
}

void pu_decoration_present(struct PuDesktopView *view)
{
    struct PuDecoration *d = view->decoration;
    if (!d) return;
    d->decorated = d->protocol && d->protocol->current.mode ==
        WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE;
    if (d->theme != d->pending_theme) {
        d->theme = d->pending_theme;
        d->width = 0;
    }
}

bool pu_decoration_button_box(struct PuDesktopView *view, int part, struct wlr_box *box)
{
    struct PuDecoration *d = view->decoration;
    if (!d || !d->decorated || view->mode == PU_DESKTOP_FULLSCREEN ||
        part < PU_DECORATION_CLOSE || part > PU_DECORATION_MINIMIZE) return false;
    const struct PuDecorationTheme *theme = theme_for(view, false);
    if (view->toplevel->base->geometry.width < 1 || view->toplevel->base->geometry.width > 32700) return false;
    int width = view->toplevel->base->geometry.width + 2 * theme->border_width;
    int size = theme->round_controls ? 14 : theme->title_height - 8;
    int index = part == PU_DECORATION_CLOSE ? 0 :
        part == PU_DECORATION_MINIMIZE && theme->left_controls ? 1 :
        part == PU_DECORATION_MAXIMIZE && !theme->left_controls ? 1 : 2;
    if (width < (index + 1) * (size + 4) + 8) return false;
    *box = (struct wlr_box) {
        .x = -theme->border_width + (theme->left_controls ? 6 + index * (size + 4) :
            width - 6 - size - index * (size + 4)),
        .y = -theme->title_height + (theme->title_height - size) / 2,
        .width = size, .height = size,
    };
    return true;
}

int pu_decoration_hit(struct PuDesktopView *view, double x, double y)
{
    struct PuDecoration *d = view->decoration;
    if (!d || !d->decorated || !view->mapped || view->minimized ||
        view->mode == PU_DESKTOP_FULLSCREEN) return PU_DECORATION_NONE;
    const struct PuDecorationTheme *theme = theme_for(view, false);
    int width = view->toplevel->base->geometry.width, height = view->toplevel->base->geometry.height;
    if (width < 1 || height < 1 || width > 32700 || height > 32700) return 0;
    int border = theme->border_width, top = theme->title_height;
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

static uint32_t mix(uint32_t from, uint32_t to, double amount)
{
    if (amount < 0) amount = 0;
    if (amount > 1) amount = 1;
    uint32_t result = 0xff000000;
    for (int shift = 0; shift <= 16; shift += 8) {
        int a = (from >> shift) & 255, b = (to >> shift) & 255;
        result |= (uint32_t)(a + (b - a) * amount) << shift;
    }
    return result;
}

static void blend(struct TitleBuffer *buffer, int x, int y, uint32_t rgb, unsigned alpha)
{
    if (x < 0 || x >= buffer->base.width || y < 0 || y >= buffer->base.height) return;
    uint32_t *pixel = &buffer->pixels[(size_t)y * buffer->base.width + x];
    if (!(*pixel >> 24)) return;
    uint32_t result = 0xff000000;
    for (int shift = 0; shift <= 16; shift += 8)
        result |= ((((rgb >> shift) & 255) * alpha +
            ((*pixel >> shift) & 255) * (255 - alpha) + 127) / 255) << shift;
    *pixel = result;
}

static uint32_t codepoint(const unsigned char **text)
{
    const unsigned char *s = *text;
    uint32_t value = *s++;
    if (value < 128) { *text = s; return value; }
    int extra = value >= 0xc2 && value <= 0xdf ? 1 :
        value >= 0xe0 && value <= 0xef ? 2 : value >= 0xf0 && value <= 0xf4 ? 3 : 0;
    if (!extra) { *text = s; return 0xfffd; }
    value &= (1u << (6 - extra)) - 1;
    for (int i = 0; i < extra; i++) {
        if ((s[i] & 0xc0) != 0x80) { *text = s; return 0xfffd; }
        value = (value << 6) | (s[i] & 63);
    }
    *text = s + extra;
    if (value < (extra == 1 ? 0x80u : extra == 2 ? 0x800u : 0x10000u) ||
        value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return 0xfffd;
    return value;
}

static FT_Face face_for(struct PuDecorations *state, uint32_t character)
{
    for (int i = 0; i < state->face_count; i++)
        if (FT_Get_Char_Index(state->faces[i], character)) return state->faces[i];
    if (state->face_count == 16) return state->faces[0];
    FcPattern *pattern = FcPatternCreate();
    FcCharSet *charset = FcCharSetCreate();
    if (!pattern || !charset) {
        if (pattern) FcPatternDestroy(pattern);
        if (charset) FcCharSetDestroy(charset);
        return NULL;
    }
    bool ok = FcCharSetAddChar(charset, character) &&
        FcPatternAddString(pattern, FC_FAMILY, (const FcChar8 *)"sans-serif") &&
        FcPatternAddCharSet(pattern, FC_CHARSET, charset) &&
        FcConfigSubstitute(state->fonts, pattern, FcMatchPattern);
    FcDefaultSubstitute(pattern);
    FcResult result;
    FcPattern *match = ok ? FcFontMatch(state->fonts, pattern, &result) : NULL;
    FcCharSetDestroy(charset);
    FcPatternDestroy(pattern);
    if (!match) return NULL;
    FcChar8 *file = NULL;
    int index = 0;
    FT_Face face = NULL;
    FcPatternGetInteger(match, FC_INDEX, 0, &index);
    if (FcPatternGetString(match, FC_FILE, 0, &file) == FcResultMatch &&
        FT_New_Face(state->freetype, (const char *)file, index, &face) == 0)
        state->faces[state->face_count++] = face;
    FcPatternDestroy(match);
    return face;
}

static bool draw_text(struct PuDecoration *d, struct TitleBuffer *buffer, const char *title,
                       int left, int right, double scale, uint32_t color)
{
    const unsigned char *text = (const unsigned char *)title;
    int pen = (int)ceil(left * scale);
    const int end = (int)floor(right * scale), size = (int)ceil(13 * scale);
    for (int count = 0; *text && count < 512 && pen < end; count++) {
        uint32_t character = codepoint(&text);
        if (character < 32 || character == 127) character = ' ';
        FT_Face face = face_for(d->view->desktop->decorations, character);
        if (!face) return false;
        if (FT_Set_Pixel_Sizes(face, 0, size) || FT_Load_Char(face, character, FT_LOAD_RENDER)) {
            face = d->view->desktop->decorations->faces[0];
            if (FT_Set_Pixel_Sizes(face, 0, size) || FT_Load_Glyph(face, 0, FT_LOAD_RENDER)) return false;
        }
        FT_GlyphSlot glyph = face->glyph;
        int advance = (int)(glyph->advance.x >> 6);
        if (pen + advance > end) break;
        FT_Bitmap *bitmap = &glyph->bitmap;
        int baseline = (buffer->base.height + (int)(face->size->metrics.ascender >> 6) +
            (int)(face->size->metrics.descender >> 6)) / 2;
        for (unsigned y = 0; y < bitmap->rows; y++) {
            const unsigned char *row = bitmap->buffer + (bitmap->pitch < 0 ?
                (bitmap->rows - 1 - y) * (unsigned)-bitmap->pitch : y * (unsigned)bitmap->pitch);
            for (unsigned x = 0; x < bitmap->width; x++) {
                unsigned alpha;
                if (bitmap->pixel_mode == FT_PIXEL_MODE_GRAY) alpha = row[x];
                else if (bitmap->pixel_mode == FT_PIXEL_MODE_MONO) alpha = row[x / 8] & (128 >> (x % 8)) ? 255 : 0;
                else if (bitmap->pixel_mode == FT_PIXEL_MODE_BGRA) alpha = row[x * 4 + 3];
                else return false;
                int px = pen + glyph->bitmap_left + (int)x;
                if (px >= left * scale && px < end)
                    blend(buffer, px, baseline - glyph->bitmap_top + (int)y, color, alpha);
            }
        }
        pen += advance;
    }
    return true;
}

static bool draw_title(struct PuDecoration *d, const char *text, int width, double scale, bool active)
{
    const struct PuDecorationTheme *theme = theme_for(d->view, false);
    int logical_width = width + 2 * theme->border_width, logical_height = theme->title_height;
    double pixel_width = ceil(logical_width * scale), pixel_height = ceil(logical_height * scale);
    if (pixel_width < 1 || pixel_height < 1 || pixel_width > 32768 || pixel_height > 4096 ||
        pixel_width * pixel_height > 16 * 1024 * 1024) return false;
    struct TitleBuffer *buffer = calloc(1, sizeof(*buffer));
    if (!buffer) return false;
    buffer->pixels = calloc((size_t)pixel_width * (size_t)pixel_height, sizeof(uint32_t));
    if (!buffer->pixels) { free(buffer); return false; }
    wlr_buffer_init(&buffer->base, &buffer_impl, (int)pixel_width, (int)pixel_height);
    int radius = theme->radius < logical_width / 2 ? theme->radius : logical_width / 2;
    if (radius > logical_height / 2) radius = logical_height / 2;
    for (int y = 0; y < buffer->base.height; y++) {
        double ly = (y + 0.5) / scale;
        uint32_t color = mix(active ? theme->titleFrom : theme->inactiveFrom,
            active ? theme->titleTo : theme->inactiveTo, ly / logical_height);
        if (theme->pinstripe && (int)ly % 3 == 0) color = mix(color, 0xffaabbcc, 0.12);
        for (int x = 0; x < buffer->base.width; x++) {
            double lx = (x + 0.5) / scale;
            double cx = lx < radius ? radius : lx > logical_width - radius ? logical_width - radius : lx;
            double cy = ly < radius ? radius : ly;
            if ((lx - cx) * (lx - cx) + (ly - cy) * (ly - cy) > radius * radius) continue;
            buffer->pixels[(size_t)y * buffer->base.width + x] =
                lx < theme->border_width || lx >= logical_width - theme->border_width ||
                ly < theme->border_width ? theme->border : color;
        }
    }
    int text_left = 10, text_right = logical_width - 10;
    for (int part = PU_DECORATION_CLOSE; part <= PU_DECORATION_MINIMIZE; part++) {
        struct wlr_box box;
        if (!pu_decoration_button_box(d->view, part, &box)) continue;
        box.x += theme->border_width; box.y += theme->title_height;
        if (theme->left_controls && text_left < box.x + box.width + 8) text_left = box.x + box.width + 8;
        if (!theme->left_controls && text_right > box.x - 8) text_right = box.x - 8;
        uint32_t from = part == PU_DECORATION_CLOSE ? theme->closeFrom : theme->controlFrom;
        uint32_t to = part == PU_DECORATION_CLOSE ? theme->closeTo : theme->controlTo;
        if (theme->round_controls && part == PU_DECORATION_MINIMIZE) { from = 0xffffdc76; to = 0xffeab63d; }
        if (theme->round_controls && part == PU_DECORATION_MAXIMIZE) { from = 0xff83dc93; to = 0xff42b964; }
        for (int y = (int)floor(box.y * scale); y < (int)ceil((box.y + box.height) * scale); y++) {
            for (int x = (int)floor(box.x * scale); x < (int)ceil((box.x + box.width) * scale); x++) {
                double rx = (x + 0.5) / scale - box.x, ry = (y + 0.5) / scale - box.y;
                double half = box.width / 2.0;
                if (theme->round_controls && (rx - half) * (rx - half) + (ry - half) * (ry - half) > half * half)
                    continue;
                uint32_t color = mix(from, to, ry / box.height);
                if (!active) color = mix(color, theme->inactiveTo, 0.55);
                if (d->hover == part) color = mix(color, 0xffffffff, 0.25);
                blend(buffer, x, y, color, 255);
                double gx = rx - half, gy = ry - half;
                bool mark = part == PU_DECORATION_CLOSE ? fabs(fabs(gx) - fabs(gy)) < 0.8 && fabs(gx) < 4 :
                    part == PU_DECORATION_MINIMIZE ? fabs(gy - 2) < 0.7 && fabs(gx) < 4 :
                    ((fabs(fabs(gx) - 3) < 0.7 && fabs(gy) <= 3) ||
                     (fabs(fabs(gy) - 3) < 0.7 && fabs(gx) <= 3));
                if (mark && (!theme->round_controls || d->hover == part))
                    blend(buffer, x, y, theme->controlText, 255);
            }
        }
    }
    bool ok = draw_text(d, buffer, text, text_left, text_right, scale,
                        active ? theme->titleText : theme->inactiveText);
    if (ok) {
        wlr_scene_buffer_set_buffer(d->title, &buffer->base);
        wlr_scene_buffer_set_dest_size(d->title, logical_width, logical_height);
    }
    wlr_buffer_drop(&buffer->base);
    return ok;
}

void pu_decoration_update(struct PuDesktopView *view)
{
    struct PuDecoration *d = view->decoration;
    if (!d) return;
    bool visible = d->decorated && view->mapped && view->mode != PU_DESKTOP_FULLSCREEN;
    wlr_scene_node_set_enabled(&d->tree->node, visible);
    if (!visible) return;
    struct wlr_box geometry = view->toplevel->base->geometry;
    if (geometry.width < 1 || geometry.height < 1) return;
    if (geometry.width > 32700 || geometry.height > 32700) {
        wlr_log(WLR_ERROR, "Decorated window exceeds supported dimensions");
        wl_resource_post_error(view->toplevel->base->resource, XDG_SURFACE_ERROR_INVALID_SIZE,
            "Decorated window exceeds supported dimensions");
        return;
    }
    double scale = pu_desktop_view_scale(view);
    const struct PuDecorationTheme *theme = theme_for(view, false);
    int border = theme->border_width;
    float color[4] = { ((theme->border >> 16) & 255) / 255.0f,
        ((theme->border >> 8) & 255) / 255.0f, (theme->border & 255) / 255.0f, 1 };
    wlr_scene_node_set_position(&d->title->node, -border, -theme->title_height);
    wlr_scene_node_set_position(&d->left->node, -border, 0);
    wlr_scene_node_set_position(&d->right->node, geometry.width, 0);
    wlr_scene_node_set_position(&d->bottom->node, -border, geometry.height);
    wlr_scene_rect_set_size(d->left, border, geometry.height);
    wlr_scene_rect_set_size(d->right, border, geometry.height);
    wlr_scene_rect_set_size(d->bottom, geometry.width + 2 * border, border);
    wlr_scene_rect_set_color(d->left, color);
    wlr_scene_rect_set_color(d->right, color);
    wlr_scene_rect_set_color(d->bottom, color);
    const char *title = view->toplevel->title && *view->toplevel->title ? view->toplevel->title :
        view->toplevel->app_id && *view->toplevel->app_id ? view->toplevel->app_id : "Untitled";
    bool active = view->desktop->focused == view && !view->desktop->focused_layer;
    bool maximized = view->mode == PU_DESKTOP_MAXIMIZED;
    if (d->width == geometry.width && d->height == geometry.height && d->scale == scale &&
        d->last_active == active && d->last_maximized == maximized && d->last_hover == d->hover &&
        d->last_title && !strcmp(d->last_title, title)) return;
    char *copy = strdup(title);
    if (!copy || !draw_title(d, title, geometry.width, scale, active)) {
        free(copy);
        wlr_log(WLR_ERROR, "Cannot rasterize titlebar (font, size or allocation failure)");
        wl_resource_post_no_memory(view->toplevel->resource);
        return;
    }
    free(d->last_title); d->last_title = copy;
    d->width = geometry.width; d->height = geometry.height; d->scale = scale;
    d->last_active = active; d->last_maximized = maximized; d->last_hover = d->hover;
}

void pu_decoration_hover(struct PuDesktop *desktop, struct PuDesktopView *view, int part)
{
    struct PuDesktopView *item;
    wl_list_for_each(item, &desktop->views, link) {
        if (!item->decoration) continue;
        int next = item == view ? part : 0;
        if (item->decoration->hover == next) continue;
        item->decoration->hover = next;
        pu_decoration_update(item);
    }
}

bool pu_decoration_create(struct PuDesktopView *view)
{
    struct PuDecoration *d = calloc(1, sizeof(*d));
    if (!d) return false;
    d->view = view;
    d->theme = d->pending_theme = view->desktop->decorations->theme;
    d->tree = wlr_scene_tree_create(view->tree);
    if (!d->tree) { free(d); return false; }
    d->title = wlr_scene_buffer_create(d->tree, NULL);
    d->left = wlr_scene_rect_create(d->tree, 1, 1, (float[4]){0, 0, 0, 1});
    d->right = wlr_scene_rect_create(d->tree, 1, 1, (float[4]){0, 0, 0, 1});
    d->bottom = wlr_scene_rect_create(d->tree, 1, 1, (float[4]){0, 0, 0, 1});
    if (!d->title || !d->left || !d->right || !d->bottom) {
        wlr_scene_node_destroy(&d->tree->node); free(d); return false;
    }
    wlr_scene_node_set_enabled(&d->tree->node, false);
    view->decoration = d;
    return true;
}

void pu_decoration_destroy(struct PuDesktopView *view)
{
    struct PuDecoration *d = view->decoration;
    if (!d) return;
    if (d->protocol) {
        wl_list_remove(&d->request_mode.link);
        wl_list_remove(&d->destroy.link);
        d->protocol->data = NULL;
    }
    wlr_scene_node_destroy(&d->tree->node);
    free(d->last_title); free(d);
    view->decoration = NULL;
}

void pu_decoration_configure(struct PuDesktopView *view)
{
    struct PuDecoration *d = view->decoration;
    if (!d || !d->protocol || !view->toplevel->base->initialized) return;
    enum wlr_xdg_toplevel_decoration_v1_mode mode =
        d->protocol->requested_mode == WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE ?
        WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE : WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE;
    wlr_xdg_toplevel_decoration_v1_set_mode(d->protocol, mode);
}

static void request_mode(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDecoration *d = wl_container_of(listener, d, request_mode);
    if (!d->view->toplevel->base->initialized) return;
    pu_decoration_configure(d->view);
    pu_desktop_redecorate(d->view);
}

static void decoration_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDecoration *d = wl_container_of(listener, d, destroy);
    wl_list_remove(&d->request_mode.link);
    wl_list_remove(&d->destroy.link);
    d->protocol->data = NULL;
    d->protocol = NULL;
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
        d->protocol = protocol;
        protocol->data = d;
        d->request_mode.notify = request_mode;
        wl_signal_add(&protocol->events.request_mode, &d->request_mode);
        d->destroy.notify = decoration_destroyed;
        wl_signal_add(&protocol->events.destroy, &d->destroy);
        request_mode(&d->request_mode, NULL);
        return;
    }
    wl_resource_post_no_memory(protocol->resource);
}

static void appearance_destroy(struct wl_client *client, struct wl_resource *resource)
{ (void)client; wl_resource_destroy(resource); }

static void set_theme(struct wl_client *client, struct wl_resource *resource, const char *name)
{
    struct PuDecorations *state = wl_resource_get_user_data(resource);
    if (client != state->desktop->shell_client) {
        wl_resource_post_error(resource, POLLY_APPEARANCE_V1_ERROR_UNAUTHORIZED, "Shell authorization was revoked");
        return;
    }
    for (unsigned i = 0; i < PU_DECORATION_THEME_COUNT; i++) {
        if (strcmp(name, pu_decoration_themes[i].id)) continue;
        if (state->theme == i) return;
        state->theme = i;
        struct PuDesktopView *view;
        wl_list_for_each(view, &state->desktop->all_views, all_link)
            if (view->decoration && (server_side(view->decoration, true) || view->decoration->decorated))
                pu_desktop_redecorate(view);
        return;
    }
    wl_resource_post_error(resource, POLLY_APPEARANCE_V1_ERROR_UNKNOWN_THEME, "Unknown decoration theme");
}

static const struct polly_appearance_v1_interface appearance_impl = {
    .destroy = appearance_destroy, .set_theme = set_theme,
};

static void appearance_bind(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
    struct PuDecorations *state = data;
    if (client != state->desktop->shell_client) {
        wl_client_post_implementation_error(client, "Appearance control requires the trusted Shell connection");
        return;
    }
    struct wl_resource *resource = wl_resource_create(client, &polly_appearance_v1_interface, version, id);
    if (!resource) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(resource, &appearance_impl, state, NULL);
}

bool pu_decorations_init(struct PuDesktop *desktop)
{
    struct PuDecorations *state = calloc(1, sizeof(*state));
    if (!state) return false;
    desktop->decorations = state;
    state->desktop = desktop;
    state->theme = PU_DECORATION_DEFAULT_THEME;
    if (FT_Init_FreeType(&state->freetype)) return false;
    state->fonts = FcInitLoadConfigAndFonts();
    if (!state->fonts || !face_for(state, 'A')) return false;
    state->manager = wlr_xdg_decoration_manager_v1_create(desktop->display);
    state->appearance = wl_global_create(desktop->display, &polly_appearance_v1_interface, 1, state, appearance_bind);
    if (!state->manager || !state->appearance) return false;
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
    for (int i = 0; i < state->face_count; i++) FT_Done_Face(state->faces[i]);
    if (state->freetype) FT_Done_FreeType(state->freetype);
    if (state->fonts) FcConfigDestroy(state->fonts);
    FcFini();
    free(state);
    desktop->decorations = NULL;
}
