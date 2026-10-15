#ifndef POLLY_APPEARANCE_CONFIG_H
#define POLLY_APPEARANCE_CONFIG_H
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include "appearance-fields.h"

enum PuCaptionStyle { PU_CAPTION_GENERIC, PU_CAPTION_LUNA, PU_CAPTION_CLASSIC, PU_CAPTION_FLUENT };

struct PuDecorationTheme {
    const char *id;
#define PU_METRIC_FIELD(type, field, token, minimum, maximum, scale) type field;
    PU_APPEARANCE_METRICS(PU_METRIC_FIELD)
#undef PU_METRIC_FIELD
    bool left_controls, round_controls, pinstripe, horizontal, glyphs_hover, luna;
    int font_family, text_align, caption_style;
    int control_width, control_top;
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
#define PU_APPEARANCE_V3_WORDS (PU_APPEARANCE_WORDS + 2)

static inline uint32_t pu_appearance_schema(bool luna)
{
    return luna ? 2u : 1u;
}

static inline uint32_t pu_appearance_theme_schema(const struct PuDecorationTheme *theme)
{
    return theme->caption_style >= PU_CAPTION_CLASSIC ||
        theme->control_width != theme->control_size ||
        theme->control_top != (theme->title_height - theme->control_size) / 2 + (theme->luna ? 2 : 0) ?
        3u : pu_appearance_schema(theme->luna);
}

static inline uint32_t pu_appearance_flags(const struct PuDecorationTheme *theme)
{
    return theme->left_controls | (theme->round_controls << 1) | (theme->pinstripe << 2) |
        (theme->horizontal << 3) | (theme->font_family << 4) | (theme->glyphs_hover << 6) |
        (theme->text_align << 7) | (theme->luna << 9) |
        ((theme->caption_style >= PU_CAPTION_CLASSIC ? theme->caption_style : 0) << 10);
}

static inline bool pu_appearance_schema_rejected(uint32_t schema, bool acknowledged,
                                                 bool accepted, const char *message)
{
    return schema >= 2 && schema <= 3 && acknowledged && !accepted && message &&
        (!strcmp(message, "Unsupported appearance schema") ||
         !strcmp(message, "Unsupported or out-of-range appearance data"));
}

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
    if ((words[0] < 1 || words[0] > 3) ||
        (words[1] & ~(words[0] == 1 ? 511u : words[0] == 2 ? 1023u : 4095u)) ||
        ((words[1] >> 4) & 3) == 3 ||
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
    theme->caption_style = words[0] == 3 ? (int)((words[1] >> 10) & 3) : 0;
    if (theme->caption_style == PU_CAPTION_LUNA ||
        (theme->caption_style && theme->luna)) return false;
    if (theme->luna) theme->caption_style = PU_CAPTION_LUNA;
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
    theme->control_width = theme->control_size;
    theme->control_top = (theme->title_height - theme->control_size) / 2 + (theme->luna ? 2 : 0);
    if (words[0] == 3) {
        if (words[index] < 8 || words[index] > 96 || words[index + 1] > 64) return false;
        theme->control_width = (int)words[index++];
        theme->control_top = (int)words[index++];
    }
    double stroke = theme->glyph_thickness > theme->close_thickness ?
        theme->glyph_thickness : theme->close_thickness;
    return (!theme->luna || theme->control_size + 4 <= theme->title_height) &&
        (!theme->round_controls || theme->control_width == theme->control_size) &&
        theme->control_top >= theme->border_width &&
        theme->control_top + theme->control_size <= theme->title_height &&
        theme->font_size + theme->border_width * 2 <= theme->title_height &&
        theme->stripe_width <= theme->stripe_spacing &&
        theme->glyph_radius + stroke <= theme->control_size / 2.0 &&
        theme->glyph_radius + stroke <= theme->control_width / 2.0;
}
#endif
