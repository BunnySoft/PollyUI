#include "server.h"
#include "session-lock.h"
#include <drm_fourcc.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <wlr/backend/headless.h>
#include <wlr/backend/multi.h>
#include <wlr/interfaces/wlr_buffer.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/util/log.h>
#include <wlr/util/transform.h>

#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL effects:%d: %s\n", __LINE__, #c); return false; } } while (0)
struct Pixels { struct wlr_buffer base; uint32_t pixels[]; };
static void destroy(struct wlr_buffer *base) { wlr_buffer_finish(base); free(base); }
static bool access_pixels(struct wlr_buffer *base, uint32_t flags, void **data, uint32_t *format, size_t *stride)
{
    struct Pixels *pixels = wl_container_of(base, pixels, base);
    if (flags & WLR_BUFFER_DATA_PTR_ACCESS_WRITE) return false;
    *data = pixels->pixels; *format = DRM_FORMAT_ARGB8888; *stride = (size_t)base->width * 4;
    return true;
}
static void end_access(struct wlr_buffer *base) { (void)base; }
static const struct wlr_buffer_impl pixels_impl = {
    .destroy = destroy, .begin_data_ptr_access = access_pixels, .end_data_ptr_access = end_access,
};
static struct wlr_buffer *pattern(void)
{
    struct Pixels *pixels = calloc(1, sizeof(*pixels) + 24 * 20 * 4);
    if (!pixels) return NULL;
    wlr_buffer_init(&pixels->base, &pixels_impl, 24, 20);
    for (int y = 0; y < 20; y++) for (int x = 0; x < 24; x++)
        pixels->pixels[y * 24 + x] = 0x80000000 | (uint32_t)(x * 5) << 16 | (uint32_t)(y * 6) << 8 | 64;
    return &pixels->base;
}
static bool capture(struct PuDesktop *desktop, struct wlr_output *target, uint32_t **copy, int *width, int *height)
{
    struct wlr_scene_output *output = wlr_scene_get_scene_output(desktop->scene, target);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_lock_attach_render(target, true);
    bool built = wlr_scene_output_build_state(output, &state, NULL);
    wlr_output_lock_attach_render(target, false);
    CHECK(built && state.buffer);
    void *data; uint32_t format; size_t stride;
    CHECK(wlr_buffer_begin_data_ptr_access(state.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride));
    *width = state.buffer->width; *height = state.buffer->height;
    *copy = malloc((size_t)*width * *height * 4);
    CHECK(*copy && (format == DRM_FORMAT_ARGB8888 || format == DRM_FORMAT_XRGB8888));
    for (int y = 0; y < *height; y++)
        memcpy(*copy + y * *width, (char *)data + y * stride, (size_t)*width * 4);
    wlr_buffer_end_data_ptr_access(state.buffer);
    wlr_output_state_finish(&state);
    return true;
}
static float distance_to_round(float x, float y, float width, float height, float radius)
{
    float qx = fabsf(x - width / 2) - width / 2 + radius;
    float qy = fabsf(y - height / 2) - height / 2 + radius;
    return hypotf(fmaxf(qx, 0), fmaxf(qy, 0)) + fminf(fmaxf(qx, qy), 0) - radius;
}
static bool caption_suite(struct PuDesktop *desktop, const char *file)
{
    FILE *input = fopen(file, "rb");
    CHECK(input);
    uint32_t header[2];
    CHECK(fread(header, sizeof(header), 1, input) == 1 && header[0] == 0x50554345 && header[1] == 8);
    struct wlr_output_layout_output *entry = wl_container_of(desktop->layout->outputs.next, entry, link);
    struct wlr_scene_tree *background = wlr_scene_tree_create(&desktop->scene->tree);
    CHECK(background);
    wlr_scene_node_lower_to_bottom(&background->node);
    for (int y = 0; y < 192; y += 8) for (int x = 0; x < 256; x += 8) {
        float color[4] = {((x / 8 + y / 8) & 1) ? 0.2f : 0.8f, 0.4f, 0.6f, 1};
        struct wlr_scene_rect *rect = wlr_scene_rect_create(background, 8, 8, color);
        CHECK(rect); wlr_scene_node_set_position(&rect->node, x, y);
    }
    for (uint32_t record = 0; record < header[1]; record++) {
        uint32_t meta[8];
        CHECK(fread(meta, sizeof(meta), 1, input) == 1);
        CHECK(meta[0] == 64 && meta[1] == 64 && meta[2] >= 16 && meta[2] <= 96 &&
            meta[3] == 16 && meta[6] <= 512 && meta[7] <= 512);
        float scale; memcpy(&scale, &meta[4], 4);
        CHECK(scale == 1 || scale == 1.25f);
        struct Pixels *pixels = calloc(1, sizeof(*pixels) + (size_t)meta[6] * meta[7] * 4);
        CHECK(pixels);
        wlr_buffer_init(&pixels->base, &pixels_impl, (int)meta[6], (int)meta[7]);
        for (uint32_t i = 0; i < meta[6] * meta[7]; i++) {
            uint8_t rgba[4];
            CHECK(fread(rgba, sizeof(rgba), 1, input) == 1 && rgba[3] == 255);
            pixels->pixels[i] = 0xff000000u | (uint32_t)rgba[0] << 16 | (uint32_t)rgba[1] << 8 | rgba[2];
        }
        struct wlr_output_state state;
        wlr_output_state_init(&state);
        wlr_output_state_set_custom_mode(&state, (int)(256 * scale), (int)(192 * scale), 60000);
        wlr_output_state_set_scale(&state, scale);
        CHECK(wlr_output_commit_state(entry->output, &state));
        wlr_output_state_finish(&state);
        struct wlr_scene_tree *group = wlr_scene_tree_create(desktop->windows);
        CHECK(group); wlr_scene_node_set_position(&group->node, 40, 40);
        CHECK(wlr_scene_rect_create(group, 64, 64 + (int)meta[2], (float[4]){0.6f, 0.2f, 0.4f, 1}));
        struct wlr_scene_buffer *caption = wlr_scene_buffer_create(group, &pixels->base);
        CHECK(caption); wlr_buffer_drop(&pixels->base);
        wlr_scene_buffer_set_dest_size(caption, 64, (int)meta[2]);
        uint32_t *plain, *behind, *actual;
        int width, height, w, h;
        CHECK(capture(desktop, entry->output, &plain, &width, &height));
        wlr_scene_node_set_enabled(&group->node, false);
        CHECK(capture(desktop, entry->output, &behind, &w, &h));
        wlr_scene_node_set_enabled(&group->node, true);
        bool maximized = meta[5] & 2;
        CHECK(wlr_scene_tree_set_rounding(group, &(struct wlr_box){0, 0, 64, 64 + (int)meta[2]},
            maximized ? 0 : 16));
        CHECK(capture(desktop, entry->output, &actual, &w, &h));
        int start = (int)roundf(40 * scale), size = (int)roundf(64 * scale);
        unsigned partial = 0;
        for (int y = 0; y < (int)(16 * scale); y++) for (int x = 0; x < size; x++) {
            float distance = distance_to_round(x + 0.5f, y + 0.5f, size,
                (64 + meta[2]) * scale, 16 * scale);
            float coverage = maximized ? 1 : roundf(fminf(fmaxf(0.5f - distance, 0), 1) * 255) / 255;
            if (coverage > 0 && coverage < 1) partial++;
            size_t offset = (size_t)(start + y) * width + start + x;
            for (int channel = 0; channel < 24; channel += 8) {
                int a = (plain[offset] >> channel) & 255, b = (behind[offset] >> channel) & 255;
                int value = (actual[offset] >> channel) & 255;
                CHECK(abs(value - (int)roundf(a * coverage + b * (1 - coverage))) <= 3);
            }
        }
        CHECK(maximized || partial > 20);
        free(plain); free(behind); free(actual);
        wlr_scene_node_destroy(&group->node);
        printf("PASS: real GUI caption + native one-coverage top-corner pixels scale=%g maximized=%d partial=%u\n",
            scale, maximized, partial);
    }
    CHECK(fgetc(input) == EOF && !ferror(input));
    fclose(input);
    wlr_scene_node_destroy(&background->node);
    return true;
}
static bool shadow_suite(struct PuDesktop *desktop, struct wlr_output *output)
{
    struct wlr_scene_rect *shadow = wlr_scene_shadow_create(desktop->windows);
    CHECK(shadow && wlr_scene_shadow_set_geometry(shadow, 64, 64, 16, 4, 3, 7));
    CHECK(!wlr_scene_shadow_set_geometry(shadow, 64, 64, 16, 0, 0, 0));
    CHECK(!wlr_scene_shadow_set_geometry(shadow, 64, 64, 16, NAN, 0, 0));
    wlr_scene_rect_set_color(shadow, (float[4]){0, 0, 0, 0.5f});
    wlr_scene_node_set_position(&shadow->node, 26, 30);
    for (unsigned i = 0; i < 8; i++) {
        float scales[] = {1, 1.25f, 1.5f, 2};
        float scale = scales[i % 4];
        enum wl_output_transform transform = i < 4 ? WL_OUTPUT_TRANSFORM_NORMAL : WL_OUTPUT_TRANSFORM_90;
        struct wlr_output_state state;
        wlr_output_state_init(&state);
        wlr_output_state_set_custom_mode(&state, (int)((i < 4 ? 256 : 192) * scale),
            (int)((i < 4 ? 192 : 256) * scale), 60000);
        wlr_output_state_set_scale(&state, scale);
        wlr_output_state_set_transform(&state, transform);
        CHECK(wlr_output_commit_state(output, &state));
        wlr_output_state_finish(&state);
        uint32_t *behind, *actual;
        int width, height, w, h;
        wlr_scene_node_set_enabled(&shadow->node, false);
        CHECK(capture(desktop, output, &behind, &width, &height));
        wlr_scene_node_set_enabled(&shadow->node, true);
        CHECK(capture(desktop, output, &actual, &w, &h) && w == width && h == height);
        int left = (int)roundf(26 * scale), top = (int)roundf(30 * scale);
        int right = (int)roundf(124 * scale), bottom = (int)roundf(128 * scale);
        int sx = (int)roundf(43 * scale), sy = (int)roundf(47 * scale);
        int sw = (int)roundf(107 * scale) - sx, sh = (int)roundf(111 * scale) - sy;
        int ox = (int)roundf(40 * scale), oy = (int)roundf(40 * scale);
        int ow = (int)roundf(104 * scale) - ox, oh = (int)roundf(104 * scale) - oy;
        unsigned outside = 0, unchanged_interior = 0;
        for (int y = top; y < bottom; y++) for (int x = left; x < right; x++) {
            float d = distance_to_round(x + 0.5f - sx, y + 0.5f - sy, sw, sh, 16 * scale);
            float original = distance_to_round(x + 0.5f - ox, y + 0.5f - oy, ow, oh, 16 * scale);
            float coverage = 0.5f * erfcf(d / (1.41421356237f * 4 * scale)) *
                (1 - fminf(fmaxf(0.5f - original, 0), 1));
            float alpha = roundf(coverage * 255) / 255 * 0.5f;
            struct wlr_box point = {x, y, 1, 1};
            wlr_box_transform(&point, &point, wlr_output_transform_invert(transform),
                (int)(256 * scale), (int)(192 * scale));
            size_t offset = (size_t)point.y * width + point.x;
            for (int channel = 0; channel < 24; channel += 8) {
                int base = (behind[offset] >> channel) & 255;
                int value = (actual[offset] >> channel) & 255;
                CHECK(abs(value - (int)roundf(base * (1 - alpha))) <= 2);
            }
            if (original > 1 && alpha > 0.01f) outside++;
            if (original < -1) {
                CHECK((actual[offset] & 0xffffff) == (behind[offset] & 0xffffff));
                unchanged_interior++;
            }
        }
        CHECK(outside > 200 && unchanged_interior > 1000);
        double nx, ny;
        CHECK(wlr_scene_node_at(&desktop->windows->node, 28, 32, &nx, &ny) != &shadow->node);
        CHECK(desktop->scene->effects_cached_bytes == 0);
        free(behind); free(actual);
        printf("PASS: true external Gaussian alpha shadow, untouched interior, checker composition and no input scale=%g transform=%d\n",
            scale, transform);
    }
    wlr_scene_node_destroy(&shadow->node);
    return true;
}
static bool phase_occlusion_suite(struct PuDesktop *desktop, struct wlr_output *output,
    struct wlr_scene_tree *group, struct wlr_scene_buffer *buffer)
{
    struct wlr_scene_tree *mover = wlr_scene_tree_create(desktop->windows);
    CHECK(mover);
    wlr_scene_node_reparent(&group->node, mover);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_custom_mode(&state, 320, 240, 60000);
    wlr_output_state_set_scale(&state, 1.25f);
    CHECK(wlr_output_commit_state(output, &state));
    wlr_output_state_finish(&state);
    uint32_t *pixels, *fresh;
    int width, height, w, h;
    CHECK(capture(desktop, output, &pixels, &width, &height));
    free(pixels);
    uint64_t before = desktop->scene->effects_render_count;
    wlr_scene_node_set_position(&mover->node, 1, 3);
    CHECK(capture(desktop, output, &pixels, &width, &height));
    free(pixels);
    CHECK(desktop->scene->effects_render_count == before + 1);
    struct wlr_scene_rect *cover = wlr_scene_rect_create(desktop->windows, 64, 64,
        (float[4]){0.25f, 0.5f, 0.75f, 1});
    CHECK(cover); wlr_scene_node_set_position(&cover->node, 41, 43);
    before = desktop->scene->effects_render_count;
    CHECK(capture(desktop, output, &pixels, &width, &height));
    uint32_t center = pixels[90 * width + 90];
    CHECK(abs((int)(center & 255) - 191) <= 1 &&
        abs((int)((center >> 8) & 255) - 128) <= 1 &&
        abs((int)((center >> 16) & 255) - 64) <= 1);
    free(pixels);
    CHECK(desktop->scene->effects_render_count == before);
    wlr_scene_buffer_set_opacity(buffer, 0.25f);
    CHECK(capture(desktop, output, &pixels, &width, &height));
    free(pixels);
    CHECK(desktop->scene->effects_render_count == before);
    wlr_scene_node_destroy(&cover->node);
    CHECK(capture(desktop, output, &pixels, &width, &height));
    CHECK(desktop->scene->effects_render_count == before + 1);
    CHECK(wlr_scene_tree_set_rounding(group, NULL, 0));
    CHECK(wlr_scene_tree_set_rounding(group, &(struct wlr_box){0, 0, 64, 64}, 16));
    CHECK(capture(desktop, output, &fresh, &w, &h) && w == width && h == height);
    CHECK(!memcmp(pixels, fresh, (size_t)width * height * 4));
    free(pixels); free(fresh);
    wlr_scene_buffer_set_opacity(buffer, 1);
    wlr_scene_node_reparent(&group->node, desktop->windows);
    wlr_scene_node_destroy(&mover->node);
    wlr_output_state_init(&state);
    wlr_output_state_set_custom_mode(&state, 256, 192, 60000);
    wlr_output_state_set_scale(&state, 1);
    CHECK(wlr_output_commit_state(output, &state));
    wlr_output_state_finish(&state);
    CHECK(capture(desktop, output, &pixels, &width, &height));
    free(pixels);
    puts("PASS: ancestor move 40,40->41,43 at scale1.25 regenerates phase-keyed cache; full occlusion suppresses hidden rendering; dirty reveal matches fresh pixels");
    return true;
}
static uint32_t pixel_at(const uint32_t *pixels, int width, int x, int y,
    enum wl_output_transform transform, int transformed_width, int transformed_height)
{
    struct wlr_box point = {x, y, 1, 1};
    wlr_box_transform(&point, &point, wlr_output_transform_invert(transform),
        transformed_width, transformed_height);
    return pixels[point.y * width + point.x];
}
static void find_headless(struct wlr_backend *backend, void *data)
{
    if (wlr_backend_is_headless(backend)) *(struct wlr_backend **)data = backend;
}
static bool backdrop_outputs(struct PuDesktop *desktop, struct wlr_output *first)
{
    struct wlr_backend *headless = NULL;
    wlr_multi_for_each_backend(desktop->backend, find_headless, &headless);
    CHECK(headless);
    wlr_output_layout_add(desktop->layout, first, 0, 0);
    struct wlr_output *second = wlr_headless_add_output(headless, 256, 192);
    CHECK(second);
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_custom_mode(&state, 240, 320, 60000);
    wlr_output_state_set_scale(&state, 1.25f);
    wlr_output_state_set_transform(&state, WL_OUTPUT_TRANSFORM_90);
    CHECK(wlr_output_commit_state(second, &state));
    wlr_output_state_finish(&state);
    wlr_output_layout_add(desktop->layout, second, 256, 0);
    struct wlr_scene_tree *lower = wlr_scene_tree_create(desktop->windows);
    struct wlr_scene_tree *glass = wlr_scene_tree_create(desktop->layer_trees[2]);
    CHECK(lower && glass);
    CHECK(wlr_scene_rect_create(lower, 256, 192, (float[4]){0.8f, 0.1f, 0.2f, 1}));
    struct wlr_scene_rect *blue = wlr_scene_rect_create(lower, 256, 192, (float[4]){0.1f, 0.2f, 0.8f, 1});
    CHECK(blue);
    wlr_scene_node_set_position(&blue->node, 256, 0);
    wlr_scene_node_set_position(&glass->node, 240, 48);
    struct wlr_scene_rect *backdrop = wlr_scene_backdrop_create(glass,
        &(struct wlr_box){0, 0, 32, 64}, 4, 2, (float[4]){0});
    CHECK(backdrop);
    wlr_scene_node_set_enabled(&backdrop->node, true);
    uint32_t *a, *b, *changed;
    int aw, ah, bw, bh, w, h;
    CHECK(capture(desktop, first, &a, &aw, &ah));
    CHECK(capture(desktop, second, &b, &bw, &bh));
    size_t bytes = desktop->scene->effects_cached_bytes;
    CHECK(bytes > 32u * 64u * 8u);
    uint64_t count = desktop->scene->backdrop_render_count;
    CHECK(capture(desktop, second, &changed, &w, &h));
    CHECK(!memcmp(b, changed, (size_t)bw * bh * 4) && desktop->scene->backdrop_render_count == count);
    free(changed);
    wlr_scene_rect_set_color(blue, (float[4]){0.1f, 0.8f, 0.2f, 1});
    CHECK(capture(desktop, second, &changed, &w, &h));
    CHECK(memcmp(b, changed, (size_t)bw * bh * 4));
    free(changed);
    CHECK(capture(desktop, first, &changed, &w, &h));
    CHECK(memcmp(a, changed, (size_t)aw * ah * 4));
    CHECK(desktop->scene->backdrop_render_count == count + 2);
    free(a); free(b); free(changed);
    wlr_output_destroy(second);
    CHECK(desktop->scene->effects_cached_bytes > 0 && desktop->scene->effects_cached_bytes < bytes);
    wlr_scene_node_set_enabled(&glass->node, false);
    CHECK(desktop->scene->effects_cached_bytes == 0);
    wlr_scene_node_destroy(&glass->node);
    wlr_scene_node_destroy(&lower->node);
    puts("PASS: one region crosses two live outputs with different scale/transform; independent caches update from lower content, reuse when idle, and release on output/ancestor retirement");
    return true;
}
static bool backdrop_taller_peak_suite(struct PuDesktop *desktop, struct wlr_output *output,
    struct wlr_scene_tree *dock)
{
    CHECK(output->scale == 1 && output->transform == WL_OUTPUT_TRANSFORM_NORMAL &&
        desktop->scene->effects_cached_bytes == 0);
    struct wlr_scene_rect *retained = wlr_scene_backdrop_create(dock,
        &(struct wlr_box){0, 0, 96, 64}, 8, 2, (float[4]){0});
    CHECK(retained);
    wlr_scene_node_set_enabled(&retained->node, true);
    struct wlr_scene_rect *control = wlr_scene_backdrop_create(dock,
        &(struct wlr_box){0, 0, 640, 660}, 8, 16, (float[4]){0});
    CHECK(control);
    wlr_scene_node_destroy(&control->node);
    struct wlr_scene_tree *large = wlr_scene_tree_create(desktop->windows);
    struct wlr_scene_tree *extra = wlr_scene_tree_create(desktop->windows);
    CHECK(large && extra &&
        wlr_scene_rect_create(large, 3900, 3900, (float[4]){0.2f, 0.4f, 0.6f, 1}) &&
        wlr_scene_rect_create(extra, 1280, 455, (float[4]){0.4f, 0.2f, 0.6f, 1}));
    wlr_scene_node_set_position(&extra->node, 128, 96);
    CHECK(wlr_scene_tree_set_rounding(large, &(struct wlr_box){0, 0, 3900, 3900}, 16) &&
        wlr_scene_tree_set_rounding(extra, &(struct wlr_box){0, 0, 1280, 455}, 16));
    uint32_t *before, *after;
    int width, height, w, h;
    CHECK(capture(desktop, output, &before, &width, &height));
    size_t reserved = desktop->scene->effects_cached_bytes;
    size_t candidate = (736u * 756u + 640u * 660u) * 8u + 97u * sizeof(float);
    CHECK(reserved == 3900u * 3900u * 8u + 1280u * 455u * 8u + 96u * 64u * 8u &&
        reserved == 126388352u && candidate == 7830916u &&
        candidate > WLR_SCENE_EFFECTS_MAX_BYTES - reserved);
    CHECK(wl_list_length(&desktop->scene->backdrops) == 1 &&
        wl_list_length(&desktop->scene->backdrops) < WLR_SCENE_BACKDROP_MAX_NODES &&
        736u * 756u <= WLR_SCENE_BACKDROP_MAX_PIXELS);
    uint64_t renders = desktop->scene->backdrop_render_count;
    CHECK(!wlr_scene_backdrop_create(dock, &(struct wlr_box){0, 0, 640, 660}, 8, 16, (float[4]){0}));
    CHECK(desktop->scene->effects_cached_bytes == reserved &&
        desktop->scene->backdrop_render_count == renders &&
        wl_list_length(&desktop->scene->backdrops) == 1);
    CHECK(capture(desktop, output, &after, &w, &h));
    CHECK(w == width && h == height && !memcmp(before, after, (size_t)width * height * 4));
    free(before); free(after);
    wlr_scene_node_destroy(&extra->node);
    wlr_scene_node_destroy(&large->node);
    wlr_scene_node_destroy(&retained->node);
    CHECK(desktop->scene->effects_cached_bytes == 0);
    printf("PASS: independent 640x660 aggregate peak refusal, live=%zu candidate/scratch=%zu total=%zu limit=%u; geometry control accepted, nodecount1, old frame/cache unchanged and all reservations released\n",
        reserved, candidate, reserved + candidate, WLR_SCENE_EFFECTS_MAX_BYTES);
    return true;
}
static bool backdrop_suite(struct PuDesktop *desktop, struct wlr_output *output)
{
    CHECK(wlr_scene_backdrop_supported(desktop->renderer));
    struct wlr_scene_tree *apps = wlr_scene_tree_create(desktop->windows);
    CHECK(apps);
    struct wlr_scene_tree *first = wlr_scene_tree_create(apps), *second = wlr_scene_tree_create(apps);
    CHECK(first && second);
    for (int y = 0; y < 192; y += 4) for (int x = 0; x < 128; x += 4) {
        bool alternate = (x / 4 + y / 4) & 1;
        float red[4] = {alternate ? 0.9f : 0.1f, 0.1f, 0.2f, 1};
        float green[4] = {0.1f, alternate ? 0.8f : 0.2f, 0.3f, 1};
        struct wlr_scene_rect *a = wlr_scene_rect_create(first, 4, 4, red);
        struct wlr_scene_rect *b = wlr_scene_rect_create(second, 4, 4, green);
        CHECK(a && b);
        wlr_scene_node_set_position(&a->node, x, y);
        wlr_scene_node_set_position(&b->node, x, y);
    }
    wlr_scene_node_set_position(&second->node, 96, 0);
    struct wlr_scene_tree *dock = wlr_scene_tree_create(desktop->layer_trees[2]);
    CHECK(dock);
    wlr_scene_node_set_position(&dock->node, 40, 40);
    struct wlr_scene_rect *glyph = wlr_scene_rect_create(dock, 8, 8, (float[4]){1, 1, 0, 1});
    struct wlr_scene_rect *upper = wlr_scene_rect_create(desktop->layer_trees[3], 8, 16,
        (float[4]){0, 0, 1, 1});
    CHECK(glyph && upper);
    wlr_scene_node_set_position(&glyph->node, 44, 28);
    wlr_scene_node_set_position(&upper->node, 110, 44);
    for (unsigned trial = 0; trial < 2; trial++) {
        float scale = trial ? 1.25f : 1;
        enum wl_output_transform transform = trial ? WL_OUTPUT_TRANSFORM_90 : WL_OUTPUT_TRANSFORM_NORMAL;
        int tw = (int)(256 * scale), th = (int)(192 * scale);
        struct wlr_output_state state;
        wlr_output_state_init(&state);
        wlr_output_state_set_custom_mode(&state, trial ? th : tw, trial ? tw : th, 60000);
        wlr_output_state_set_scale(&state, scale);
        wlr_output_state_set_transform(&state, transform);
        CHECK(wlr_output_commit_state(output, &state));
        wlr_output_state_finish(&state);
        uint32_t *raw, *plain, *actual, *idle;
        int width, height, w, h;
        wlr_scene_node_set_enabled(&glyph->node, false);
        wlr_scene_node_set_enabled(&upper->node, false);
        CHECK(capture(desktop, output, &raw, &width, &height));
        wlr_scene_node_set_enabled(&glyph->node, true);
        wlr_scene_node_set_enabled(&upper->node, true);
        CHECK(capture(desktop, output, &plain, &w, &h));
        struct wlr_scene_rect *backdrop = wlr_scene_backdrop_create(dock,
            &(struct wlr_box){0, 0, 96, 64}, 8, 2, (float[4]){0.2f, 0.2f, 0.2f, 0.25f});
        CHECK(backdrop && !backdrop->node.enabled);
        wlr_scene_node_set_enabled(&backdrop->node, true);
        CHECK(capture(desktop, output, &actual, &w, &h));
        unsigned checked = 0, changed = 0;
        int left = (int)roundf(40 * scale), top = left;
        int bw = (int)roundf(136 * scale) - left, bh = (int)roundf(104 * scale) - top;
        int pad = (int)ceilf(6 * scale);
        double weights[17], sum = 0;
        CHECK(pad <= 8);
        for (int i = -pad; i <= pad; i++) {
            weights[i + pad] = exp(-(double)i * i / (8 * scale * scale));
            sum += weights[i + pad];
        }
        for (int i = 0; i <= 2 * pad; i++) weights[i] /= sum;
        for (int py = 0; py < bh; py++) for (int px = 0; px < bw; px++) {
            int x = left + px, y = top + py;
            uint32_t before = pixel_at(raw, width, x, y, transform, tw, th);
            uint32_t value = pixel_at(actual, width, x, y, transform, tw, th);
            if ((x >= (int)roundf(84 * scale) && x < (int)roundf(92 * scale) &&
                y >= (int)roundf(68 * scale) && y < (int)roundf(76 * scale)) ||
                (x >= (int)roundf(110 * scale) && x < (int)roundf(118 * scale) &&
                y >= (int)roundf(44 * scale) && y < (int)roundf(60 * scale))) {
                CHECK(value == pixel_at(plain, width, x, y, transform, tw, th));
                continue;
            }
            float coverage = fminf(fmaxf(0.5f - distance_to_round(px + 0.5f, py + 0.5f,
                bw, bh, 8 * scale), 0), 1);
            for (int channel = 0; channel < 24; channel += 8) {
                double blurred = 0;
                for (int ky = -pad; ky <= pad; ky++) {
                    double horizontal = 0;
                    for (int kx = -pad; kx <= pad; kx++)
                        horizontal += ((pixel_at(raw, width, x + kx, y + ky,
                            transform, tw, th) >> channel) & 255) * weights[kx + pad];
                    blurred += round(horizontal) * weights[ky + pad];
                }
                int expected = (int)round(round(51 + blurred * 0.75) * coverage +
                    ((before >> channel) & 255) * (1 - coverage));
                CHECK(abs((int)((value >> channel) & 255) - expected) <= 3);
            }
            checked++;
            changed += (value & 0xffffff) != (before & 0xffffff);
        }
        CHECK(checked > 5000 && changed > 4000);
        uint64_t count = desktop->scene->backdrop_render_count;
        CHECK(capture(desktop, output, &idle, &w, &h));
        CHECK(desktop->scene->backdrop_render_count == count &&
            !memcmp(actual, idle, (size_t)w * h * 4));
        free(idle);
        double nx, ny;
        CHECK(wlr_scene_node_at(&dock->node, 41, 41, &nx, &ny) != &backdrop->node);
        CHECK(wlr_scene_node_at(&dock->node, 86, 70, &nx, &ny) == &glyph->node);
        wlr_scene_node_set_position(&second->node, 72, 0);
        CHECK(capture(desktop, output, &idle, &w, &h));
        CHECK(desktop->scene->backdrop_render_count > count &&
            memcmp(actual, idle, (size_t)w * h * 4));
        free(idle);
        wlr_scene_node_set_position(&second->node, 96, 0);
        wlr_scene_backdrop_clear(desktop->scene);
        CHECK(desktop->scene->effects_cached_bytes == 0);
        CHECK(capture(desktop, output, &idle, &w, &h));
        CHECK(!memcmp(actual, idle, (size_t)w * h * 4));
        free(idle);
        CHECK(!wlr_scene_backdrop_create(dock, &(struct wlr_box){0, 0, 4096, 512},
            8, 32, (float[4]){0}));
        CHECK(!wlr_scene_backdrop_create(dock, &(struct wlr_box){0, 0, 96, 64},
            8, NAN, (float[4]){0}));
        CHECK(capture(desktop, output, &idle, &w, &h));
        CHECK(!memcmp(actual, idle, (size_t)w * h * 4));
        free(idle);
        wlr_scene_node_set_enabled(&backdrop->node, false);
        CHECK(desktop->scene->effects_cached_bytes == 0);
        CHECK(capture(desktop, output, &idle, &w, &h));
        CHECK(!memcmp(plain, idle, (size_t)w * h * 4));
        free(raw); free(plain); free(actual); free(idle);
        wlr_scene_node_destroy(&backdrop->node);
        printf("PASS: regional current lower-scene Gaussian oracle %u pixels; two moving app trees; foreground exclusion/glyph/input unchanged; idle reuse; privacy clear; failed candidate preserves pixels; disable byte restoration scale=%g transform=%d\n",
            checked, scale, transform);
    }
    struct wlr_output_state reset;
    wlr_output_state_init(&reset);
    wlr_output_state_set_scale(&reset, 1);
    wlr_output_state_set_transform(&reset, WL_OUTPUT_TRANSFORM_NORMAL);
    wlr_output_state_set_custom_mode(&reset, 256, 192, 60000);
    CHECK(wlr_output_commit_state(output, &reset));
    wlr_output_state_finish(&reset);
    struct wlr_scene_rect *retained = wlr_scene_backdrop_create(dock,
        &(struct wlr_box){0, 0, 96, 64}, 8, 2, (float[4]){0});
    CHECK(retained);
    wlr_scene_node_set_enabled(&retained->node, true);
    struct wlr_scene_tree *blocker = wlr_scene_tree_create(desktop->windows);
    CHECK(blocker && wlr_scene_rect_create(blocker, 3900, 3900, (float[4]){0.2f, 0.4f, 0.6f, 1}));
    CHECK(wlr_scene_tree_set_rounding(blocker, &(struct wlr_box){0, 0, 3900, 3900}, 16));
    uint32_t *before, *after;
    int width, height, w, h;
    CHECK(capture(desktop, output, &before, &width, &height));
    size_t reserved = desktop->scene->effects_cached_bytes;
    CHECK(reserved > 120u * 1000u * 1000u);
    CHECK(!wlr_scene_backdrop_create(dock, &(struct wlr_box){0, 0, 2048, 480}, 8, 8, (float[4]){0}));
    CHECK(desktop->scene->effects_cached_bytes == reserved);
    CHECK(capture(desktop, output, &after, &w, &h));
    CHECK(w == width && h == height && !memcmp(before, after, (size_t)width * height * 4));
    free(before); free(after);
    wlr_scene_node_destroy(&blocker->node);
    wlr_scene_node_destroy(&retained->node);
    puts("PASS: real 121MiB live rounding/backdrop reservations reject an otherwise valid regional candidate at aggregate old-plus-new/workspace peak; committed whole-frame bytes remain identical");
    CHECK(backdrop_taller_peak_suite(desktop, output, dock));
    wlr_scene_node_destroy(&upper->node);
    wlr_scene_node_destroy(&dock->node);
    wlr_scene_node_destroy(&apps->node);
    CHECK(desktop->scene->effects_cached_bytes == 0 &&
        desktop->scene->effects_peak_bytes <= WLR_SCENE_EFFECTS_MAX_BYTES);
    CHECK(backdrop_outputs(desktop, output));
    return true;
}
static double milliseconds(void)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) abort();
    return now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0;
}
static bool taller_oracle(const uint32_t *raw, const uint32_t *plain, const uint32_t *actual,
    int stride, int height)
{
    double weights[97], sum = 0;
    for (int i = -48; i <= 48; i++) {
        weights[i + 48] = exp(-(double)i * i / (2 * 16 * 16));
        sum += weights[i + 48];
    }
    for (unsigned i = 0; i < 97; i++) weights[i] /= sum;
    unsigned checked = 0;
    /* Stratify over the entire real footprint, including its bottom/right edges. */
    for (int py = 0;; py = py + 29 < height ? py + 29 : height - 1) {
        for (int px = 0;; px = px + 31 < 640 ? px + 31 : 639) {
            int x = 64 + px, y = 64 + py;
            size_t offset = (size_t)y * stride + x;
            bool foreground = (px >= 300 && px < 316 && py >= 300 && py < 324) ||
                (px >= 400 && px < 432 && py >= 400 && py < 416);
            if (!foreground) {
                float coverage = fminf(fmaxf(0.5f - distance_to_round(px + 0.5f,
                    py + 0.5f, 640, height, 8), 0), 1);
                const double tint[] = {51, 12.75, 25.5};
                for (int channel = 0; channel < 24; channel += 8) {
                    double blurred = 0;
                    for (int ky = -48; ky <= 48; ky++) {
                        double horizontal = 0;
                        for (int kx = -48; kx <= 48; kx++)
                            horizontal += ((raw[(y + ky) * stride + x + kx] >> channel) & 255) *
                                weights[kx + 48];
                        blurred += round(horizontal) * weights[ky + 48];
                    }
                    int expected = (int)round(round(tint[channel / 8] + blurred * 0.75) * coverage +
                        ((raw[offset] >> channel) & 255) * (1 - coverage));
                    CHECK(abs((int)((actual[offset] >> channel) & 255) - expected) <= 3);
                }
                checked++;
            }
            if (px == 639) break;
        }
        if (py == height - 1) break;
    }
    for (int py = 300; py < 416; py++) for (int px = 300; px < 432; px++) {
        if ((px < 316 && py < 324) || (px >= 400 && py >= 400))
            CHECK(actual[(64 + py) * stride + 64 + px] == plain[(64 + py) * stride + 64 + px]);
    }
    CHECK(checked >= 500);
    printf("PASS: 640x%d full-domain stratified Gaussian oracle %u points, including bottom/right/corners; opaque glyph/upper foreground byte-identical\n",
        height, checked);
    return true;
}
static bool taller_bounds_suite(struct PuDesktop *desktop, struct wlr_output *output,
    struct wlr_scene_tree *target)
{
    CHECK(WLR_SCENE_BACKDROP_MAX_WIDTH == 4096 && WLR_SCENE_BACKDROP_MAX_HEIGHT == 768 &&
        WLR_SCENE_BACKDROP_MAX_PIXELS == 2u * 1024u * 1024u &&
        WLR_SCENE_BACKDROP_MAX_NODES == 8 && WLR_SCENE_BACKDROP_MAX_RADIUS == 64 &&
        WLR_SCENE_BACKDROP_MIN_SIGMA == 0.5f && WLR_SCENE_BACKDROP_MAX_SIGMA == 32 &&
        WLR_SCENE_BACKDROP_MAX_SCALED_SIGMA == 64);
    const struct { int width, height; float scale, sigma; bool accepted; } cases[] = {
        {16, 511, 1, 0.5f, true}, {16, 512, 1, 0.5f, true}, {16, 513, 1, 0.5f, true},
        {16, 767, 1, 0.5f, true}, {16, 768, 1, 0.5f, true}, {16, 769, 1, 0.5f, false},
        {4096, 1, 1, 0.5f, true}, {4097, 1, 1, 0.5f, false},
        {0, 660, 1, 0.5f, false}, {640, -1, 1, 0.5f, false},
        /* (4092+4)*(508+4) is exactly 2MiPixel; one extra column must fail. */
        {4092, 508, 1, 0.5f, true}, {4093, 508, 1, 0.5f, false},
        {640, 660, 1.25f, 0.5f, true},
        {640, 640, 2, 16, false}, {640, 660, 2, 16, false},
        {640, 660, 2, 1, true},
        {96, 64, 2, 32, true}, {96, 64, 2.01f, 32, false},
        /* At scale8 the padded axis, not sigma or area, hits exactly 32768. */
        {4093, 1, 8, 0.5f, true}, {4094, 1, 8, 0.5f, false},
    };
    for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        struct wlr_output_state state;
        wlr_output_state_init(&state);
        wlr_output_state_set_scale(&state, cases[i].scale);
        CHECK(wlr_output_commit_state(output, &state));
        wlr_output_state_finish(&state);
        size_t before = desktop->scene->effects_cached_bytes;
        struct wlr_scene_rect *rect = wlr_scene_backdrop_create(target,
            &(struct wlr_box){0, 0, cases[i].width, cases[i].height}, 0, cases[i].sigma, (float[4]){0});
        CHECK((rect != NULL) == cases[i].accepted);
        if (rect) wlr_scene_node_destroy(&rect->node);
        CHECK(desktop->scene->effects_cached_bytes == before);
        printf("PASS: exact generic bound %dx%d scale=%g sigma=%g accepted=%d\n",
            cases[i].width, cases[i].height, cases[i].scale, cases[i].sigma, cases[i].accepted);
    }
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_scale(&state, 1);
    CHECK(wlr_output_commit_state(output, &state));
    wlr_output_state_finish(&state);
    struct wlr_scene_rect *nodes[WLR_SCENE_BACKDROP_MAX_NODES];
    for (unsigned i = 0; i < WLR_SCENE_BACKDROP_MAX_NODES; i++) {
        nodes[i] = wlr_scene_backdrop_create(target, &(struct wlr_box){0, 0, 1, 1}, 0, 0.5f, (float[4]){0});
        CHECK(nodes[i]);
    }
    size_t before = desktop->scene->effects_cached_bytes;
    CHECK(!wlr_scene_backdrop_create(target, &(struct wlr_box){0, 0, 1, 1}, 0, 0.5f, (float[4]){0}));
    CHECK(desktop->scene->effects_cached_bytes == before);
    for (unsigned i = 0; i < WLR_SCENE_BACKDROP_MAX_NODES; i++) wlr_scene_node_destroy(&nodes[i]->node);
    CHECK(desktop->scene->effects_cached_bytes == 0);
    puts("PASS: exact 8-node cap retained; rejected ninth candidate preserves all reservations");
    return true;
}
static bool taller_extent_suite(struct PuDesktop *desktop, struct wlr_output *output)
{
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_custom_mode(&state, 800, 800, 60000);
    wlr_output_state_set_scale(&state, 1);
    wlr_output_state_set_transform(&state, WL_OUTPUT_TRANSFORM_NORMAL);
    CHECK(wlr_output_commit_state(output, &state));
    wlr_output_state_finish(&state);
    struct wlr_scene_tree *target = wlr_scene_tree_create(desktop->layer_trees[2]);
    CHECK(target);
    CHECK(taller_bounds_suite(desktop, output, target));
    struct wlr_scene_tree *apps = wlr_scene_tree_create(desktop->windows);
    struct wlr_scene_tree *second = apps ? wlr_scene_tree_create(apps) : NULL;
    CHECK(apps && second);
    for (int y = 0; y < 800; y += 16) for (int x = 0; x < 800; x += 16) {
        bool alternate = (x / 16 + y / 16) & 1;
        struct wlr_scene_rect *tile = wlr_scene_rect_create(apps, 16, 16,
            (float[4]){alternate ? 0.8f : 0.2f, 0.1f, 0.2f, 1});
        CHECK(tile);
        wlr_scene_node_set_position(&tile->node, x, y);
        if (x < 320) {
            tile = wlr_scene_rect_create(second, 16, 16,
                (float[4]){0.1f, alternate ? 0.3f : 0.9f, 0.4f, 1});
            CHECK(tile);
            wlr_scene_node_set_position(&tile->node, x, y);
        }
    }
    wlr_scene_node_raise_to_top(&second->node);
    struct wlr_scene_rect *glyph = wlr_scene_rect_create(target, 16, 24, (float[4]){1, 1, 0, 1});
    struct wlr_scene_rect *upper = wlr_scene_rect_create(desktop->layer_trees[3], 32, 16, (float[4]){0, 0, 1, 1});
    CHECK(glyph && upper);
    wlr_scene_node_set_position(&glyph->node, 364, 364);
    wlr_scene_node_set_position(&upper->node, 464, 464);
    for (int height = 640; height <= 660; height += 20) {
        uint32_t *raw, *plain, *actual, *changed, *idle;
        int width, output_height, w, h;
        wlr_scene_node_set_position(&second->node, 400, 0);
        wlr_scene_node_set_enabled(&glyph->node, false);
        wlr_scene_node_set_enabled(&upper->node, false);
        CHECK(capture(desktop, output, &raw, &width, &output_height) && width == 800 && output_height == 800);
        wlr_scene_node_set_enabled(&glyph->node, true);
        wlr_scene_node_set_enabled(&upper->node, true);
        CHECK(capture(desktop, output, &plain, &w, &h));
        double start = milliseconds();
        struct wlr_scene_rect *rect = wlr_scene_backdrop_create(target,
            &(struct wlr_box){64, 64, 640, height}, 8, 16, (float[4]){0.1f, 0.05f, 0.2f, 0.25f});
        double prepare_ms = milliseconds() - start;
        CHECK(rect && !rect->node.enabled);
        wlr_scene_node_set_enabled(&rect->node, true);
        CHECK(capture(desktop, output, &actual, &w, &h));
        CHECK(taller_oracle(raw, plain, actual, width, height));
        uint64_t count = desktop->scene->backdrop_render_count;
        start = milliseconds();
        CHECK(capture(desktop, output, &idle, &w, &h));
        double idle_ms = milliseconds() - start;
        CHECK(desktop->scene->backdrop_render_count == count &&
            !memcmp(actual, idle, (size_t)w * h * 4));
        free(idle);
        double nx, ny;
        CHECK(wlr_scene_node_at(&target->node, 65, 65, &nx, &ny) != &rect->node);
        CHECK(wlr_scene_node_at(&target->node, 365, 365, &nx, &ny) == &glyph->node);
        wlr_scene_node_set_position(&second->node, 320, 0);
        start = milliseconds();
        CHECK(capture(desktop, output, &changed, &w, &h));
        double moving_ms = milliseconds() - start;
        CHECK(desktop->scene->backdrop_render_count == count + 1 &&
            memcmp(actual, changed, (size_t)w * h * 4));
        free(raw); free(plain);
        wlr_scene_node_set_enabled(&rect->node, false);
        wlr_scene_node_set_enabled(&glyph->node, false);
        wlr_scene_node_set_enabled(&upper->node, false);
        CHECK(capture(desktop, output, &raw, &w, &h));
        wlr_scene_node_set_enabled(&glyph->node, true);
        wlr_scene_node_set_enabled(&upper->node, true);
        CHECK(capture(desktop, output, &plain, &w, &h));
        CHECK(taller_oracle(raw, plain, changed, width, height));
        wlr_scene_node_set_enabled(&rect->node, true);
        CHECK(capture(desktop, output, &idle, &w, &h));
        CHECK(!memcmp(changed, idle, (size_t)w * h * 4));
        free(idle);
        wlr_scene_backdrop_clear(desktop->scene);
        CHECK(desktop->scene->effects_cached_bytes == 0);
        CHECK(capture(desktop, output, &idle, &w, &h));
        CHECK(!memcmp(changed, idle, (size_t)w * h * 4));
        free(idle);
        uint64_t taps = ((uint64_t)640 * (height + 96) + (uint64_t)640 * height) * 4 * 97;
        printf("WORK: full-footprint=640x%d sigma=16 scale=1 expanded=736x%d taps=%llu prepare_ms=%.3f moving_capture_ms=%.3f idle_capture_ms=%.3f retained_bytes=%zu peak_bytes=%zu\n",
            height, height + 96, (unsigned long long)taps, prepare_ms, moving_ms, idle_ms,
            desktop->scene->effects_cached_bytes, desktop->scene->effects_peak_bytes);
        if (height == 660) {
            count = desktop->scene->backdrop_render_count;
            uint64_t epoch = desktop->backdrop_epoch;
            char *lock[] = {"/bin/false", NULL};
            CHECK(pu_session_lock_spawn(desktop, lock) && pu_session_lock_active(desktop) &&
                desktop->backdrop_epoch > epoch && desktop->scene->effects_cached_bytes == 0);
            for (unsigned trial = 0; trial < 2; trial++) {
                CHECK(capture(desktop, output, &idle, &w, &h));
                for (int i = 0; i < w * h; i++) CHECK((idle[i] & 0xffffff) == 0);
                free(idle);
                CHECK(desktop->scene->backdrop_render_count == count &&
                    desktop->scene->effects_cached_bytes == 0);
            }
            puts("PASS: real compositor lock clears full 640x660 retained samples, advances privacy epoch, presents only black and performs zero lower-scene resampling");
        }
        wlr_scene_node_destroy(&rect->node);
        CHECK(desktop->scene->effects_cached_bytes == 0);
        free(raw); free(plain); free(actual); free(changed);
        printf("PASS: required generic footprint 640x%d sigma=16 scale=1; moving lower apps/input/idle/privacy/destroy preserved\n", height);
    }
    wlr_scene_node_destroy(&upper->node);
    wlr_scene_node_destroy(&target->node);
    wlr_scene_node_destroy(&apps->node);
    CHECK(desktop->scene->effects_cached_bytes == 0 &&
        desktop->scene->effects_peak_bytes <= WLR_SCENE_EFFECTS_MAX_BYTES);
    return true;
}
static bool suite(struct PuDesktop *desktop)
{
    CHECK(wlr_scene_effects_abi_v4() == 4);
    struct wlr_output_layout_output *entry = wl_container_of(desktop->layout->outputs.next, entry, link);
    struct wlr_output *output = entry->output;
    struct wlr_scene_tree *background = wlr_scene_tree_create(&desktop->scene->tree);
    CHECK(background);
    wlr_scene_node_lower_to_bottom(&background->node);
    for (int y = 0; y < 192; y += 8) for (int x = 0; x < 256; x += 8) {
        float color[4] = { ((x / 8 + y / 8) & 1) ? 0.2f : 0.8f, 0.4f, 0.6f, 1 };
        struct wlr_scene_rect *rect = wlr_scene_rect_create(background, 8, 8, color);
        CHECK(rect); wlr_scene_node_set_position(&rect->node, x, y);
    }
    struct wlr_scene_tree *group = wlr_scene_tree_create(desktop->windows);
    CHECK(group);
    wlr_scene_node_set_position(&group->node, 40, 40);
    struct wlr_scene_rect *base = wlr_scene_rect_create(group, 64, 64, (float[4]){0.8f, 0.1f, 0.2f, 1});
    CHECK(base);
    struct wlr_buffer *source = pattern();
    CHECK(source);
    struct wlr_scene_buffer *buffer = wlr_scene_buffer_create(group, source);
    CHECK(buffer);
    wlr_buffer_drop(source);
    wlr_scene_buffer_set_source_box(buffer, &(struct wlr_fbox){4, 2, 16, 12});
    wlr_scene_buffer_set_dest_size(buffer, 64, 64);
    wlr_scene_buffer_set_transform(buffer, WL_OUTPUT_TRANSFORM_90);
    struct wlr_scene_rect *overlap = wlr_scene_rect_create(group, 64, 64, (float[4]){0, 0.25f, 0, 0.5f});
    CHECK(overlap);
    struct wlr_box box = {0, 0, 64, 64};
    CHECK(!wlr_scene_tree_set_rounding(group, &box, -1));
    CHECK(!wlr_scene_tree_set_rounding(group, &box, NAN));
    CHECK(!wlr_scene_tree_set_rounding(group, &box, 33));
    for (unsigned i = 0; i < 8; i++) {
        float scales[] = {1, 1.25f, 1.5f, 2};
        float scale = scales[i % 4];
        enum wl_output_transform transform = i < 4 ? WL_OUTPUT_TRANSFORM_NORMAL : WL_OUTPUT_TRANSFORM_90;
        struct wlr_output_state state;
        wlr_output_state_init(&state);
        wlr_output_state_set_custom_mode(&state, (int)((i < 4 ? 256 : 192) * scale),
            (int)((i < 4 ? 192 : 256) * scale), 60000);
        wlr_output_state_set_scale(&state, scale);
        wlr_output_state_set_transform(&state, transform);
        CHECK(wlr_output_commit_state(output, &state));
        wlr_output_state_finish(&state);
        uint32_t *plain, *behind, *rounded, *idle;
        int width, height, w, h;
        CHECK(wlr_scene_tree_set_rounding(group, NULL, 0));
        CHECK(capture(desktop, output, &plain, &width, &height));
        wlr_scene_node_set_enabled(&group->node, false);
        CHECK(capture(desktop, output, &behind, &w, &h) && w == width && h == height);
        wlr_scene_node_set_enabled(&group->node, true);
        CHECK(wlr_scene_tree_set_rounding(group, &box, 16));
        CHECK(capture(desktop, output, &rounded, &w, &h) && w == width && h == height);
        uint64_t renders = desktop->scene->effects_render_count;
        CHECK(capture(desktop, output, &idle, &w, &h));
        CHECK(desktop->scene->effects_render_count == renders);
        CHECK(!memcmp(idle, rounded, (size_t)width * height * 4));
        int start = (int)roundf(40 * scale), size = (int)roundf(64 * scale);
        unsigned partial = 0;
        for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) {
            float r = 16 * scale;
            float qx = fabsf(x + 0.5f - size * 0.5f) - size * 0.5f + r;
            float qy = fabsf(y + 0.5f - size * 0.5f) - size * 0.5f + r;
            float distance = hypotf(fmaxf(qx, 0), fmaxf(qy, 0)) + fminf(fmaxf(qx, qy), 0) - r;
            float coverage = roundf(fminf(fmaxf(0.5f - distance, 0), 1) * 255) / 255;
            if (coverage > 0 && coverage < 1) partial++;
            struct wlr_box point = {start + x, start + y, 1, 1};
            wlr_box_transform(&point, &point, wlr_output_transform_invert(transform),
                (int)(256 * scale), (int)(192 * scale));
            size_t offset = (size_t)point.y * width + point.x;
            for (int channel = 0; channel < 24; channel += 8) {
                int a = (plain[offset] >> channel) & 255, b = (behind[offset] >> channel) & 255;
                int actual = (rounded[offset] >> channel) & 255;
                int expected = (int)roundf(a * coverage + b * (1 - coverage));
                if (abs(actual - expected) > 3) {
                    fprintf(stderr, "scale=%g corner=%d,%d channel=%d coverage=%g actual=%d expected=%d\n",
                        scale, x, y, channel, coverage, actual, expected);
                    CHECK(false);
                }
            }
        }
        CHECK(partial > 12);
        double nx, ny;
        CHECK(wlr_scene_node_at(&group->node, 40.5, 40.5, &nx, &ny) == &overlap->node);
        CHECK(desktop->scene->effects_cached_bytes > 0 &&
            desktop->scene->effects_cached_bytes <= WLR_SCENE_EFFECTS_MAX_BYTES);
        free(plain); free(behind); free(rounded); free(idle);
        CHECK(wlr_scene_tree_set_rounding(group, NULL, 0));
        CHECK(desktop->scene->effects_cached_bytes == 0);
        printf("PASS: isolated AA overlap/crop/rotation/alpha/checker pixels scale=%g transform=%d partial=%u; cache reuse; rectangular input\n", scale, transform, partial);
    }
    CHECK(wlr_scene_tree_set_rounding(group, &box, 16));
    struct wlr_scene_tree *nested = wlr_scene_tree_create(group);
    CHECK(nested && !wlr_scene_tree_set_rounding(nested, &box, 16));
    struct wlr_output_state reset;
    wlr_output_state_init(&reset);
    wlr_output_state_set_scale(&reset, 1);
    wlr_output_state_set_transform(&reset, WL_OUTPUT_TRANSFORM_NORMAL);
    wlr_output_state_set_custom_mode(&reset, 256, 192, 60000);
    CHECK(wlr_output_commit_state(output, &reset));
    wlr_output_state_finish(&reset);
    uint32_t *last;
    int last_width, last_height;
    CHECK(capture(desktop, output, &last, &last_width, &last_height));
    free(last);
    CHECK(phase_occlusion_suite(desktop, output, group, buffer));
    size_t existing = desktop->scene->effects_cached_bytes;
    struct wlr_scene_tree *large = wlr_scene_tree_create(desktop->windows);
    CHECK(large && wlr_scene_rect_create(large, 4096, 4096, (float[4]){1, 1, 1, 1}));
    CHECK(wlr_scene_tree_set_rounding(large, &(struct wlr_box){0, 0, 4096, 4096}, 16));
    struct wlr_output_state failed;
    wlr_output_state_init(&failed);
    CHECK(!wlr_scene_output_build_state(wlr_scene_get_scene_output(desktop->scene, output), &failed, NULL));
    wlr_output_state_finish(&failed);
    CHECK(desktop->scene->effects_cached_bytes == existing);
    wlr_scene_node_destroy(&large->node);
    wlr_scene_node_set_enabled(&group->node, false);
    CHECK(desktop->scene->effects_cached_bytes == 0);
    puts("PASS: aggregate old-cache plus target/workspace peak is rejected explicitly; disabling releases every cache");
    wlr_scene_node_destroy(&group->node);
    CHECK(desktop->scene->effects_cached_bytes == 0);
    CHECK(shadow_suite(desktop, output));
    wlr_scene_node_destroy(&background->node);
    CHECK(backdrop_suite(desktop, output));
    CHECK(taller_extent_suite(desktop, output));
    return true;
}

/* Link this same fixture separately to each paired core/SDK. Timings exclude
 * desktop setup and include the complete lower-scene preparation. */
static int gaussian_probe(struct PuDesktop *desktop, unsigned index, const char *directory,
    uint32_t *frames, uint32_t *expected, size_t capacity)
{
    const struct { int width, height, x, y; float sigma, scale, radius, tint[4]; } cases[] = {
        {640, 640, 64, 64, 16, 1, 8, {0.1f, 0.05f, 0.2f, 0.25f}},
        {640, 660, 64, 64, 16, 1, 8, {0.1f, 0.05f, 0.2f, 0.25f}},
        {37, 29, 17, 19, 0.5f, 1.25f, 8, {0}},
        {41, 33, 19, 17, 2.25f, 1.5f, 0, {0.07f, 0.1f, 0.02f, 0.4f}},
        {96, 64, 32, 31, 32, 2, 32, {0.2f, 0.1f, 0.05f, 0.5f}},
        {16, 768, 8, 8, 0.5f, 1, 8, {0}},
        {4096, 1, 0, 0, 0.5f, 1, 0, {0}},
        {4092, 508, 0, 0, 0.5f, 1, 0, {0}},
        {4093, 1, 0, 0, 0.5f, 8, 0, {0}},
    };
    if (index >= sizeof(cases) / sizeof(cases[0])) return 2;
    double case_start = milliseconds(), measured_ms = 0;
    bool ok;
    {
        struct wlr_output_layout_output *entry = wl_container_of(desktop->layout->outputs.next, entry, link);
        struct wlr_output *output = entry->output;
        float scale = cases[index].scale;
        int logical_width = cases[index].width > 800 ? cases[index].width : 800;
        int logical_height = cases[index].height > 800 ? cases[index].height : 800;
        /* Extreme padded-axis coverage needs only a visible strip, not a
         * 32768-by-6400 output unrelated to the admitted regional target. */
        if (scale == 8) { logical_width = 100; logical_height = 100; }
        struct wlr_output_state state;
        wlr_output_state_init(&state);
        wlr_output_state_set_custom_mode(&state, (int)(logical_width * scale),
            (int)(logical_height * scale), 60000);
        wlr_output_state_set_scale(&state, scale);
        ok = wlr_output_commit_state(output, &state);
        wlr_output_state_finish(&state);
        struct wlr_scene_tree *apps = wlr_scene_tree_create(desktop->windows);
        struct wlr_scene_tree *second = apps ? wlr_scene_tree_create(apps) : NULL;
        struct wlr_scene_tree *target = wlr_scene_tree_create(desktop->layer_trees[2]);
        ok = ok && apps && second && target;
        if (apps) wlr_scene_node_set_enabled(&apps->node, false);
        uint32_t seed = 0x22e4a17u;
        for (int y = 0; ok && y < logical_height; y += 16) {
            for (int x = 0; ok && x < logical_width; x += 16) {
                seed = seed * 1664525u + 1013904223u;
                float alpha = ((seed >> 24) + 1) / 256.0f;
                float color[4] = {(seed & 255) / 255.0f * alpha,
                    ((seed >> 8) & 255) / 255.0f * alpha,
                    ((seed >> 16) & 255) / 255.0f * alpha, alpha};
                if (index < 2) {
                    color[0] = ((x / 16 + y / 16) & 1) ? 0.8f : 0.2f;
                    color[1] = 0.1f; color[2] = 0.2f; color[3] = 1;
                }
                struct wlr_scene_rect *tile = wlr_scene_rect_create(apps, 16, 16, color);
                ok = tile != NULL;
                if (tile) wlr_scene_node_set_position(&tile->node, x, y);
                if (ok && x < 320) {
                    tile = wlr_scene_rect_create(second, 16, 16,
                        (float[4]){0.1f, ((x / 16 + y / 16) & 1) ? 0.3f : 0.9f, 0.4f, 1});
                    ok = tile != NULL;
                    if (tile) wlr_scene_node_set_position(&tile->node, x, y);
                }
            }
        }
        if (second) {
            wlr_scene_node_raise_to_top(&second->node);
            wlr_scene_node_set_position(&second->node, 400, 0);
        }
        if (apps) wlr_scene_node_set_enabled(&apps->node, true);
        struct wlr_scene_rect *glyph = target ? wlr_scene_rect_create(target, 16, 24,
            (float[4]){1, 1, 0, 1}) : NULL;
        struct wlr_scene_rect *upper = wlr_scene_rect_create(desktop->layer_trees[3], 32, 16,
            (float[4]){0, 0, 1, 1});
        ok = ok && glyph && upper;
        if (glyph) wlr_scene_node_set_position(&glyph->node, 364, 364);
        if (upper) wlr_scene_node_set_position(&upper->node, 464, 464);
        printf("GAUSSIAN_FIXTURE: case=%u setup_ms=%.6f logical=%dx%d sigma=%g scale=%g radius=%g\n",
            index, milliseconds() - case_start, cases[index].width, cases[index].height,
            cases[index].sigma, scale, cases[index].radius);
        int expected_width = 0, expected_height = 0;
        for (unsigned trial = 0; ok && trial < 4; trial++) {
            double times[4] = {0};
            wlr_scene_node_set_position(&second->node, 400, 0);
            ok = desktop->scene->effects_cached_bytes == 0;
            double start = milliseconds();
            uint64_t count = desktop->scene->backdrop_render_count;
            struct wlr_scene_rect *rect = ok ? wlr_scene_backdrop_create(target,
                &(struct wlr_box){cases[index].x, cases[index].y, cases[index].width, cases[index].height},
                cases[index].radius, cases[index].sigma, cases[index].tint) : NULL;
            times[0] = milliseconds() - start;
            ok = ok && rect && desktop->scene->backdrop_render_count == count + 1;
            uint32_t *actual = NULL, *idle = NULL, *moved = NULL;
            int width = 0, height = 0, w = 0, h = 0;
            if (ok) {
                wlr_scene_node_set_enabled(&rect->node, true);
                start = milliseconds();
                ok = capture(desktop, output, &actual, &width, &height);
                times[3] = milliseconds() - start;
            }
            uint64_t initial_filters = desktop->scene->backdrop_render_count - count;
            count = desktop->scene->backdrop_render_count;
            if (ok) {
                start = milliseconds();
                ok = capture(desktop, output, &idle, &w, &h);
                times[2] = milliseconds() - start;
                ok = ok && w == width && h == height &&
                    desktop->scene->backdrop_render_count == count &&
                    !memcmp(actual, idle, (size_t)width * height * 4);
            }
            if (ok) {
                wlr_scene_node_set_position(&second->node, 320, 0);
                start = milliseconds();
                ok = capture(desktop, output, &moved, &w, &h);
                times[1] = milliseconds() - start;
                ok = ok && w == width && h == height &&
                    desktop->scene->backdrop_render_count == count + 1;
                if (index < 2) ok = ok && memcmp(actual, moved, (size_t)width * height * 4);
            }
            size_t pixels = (size_t)width * height, bytes = pixels * 8;
            if (ok && capacity >= pixels * 2) {
                memcpy(frames, actual, pixels * 4);
                memcpy(frames + pixels, moved, pixels * 4);
                if (trial == 0) {
                    memcpy(expected, frames, bytes);
                    expected_width = width; expected_height = height;
                } else {
                    ok = width == expected_width && height == expected_height &&
                        !memcmp(expected, frames, bytes);
                }
            } else {
                ok = false;
            }
            if (ok && trial == 1) {
                char path[4096];
                int length = snprintf(path, sizeof(path), "%s/case-%u.rgba", directory, index);
                FILE *file = length > 0 && (size_t)length < sizeof(path) ? fopen(path, "wb") : NULL;
                if (file) {
                    bool written = fwrite(frames, 1, bytes, file) == bytes;
                    ok = fclose(file) == 0 && written;
                } else {
                    ok = false;
                }
            }
            free(actual); free(idle); free(moved);
            if (rect) wlr_scene_node_destroy(&rect->node);
            ok = ok && desktop->scene->effects_cached_bytes == 0;
            measured_ms += times[0] + times[1] + times[2] + times[3];
            if (!ok) fprintf(stderr, "FAIL Gaussian probe case=%u trial=%u capacity=%zu pixels=%zu\n",
                index, trial, capacity, pixels);
            printf("GAUSSIAN: case=%u trial=%u warmup=%u output=%dx%d bytes=%zu prepare_ms=%.6f moving_ms=%.6f idle_ms=%.6f initial_capture_ms=%.6f initial_filters=%llu cache_after_destroy=%zu measured_cumulative_ms=%.6f wall_cumulative_ms=%.6f\n",
                index, trial, trial == 0, width, height, bytes, times[0], times[1], times[2], times[3],
                (unsigned long long)initial_filters, desktop->scene->effects_cached_bytes,
                measured_ms, milliseconds() - case_start);
        }
        if (upper) wlr_scene_node_destroy(&upper->node);
        if (target) wlr_scene_node_destroy(&target->node);
        if (apps) {
            wlr_scene_node_set_enabled(&apps->node, false);
            wlr_scene_node_destroy(&apps->node);
        }
        ok = ok && desktop->scene->effects_cached_bytes == 0 &&
            desktop->scene->effects_peak_bytes <= WLR_SCENE_EFFECTS_MAX_BYTES;
    }
    printf("GAUSSIAN_CASE_TOTAL: case=%u measured_ms=%.6f other_ms=%.6f\n",
        index, measured_ms, milliseconds() - case_start - measured_ms);
    return ok ? 0 : 1;
}

static bool gaussian_measurements(struct PuDesktop *desktop, const char *directory)
{
    size_t capacity = 2u * 4096u * 800u;
    uint32_t *frames = malloc(capacity * 4), *expected = malloc(capacity * 4);
    CHECK(frames && expected);
    printf("GAUSSIAN: abi=%u patch=%s seed=0x22e4a17 warmup=1 measurements=3\n",
        wlr_scene_effects_abi_v4(), wlr_scene_effects_source_sha256_v4());
    for (unsigned index = 0;; index++) {
        int result = gaussian_probe(desktop, index, directory, frames, expected, capacity);
        if (result != 0) {
            free(frames); free(expected);
            CHECK(result == 2);
            return true;
        }
    }
}

static bool gaussian_comparison(const char *directory)
{
    char runtime[] = "/tmp/polly-gaussian-XXXXXX";
    CHECK(mkdtemp(runtime));
    setenv("XDG_RUNTIME_DIR", runtime, 1);
    setenv("WLR_BACKENDS", "headless", 1);
    setenv("WLR_HEADLESS_OUTPUTS", "1", 1);
    setenv("WLR_RENDERER", "pixman", 1);
    wlr_log_init(WLR_ERROR, NULL);
    struct PuDesktop desktop = {0};
    bool ok = pu_desktop_init(&desktop, NULL) && pu_desktop_start(&desktop) &&
        gaussian_measurements(&desktop, directory);
    pu_desktop_finish(&desktop);
    if (rmdir(runtime)) ok = false;
    return ok;
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (argc == 3 && !strcmp(argv[1], "--gaussian-compare"))
        return gaussian_comparison(argv[2]) ? 0 : 1;
    if (argc != 1 && !(argc == 3 && !strcmp(argv[1], "--caption"))) return 2;
    char runtime[] = "/tmp/polly-effects-XXXXXX";
    if (!mkdtemp(runtime)) return 1;
    setenv("XDG_RUNTIME_DIR", runtime, 1);
    setenv("WLR_BACKENDS", "headless", 1);
    setenv("WLR_HEADLESS_OUTPUTS", "1", 1);
    setenv("WLR_RENDERER", "pixman", 1);
    wlr_log_init(WLR_INFO, NULL);
    struct PuDesktop desktop;
    bool passed = pu_desktop_init(&desktop, NULL) && pu_desktop_start(&desktop) &&
        (argc == 3 ? caption_suite(&desktop, argv[2]) : suite(&desktop));
    pu_desktop_finish(&desktop);
    if (rmdir(runtime)) passed = false;
    return passed ? 0 : 1;
}
