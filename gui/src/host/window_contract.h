#ifndef PU_WINDOW_CONTRACT_H
#define PU_WINDOW_CONTRACT_H

#include "pollyui/window.h"

static inline int pu_window_config_valid(const PuWindowConfig *c)
{
    if (!c) return 0;
    const PuWindowLimits *s = &c->limits;
    int service = c->layer != NULL || c->input_popup || c->lock_output != 0;
    int limits = s->min_width || s->min_height || s->max_width || s->max_height;
    return c->popup >= PU_POPUP_NONE && c->popup <= PU_POPUP_TOOLTIP &&
        (c->modal == 0 || c->modal == 1) &&
        (c->transparent == 0 || c->transparent == 1) &&
        !(c->transparent && (service || c->popup)) &&
        !(c->input_popup && c->lock_output) &&
        !(c->layer && (c->input_popup || c->lock_output)) &&
        !(service && (c->parent || c->popup || c->modal || limits)) &&
        !((c->popup || c->modal) && !c->parent) &&
        !(c->popup && (c->modal || limits)) &&
        !(!c->popup && (c->popup_x || c->popup_y)) &&
        s->min_width >= 0 && s->min_height >= 0 && s->max_width >= 0 && s->max_height >= 0 &&
        (!s->max_width || s->max_width >= s->min_width) &&
        (!s->max_height || s->max_height >= s->min_height);
}

static inline int pu_window_clamp(int size, int minimum, int maximum)
{
    if (minimum && size < minimum) size = minimum;
    if (maximum && size > maximum) size = maximum;
    return size;
}

static inline unsigned pu_window_required_capabilities(const PuWindowConfig *c)
{
    return (c->parent ? PU_WINDOW_OWNED : 0) | (c->popup ? PU_WINDOW_POPUP : 0) |
        (c->modal ? PU_WINDOW_MODAL : 0) |
        ((c->limits.min_width || c->limits.min_height || c->limits.max_width || c->limits.max_height) ?
            PU_WINDOW_LIMITS : 0) | (c->transparent ? PU_WINDOW_TRANSPARENT : 0);
}

#endif
