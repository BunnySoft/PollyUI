#include "host/win32/window.h"
#include "script/script.h"
#include "bridge/bridge.h"
#include "layout/layout.h"
#include "render/render.h"
#include "model/node.h"

#include <stdio.h>

/* PollyUI entry point.
 *
 *   pollyui            -> built-in render demo (M0b)
 *   pollyui app.js     -> run the script to build the DOM, then lay it out with
 *                         Yoga and paint it in a window (M1 + M2 + M3)
 */

/* Shared state for the window callbacks. */
typedef struct PuApp {
    PuScript *script;
    PuBridge *bridge;
} PuApp;

/* Per-frame: lay out the DOM for the current window size, then paint it. */
static void app_paint(PuSurface *surface, int width, int height, void *user)
{
    PuApp *app = (PuApp *)user;
    PuNode *body = pu_bridge_body(app->bridge);
    pu_layout_calculate(body, (float)width, (float)height);
    pu_render_tree(surface, body);
}

/* Click: hit-test against the last computed layout, dispatch to JS, then drain
 * any microtasks the handler queued. The window repaints afterward. */
static void app_pointer(int x, int y, PuPointerType type, void *user)
{
    PuApp *app = (PuApp *)user;
    if (type != PU_POINTER_CLICK) return;
    PuNode *target = pu_node_hit_test(pu_bridge_body(app->bridge), (float)x, (float)y);
    if (target) {
        pu_bridge_dispatch_event(app->bridge, target, "click");
        pu_script_run_loop(app->script);
    }
}

static int run_app(const char *path)
{
    PuScript *s = pu_script_create();
    if (!s)
        return 1;

    PuBridge *bridge = pu_bridge_install(pu_script_jsctx(s));
    if (!bridge) { pu_script_destroy(s); return 1; }

    int rc = pu_script_run_file(s, path);
    if (rc == 0)
        pu_script_run_loop(s);   /* drain microtasks/timers from setup */

    if (rc == 0) {
        PuNode *body = pu_bridge_body(bridge);
        printf("--- native DOM tree ---\n");
        pu_node_dump(body, 0);
        fflush(stdout);

        PuWindowConfig cfg;
        cfg.title  = "PollyUI \xE2\x80\x94 M3";
        cfg.width  = 960;
        cfg.height = 600;
        PuWindow *win = pu_window_create(&cfg);
        if (win) {
            PuApp app = { s, bridge };
            pu_window_set_paint(win, app_paint, &app);
            pu_window_set_pointer(win, app_pointer, &app);
            pu_window_run(win);
            pu_window_destroy(win);
        }
    }

    pu_script_destroy(s);   /* GC finalizers; bridge ref keeps body alive */
    pu_bridge_free(bridge); /* frees the native tree */
    return rc;
}

static int run_demo(void)
{
    PuWindowConfig cfg;
    cfg.title  = "PollyUI \xE2\x80\x94 demo";
    cfg.width  = 960;
    cfg.height = 600;

    PuWindow *w = pu_window_create(&cfg);
    if (!w)
        return 1;
    int code = pu_window_run(w);
    pu_window_destroy(w);
    return code;
}

int main(int argc, char **argv)
{
    if (argc >= 2)
        return run_app(argv[1]);
    return run_demo();
}
