#define _POSIX_C_SOURCE 200809L
#include "server.h"
#include "window-previews.h"
#include <math.h>
#include <drm_fourcc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wlr/interfaces/wlr_buffer.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/util/log.h>

#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL window preview:%d: %s\n", __LINE__, #c); return false; } } while (0)

struct Pixels { struct wlr_buffer base; uint32_t pixels[16 * 16]; };
static unsigned sources_destroyed, source_samples;

static bool projection_geometry(void)
{
    const int sizes[][2] = {{320, 640}, {900, 480}, {1280, 720}, {4096, 768}};
    for (unsigned size = 0; size < sizeof(sizes) / sizeof(sizes[0]); size++) {
        int width = sizes[size][0], height = sizes[size][1];
        for (unsigned ordinal = 0; ordinal < 9; ordinal++) {
            float vertices[16], depth;
            CHECK(pu_window_preview_project_quad((float)ordinal, width, height, vertices));
            double x = 0, y = 0, w = 0;
            for (unsigned vertex = 0; vertex < 4; vertex++) {
                for (unsigned axis = 0; axis < 4; axis++) CHECK(isfinite(vertices[vertex * 4 + axis]));
                CHECK(vertices[vertex * 4 + 3] > 0);
                x += vertices[vertex * 4];
                y += vertices[vertex * 4 + 1];
                w += vertices[vertex * 4 + 3];
            }
            x = (x / w + 1) * width / 2;
            y = (y / w + 1) * height / 2;
            CHECK(pu_window_preview_hit_quad(vertices, width, height, x, y, &depth));
            CHECK(depth > -1 && depth < 1);
            CHECK(!pu_window_preview_hit_quad(vertices, width, height, -1, -1, &depth));
        }
        float front[16], back[16], front_depth, back_depth;
        CHECK(pu_window_preview_project_quad(0, width, height, front));
        CHECK(pu_window_preview_project_quad(1, width, height, back));
        double x = 0, y = 0, w = 0;
        for (unsigned vertex = 0; vertex < 4; vertex++) {
            x += front[vertex * 4]; y += front[vertex * 4 + 1]; w += front[vertex * 4 + 3];
        }
        x = (x / w + 1) * width / 2; y = (y / w + 1) * height / 2;
        CHECK(pu_window_preview_hit_quad(front, width, height, x, y, &front_depth));
        CHECK(pu_window_preview_hit_quad(back, width, height, x, y, &back_depth));
        CHECK(front_depth < back_depth);
        unsigned exposed = 0;
        for (int py = 0; py < height; py += 4) for (int px = 0; px < width; px += 4) {
            if (pu_window_preview_hit_quad(back, width, height, px, py, &back_depth) &&
                !pu_window_preview_hit_quad(front, width, height, px, py, &front_depth)) exposed++;
        }
        CHECK(exposed > 20);
    }
    puts("PASS: bounded real-perspective camera and depth-consistent quad hit testing");
    return true;
}

static bool cube_geometry(void)
{
    const int sizes[][2] = {{1280, 720}, {720, 1280}, {3840, 2160}, {320, 240}, {32768, 1}, {1, 32768}};
    for (unsigned size = 0; size < sizeof(sizes) / sizeof(sizes[0]); size++) {
        for (unsigned step = 0; step <= 32; step++) {
            float turns = (float)step / 8, vertices[6][16];
            for (unsigned face = 0; face < 6; face++) {
                CHECK(pu_workspace_cube_project_quad(face, turns, sizes[size][0], sizes[size][1], vertices[face]));
                for (unsigned vertex = 0; vertex < 4; vertex++) {
                    float w = vertices[face][vertex * 4 + 3];
                    CHECK(isfinite(w) && w > 0.05f);
                    for (unsigned axis = 0; axis < 3; axis++) {
                        float value = vertices[face][vertex * 4 + axis] / w;
                        CHECK(isfinite(value) && value > -1 && value < 1);
                    }
                }
            }
            for (unsigned vertex = 0; vertex < 2; vertex++) for (unsigned axis = 0; axis < 4; axis++) {
                CHECK(fabsf(vertices[0][(vertex * 2 + 1) * 4 + axis] -
                    vertices[1][vertex * 8 + axis]) < 0.00001f);
                CHECK(fabsf(vertices[0][vertex * 4 + axis] -
                    vertices[4][(vertex + 2) * 4 + axis]) < 0.00001f);
            }
        }
    }
    float front[16], back[16], selected[16], front_depth, back_depth;
    CHECK(pu_workspace_cube_project_quad(0, 0, 1280, 720, front));
    CHECK(pu_workspace_cube_project_quad(2, 0, 1280, 720, back));
    CHECK(pu_workspace_cube_project_quad(1, 1, 1280, 720, selected));
    for (unsigned value = 0; value < 16; value++) CHECK(fabsf(front[value] - selected[value]) < 0.00001f);
    CHECK(pu_window_preview_hit_quad(front, 1, 1, 0.5, 0.5, &front_depth));
    CHECK(pu_window_preview_hit_quad(back, 1, 1, 0.5, 0.5, &back_depth));
    CHECK(front_depth < back_depth);
    for (unsigned step = 0; step < 2; step++) {
        float vertices[4][16];
        float turns = step == 0 ? 0.5f : 3.5f;
        for (unsigned face = 0; face < 4; face++)
            CHECK(pu_workspace_cube_project_quad(face, turns, 1280, 720, vertices[face]));
        unsigned visible = 0;
        for (unsigned sample = 1; sample < 100; sample++) {
            float nearest = 2;
            unsigned picked = 4;
            for (unsigned face = 0; face < 4; face++) {
                float depth;
                if (pu_window_preview_hit_quad(vertices[face], 1, 1, (double)sample / 100, 0.5, &depth) &&
                    depth < nearest) { nearest = depth; picked = face; }
            }
            if (picked < 4) visible |= 1u << picked;
        }
        CHECK(visible == (step == 0 ? 3u : 9u));
    }
    CHECK(!pu_workspace_cube_project_quad(6, 0, 1280, 720, front));
    CHECK(!pu_workspace_cube_project_quad(0, NAN, 1280, 720, front));
    CHECK(!pu_workspace_cube_project_quad(0, 5, 1280, 720, front));
    CHECK(!pu_workspace_cube_project_quad(0, 0, 0, 720, front));
    puts("PASS: closed four-workspace cube geometry, shared cap/side seams, portrait/extreme fitting and depth-consistent adjacent-face visibility");
    return true;
}

static void pixels_destroy(struct wlr_buffer *buffer)
{
    wlr_buffer_finish(buffer);
    sources_destroyed++;
    free(buffer);
}
static bool pixels_begin(struct wlr_buffer *buffer, uint32_t flags, void **data, uint32_t *format, size_t *stride)
{
    if (flags & WLR_BUFFER_DATA_PTR_ACCESS_WRITE) return false;
    struct Pixels *pixels = wl_container_of(buffer, pixels, base);
    *data = pixels->pixels;
    *format = DRM_FORMAT_ARGB8888;
    *stride = 16 * sizeof(uint32_t);
    return true;
}
static void pixels_end(struct wlr_buffer *buffer) { (void)buffer; }
static const struct wlr_buffer_impl pixels_impl = {
    .destroy = pixels_destroy, .begin_data_ptr_access = pixels_begin, .end_data_ptr_access = pixels_end,
};
static void sampled(struct wl_listener *listener, void *data)
{
    (void)listener; (void)data;
    source_samples++;
}
static bool pixel(struct wlr_buffer *buffer, int x, int y, uint32_t expected)
{
    void *data;
    uint32_t format, value;
    size_t stride;
    CHECK(wlr_buffer_begin_data_ptr_access(buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride));
    CHECK(format == DRM_FORMAT_ARGB8888);
    memcpy(&value, (char *)data + (size_t)y * stride + (size_t)x * 4, sizeof(value));
    wlr_buffer_end_data_ptr_access(buffer);
    for (unsigned shift = 0; shift < 32; shift += 8)
        CHECK(abs((int)((value >> shift) & 255) - (int)((expected >> shift) & 255)) <= 2);
    return true;
}

static bool suite(struct PuDesktop *desktop)
{
    struct wlr_output_layout_output *entry = wl_container_of(desktop->layout->outputs.next, entry, link);
    struct wlr_scene_output *output = wlr_scene_get_scene_output(desktop->scene, entry->output);
    struct wlr_scene_tree *owner = wlr_scene_tree_create(desktop->windows);
    struct wlr_scene_tree *source = owner ? wlr_scene_tree_create(owner) : NULL;
    CHECK(source);
    wlr_scene_node_set_position(&owner->node, 200, 120);
    CHECK(wlr_scene_rect_create(source, 32, 16, (float[4]){1, 0, 0, 1}));
    struct wlr_scene_rect *overlap = wlr_scene_rect_create(source, 16, 16, (float[4]){0, 0.5f, 0, 0.5f});
    CHECK(overlap);
    wlr_scene_node_set_position(&overlap->node, 16, 0);
    struct Pixels *pixels = calloc(1, sizeof(*pixels));
    CHECK(pixels);
    wlr_buffer_init(&pixels->base, &pixels_impl, 16, 16);
    for (unsigned index = 0; index < 16 * 16; index++) pixels->pixels[index] = 0xff0000ff;
    struct wlr_scene_buffer *image = wlr_scene_buffer_create(source, &pixels->base);
    CHECK(image);
    wlr_buffer_drop(&pixels->base);
    wlr_scene_node_set_position(&image->node, 32, 0);
    struct wl_listener observer = {.notify = sampled};
    wl_signal_add(&image->events.output_sample, &observer);
    const struct wlr_box box = {0, 0, 64, 32};
    size_t before = desktop->scene->effects_cached_bytes;
    struct wlr_buffer *frame = wlr_scene_tree_snapshot(source, output, &box, 0, 128, 128);
    CHECK(frame && frame->width == 128 && frame->height == 128);
    CHECK(desktop->scene->effects_cached_bytes == before + 128 * 128 * 8);
    CHECK(pixel(frame, 16, 40, 0xffff0000));
    CHECK(pixel(frame, 48, 40, 0xff808000));
    CHECK(pixel(frame, 80, 40, 0xff0000ff));
    CHECK(pixel(frame, 16, 80, 0));
    CHECK(pixel(frame, 0, 0, 0));
    CHECK(source_samples == 0);
    wlr_scene_node_set_enabled(&owner->node, false);
    struct wlr_buffer *hidden = wlr_scene_tree_snapshot(source, output, &box, 0, 128, 128);
    CHECK(hidden && pixel(hidden, 80, 40, 0xff0000ff));
    CHECK(source_samples == 0);
    wlr_buffer_drop(hidden);
    wlr_scene_rect_set_color(overlap, (float[4]){0, 1, 0, 1});
    CHECK(pixel(frame, 48, 40, 0xff808000));
    struct wlr_buffer *next = wlr_scene_tree_snapshot(source, output, &box, 0, 128, 128);
    CHECK(next && pixel(next, 48, 40, 0xff00ff00));
    wlr_buffer_drop(next);
    struct wlr_buffer *rounded = wlr_scene_tree_snapshot(source, output, &box, 8, 128, 64);
    CHECK(rounded && pixel(rounded, 0, 0, 0) && pixel(rounded, 16, 8, 0xffff0000));
    wlr_buffer_drop(rounded);
    CHECK(!wlr_scene_tree_snapshot(source, output, &box, 0, 1025, 1));
    CHECK(!wlr_scene_tree_snapshot(source, output, &(struct wlr_box){0}, 0, 1, 1));
    CHECK(desktop->scene->effects_cached_bytes == before + 128 * 128 * 8);
    wl_list_remove(&observer.link);
    wlr_scene_node_destroy(&image->node);
    CHECK(sources_destroyed == 1 && pixel(frame, 80, 40, 0xff0000ff));
    struct wlr_buffer *held[32] = {0};
    unsigned count = 0;
    while (count < 32) {
        held[count] = wlr_scene_tree_snapshot(source, output, &box, 0, 1024, 640);
        if (!held[count]) break;
        count++;
    }
    CHECK(count > 0 && count < 32 && desktop->scene->effects_cached_bytes <= WLR_SCENE_EFFECTS_MAX_BYTES);
    for (unsigned index = 0; index < count; index++) wlr_buffer_drop(held[index]);
    CHECK(desktop->scene->effects_cached_bytes == before + 128 * 128 * 8);
    wlr_scene_node_destroy(&owner->node);
    CHECK(pixel(frame, 80, 40, 0xff0000ff));
    wlr_buffer_drop(frame);
    CHECK(desktop->scene->effects_cached_bytes == before);

    struct wlr_scene *temporary = wlr_scene_create();
    CHECK(temporary);
    struct wlr_scene_output *temporary_output = wlr_scene_output_create(temporary, entry->output);
    source = wlr_scene_tree_create(&temporary->tree);
    CHECK(temporary_output && source && wlr_scene_rect_create(source, 16, 16, (float[4]){1, 0, 0, 1}));
    frame = wlr_scene_tree_snapshot(source, temporary_output, &(struct wlr_box){0, 0, 16, 16}, 0, 16, 16);
    CHECK(frame);
    wlr_scene_node_destroy(&temporary->tree.node);
    CHECK(pixel(frame, 8, 8, 0xffff0000));
    wlr_buffer_drop(frame);
    puts("PASS: owned actual subtree pixels, overlap/alpha, aspect fit, hidden ancestors, no sampling feedback, source independence and bounded frame lifetime");
    return true;
}

int main(void)
{
    char runtime[] = "/tmp/polly-window-preview-XXXXXX";
    if (!mkdtemp(runtime)) return 1;
    setenv("XDG_RUNTIME_DIR", runtime, 1);
    setenv("WLR_BACKENDS", "headless", 1);
    setenv("WLR_HEADLESS_OUTPUTS", "1", 1);
    setenv("WLR_RENDERER", "pixman", 1);
    wlr_log_init(WLR_ERROR, NULL);
    struct PuDesktop desktop = {0};
    bool passed = projection_geometry() && cube_geometry() &&
        pu_desktop_init(&desktop, NULL) && pu_desktop_start(&desktop) && suite(&desktop);
    pu_desktop_finish(&desktop);
    if (rmdir(runtime)) passed = false;
    return passed ? 0 : 1;
}
