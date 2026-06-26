#include "host/win32/window.h"

/* PollyUI entry point (M0a).
 * Wires only the HostEngine for now; Script/Model/Layout/Render are added in
 * later milestones (DESIGN.md §10). */

int main(void)
{
    PuWindowConfig cfg;
    cfg.title  = "PollyUI \xE2\x80\x94 M0"; /* "PollyUI — M0" (UTF-8 em dash) */
    cfg.width  = 960;
    cfg.height = 600;

    PuWindow *w = pu_window_create(&cfg);
    if (!w)
        return 1;

    int code = pu_window_run(w);
    pu_window_destroy(w);
    return code;
}
