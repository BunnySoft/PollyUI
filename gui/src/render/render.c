#include "render/render.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* ---- color parsing (#rgb, #rrggbb, #rrggbbaa, a few names) -----------------*/

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool parse_color(const char *s, uint8_t *r, uint8_t *g, uint8_t *b, uint8_t *a)
{
    if (!s) return false;
    *a = 255;

    if (s[0] == '#') {
        const char *h = s + 1;
        size_t n = strlen(h);
        int d[8];
        if (n == 3 || n == 4) {
            for (size_t i = 0; i < n; i++) { int x = hexval(h[i]); if (x < 0) return false; d[i] = x * 16 + x; }
            *r = (uint8_t)d[0]; *g = (uint8_t)d[1]; *b = (uint8_t)d[2];
            if (n == 4) *a = (uint8_t)d[3];
            return true;
        }
        if (n == 6 || n == 8) {
            for (size_t i = 0; i < n; i++) { int x = hexval(h[i]); if (x < 0) return false; d[i] = x; }
            *r = (uint8_t)(d[0] * 16 + d[1]);
            *g = (uint8_t)(d[2] * 16 + d[3]);
            *b = (uint8_t)(d[4] * 16 + d[5]);
            if (n == 8) *a = (uint8_t)(d[6] * 16 + d[7]);
            return true;
        }
        return false;
    }

    if (strcmp(s, "transparent") == 0) { *r = *g = *b = 0; *a = 0; return true; }

    static const struct { const char *name; uint8_t r, g, b; } named[] = {
        { "white", 255, 255, 255 }, { "black", 0, 0, 0 },
        { "red", 255, 0, 0 },       { "green", 0, 128, 0 },
        { "blue", 0, 0, 255 },      { "gray", 128, 128, 128 },
        { "grey", 128, 128, 128 },
    };
    for (size_t i = 0; i < sizeof(named) / sizeof(named[0]); i++)
        if (strcmp(s, named[i].name) == 0) { *r = named[i].r; *g = named[i].g; *b = named[i].b; return true; }

    return false;
}

/* ---- paint walk ------------------------------------------------------------*/

/* Text inherits fontSize + color from its parent element. */
static float text_font_size(const PuNode *n)
{
    const PuNode *p = n->parent;
    const char *v = p ? pu_style_get(&p->style, "fontSize") : NULL;
    float f = v ? (float)atof(v) : 0.0f;
    return f > 0 ? f : 16.0f;
}

static const char *style_get_st(const PuNode *n, const char *key); /* fwd */

static void text_color(const PuNode *n, uint8_t *r, uint8_t *g, uint8_t *b, uint8_t *a)
{
    const PuNode *p = n->parent;
    const char *v = p ? style_get_st(p, "color") : NULL; /* inherit parent hover/focus color */
    if (!v || !parse_color(v, r, g, b, a)) { *r = *g = *b = 0; *a = 255; } /* default black */
}

static int text_font_weight(const PuNode *n)
{
    const PuNode *p = n->parent;
    const char *v = p ? pu_style_get(&p->style, "fontWeight") : NULL;
    if (!v) return 400;
    if (strcmp(v, "bold") == 0) return 700;
    if (strcmp(v, "normal") == 0) return 400;
    int w = atoi(v);
    return w > 0 ? w : 400;
}

static int text_italic(const PuNode *n)
{
    const PuNode *p = n->parent;
    const char *v = p ? pu_style_get(&p->style, "fontStyle") : NULL;
    return v && strcmp(v, "italic") == 0;
}

static int text_align(const PuNode *n)
{
    const PuNode *p = n->parent;
    const char *v = p ? pu_style_get(&p->style, "textAlign") : NULL;
    if (!v) return 0;
    if (strcmp(v, "center") == 0) return 1;
    if (strcmp(v, "right") == 0)  return 2;
    return 0;
}

static const char *text_font_family(const PuNode *n)
{
    const PuNode *p = n->parent;
    return p ? pu_style_get(&p->style, "fontFamily") : NULL;
}

/* State-aware style lookup: when the node is focused/hovered, a `focus:KEY` or
 * `hover:KEY` override (if non-empty) wins over the base `KEY`. Focus takes
 * precedence over hover, resolved per-property so a node can, e.g., change its
 * background on hover and its border on focus independently. */
static const char *style_get_st(const PuNode *n, const char *key)
{
    if (n->state) {
        char buf[80];
        if (n->state & PU_STATE_FOCUS) {
            snprintf(buf, sizeof(buf), "focus:%s", key);
            const char *v = pu_style_get(&n->style, buf);
            if (v && *v) return v;
        }
        if (n->state & PU_STATE_HOVER) {
            snprintf(buf, sizeof(buf), "hover:%s", key);
            const char *v = pu_style_get(&n->style, buf);
            if (v && *v) return v;
        }
    }
    return pu_style_get(&n->style, key);
}

static float style_num(const PuNode *n, const char *name, float def)
{
    const char *v = pu_style_get(&n->style, name);
    return (v && *v) ? (float)atof(v) : def;
}

static float style_num_st(const PuNode *n, const char *name, float def)
{
    const char *v = style_get_st(n, name);
    return (v && *v) ? (float)atof(v) : def;
}

static void render_node(PuSurface *s, PuNode *n)
{
    if (n->type == PU_NODE_TEXT) {
        if (n->text && *n->text) {
            uint8_t r, g, b, a;
            text_color(n, &r, &g, &b, &a);
            const char *fam = text_font_family(n);
            /* gradient-filled text when the parent sets textGradientFrom/To */
            const PuNode *p = n->parent;
            const char *gf = p ? pu_style_get(&p->style, "textGradientFrom") : NULL;
            const char *gt = p ? pu_style_get(&p->style, "textGradientTo") : NULL;
            uint8_t r0, g0, b0, a0, r1, g1, b1, a1;
            if (gf && gt && parse_color(gf, &r0, &g0, &b0, &a0) && parse_color(gt, &r1, &g1, &b1, &a1)) {
                pu_surface_draw_text_gradient(s, n->text, n->layout_x, n->layout_y, text_font_size(n),
                                              text_font_weight(n), text_italic(n), fam,
                                              r0, g0, b0, r1, g1, b1);
            } else {
                pu_surface_draw_text(s, n->text, n->layout_x, n->layout_y, text_font_size(n),
                                     text_font_weight(n), text_italic(n), fam,
                                     n->text_wrap_width, text_align(n), n->layout_w, r, g, b, a);
            }
        }
        for (PuNode *c = n->first_child; c; c = c->next_sibling) render_node(s, c);
        return;
    }

    /* element */
    const char *disp = pu_style_get(&n->style, "display");
    if (disp && strcmp(disp, "none") == 0) return;

    float x = n->layout_x, y = n->layout_y, w = n->layout_w, h = n->layout_h;
    float radius  = style_num(n, "borderRadius", 0);
    float opacity = style_num_st(n, "opacity", 1.0f);
    uint8_t r, g, b, a;

    int layered = (opacity < 1.0f);
    if (layered) pu_surface_save_layer_alpha(s, opacity);

    /* transform: rotate/scale/translate about the element's center. Affects the
     * element and its subtree (paint only; hit-testing stays on the layout box). */
    float rot = style_num(n, "rotate", 0);
    float scl = style_num(n, "scale", 1);
    float tx  = style_num(n, "translateX", 0);
    float ty  = style_num(n, "translateY", 0);
    int xf = (rot != 0 || scl != 1 || tx != 0 || ty != 0);
    if (xf) {
        float cx = x + w / 2, cy = y + h / 2;
        pu_surface_save(s);
        pu_surface_translate(s, cx, cy);
        if (rot != 0) pu_surface_rotate(s, rot);
        if (scl != 1) pu_surface_scale(s, scl, scl);
        if (tx != 0 || ty != 0) pu_surface_translate(s, tx, ty);
        pu_surface_translate(s, -cx, -cy);
    }

    const char *sc = pu_style_get(&n->style, "shadowColor");
    if (sc && parse_color(sc, &r, &g, &b, &a) && a > 0) {
        pu_surface_shadow(s, x, y, w, h, radius,
                          style_num(n, "shadowBlur", 12), style_num(n, "shadowX", 0),
                          style_num(n, "shadowY", 4), r, g, b, a);
    }

    const char *bg = style_get_st(n, "backgroundColor");
    if (bg && parse_color(bg, &r, &g, &b, &a) && a > 0)
        pu_surface_fill_rrect(s, x, y, w, h, radius, r, g, b, a);

    const char *gf = pu_style_get(&n->style, "gradientFrom");
    const char *gt = pu_style_get(&n->style, "gradientTo");
    if (gf && gt) {
        uint8_t r0, g0, b0, a0, r1, g1, b1, a1;
        if (parse_color(gf, &r0, &g0, &b0, &a0) && parse_color(gt, &r1, &g1, &b1, &a1)) {
            const char *dir = pu_style_get(&n->style, "gradientDir");
            int horiz = dir && strcmp(dir, "horizontal") == 0;
            pu_surface_fill_gradient(s, x, y, w, h, radius, horiz,
                                     r0, g0, b0, a0, r1, g1, b1, a1);
        }
    }

    const char *img = pu_style_get(&n->style, "backgroundImage");
    if (img && *img) pu_surface_draw_image(s, img, x, y, w, h, radius);

    /* overflow: clip children to the box; scrollTop/Left translate them. */
    const char *ov = pu_style_get(&n->style, "overflow");
    int clip = ov && (strcmp(ov, "hidden") == 0 || strcmp(ov, "scroll") == 0 || strcmp(ov, "auto") == 0);
    float sx = style_num(n, "scrollLeft", 0), sy = style_num(n, "scrollTop", 0);
    if (clip) { pu_surface_save(s); pu_surface_clip_rrect(s, x, y, w, h, radius); }
    if (sx != 0 || sy != 0) pu_surface_translate(s, -sx, -sy);

    for (PuNode *c = n->first_child; c; c = c->next_sibling) render_node(s, c);

    if (clip) pu_surface_restore(s);     /* undoes the clip + translate */
    else if (sx != 0 || sy != 0) pu_surface_translate(s, sx, sy); /* undo translate */

    /* visible scrollbar thumb when a scroll/auto container's content overflows */
    if (ov && (strcmp(ov, "scroll") == 0 || strcmp(ov, "auto") == 0)) {
        float content_bottom = 0;
        for (PuNode *c = n->first_child; c; c = c->next_sibling) {
            float cb = (c->layout_y + c->layout_h) - y;
            if (cb > content_bottom) content_bottom = cb;
        }
        if (content_bottom > h + 0.5f) {
            /* Windows 11-style overlay scrollbar: a faint full-height track plus
             * a clearly visible rounded thumb, sitting in a small right gutter so
             * it reads as having its own width rather than hugging the edge. */
            float track = h - 8;
            float thumb_h = track * (h / content_bottom);
            if (thumb_h < 28) thumb_h = 28;
            if (thumb_h > track) thumb_h = track;
            float max_scroll = content_bottom - h;
            float thumb_y = max_scroll > 0 ? (sy / max_scroll) * (track - thumb_h) : 0;
            float bx = x + w - 11;   /* small gutter from the edge; clear of content */
            pu_surface_fill_rrect(s, bx + 1, y + 4, 6, track, 3.0f, 0, 0, 0, 18);            /* track */
            pu_surface_fill_rrect(s, bx, y + 4 + thumb_y, 8, thumb_h, 4.0f, 135, 135, 135, 205); /* thumb */
        }
    }

    const char *bc = style_get_st(n, "borderColor");
    float bw = style_num_st(n, "borderWidth", 0);
    if (bw > 0 && bc && parse_color(bc, &r, &g, &b, &a) && a > 0)
        pu_surface_stroke_rrect(s, x, y, w, h, radius, bw, r, g, b, a);

    if (xf) pu_surface_restore(s);
    if (layered) pu_surface_restore(s);
}

void pu_render_tree(PuSurface *surface, PuNode *root, float scale)
{
    pu_surface_set_scale(surface, scale);           /* logical -> physical */
    pu_surface_clear(surface, 255, 255, 255, 255);  /* white viewport */
    if (root) render_node(surface, root);
}

void pu_render_tree_transparent(PuSurface *surface, PuNode *root, float scale)
{
    pu_surface_set_scale(surface, scale);
    pu_surface_clear(surface, 0, 0, 0, 0);
    if (root) render_node(surface, root);
}
