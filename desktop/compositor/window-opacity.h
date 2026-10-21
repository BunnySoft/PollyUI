#ifndef POLLYWM_WINDOW_OPACITY_H
#define POLLYWM_WINDOW_OPACITY_H

#include <stdbool.h>
#include <stdint.h>
struct PuDesktop;
struct PuDesktopView;
struct wlr_scene_tree;
struct wlr_box;

float pu_window_opacity(struct PuDesktopView *view);
bool pu_window_composition(struct wlr_scene_tree *tree, const struct wlr_box *box, float radius, float opacity);
bool pu_window_effects_update(struct PuDesktopView *view);
bool pu_desktop_set_window_opacity(struct PuDesktop *desktop, uint32_t percent);
bool pu_window_opacity_supported(struct PuDesktop *desktop);
bool pu_desktop_prepare_window_opacity(struct PuDesktop *desktop);

#endif
