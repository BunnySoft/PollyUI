#include "decoration.h"
#include "decoration-themes.h"
#include "decoration-paint.h"
#include "appearance-document.h"
#include "server.h"
#include "polly-appearance-server.h"

#include <drm_fourcc.h>
#include <fontconfig/fontconfig.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
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
    int font_family, font_weight;
    struct PuDecorationTheme theme;
    uint64_t generation;
    int document_fd;
    uint32_t document_size;
    struct wl_list appearance_clients;
    struct wl_global *theme_feed;
    struct wl_list theme_watchers;
    uint32_t theme_revision;
};

struct AppearanceClient {
    struct PuDecorations *state;
    struct wl_resource *resource;
    struct wl_list link;
    struct PuDecorationTheme staged;
    uint32_t serial;
    int document_fd;
    uint32_t document_size;
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
    struct wlr_scene_buffer *title;
    struct wlr_scene_rect *left, *right, *bottom;
    struct PuDecorationTheme theme, pending_theme;
    uint64_t generation, pending_generation;
    bool decorated, last_active, last_maximized, last_pressed;
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
    return pending ? &view->desktop->decorations->theme : &view->decoration->theme;
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
    if (view->decoration) {
        view->decoration->pending_theme = view->desktop->decorations->theme;
        view->decoration->pending_generation = view->desktop->decorations->generation;
    }
}

void pu_decoration_present(struct PuDesktopView *view)
{
    struct PuDecoration *d = view->decoration;
    if (!d) return;
    d->decorated = d->protocol && d->protocol->current.mode ==
        WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE;
    if (d->generation != d->pending_generation) {
        d->theme = d->pending_theme;
        d->generation = d->pending_generation;
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
    int size = theme->control_size;
    int index = part == PU_DECORATION_CLOSE ? 0 :
        part == PU_DECORATION_MINIMIZE && theme->left_controls ? 1 :
        part == PU_DECORATION_MAXIMIZE && !theme->left_controls ? 1 : 2;
    if (width < (index + 1) * size + index * theme->control_gap + 2 * theme->control_inset) return false;
    *box = (struct wlr_box) {
        .x = -theme->border_width + (theme->left_controls ? theme->control_inset + index * (size + theme->control_gap) :
            width - theme->control_inset - size - index * (size + theme->control_gap)),
        .y = -theme->title_height + (theme->title_height - size) / 2 + (theme->luna ? 2 : 0),
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

static FT_Face face_for(struct PuDecorations *state, uint32_t character, const struct PuDecorationTheme *theme)
{
    if (state->font_family != theme->font_family || state->font_weight != theme->font_weight) {
        for (int i = 0; i < state->face_count; i++) FT_Done_Face(state->faces[i]);
        state->face_count = 0;
        state->font_family = theme->font_family; state->font_weight = theme->font_weight;
    }
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
    const char *families[] = {"sans-serif", "serif", "monospace"};
    bool ok = FcCharSetAddChar(charset, character) &&
        FcPatternAddString(pattern, FC_FAMILY, (const FcChar8 *)families[theme->font_family]) &&
        FcPatternAddInteger(pattern, FC_WEIGHT, FcWeightFromOpenType(theme->font_weight)) &&
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

static FT_Face title_glyph(struct PuDecoration *decoration, uint32_t character, int size, int flags)
{
    const struct PuDecorationTheme *theme = &decoration->theme;
    if (character < 32 || character == 127) character = ' ';
    struct PuDecorations *state = decoration->view->desktop->decorations;
    FT_Face face = face_for(state, character, theme);
    if (!face) return NULL;
    if (FT_Set_Pixel_Sizes(face, 0, size) || FT_Load_Char(face, character, flags)) {
        face = state->faces[0];
        if (FT_Set_Pixel_Sizes(face, 0, size) || FT_Load_Glyph(face, 0, flags)) return NULL;
    }
    return face;
}

static bool draw_text(struct PuDecoration *d, struct TitleBuffer *buffer, const char *title,
                       int left, int right, double scale, uint32_t color)
{
    const unsigned char *text = (const unsigned char *)title;
    const struct PuDecorationTheme *theme = &d->theme;
    int pen = (int)ceil(left * scale);
    const int end = (int)floor(right * scale), size = (int)ceil(theme->font_size * scale);
    if (theme->text_align) {
        const unsigned char *scan = text;
        int width = 0;
        for (int count = 0; *scan && count < 512; count++) {
            FT_Face face = title_glyph(d, codepoint(&scan), size, FT_LOAD_DEFAULT);
            if (!face) return false;
            width += (int)(face->glyph->advance.x >> 6);
        }
        pen += (end - pen - width) / (theme->text_align == 1 ? 2 : 1);
    }
    for (int count = 0; *text && count < 512 && pen < end; count++) {
        uint32_t character = codepoint(&text);
        FT_Face face = title_glyph(d, character, size, FT_LOAD_RENDER);
        if (!face) return false;
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
                if (px >= left * scale && px < end) {
                    if (theme->luna)
                        blend(buffer, px + (int)ceil(scale), baseline - glyph->bitmap_top + (int)y +
                            (int)ceil(scale), pu_chrome_mix(color, 0xff000000, 0.7), alpha);
                    blend(buffer, px, baseline - glyph->bitmap_top + (int)y, color, alpha);
                }
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
        bool striped = theme->pinstripe && (int)ly % theme->stripe_spacing < theme->stripe_width;
        uint32_t vertical = pu_chrome_title(theme, ly, active);
        if (striped) vertical = mix(vertical, theme->stripeColor, theme->stripe_opacity);
        for (int x = 0; x < buffer->base.width; x++) {
            double lx = (x + 0.5) / scale;
            uint32_t color = vertical;
            if (theme->horizontal) {
                color = mix(active ? theme->titleFrom : theme->inactiveFrom,
                    active ? theme->titleTo : theme->inactiveTo, lx / logical_width);
                if (striped) color = mix(color, theme->stripeColor, theme->stripe_opacity);
            }
            double cx = lx < radius ? radius : lx > logical_width - radius ? logical_width - radius : lx;
            double cy = ly < radius ? radius : ly;
            if ((lx - cx) * (lx - cx) + (ly - cy) * (ly - cy) > radius * radius) continue;
            bool edge = lx < theme->border_width || lx >= logical_width - theme->border_width ||
                ly < theme->border_width;
            if (theme->luna) {
                if (lx < 1 || lx >= logical_width - 1)
                    color = active ? theme->border : pu_chrome_mix(theme->inactiveFrom, 0xff000000, 0.3);
                else if (lx < 2 || lx >= logical_width - 2)
                    color = pu_chrome_mix(color, 0xffffffff, 0.25);
            } else if (edge) color = theme->border;
            buffer->pixels[(size_t)y * buffer->base.width + x] = color;
        }
    }
    int text_left = theme->text_inset, text_right = logical_width - theme->text_inset;
    for (int part = PU_DECORATION_CLOSE; part <= PU_DECORATION_MINIMIZE; part++) {
        struct wlr_box box;
        if (!pu_decoration_button_box(d->view, part, &box)) continue;
        box.x += theme->border_width; box.y += theme->title_height;
        if (theme->left_controls && text_left < box.x + box.width + theme->text_gap)
            text_left = box.x + box.width + theme->text_gap;
        if (!theme->left_controls && text_right > box.x - theme->text_gap) text_right = box.x - theme->text_gap;
        uint32_t from = part == PU_DECORATION_CLOSE ? theme->closeFrom : theme->controlFrom;
        uint32_t to = part == PU_DECORATION_CLOSE ? theme->closeTo : theme->controlTo;
        if (part == PU_DECORATION_MINIMIZE) { from = theme->minimizeFrom; to = theme->minimizeTo; }
        if (part == PU_DECORATION_MAXIMIZE) { from = theme->maximizeFrom; to = theme->maximizeTo; }
        bool pressed = theme->luna && d->view->desktop->decoration_pressed == d->view &&
            d->view->desktop->decoration_part == part && d->hover == part;
        for (int y = (int)floor(box.y * scale); y < (int)ceil((box.y + box.height) * scale); y++) {
            for (int x = (int)floor(box.x * scale); x < (int)ceil((box.x + box.width) * scale); x++) {
                double rx = (x + 0.5) / scale - box.x, ry = (y + 0.5) / scale - box.y;
                double half = box.width / 2.0;
                if (theme->round_controls && (rx - half) * (rx - half) + (ry - half) * (ry - half) > half * half)
                    continue;
                if (!theme->round_controls && theme->control_radius > 0) {
                    double radius = theme->control_radius < half ? theme->control_radius : half;
                    double cx = fmax(radius, fmin(box.width - radius, rx));
                    double cy = fmax(radius, fmin(box.height - radius, ry));
                    if ((rx - cx) * (rx - cx) + (ry - cy) * (ry - cy) > radius * radius) continue;
                }
                uint32_t color = pu_chrome_control(theme, from, to, rx, ry, active, d->hover == part, pressed);
                blend(buffer, x, y, color, 255);
                bool mark = pu_chrome_glyph(theme, part - PU_DECORATION_CLOSE, rx, ry,
                    d->view->mode == PU_DESKTOP_MAXIMIZED, pressed);
                if (mark && (!theme->glyphs_hover || d->hover == part))
                    blend(buffer, x, y, theme->controlText, 255);
            }
        }
    }
    if (theme->luna && !theme->left_controls && text_left >= 24) {
        /* Original generic document mark; never a client's proprietary icon. */
        for (int y = (int)ceil(8 * scale); y < (int)ceil(23 * scale); y++)
            for (int x = (int)ceil(7 * scale); x < (int)ceil(19 * scale) && x < text_right * scale; x++) {
                double lx = (x + 0.5) / scale, ly = (y + 0.5) / scale;
                if (lx > 15 && ly < 12 && lx - 15 > ly - 8) continue;
                uint32_t ink = lx < 8 || lx >= 18 || ly < 9 || ly >= 22 ?
                    pu_chrome_mix(theme->controlTo, 0xff000000, 0.4) : theme->controlText;
                if (lx >= 9 && lx < 16 && ((ly >= 14 && ly < 15) || (ly >= 17 && ly < 18)))
                    ink = theme->controlFrom;
                blend(buffer, x, y, ink, active ? 255 : 160);
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
    bool active = view->desktop->focused == view && !view->desktop->focused_layer;
    uint32_t frame = theme->luna && !active ?
        pu_chrome_mix(theme->inactiveFrom, 0xff000000, 0.3) : theme->border;
    float color[4] = { ((frame >> 16) & 255) / 255.0f,
        ((frame >> 8) & 255) / 255.0f, (frame & 255) / 255.0f, 1 };
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
    bool maximized = view->mode == PU_DESKTOP_MAXIMIZED;
    bool pressed = theme->luna && view->desktop->decoration_pressed == view;
    if (d->width == geometry.width && d->height == geometry.height && d->scale == scale &&
        d->last_active == active && d->last_maximized == maximized && d->last_pressed == pressed && d->last_hover == d->hover &&
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
    d->last_active = active; d->last_maximized = maximized; d->last_pressed = pressed; d->last_hover = d->hover;
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
    d->generation = d->pending_generation = view->desktop->decorations->generation;
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

static void appearance_released(struct wl_resource *resource)
{
    struct AppearanceClient *client = wl_resource_get_user_data(resource);
    wl_list_remove(&client->link);
    if (client->document_fd >= 0) close(client->document_fd);
    free(client);
}

static void notify_theme(struct PuDecorations *state)
{
    if (!++state->theme_revision) ++state->theme_revision;
    struct ThemeWatcher *watcher;
    wl_list_for_each(watcher, &state->theme_watchers, link) {
        if (watcher->notified) continue;
        watcher->notified = true;
        polly_theme_manager_v1_send_changed(watcher->resource, state->theme_revision);
    }
}

static void repaint_decorations(struct PuDecorations *state)
{
    state->generation++;
    struct PuDesktopView *view;
    wl_list_for_each(view, &state->desktop->all_views, all_link)
        if (view->decoration && (server_side(view->decoration, true) || view->decoration->decorated))
            pu_desktop_redecorate(view);
    notify_theme(state);
}

static void theme_watcher_released(struct wl_resource *resource)
{
    struct ThemeWatcher *watcher = wl_resource_get_user_data(resource);
    wl_list_remove(&watcher->link);
    free(watcher);
}

static void theme_snapshot(struct wl_client *client, struct wl_resource *resource)
{
    (void)client;
    struct ThemeWatcher *watcher = wl_resource_get_user_data(resource);
    if (!watcher->notified) {
        wl_resource_post_error(resource, POLLY_THEME_MANAGER_V1_ERROR_UNEXPECTED_REQUEST,
            "Request a theme snapshot only after a change notification");
        return;
    }
    watcher->notified = false;
    if (watcher->state->document_fd >= 0)
        polly_theme_manager_v1_send_snapshot(resource, watcher->state->theme_revision,
            watcher->state->document_fd, watcher->state->document_size);
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
        wl_client_post_implementation_error(client, "Theme subscription limit reached");
        return;
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

static void set_theme(struct wl_client *client, struct wl_resource *resource, const char *name)
{
    struct AppearanceClient *owner = wl_resource_get_user_data(resource);
    struct PuDecorations *state = owner->state;
    if (client != state->desktop->shell_client) {
        wl_resource_post_error(resource, POLLY_APPEARANCE_V1_ERROR_UNAUTHORIZED, "Shell authorization was revoked");
        return;
    }
    for (unsigned i = 0; i < PU_DECORATION_THEME_COUNT; i++) {
        if (strcmp(name, pu_decoration_themes[i].id)) continue;
        if (state->theme.id == pu_decoration_themes[i].id) return;
        state->theme = pu_decoration_themes[i];
        if (state->document_fd >= 0) close(state->document_fd);
        state->document_fd = -1; state->document_size = 0;
        repaint_decorations(state);
        return;
    }
    wl_resource_post_error(resource, POLLY_APPEARANCE_V1_ERROR_UNKNOWN_THEME, "Unknown decoration theme");
}

static void prepare_theme(struct wl_client *client, struct wl_resource *resource, uint32_t serial,
                          const char *name, struct wl_array *configuration, int32_t document, uint32_t length)
{
    struct AppearanceClient *owner = wl_resource_get_user_data(resource);
    if (client != owner->state->desktop->shell_client) {
        close(document);
        wl_resource_post_error(resource, POLLY_APPEARANCE_V1_ERROR_UNAUTHORIZED, "Shell authorization was revoked");
        return;
    }
    if (owner->document_fd >= 0) close(owner->document_fd);
    owner->document_fd = -1; owner->document_size = 0; owner->serial = 0;
    uint32_t words[PU_APPEARANCE_WORDS];
    bool valid = serial && pu_appearance_identifier(name) && configuration->size == sizeof(words) &&
        pu_appearance_document_valid(document, length);
    if (valid) {
        memcpy(words, configuration->data, sizeof(words));
        valid = pu_appearance_decode(&owner->staged, words);
    }
    if (!valid) {
        close(document);
        polly_appearance_v1_send_prepared(resource, serial, 0, "Unsupported or out-of-range appearance data");
        return;
    }
    owner->document_fd = document; owner->document_size = length;
    owner->serial = serial;
    polly_appearance_v1_send_prepared(resource, serial, 1, "");
}

static void commit_theme(struct wl_client *client, struct wl_resource *resource, uint32_t serial)
{
    struct AppearanceClient *owner = wl_resource_get_user_data(resource);
    struct PuDecorations *state = owner->state;
    if (client != state->desktop->shell_client) {
        wl_resource_post_error(resource, POLLY_APPEARANCE_V1_ERROR_UNAUTHORIZED, "Shell authorization was revoked");
        return;
    }
    if (!serial || owner->serial != serial || owner->document_fd < 0 || state->generation == UINT64_MAX) {
        polly_appearance_v1_send_applied(resource, serial, 0, "No matching prepared appearance");
        return;
    }
    state->theme = owner->staged;
    if (state->document_fd >= 0) close(state->document_fd);
    state->document_fd = owner->document_fd; state->document_size = owner->document_size;
    owner->document_fd = -1; owner->document_size = 0; owner->serial = 0;
    repaint_decorations(state);
    polly_appearance_v1_send_applied(resource, serial, 1, "");
}

static void cancel_theme(struct wl_client *client, struct wl_resource *resource, uint32_t serial)
{
    (void)client;
    struct AppearanceClient *owner = wl_resource_get_user_data(resource);
    if (owner->serial != serial) return;
    if (owner->document_fd >= 0) close(owner->document_fd);
    owner->document_fd = -1; owner->document_size = 0; owner->serial = 0;
}

static const struct polly_appearance_v1_interface appearance_impl = {
    .destroy = appearance_destroy, .set_theme = set_theme,
    .prepare = prepare_theme, .commit = commit_theme, .cancel = cancel_theme,
};

static void appearance_bind(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
    struct PuDecorations *state = data;
    if (client != state->desktop->shell_client) {
        wl_client_post_implementation_error(client, "Appearance control requires the trusted Shell connection");
        return;
    }
    if (wl_list_length(&state->appearance_clients) >= 8) {
        wl_client_post_implementation_error(client, "Appearance binding limit reached");
        return;
    }
    struct AppearanceClient *owner = calloc(1, sizeof(*owner));
    if (!owner) { wl_client_post_no_memory(client); return; }
    owner->document_fd = -1;
    struct wl_resource *resource = wl_resource_create(client, &polly_appearance_v1_interface, version, id);
    if (!resource) { free(owner); wl_client_post_no_memory(client); return; }
    owner->state = state; owner->resource = resource;
    wl_list_insert(&state->appearance_clients, &owner->link);
    wl_resource_set_implementation(resource, &appearance_impl, owner, appearance_released);
}

bool pu_decorations_init(struct PuDesktop *desktop)
{
    struct PuDecorations *state = calloc(1, sizeof(*state));
    if (!state) return false;
    state->document_fd = -1;
    desktop->decorations = state;
    state->desktop = desktop;
    state->theme = pu_decoration_themes[PU_DECORATION_DEFAULT_THEME];
    state->generation = 1;
    wl_list_init(&state->appearance_clients);
    wl_list_init(&state->theme_watchers);
    state->theme_revision = 1;
    if (FT_Init_FreeType(&state->freetype)) return false;
    state->fonts = FcInitLoadConfigAndFonts();
    if (!state->fonts || !face_for(state, 'A', &state->theme)) return false;
    state->manager = wlr_xdg_decoration_manager_v1_create(desktop->display);
    state->appearance = wl_global_create(desktop->display, &polly_appearance_v1_interface, 2, state, appearance_bind);
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
    if (state->document_fd >= 0) close(state->document_fd);
    for (int i = 0; i < state->face_count; i++) FT_Done_Face(state->faces[i]);
    if (state->freetype) FT_Done_FreeType(state->freetype);
    if (state->fonts) FcConfigDestroy(state->fonts);
    FcFini();
    free(state);
    desktop->decorations = NULL;
}
