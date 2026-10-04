#ifndef POLLYUI_RENDER_RENDER_H
#define POLLYUI_RENDER_RENDER_H

/* RenderEngine — paints a laid-out DOM tree onto a Skia surface (DESIGN.md §5).
 *
 * M3: clears to white, then fills each element's background-color rect at its
 * computed layout box. Borders, text, gradients, etc. come later. */

#include "render/skia_c.h"
#include "model/node.h"

/* Paint the laid-out tree. `scale` maps logical (layout) pixels to physical
 * device pixels for high-DPI displays (1.0 = no scaling). */
void pu_render_tree(PuSurface *surface, PuNode *root, float scale);
void pu_render_tree_transparent(PuSurface *surface, PuNode *root, float scale);

#endif /* POLLYUI_RENDER_RENDER_H */
