#ifndef POLLY_APPEARANCE_CONFIG_H
#define POLLY_APPEARANCE_CONFIG_H
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include "appearance-fields.h"

struct PuDecorationTheme {
    const char *id;
#define PU_METRIC_FIELD(type, field, token, minimum, maximum, scale) type field;
    PU_APPEARANCE_METRICS(PU_METRIC_FIELD)
#undef PU_METRIC_FIELD
    bool left_controls, round_controls, pinstripe, horizontal, glyphs_hover, luna;
    int font_family, text_align;
#define PU_COLOR_FIELD(name) uint32_t name;
    PU_APPEARANCE_COLORS(PU_COLOR_FIELD)
#undef PU_COLOR_FIELD
};

#define PU_COUNT_METRIC(type, field, token, minimum, maximum, scale) +1
#define PU_COUNT_COLOR(name) +1
enum { PU_APPEARANCE_WORDS = 2 PU_APPEARANCE_METRICS(PU_COUNT_METRIC) PU_APPEARANCE_COLORS(PU_COUNT_COLOR) };
#undef PU_COUNT_METRIC
#undef PU_COUNT_COLOR
#define PU_APPEARANCE_DOCUMENT_LIMIT 32768

static inline bool pu_appearance_identifier(const char *name)
{
    size_t length = name ? strlen(name) : 0;
    if (!length || length > 64 || name[0] < 'a' || name[0] > 'z') return false;
    for (size_t i = 1; i < length; i++)
        if (!((name[i] >= 'a' && name[i] <= 'z') || (name[i] >= '0' && name[i] <= '9') ||
            name[i] == '-' || name[i] == '_')) return false;
    return true;
}

static inline bool pu_appearance_decode(struct PuDecorationTheme *theme, const uint32_t *words)
{
    if ((words[0] != 1 && words[0] != 2) ||
        (words[1] & ~(words[0] == 1 ? 511u : 1023u)) || ((words[1] >> 4) & 3) == 3 ||
        ((words[1] >> 7) & 3) == 3) return false;
    memset(theme, 0, sizeof(*theme));
    theme->left_controls = words[1] & 1;
    theme->round_controls = words[1] & 2;
    theme->pinstripe = words[1] & 4;
    theme->horizontal = words[1] & 8;
    theme->font_family = (int)((words[1] >> 4) & 3);
    theme->glyphs_hover = words[1] & 64;
    theme->text_align = (int)((words[1] >> 7) & 3);
    theme->luna = words[1] & 512;
    unsigned index = 2;
#define PU_DECODE_METRIC(type, field, token, minimum, maximum, scale) \
    { double value = (double)words[index++] / (scale); \
      if (value < (minimum) || value > (maximum)) { return false; } theme->field = (type)value; }
    PU_APPEARANCE_METRICS(PU_DECODE_METRIC)
#undef PU_DECODE_METRIC
#define PU_DECODE_COLOR(name) \
    theme->name = words[index++]; if ((theme->name >> 24) != 255) return false;
    PU_APPEARANCE_COLORS(PU_DECODE_COLOR)
#undef PU_DECODE_COLOR
    return (!theme->luna || theme->control_size + 4 <= theme->title_height) &&
        theme->control_size + theme->border_width * 2 <= theme->title_height &&
        theme->font_size + theme->border_width * 2 <= theme->title_height &&
        theme->stripe_width <= theme->stripe_spacing &&
        theme->glyph_radius + (theme->glyph_thickness > theme->close_thickness ?
            theme->glyph_thickness : theme->close_thickness) <= theme->control_size / 2.0;
}
#endif
