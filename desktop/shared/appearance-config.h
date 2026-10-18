#ifndef POLLY_APPEARANCE_CONFIG_H
#define POLLY_APPEARANCE_CONFIG_H
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include "appearance-fields.h"

struct PuDecorationLayout {
    bool left_controls;
#define PU_LAYOUT_FIELD(type, field, token, minimum, maximum, scale) type field;
    PU_APPEARANCE_METRICS(PU_LAYOUT_FIELD)
#undef PU_LAYOUT_FIELD
};
#define PU_COUNT_FIELD(type, field, token, minimum, maximum, scale) +1
enum { PU_APPEARANCE_WORDS = 2 PU_APPEARANCE_METRICS(PU_COUNT_FIELD) };
#undef PU_COUNT_FIELD
#define PU_APPEARANCE_SCHEMA 7
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

static inline bool pu_appearance_decode(struct PuDecorationLayout *layout, const uint32_t *words)
{
    if (words[0] != PU_APPEARANCE_SCHEMA || words[1] > 1) return false;
    memset(layout, 0, sizeof(*layout));
    layout->left_controls = words[1] == 1;
    unsigned index = 2;
#define PU_DECODE_FIELD(type, field, token, minimum, maximum, scale) \
    { double value = (double)words[index++] / (scale); \
      if (value < (minimum) || value > (maximum)) return false; \
      layout->field = (type)value; }
    PU_APPEARANCE_METRICS(PU_DECODE_FIELD)
#undef PU_DECODE_FIELD
    return layout->control_top >= layout->border_width &&
        layout->control_top + layout->control_height <= layout->title_height;
}
#endif
