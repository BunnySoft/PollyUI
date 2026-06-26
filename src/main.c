#include "host/win32/window.h"
#include "script/script.h"

/* PollyUI entry point.
 *
 *   pollyui              -> open the window (M0: Host + Render)
 *   pollyui <file.js>    -> run a script in the ScriptEngine (M1)
 *
 * M2 fuses these: a script that builds the DOM, rendered in the window. */

static int run_script(const char *path)
{
    PuScript *s = pu_script_create();
    if (!s)
        return 1;
    int rc = pu_script_run_file(s, path);
    if (rc == 0)
        pu_script_run_loop(s);
    pu_script_destroy(s);
    return rc;
}

static int run_window(void)
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

int main(int argc, char **argv)
{
    if (argc >= 2)
        return run_script(argv[1]);
    return run_window();
}
