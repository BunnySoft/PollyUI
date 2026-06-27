#ifndef POLLYUI_LAYOUT_LAYOUT_H
#define POLLYUI_LAYOUT_LAYOUT_H

/* LayoutEngine — Flexbox layout via Yoga (DESIGN.md §2).
 *
 * Builds a transient YGNode tree mirroring the DOM, applies styles, computes
 * layout for the given viewport, and writes absolute layout_x/y/w/h back onto
 * every element node. Text nodes are not laid out yet (M4). */

#include "model/node.h"

void pu_layout_calculate(PuNode *root, float width, float height);

#endif /* POLLYUI_LAYOUT_LAYOUT_H */
