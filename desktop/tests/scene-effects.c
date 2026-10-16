#include "server.h"
#include <drm_fourcc.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wlr/interfaces/wlr_buffer.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/util/log.h>
#include <wlr/util/transform.h>

#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL effects:%d: %s\n", __LINE__, #c); return false; } } while (0)
struct Pixels { struct wlr_buffer base; uint32_t pixels[24 * 20]; };
static void destroy(struct wlr_buffer *base) { wlr_buffer_finish(base); free(base); }
static bool access_pixels(struct wlr_buffer *base, uint32_t flags, void **data, uint32_t *format, size_t *stride)
{
    struct Pixels *pixels = wl_container_of(base, pixels, base);
    if (flags & WLR_BUFFER_DATA_PTR_ACCESS_WRITE) return false;
    *data = pixels->pixels; *format = DRM_FORMAT_ARGB8888; *stride = 24 * 4;
    return true;
}
static void end_access(struct wlr_buffer *base) { (void)base; }
static const struct wlr_buffer_impl pixels_impl = {
    .destroy = destroy, .begin_data_ptr_access = access_pixels, .end_data_ptr_access = end_access,
};
static struct wlr_buffer *pattern(void)
{
    struct Pixels *pixels = calloc(1, sizeof(*pixels));
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
static bool suite(struct PuDesktop *desktop)
{
    CHECK(wlr_scene_effects_abi_v1() == 1);
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
    wlr_scene_node_destroy(&background->node);
    return true;
}
int main(void)
{
    char runtime[] = "/tmp/polly-effects-XXXXXX";
    if (!mkdtemp(runtime)) return 1;
    setenv("XDG_RUNTIME_DIR", runtime, 1);
    setenv("WLR_BACKENDS", "headless", 1);
    setenv("WLR_HEADLESS_OUTPUTS", "1", 1);
    setenv("WLR_RENDERER", "pixman", 1);
    wlr_log_init(WLR_INFO, NULL);
    struct PuDesktop desktop;
    bool passed = pu_desktop_init(&desktop, NULL) && pu_desktop_start(&desktop) && suite(&desktop);
    pu_desktop_finish(&desktop);
    if (rmdir(runtime)) passed = false;
    return passed ? 0 : 1;
}
