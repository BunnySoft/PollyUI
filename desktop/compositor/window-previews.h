#ifndef POLLYWM_WINDOW_PREVIEWS_H
#define POLLYWM_WINDOW_PREVIEWS_H

#include <stdint.h>
#include <stdbool.h>
struct PuDesktopView;
struct wlr_buffer;
struct wlr_scene_output;

uint64_t pu_window_preview_revision(struct PuDesktopView *view);
struct wlr_buffer *pu_window_preview_frame(struct PuDesktopView *view,
    struct wlr_scene_output *output, int width, int height);
bool pu_window_preview_project_quad(float ordinal, int width, int height, float vertices[16]);
bool pu_window_preview_hit_quad(const float vertices[16], int width, int height,
    double x, double y, float *depth);
/* Faces 0-3 are workspace sides; 4/5 close the top/bottom. One unit is a quarter turn. */
bool pu_workspace_cube_project_quad(unsigned face, float quarter_turns,
    int width, int height, float vertices[16]);

#endif
