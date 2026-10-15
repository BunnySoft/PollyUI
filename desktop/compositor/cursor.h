#ifndef POLLYWM_CURSOR_H
#define POLLYWM_CURSOR_H

#include <stdbool.h>
#include <stdint.h>
#include <string.h>
struct PuDesktop;
struct wlr_surface;

static inline bool pu_cursor_classic_theme(const char *setting)
{
    return !setting || !*setting || !strcmp(setting, "classic");
}

bool pu_cursor_init(struct PuDesktop *desktop);
void pu_cursor_finish(struct PuDesktop *desktop);
bool pu_cursor_load_scale(struct PuDesktop *desktop, float scale);
void pu_cursor_refresh(struct PuDesktop *desktop);
void pu_cursor_motion(struct PuDesktop *desktop);
void pu_cursor_button(struct PuDesktop *desktop, uint32_t button, bool pressed);
void pu_cursor_cancel(struct PuDesktop *desktop);
void pu_cursor_compositor(struct PuDesktop *desktop, const char *name);
void pu_cursor_drag(struct PuDesktop *desktop, struct wlr_surface *origin);
/* Native diagnostics used by the paired-input fixture, not a client protocol. */
const char *pu_cursor_selected(struct PuDesktop *desktop);
bool pu_cursor_timer_active(struct PuDesktop *desktop);

#endif
