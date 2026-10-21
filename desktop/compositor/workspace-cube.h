#ifndef POLLYWM_WORKSPACE_CUBE_H
#define POLLYWM_WORKSPACE_CUBE_H

#include <stdbool.h>
#include <stdint.h>
struct PuDesktop;
struct wlr_keyboard;
struct wlr_output;

bool pu_workspace_cube_init(struct PuDesktop *desktop);
void pu_workspace_cube_finish(struct PuDesktop *desktop);
bool pu_workspace_cube_supported(struct PuDesktop *desktop);
const char *pu_workspace_cube_configure(struct PuDesktop *desktop, bool enabled, bool motion);
void pu_workspace_cube_status(struct PuDesktop *desktop, bool *enabled, bool *motion,
    bool *active, uint32_t *selected, const char **message);
bool pu_workspace_cube_step(struct PuDesktop *desktop, struct wlr_keyboard *keyboard,
    uint32_t modifiers, int direction);
bool pu_workspace_cube_key(struct PuDesktop *desktop, uint32_t key);
void pu_workspace_cube_pointer(struct PuDesktop *desktop, bool choose, double x, double y);
void pu_workspace_cube_modifiers(struct PuDesktop *desktop, struct wlr_keyboard *keyboard, uint32_t modifiers);
void pu_workspace_cube_cancel(struct PuDesktop *desktop);
void pu_workspace_cube_damage(struct PuDesktop *desktop);
void pu_workspace_cube_prepare(struct PuDesktop *desktop, struct wlr_output *output);
bool pu_workspace_cube_active(struct PuDesktop *desktop);

#endif
