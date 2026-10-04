#ifndef POLLYWM_DECORATION_H
#define POLLYWM_DECORATION_H
#include <stdbool.h>
#include <stdint.h>
#include <wlr/util/box.h>

struct PuDesktop;
struct PuDesktopView;
struct PuDecoration;
struct PuDecorations;

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
bool pu_decoration_create(struct PuDesktopView *view);
void pu_decoration_destroy(struct PuDesktopView *view);
void pu_decoration_schedule(struct PuDesktopView *view);
void pu_decoration_configure(struct PuDesktopView *view);
void pu_decoration_present(struct PuDesktopView *view);
void pu_decoration_update(struct PuDesktopView *view);
void pu_decoration_inset(struct PuDesktopView *view, struct wlr_box *bounds, bool pending);
int pu_decoration_hit(struct PuDesktopView *view, double x, double y);
void pu_decoration_hover(struct PuDesktop *desktop, struct PuDesktopView *view, int part);
const char *pu_decoration_cursor(int part);
bool pu_decoration_button_box(struct PuDesktopView *view, int part, struct wlr_box *box);

/* Reconfigure through the normal configure/ack/commit path. */
void pu_desktop_redecorate(struct PuDesktopView *view);
double pu_desktop_view_scale(struct PuDesktopView *view);
#endif
