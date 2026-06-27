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

static void text_color(const PuNode *n, uint8_t *r, uint8_t *g, uint8_t *b, uint8_t *a)
{
    const PuNode *p = n->parent;
    const char *v = p ? pu_style_get(&p->style, "color") : NULL;
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

static float style_num(const PuNode *n, const char *name, float def)
{
    const char *v = pu_style_get(&n->style, name);
    return (v && *v) ? (float)atof(v) : def;
}

static void render_node(PuSurface *s, PuNode *n)
{
    if (n->type == PU_NODE_TEXT) {
        if (n->text && *n->text) {
            uint8_t r, g, b, a;
            text_color(n, &r, &g, &b, &a);
            pu_surface_draw_text(s, n->text, n->layout_x, n->layout_y, text_font_size(n),
                                 text_font_weight(n), text_italic(n), r, g, b, a);
        }
        for (PuNode *c = n->first_child; c; c = c->next_sibling) render_node(s, c);
        return;
    }

    /* element */
    const char *disp = pu_style_get(&n->style, "display");
    if (disp && strcmp(disp, "none") == 0) return;

    float x = n->layout_x, y = n->layout_y, w = n->layout_w, h = n->layout_h;
    float radius  = style_num(n, "borderRadius", 0);
    float opacity = style_num(n, "opacity", 1.0f);
    uint8_t r, g, b, a;

    int layered = (opacity < 1.0f);
    if (layered) pu_surface_save_layer_alpha(s, opacity);

    const char *sc = pu_style_get(&n->style, "shadowColor");
    if (sc && parse_color(sc, &r, &g, &b, &a) && a > 0) {
        pu_surface_shadow(s, x, y, w, h, radius,
                          style_num(n, "shadowBlur", 12), style_num(n, "shadowX", 0),
                          style_num(n, "shadowY", 4), r, g, b, a);
    }

    const char *bg = pu_style_get(&n->style, "backgroundColor");
    if (bg && parse_color(bg, &r, &g, &b, &a) && a > 0)
        pu_surface_fill_rrect(s, x, y, w, h, radius, r, g, b, a);

    for (PuNode *c = n->first_child; c; c = c->next_sibling) render_node(s, c);

    const char *bc = pu_style_get(&n->style, "borderColor");
    float bw = style_num(n, "borderWidth", 0);
    if (bw > 0 && bc && parse_color(bc, &r, &g, &b, &a) && a > 0)
        pu_surface_stroke_rrect(s, x, y, w, h, radius, bw, r, g, b, a);

    if (layered) pu_surface_restore(s);
}

void pu_render_tree(PuSurface *surface, PuNode *root, float scale)
{
    pu_surface_set_scale(surface, scale);           /* logical -> physical */
    pu_surface_clear(surface, 255, 255, 255, 255);  /* white viewport */
    if (root) render_node(surface, root);
}
