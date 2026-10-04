#include "server.h"
#include "input-method.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdlib.h>
#include <errno.h>
#include <limits.h>
#include <wlr/util/log.h>

static void usage(FILE *out)
{
    fprintf(out, "Usage: pollywm [--socket NAME] [--debug] [--help] [--shell PROGRAM [ARG...]]\n"
        "Experimental wlroots 0.19 compositor. No shell is started by default.\n"
        "--shell-restarts N: retry failed shells at most N times, with backoff (default 0).\n"
        "--exit-with-shell: end the session on shell exit status 0 (not on a crash).\n"
        "--input-method PROGRAM: start a separately trusted input-method service (before --shell).\n"
        "--shell must be last; its program receives a private trusted Wayland connection.\n"
        "Alt+Tab: cycle windows; Alt+F4: close; Alt+Escape: exit.\n"
        "Alt+F10: toggle maximize; Alt+F11: toggle fullscreen.\n"
        "Alt+F9: minimize; Alt+Tab also restores minimized windows.\n"
        "Alt+left drag: move; Alt+right drag: resize.\n");
}

int main(int argc, char **argv)
{
    const char *socket_name = NULL;
    bool debug = false;
    char **shell_argv = NULL;
    char *input_method_argv[2] = {0};
    unsigned shell_restarts = 0;
    bool restart_option = false, exit_with_shell = false;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0) { usage(stdout); return 0; }
        if (strcmp(argv[i], "--debug") == 0) { debug = true; continue; }
        if (strcmp(argv[i], "--input-method") == 0 && i + 1 < argc && *argv[i + 1] &&
            !input_method_argv[0]) { input_method_argv[0] = argv[++i]; continue; }
        if (strcmp(argv[i], "--exit-with-shell") == 0) { exit_with_shell = true; continue; }
        if (strcmp(argv[i], "--shell-restarts") == 0 && i + 1 < argc) {
            const char *value = argv[++i];
            char *end;
            errno = 0;
            unsigned long count = strtoul(value, &end, 10);
            if (*value < '0' || *value > '9' || *end || errno || count > UINT_MAX) {
                fprintf(stderr, "--shell-restarts must be a nonnegative integer\n");
                return 2;
            }
            shell_restarts = (unsigned)count;
            restart_option = true;
            continue;
        }
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
    if (!shell_argv && (restart_option || exit_with_shell)) {
        fprintf(stderr, "Shell supervision options require --shell PROGRAM\n");
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
    desktop.exit_with_shell = exit_with_shell;
    if (ready && input_method_argv[0]) ready = pu_input_method_spawn(&desktop, input_method_argv);
    if (ready && shell_argv) ready = pu_desktop_supervise_shell(&desktop, shell_argv, shell_restarts);
    if (ready) wl_display_run(desktop.display);
    int result = !ready || desktop.failed ? 1 : 0;
    pu_desktop_finish(&desktop);
    return result;
}
