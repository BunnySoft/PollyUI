#include "server.h"

#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <wlr/util/log.h>

extern char **environ;

bool pu_desktop_global_filter(const struct wl_client *client,
                              const struct wl_global *global, void *data)
{
    const struct PuDesktop *desktop = data;
    if (strcmp(wl_global_get_interface(global)->name, "zwlr_layer_shell_v1") == 0)
        return desktop->shell_client && client == desktop->shell_client;
    return true;
}

static void shell_disconnected(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktop *desktop = wl_container_of(listener, desktop, shell_client_destroy);
    desktop->shell_client = NULL;
    wl_list_remove(&listener->link);
    wl_list_init(&listener->link);
    if (!desktop->stopping)
        wlr_log(WLR_INFO, "Shell connection revoked; ordinary clients remain running");
}

static void revoke_shell(struct PuDesktop *desktop)
{
    if (desktop->shell_client) wl_client_destroy(desktop->shell_client);
}

static bool reap_shell(struct PuDesktop *desktop, int options)
{
    if (!desktop->shell_pid) return true;
    int status;
    pid_t result;
    do { result = waitpid(desktop->shell_pid, &status, options); }
    while (result < 0 && errno == EINTR);
    if (result == 0) return false;
    if (result < 0) {
        int error = errno;
        wlr_log(WLR_ERROR, "Cannot reap shell: %s", strerror(error));
        if (error != ECHILD) return false;
    } else {
        desktop->shell_status = status;
        desktop->shell_exited = true;
        if (!desktop->stopping) {
            if (WIFEXITED(status))
                wlr_log(WEXITSTATUS(status) ? WLR_ERROR : WLR_INFO,
                    "Shell exited with status %d", WEXITSTATUS(status));
            else if (WIFSIGNALED(status))
                wlr_log(WLR_ERROR, "Shell terminated by signal %d", WTERMSIG(status));
        }
    }
    desktop->shell_pid = 0;
    revoke_shell(desktop);
    return true;
}

static int shell_exited(int signal_number, void *data)
{
    (void)signal_number;
    reap_shell(data, WNOHANG);
    return 0;
}

bool pu_desktop_spawn_shell(struct PuDesktop *desktop, char *const argv[])
{
    if (!desktop->display || !desktop->socket_name || desktop->stopping ||
        desktop->shell_pid || !argv || !argv[0] || !*argv[0]) {
        wlr_log(WLR_ERROR, "Cannot start shell: invalid state, command, or shell already running");
        return false;
    }
    if (!desktop->shell_exit) {
        desktop->shell_exit = wl_event_loop_add_signal(
            wl_display_get_event_loop(desktop->display), SIGCHLD, shell_exited, desktop);
        if (!desktop->shell_exit) {
            wlr_log_errno(WLR_ERROR, "Cannot monitor shell exit");
            return false;
        }
    }
    size_t count = 0;
    while (environ[count]) count++;
    char **environment = calloc(count + 3, sizeof(*environment));
    size_t display_size = strlen(desktop->socket_name) + sizeof("WAYLAND_DISPLAY=");
    char *display = malloc(display_size);
    if (!environment || !display) {
        free(environment);
        free(display);
        wlr_log(WLR_ERROR, "Cannot allocate shell environment");
        return false;
    }
    size_t next = 0;
    for (size_t i = 0; i < count; i++) {
        if (strncmp(environ[i], "WAYLAND_SOCKET=", 15) &&
            strncmp(environ[i], "WAYLAND_DISPLAY=", 16))
            environment[next++] = environ[i];
    }
    snprintf(display, display_size, "WAYLAND_DISPLAY=%s", desktop->socket_name);
    environment[next++] = display;
    environment[next] = "WAYLAND_SOCKET=3";

    int sockets[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets) < 0) {
        wlr_log_errno(WLR_ERROR, "Cannot create shell connection");
        free(environment);
        free(display);
        return false;
    }
    desktop->shell_client = wl_client_create(desktop->display, sockets[0]);
    if (!desktop->shell_client) {
        wlr_log(WLR_ERROR, "Cannot create trusted Wayland client");
        close(sockets[0]);
        close(sockets[1]);
        free(environment);
        free(display);
        return false;
    }
    desktop->shell_client_destroy.notify = shell_disconnected;
    wl_client_add_destroy_listener(desktop->shell_client, &desktop->shell_client_destroy);

    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attributes;
    bool actions_ready = false, attributes_ready = false;
    int error = posix_spawn_file_actions_init(&actions);
    if (error) goto done;
    actions_ready = true;
    error = posix_spawnattr_init(&attributes);
    if (error) goto done;
    attributes_ready = true;
    sigset_t mask, defaults;
    sigemptyset(&mask);
    sigemptyset(&defaults);
    sigaddset(&defaults, SIGINT);
    sigaddset(&defaults, SIGTERM);
    sigaddset(&defaults, SIGCHLD);
    sigaddset(&defaults, SIGPIPE);
    if ((error = posix_spawnattr_setsigmask(&attributes, &mask)) ||
        (error = posix_spawnattr_setsigdefault(&attributes, &defaults)) ||
        (error = posix_spawnattr_setflags(&attributes,
            POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)) ||
        (error = posix_spawn_file_actions_addclose(&actions, sockets[0])) ||
        (error = posix_spawn_file_actions_adddup2(&actions, sockets[1], 3)) ||
        (sockets[1] != 3 &&
            (error = posix_spawn_file_actions_addclose(&actions, sockets[1]))))
        goto done;
    error = posix_spawnp(&desktop->shell_pid, argv[0], &actions, &attributes,
                        argv, environment);
done:
    if (attributes_ready) posix_spawnattr_destroy(&attributes);
    if (actions_ready) posix_spawn_file_actions_destroy(&actions);
    close(sockets[1]);
    free(environment);
    free(display);
    if (error) {
        desktop->shell_pid = 0;
        revoke_shell(desktop);
        wlr_log(WLR_ERROR, "Cannot start shell %s: %s", argv[0], strerror(error));
        return false;
    }
    desktop->shell_exited = false;
    wlr_log(WLR_INFO, "Started trusted shell (pid %ld)", (long)desktop->shell_pid);
    return true;
}

void pu_desktop_stop_shell(struct PuDesktop *desktop)
{
    revoke_shell(desktop);
    if (!reap_shell(desktop, WNOHANG)) {
        if (kill(desktop->shell_pid, SIGTERM) < 0 && errno != ESRCH)
            wlr_log_errno(WLR_ERROR, "Cannot terminate shell");
        for (int i = 0; i < 100 && !reap_shell(desktop, WNOHANG); i++) {
            struct timespec delay = { .tv_nsec = 10000000 };
            nanosleep(&delay, NULL);
        }
        if (desktop->shell_pid) {
            wlr_log(WLR_ERROR, "Shell did not exit after SIGTERM; sending SIGKILL");
            if (kill(desktop->shell_pid, SIGKILL) < 0 && errno != ESRCH) {
                wlr_log_errno(WLR_ERROR, "Cannot kill unresponsive shell");
                reap_shell(desktop, WNOHANG);
            } else {
                reap_shell(desktop, 0);
            }
        }
    }
    if (desktop->shell_exit) wl_event_source_remove(desktop->shell_exit);
    desktop->shell_exit = NULL;
}
