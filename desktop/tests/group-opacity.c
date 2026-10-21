#define _POSIX_C_SOURCE 200809L
#include "server.h"
#include <drm_fourcc.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/util/log.h>

#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL group opacity:%d: %s\n", __LINE__, #c); return false; } } while (0)

static bool capture(struct PuDesktop *desktop, struct wlr_output *output, uint32_t **pixels, size_t *count)
{
    struct wlr_output_state state;
    wlr_output_state_init(&state);
    struct wlr_scene_output *scene_output = wlr_scene_get_scene_output(desktop->scene, output);
    wlr_output_lock_attach_render(output, true);
    bool built = wlr_scene_output_build_state(scene_output, &state, NULL);
    wlr_output_lock_attach_render(output, false);
    CHECK(built && state.buffer);
    void *data;
    uint32_t format;
    size_t stride;
    CHECK(wlr_buffer_begin_data_ptr_access(state.buffer, WLR_BUFFER_DATA_PTR_ACCESS_READ, &data, &format, &stride));
    CHECK(format == DRM_FORMAT_ARGB8888 || format == DRM_FORMAT_XRGB8888);
    *count = (size_t)state.buffer->width * state.buffer->height;
    *pixels = malloc(*count * sizeof(**pixels));
    CHECK(*pixels);
    for (int y = 0; y < state.buffer->height; y++)
        memcpy(*pixels + (size_t)y * state.buffer->width, (char *)data + (size_t)y * stride,
            (size_t)state.buffer->width * sizeof(**pixels));
    wlr_buffer_end_data_ptr_access(state.buffer);
    wlr_output_state_finish(&state);
    return true;
}

static bool suite(struct PuDesktop *desktop)
{
    struct wlr_output_layout_output *entry = wl_container_of(desktop->layout->outputs.next, entry, link);
    struct wlr_output *output = entry->output;
    struct wlr_scene_tree *background = wlr_scene_tree_create(&desktop->scene->tree);
    CHECK(background);
    wlr_scene_node_lower_to_bottom(&background->node);
    CHECK(wlr_scene_rect_create(background, 256, 256, (float[4]){0.1f, 0.2f, 0.8f, 1}));
    struct wlr_scene_tree *group = wlr_scene_tree_create(desktop->windows);
    CHECK(group);
    wlr_scene_node_set_position(&group->node, 19, 23);
    CHECK(wlr_scene_rect_create(group, 64, 64, (float[4]){0.8f, 0.1f, 0, 1}));
    CHECK(wlr_scene_rect_create(group, 64, 64, (float[4]){0, 0.4f, 0, 0.5f}));
    const struct wlr_box box = {0, 0, 64, 64};
    for (unsigned index = 0; index < 8; index++) {
        const float scales[] = {1, 1.25f, 1.5f, 2};
        float scale = scales[index % 4];
        struct wlr_output_state state;
        wlr_output_state_init(&state);
        wlr_output_state_set_custom_mode(&state, (int)(128 * scale), (int)(128 * scale), 60000);
        wlr_output_state_set_scale(&state, scale);
        wlr_output_state_set_transform(&state, index < 4 ? WL_OUTPUT_TRANSFORM_NORMAL : WL_OUTPUT_TRANSFORM_90);
        CHECK(wlr_output_commit_state(output, &state));
        wlr_output_state_finish(&state);
        uint32_t *behind, *plain, *composed, *idle;
        size_t count, n;
        wlr_scene_node_set_enabled(&group->node, false);
        CHECK(capture(desktop, output, &behind, &count));
        wlr_scene_node_set_enabled(&group->node, true);
        for (unsigned rounded = 0; rounded < 2; rounded++) {
            float radius = rounded ? 12 : 0;
            CHECK(wlr_scene_tree_set_composition(group, radius ? &box : NULL, radius, 1));
            CHECK(capture(desktop, output, &plain, &n) && n == count);
            for (unsigned percent = 50; percent < 100; percent += 25) {
                float opacity = percent / 100.0f;
                CHECK(wlr_scene_tree_set_composition(group, &box, radius, opacity));
                CHECK(wlr_scene_tree_prepare_composition(group));
                CHECK(capture(desktop, output, &composed, &n) && n == count);
                unsigned changed = 0;
                for (size_t pixel = 0; pixel < count; pixel++) {
                    changed += composed[pixel] != plain[pixel];
                    for (unsigned shift = 0; shift < 24; shift += 8) {
                        int source = (plain[pixel] >> shift) & 255;
                        int lower = (behind[pixel] >> shift) & 255;
                        int expected = (int)lroundf(source * opacity + lower * (1 - opacity));
                        CHECK(abs((int)((composed[pixel] >> shift) & 255) - expected) <= 2);
                    }
                }
                CHECK(changed > 100);
                uint64_t renders = desktop->scene->effects_render_count;
                CHECK(capture(desktop, output, &idle, &n) && n == count);
                CHECK(!memcmp(idle, composed, count * sizeof(*idle)));
                CHECK(desktop->scene->effects_render_count == renders);
                free(idle);
                free(composed);
            }
            CHECK(wlr_scene_tree_set_composition(group, radius ? &box : NULL, radius, 1));
            CHECK(capture(desktop, output, &composed, &n) && n == count);
            CHECK(!memcmp(plain, composed, count * sizeof(*plain)));
            free(plain);
            free(composed);
        }
        free(behind);
        CHECK(wlr_scene_tree_set_composition(group, NULL, 0, 1));
        CHECK(desktop->scene->effects_cached_bytes == 0);
    }
    for (unsigned index = 0; index < 4; index++) {
        const float invalid[] = {-0.1f, 1.1f, NAN, INFINITY};
        CHECK(!wlr_scene_tree_set_composition(group, &box, 0, invalid[index]));
        CHECK(!group->rounding);
    }
    CHECK(!wlr_scene_tree_set_composition(group, NULL, 0, 0.5f));
    CHECK(wlr_scene_tree_set_composition(group, &box, 0, 0.5f));
    struct wlr_scene_tree *nested = wlr_scene_tree_create(group);
    CHECK(nested && !wlr_scene_tree_set_composition(nested, &box, 0, 0.5f));
    CHECK(wlr_scene_tree_prepare_composition(group));
    size_t committed = desktop->scene->effects_cached_bytes;
    struct wlr_scene_tree *large = wlr_scene_tree_create(desktop->windows);
    CHECK(large && wlr_scene_rect_create(large, 4096, 4096, (float[4]){1, 1, 1, 1}));
    CHECK(wlr_scene_tree_set_composition(large, &(struct wlr_box){0, 0, 4096, 4096}, 0, 0.5f));
    CHECK(!wlr_scene_tree_prepare_composition(large));
    CHECK(desktop->scene->effects_cached_bytes == committed);
    CHECK(wlr_scene_tree_set_composition(large, NULL, 0, 1));
    wlr_scene_node_destroy(&large->node);
    wlr_scene_node_destroy(&group->node);
    wlr_scene_node_destroy(&background->node);
    CHECK(desktop->scene->effects_cached_bytes == 0);
    puts("PASS: isolated whole-group opacity, overlapping children, rounding, scale/rotation, idle reuse, exact restoration, invalid inputs and bounded preflight");
    return true;
}

int main(void)
{
    char runtime[] = "/tmp/polly-group-opacity-XXXXXX";
    if (!mkdtemp(runtime)) return 1;
    setenv("XDG_RUNTIME_DIR", runtime, 1);
    setenv("WLR_BACKENDS", "headless", 1);
    setenv("WLR_HEADLESS_OUTPUTS", "1", 1);
    setenv("WLR_RENDERER", "pixman", 1);
    wlr_log_init(WLR_INFO, NULL);
    struct PuDesktop desktop = {0};
    bool passed = pu_desktop_init(&desktop, NULL) && pu_desktop_start(&desktop) && suite(&desktop);
    pu_desktop_finish(&desktop);
    if (rmdir(runtime)) passed = false;
    return passed ? 0 : 1;
}
