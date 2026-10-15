#ifndef POLLYWM_DECORATION_PAINT_H
#define POLLYWM_DECORATION_PAINT_H
#include "appearance-config.h"
#include <math.h>

struct PuChromeBox { int x, y, width, height; };

static inline bool pu_chrome_button_box(const struct PuDecorationTheme *theme, int width,
    int command, struct PuChromeBox *box)
{
    if (command < 0 || command > 2) return false;
    int index = !command ? 0 : theme->left_controls ? (command == 2 ? 1 : 2) : command;
    int gap = theme->caption_style == PU_CAPTION_CLASSIC && index > 0 ?
        theme->control_gap : index * theme->control_gap;
    int size = theme->control_width;
    if (width < (index + 1) * size + gap + 2 * theme->control_inset) return false;
    *box = (struct PuChromeBox) {
        .x = theme->left_controls ? theme->control_inset + index * size + gap :
            width - theme->control_inset - size - index * size - gap,
        .y = theme->control_top, .width = size, .height = theme->control_size,
    };
    return true;
}

static inline uint32_t pu_chrome_mix(uint32_t from, uint32_t to, double amount)
{
    amount = fmax(0, fmin(1, amount));
    uint32_t result = 0xff000000;
    for (int shift = 0; shift <= 16; shift += 8) {
        int a = (from >> shift) & 255, b = (to >> shift) & 255;
        result |= (uint32_t)(a + (b - a) * amount) << shift;
    }
    return result;
}

static inline uint32_t pu_chrome_frame(const struct PuDecorationTheme *theme, int edge,
    int layer, bool active)
{
    if (theme->caption_style == PU_CAPTION_CLASSIC) {
        const uint32_t light[] = {0xffd4d0c8, 0xffffffff, 0xffd4d0c8};
        const uint32_t dark[] = {0xff404040, 0xff808080, 0xffd4d0c8};
        return (edge == 0 || edge == 1 ? light : dark)[layer < 3 ? layer : 2];
    }
    return theme->luna && !active ?
        pu_chrome_mix(theme->inactiveFrom, 0xff000000, 0.3) : theme->border;
}

static inline uint32_t pu_chrome_title(const struct PuDecorationTheme *theme, double y, bool active)
{
    uint32_t from = active ? theme->titleFrom : theme->inactiveFrom;
    uint32_t to = active ? theme->titleTo : theme->inactiveTo;
    if (!theme->luna) return pu_chrome_mix(from, to, y / theme->title_height);
    double position = fmax(0, (y - 0.5) / theme->title_height);
    const double stops[] = {0, 1.0/30, 2.0/30, 3.0/30, 4.0/30, 7.0/30,
        10.0/30, 14.0/30, 16.0/30, 22.0/30, 25.0/30, 27.0/30, 28.0/30, 1};
    uint32_t colors[] = {
        pu_chrome_mix(from, to, 0.3),
        pu_chrome_mix(to, active ? 0xff7cc4ff : 0xffffffff, active ? 0.5 : 0.2),
        pu_chrome_mix(to, active ? 0xff7cdcff : 0xffffffff, active ? 0.333 : 0.12),
        pu_chrome_mix(to, active ? 0xff0fa0ff : 0xffffffff, active ? 0.15 : 0.05),
        pu_chrome_mix(from, to, 0.5), from, pu_chrome_mix(from, to, 0.04),
        pu_chrome_mix(from, to, 0.07), pu_chrome_mix(from, to, 0.25), to, to,
        active ? pu_chrome_mix(to, 0xff0054fa, 0.4) : pu_chrome_mix(from, to, 0.8),
        active ? pu_chrome_mix(from, 0xff003fe3, 0.33) : from,
        active ? pu_chrome_mix(from, 0xff0034b8, 0.5) : pu_chrome_mix(from, 0xff000000, 0.12),
    };
    for (unsigned i = 1; i < sizeof(stops) / sizeof(stops[0]); i++)
        if (position <= stops[i])
            return pu_chrome_mix(colors[i - 1], colors[i],
                (position - stops[i - 1]) / (stops[i] - stops[i - 1]));
    return colors[sizeof(colors) / sizeof(colors[0]) - 1];
}

static inline uint32_t pu_chrome_control(const struct PuDecorationTheme *theme,
    uint32_t from, uint32_t to, double x, double y, bool active, bool hovered, bool pressed)
{
    double size = theme->control_size;
    if (theme->caption_style == PU_CAPTION_CLASSIC) {
        int px = (int)x, py = (int)y, width = theme->control_width;
        if (pressed) {
            if (!px || !py) return 0xff808080;
            return theme->controlFrom;
        }
        if (px == width - 1 || py == (int)size - 1) return 0xff404040;
        if (!px || !py) return 0xffffffff;
        if (px == width - 2 || py == (int)size - 2) return 0xff808080;
        return theme->controlFrom;
    }
    uint32_t color = pu_chrome_mix(from, to, y / size);
    if (!active) color = pu_chrome_mix(color, theme->inactiveTo, theme->inactive_opacity);
    if (hovered) color = pu_chrome_mix(color, theme->hoverColor, theme->hover_opacity);
    if (!theme->luna) return color;
    double edge = fmin(fmin(x, size - x), fmin(y, size - y));
    if (edge < 1) return pu_chrome_mix(theme->controlText, color, active ? 0.12 : 0.5);
    if (pressed) color = pu_chrome_mix(to, from, y / size);
    if (x < 2 || y < 2) color = pu_chrome_mix(color, pressed ? 0xff000000 : 0xffffffff, pressed ? 0.3 : 0.45);
    if (x > size - 2 || y > size - 2) color = pu_chrome_mix(color, pressed ? 0xffffffff : 0xff000000, pressed ? 0.15 : 0.25);
    return color;
}

static inline uint32_t pu_chrome_button(const struct PuDecorationTheme *theme, int command,
    uint32_t from, uint32_t to, double x, double y, bool active, bool hovered, bool pressed)
{
    if (theme->caption_style != PU_CAPTION_FLUENT)
        return pu_chrome_control(theme, from, to, x, y, active, hovered, pressed);
    if (!hovered) return active ? theme->titleFrom : theme->inactiveFrom;
    if (!command) return pressed ? theme->closeTo : theme->closeFrom;
    return pressed ? theme->controlTo : theme->hoverColor;
}

static inline uint32_t pu_chrome_pixel(const struct PuDecorationTheme *theme,
    double x, double y, int width, bool active)
{
    uint32_t color = theme->horizontal ?
        pu_chrome_mix(active ? theme->titleFrom : theme->inactiveFrom,
            active ? theme->titleTo : theme->inactiveTo,
            (x - theme->border_width) / fmax(1, width - 2 * theme->border_width)) :
        pu_chrome_title(theme, y, active);
    if (theme->pinstripe && (int)y % theme->stripe_spacing < theme->stripe_width)
        color = pu_chrome_mix(color, theme->stripeColor, theme->stripe_opacity);
    if (theme->luna) {
        if (x < 1 || x >= width - 1) color = pu_chrome_frame(theme, 1, 0, active);
        else if (x < 2 || x >= width - 2) color = pu_chrome_mix(color, 0xffffffff, 0.25);
    } else if (y < theme->border_width || x < theme->border_width ||
               x >= width - theme->border_width) {
        int layer = (int)fmin(y, fmin(x, width - 1 - floor(x)));
        int edge = y <= x && y < width - x ? 0 : x < width / 2 ? 1 : 2;
        color = pu_chrome_frame(theme, edge, layer, active);
    } else if (theme->caption_style == PU_CAPTION_CLASSIC && y >= theme->title_height - 1)
        color = 0xffd4d0c8;
    return color;
}

static inline bool pu_chrome_glyph(const struct PuDecorationTheme *theme, int command,
    double x, double y, bool maximized, bool pressed)
{
    double size = theme->control_size;
    double gx = x - theme->control_width / 2.0 - (pressed ? 1 : 0);
    double gy = y - size / 2 - (pressed ? 1 : 0);
    if (command == 0)
        return fabs(fabs(gx) - fabs(gy)) < theme->close_thickness && fabs(gx) < theme->glyph_radius;
    if (command == 2)
        return fabs(gy - (theme->round_controls ? 0 : theme->glyph_radius / 2)) <
            theme->glyph_thickness && fabs(gx) < theme->glyph_radius;
    if (theme->round_controls)
        return (fabs(gx) < theme->glyph_thickness && fabs(gy) < theme->glyph_radius) ||
            (fabs(gy) < theme->glyph_thickness && fabs(gx) < theme->glyph_radius);
    double extent = theme->glyph_radius * (theme->luna ? 1 : 0.75);
    if (maximized && (theme->luna || theme->caption_style == PU_CAPTION_CLASSIC ||
                     theme->caption_style == PU_CAPTION_FLUENT)) {
        double back_x = gx - 1, back_y = gy + 1;
        bool back = ((fabs(back_y + extent) < theme->glyph_thickness && fabs(back_x) <= extent) ||
            (fabs(back_x - extent) < theme->glyph_thickness && fabs(back_y) <= extent));
        gx += 1; gy -= 1;
        return back || (fabs(fabs(gx) - extent) < theme->glyph_thickness && fabs(gy) <= extent) ||
            (fabs(fabs(gy) - extent) < theme->glyph_thickness && fabs(gx) <= extent);
    }
    return (fabs(fabs(gx) - extent) < theme->glyph_thickness && fabs(gy) <= extent) ||
        (fabs(fabs(gy) - extent) < theme->glyph_thickness && fabs(gx) <= extent);
}
#endif
