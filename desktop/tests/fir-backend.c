#define _POSIX_C_SOURCE 200809L
#include "server.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/util/box.h>
#include <wlr/util/log.h>

int main(int argc, char **argv)
{
    if (argc == 2 && !strcmp(argv[1], "--supports-experimental")) {
#if defined(__x86_64__) && defined(__SSE2__)
        puts("1");
#else
        puts("0");
#endif
        return 0;
    }
    if (argc != 1) return 2;
    wlr_log_init(WLR_INFO, NULL);
    struct PuDesktop desktop = {0};
    if (!pu_desktop_init(&desktop, NULL) || !pu_desktop_start(&desktop)) {
        pu_desktop_finish(&desktop);
        return 1;
    }
    /* A later environment change must not alter an already-created scene. */
    if (setenv("POLLY_EXPERIMENTAL_FIR", "invalid-after-scene-creation", 1) < 0) {
        perror("setenv");
        pu_desktop_finish(&desktop);
        return 1;
    }
    struct wlr_scene_tree *tree = wlr_scene_tree_create(desktop.layer_trees[2]);
    struct wlr_scene_rect *backdrop = tree ? wlr_scene_backdrop_create(tree,
        &(struct wlr_box){8, 8, 17, 9}, 2, 1, (float[4]){0.1f, 0.05f, 0.2f, 0.25f}) : NULL;
    bool ok = backdrop && desktop.scene->backdrop_render_count == 1 &&
        desktop.scene->effects_cached_bytes > 0;
    if (tree) wlr_scene_node_destroy(&tree->node);
    ok = ok && desktop.scene->effects_cached_bytes == 0;
    pu_desktop_finish(&desktop);
    if (!ok) {
        fputs("FAIL: selected FIR backend did not prepare and release a real backdrop\n", stderr);
        return 1;
    }
    puts("PASS: real backdrop filtered through the startup-latched native backend; cache released");
    return 0;
}
