#ifndef POLLYWM_SERVER_H
#define POLLYWM_SERVER_H

#include <stdbool.h>
#include <stdint.h>
#include <sys/types.h>
#include <wayland-server-core.h>
#include <wlr/util/box.h>

struct PuDesktop;
struct PuDesktopOwner {
    struct PuDesktopView *view;
    struct PuDesktopLayer *layer;
};

struct PuDesktopLayer {
    struct PuDesktop *desktop;
    struct PuDesktopOwner owner;
    struct wlr_layer_surface_v1 *surface;
    struct wlr_scene_tree *tree, *content, *popups;
    struct wl_list link;
    struct wl_listener map, unmap, commit, destroy;
    struct wlr_box pending_box;
    uint32_t serial;
    bool ready, positioned, presented;
};

enum PuDesktopMode {
    PU_DESKTOP_FLOATING,
    PU_DESKTOP_MAXIMIZED,
    PU_DESKTOP_FULLSCREEN,
};

struct PuDesktopView {
    struct PuDesktop *desktop;
    struct PuDesktopOwner owner;
    struct wlr_xdg_toplevel *toplevel;
    struct wlr_scene_tree *tree;
    struct wlr_scene_tree *content, *popups;
    struct wlr_scene_rect *backdrop;
    struct wl_list link, all_link;
    bool mapped;
    /* Policy may lead the presented mode until a matching configure is committed. */
    bool maximized, fullscreen, geometry_pending;
    enum PuDesktopMode mode;
    struct wlr_output *output;
    struct wlr_box restore_box, pending_box, presented_box;
    uint32_t geometry_serial;
    bool resize_pending;
    struct wlr_box resize_anchor;
    uint32_t resize_edges;
    struct wl_listener map, unmap, commit, destroy;
    struct wl_listener move, resize, maximize, request_fullscreen;
};

enum PuDesktopGrab {
    PU_DESKTOP_PASSTHROUGH,
    PU_DESKTOP_MOVE,
    PU_DESKTOP_RESIZE,
};

/* Private compositor state, also inspected by the headless integration tests. */
struct PuDesktop {
    struct wl_display *display;
    struct wlr_backend *backend;
    struct wlr_renderer *renderer;
    struct wlr_allocator *allocator;
    struct wlr_scene *scene;
    struct wlr_scene_tree *windows, *layer_trees[4];
    struct wlr_scene_output_layout *scene_layout;
    struct wlr_output_layout *layout;
    struct wlr_cursor *cursor;
    struct wlr_xcursor_manager *cursor_theme;
    struct wlr_seat *seat;
    struct wlr_xdg_shell *shell;
    struct wlr_layer_shell_v1 *layer_shell;
    struct wl_list views, all_views, keyboards, pointers, layers;
    struct PuDesktopLayer *focused_layer;
    bool arranging_layers;
    struct PuDesktopView *focused, *grabbed;
    enum PuDesktopGrab grab;
    double grab_x, grab_y;
    struct wlr_box grab_box;
    uint32_t grab_edges, grab_button, suppressed_button;
    int output_count;
    bool failed, stopping;
    const char *socket_name;
    struct wl_event_source *sigint, *sigterm;
    struct wl_event_source *shell_exit;
    struct wl_client *shell_client;
    struct wl_listener shell_client_destroy;
    pid_t shell_pid;
    int shell_status;
    bool shell_exited;
    struct wl_listener new_output, new_input, new_toplevel, new_popup;
    struct wl_listener new_layer;
    struct wl_listener motion, motion_absolute, button, axis, frame;
    struct wl_listener request_cursor, request_selection;
    struct wl_listener layout_change;
};

/* On failure, finish is still required and is safe for partially initialized state. */
bool pu_desktop_init(struct PuDesktop *desktop, const char *socket_name);
bool pu_desktop_start(struct PuDesktop *desktop);
void pu_desktop_finish(struct PuDesktop *desktop);
bool pu_desktop_spawn_shell(struct PuDesktop *desktop, char *const argv[]);
void pu_desktop_stop_shell(struct PuDesktop *desktop);
bool pu_desktop_global_filter(const struct wl_client *client,
                              const struct wl_global *global, void *data);

#endif
