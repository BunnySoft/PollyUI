#ifndef POLLYWM_WORKSPACE_H
#define POLLYWM_WORKSPACE_H
#include <stdbool.h>
#include <stdint.h>
#include <wayland-server-core.h>

struct PuDesktop;
struct PuDesktopView;
struct wlr_output;
struct PuWorkspace {
    struct wl_list link;
    uint32_t id;
    char *name;
    bool announced;
};

bool pu_workspaces_init(struct PuDesktop *desktop);
void pu_workspaces_finish(struct PuDesktop *desktop);
struct PuWorkspace *pu_workspace_at(struct PuDesktop *desktop, uint32_t index);
bool pu_workspace_current(struct PuDesktopView *view);
void pu_workspace_activate(struct PuDesktop *desktop, struct PuWorkspace *workspace, struct PuDesktopView *preferred);
void pu_workspace_step(struct PuDesktop *desktop, int direction);
void pu_workspaces_view_map(struct PuDesktopView *view);
void pu_workspaces_view_unmap(struct PuDesktopView *view);
void pu_workspaces_adopt_parent(struct PuDesktopView *view);
bool pu_workspaces_output_add(struct PuDesktop *desktop, struct wlr_output *output);

/* Applies visibility and focus after a complete workspace transaction. */
void pu_desktop_workspaces_changed(struct PuDesktop *desktop, struct PuDesktopView *preferred);
#endif
