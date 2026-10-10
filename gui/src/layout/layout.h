#ifndef POLLYUI_LAYOUT_LAYOUT_H
#define POLLYUI_LAYOUT_LAYOUT_H

/* LayoutEngine — Flexbox layout via Yoga (DESIGN.md §2).
 *
 * Builds a transient YGNode tree mirroring the DOM, applies styles, computes
 * layout for the given viewport, and writes absolute layout_x/y/w/h back onto
 * every element node. Text nodes are not laid out yet (M4). */

#include "model/node.h"

void pu_layout_calculate(PuNode *root, float width, float height);

/* Incremental layout: the DOM mutators call pu_layout_mark_dirty() whenever a
 * change can affect geometry, so pu_layout_calculate can skip the Yoga rebuild
 * when only render-only state changed. pu_layout_affects() classifies a style
 * property (1 = may change layout, 0 = render-only). */
void pu_layout_mark_dirty(void);
int  pu_layout_affects(const char *prop);

#endif /* POLLYUI_LAYOUT_LAYOUT_H */
