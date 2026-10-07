#ifndef POLLYWM_DECORATION_PAINT_H
#define POLLYWM_DECORATION_PAINT_H
#include "appearance-config.h"
#include <math.h>

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

static inline bool pu_chrome_glyph(const struct PuDecorationTheme *theme, int command,
    double x, double y, bool maximized, bool pressed)
{
    double size = theme->control_size;
    double gx = x - size / 2 - (pressed ? 1 : 0), gy = y - size / 2 - (pressed ? 1 : 0);
    if (command == 0)
        return fabs(fabs(gx) - fabs(gy)) < theme->close_thickness && fabs(gx) < theme->glyph_radius;
    if (command == 2)
        return fabs(gy - theme->glyph_radius / 2) < theme->glyph_thickness && fabs(gx) < theme->glyph_radius;
    double extent = theme->glyph_radius * (theme->luna ? 1 : 0.75);
    if (theme->luna && maximized) {
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
