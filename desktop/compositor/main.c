#include "server.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdlib.h>
#include <wlr/util/log.h>

static void usage(FILE *out)
{
    fprintf(out, "Usage: pollywm [--socket NAME] [--debug] [--help] [--shell PROGRAM [ARG...]]\n"
        "Experimental wlroots 0.19 compositor. No shell is started by default.\n"
        "--shell must be last; its program receives a private trusted Wayland connection.\n"
        "Alt+Tab: cycle windows; Alt+F4: close; Alt+Escape: exit.\n"
        "Alt+F10: toggle maximize; Alt+F11: toggle fullscreen.\n"
        "Alt+left drag: move; Alt+right drag: resize.\n");
}

int main(int argc, char **argv)
{
    const char *socket_name = NULL;
    bool debug = false;
    char **shell_argv = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0) { usage(stdout); return 0; }
        if (strcmp(argv[i], "--debug") == 0) { debug = true; continue; }
        if (strcmp(argv[i], "--shell") == 0 && i + 1 < argc && *argv[i + 1]) {
            shell_argv = &argv[i + 1];
            break;
        }
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) {
            socket_name = argv[++i];
            if (*socket_name && !strchr(socket_name, '/') &&
                strcmp(socket_name, ".") && strcmp(socket_name, "..")) continue;
            fprintf(stderr, "--socket must be a nonempty socket basename\n");
            return 2;
        }
        usage(stderr);
        return 2;
    }
    const char *runtime = getenv("XDG_RUNTIME_DIR");
    struct stat info;
    if (!runtime || runtime[0] != '/' || stat(runtime, &info) < 0 ||
        !S_ISDIR(info.st_mode) || info.st_uid != getuid() ||
        (info.st_mode & 0777) != 0700) {
        fprintf(stderr, "XDG_RUNTIME_DIR must be an absolute, user-owned directory with mode 0700.\n"
            "On WSLg, create a private runtime directory and use an absolute parent WAYLAND_DISPLAY.\n");
        return 1;
    }
    wlr_log_init(debug ? WLR_DEBUG : WLR_INFO, NULL);
    struct PuDesktop desktop;
    bool ready = pu_desktop_init(&desktop, socket_name) && pu_desktop_start(&desktop);
    if (ready && shell_argv) ready = pu_desktop_spawn_shell(&desktop, shell_argv);
    if (ready) wl_display_run(desktop.display);
    int result = !ready || desktop.failed ? 1 : 0;
    pu_desktop_finish(&desktop);
    return result;
}
