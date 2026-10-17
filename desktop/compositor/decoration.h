#ifndef POLLYWM_DECORATION_H
#define POLLYWM_DECORATION_H
#include <stdbool.h>
#include <stdint.h>
#include <wlr/util/box.h>

struct PuDesktop;
struct PuDesktopView;
struct PuDecoration;
struct PuDecorations;
struct wlr_output;
void pu_decorations_backdrop_status(struct PuDesktop *desktop, struct wlr_output *output, const char *message);
void pu_decorations_validate_shell_backdrops(struct PuDesktop *desktop);

/* Edge hit results use the wlroots edge bitmask. */
enum PuDecorationPart {
    PU_DECORATION_NONE = 0,
    PU_DECORATION_TITLE = 16,
    PU_DECORATION_CLOSE,
    PU_DECORATION_MAXIMIZE,
    PU_DECORATION_MINIMIZE,
};

bool pu_decorations_init(struct PuDesktop *desktop);
void pu_decorations_finish(struct PuDesktop *desktop);
void pu_decorations_service_changed(struct PuDesktop *desktop);
bool pu_decoration_create(struct PuDesktopView *view);
void pu_decoration_destroy(struct PuDesktopView *view);
void pu_decoration_suspend(struct PuDesktopView *view);
void pu_decoration_waiting_clip(struct PuDesktopView *view, struct wlr_box *box);
void pu_decoration_schedule(struct PuDesktopView *view);
void pu_decoration_configure(struct PuDesktopView *view);
bool pu_decoration_mode_pending(struct PuDesktopView *view);
void pu_decoration_present(struct PuDesktopView *view);
bool pu_decoration_effects(struct PuDesktopView *view);
bool pu_decoration_ready(struct PuDesktopView *view);
/* Observe the latest complete server frame without requesting or presenting one. */
bool pu_decoration_presented_current(const struct PuDesktopView *view);
void pu_decoration_update(struct PuDesktopView *view);
void pu_decoration_inset(struct PuDesktopView *view, struct wlr_box *bounds, bool pending);
int pu_decoration_hit(struct PuDesktopView *view, double x, double y);
void pu_decoration_hover(struct PuDesktop *desktop, struct PuDesktopView *view, int part);
const char *pu_decoration_cursor(int part);
bool pu_decoration_button_box(struct PuDesktopView *view, int part, struct wlr_box *box);

/* Reconfigure; new client content or decoration modes still require a commit. */
void pu_desktop_redecorate(struct PuDesktopView *view);
void pu_desktop_decoration_ready(struct PuDesktopView *view);
double pu_desktop_view_scale(struct PuDesktopView *view);
#endif
