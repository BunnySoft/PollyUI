#include "private-process.h"
#include "server.h"
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#include <wlr/util/log.h>

extern char **environ;

static int processes_exited(int signal_number, void *data)
{
    (void)signal_number;
    struct PuDesktop *desktop = data;
    desktop->private_process_pending = true;
    if (desktop->private_process_dispatching) return 0;
    desktop->private_process_dispatching = true;
    do {
        desktop->private_process_pending = false;
        struct PuPrivateProcessWatch watches[PU_PRIVATE_PROCESS_COUNT];
        memcpy(watches, desktop->private_processes, sizeof(watches));
        for (unsigned i = 0; i < PU_PRIVATE_PROCESS_COUNT; i++) {
            /* A preceding check may stop/free or replace another service. */
            if (watches[i].check &&
                watches[i].generation == desktop->private_processes[i].generation)
                watches[i].check(desktop);
        }
        /* Shutdown can dispatch recursively. Rescan only for an actual nested
         * notification, including exits of owners already checked in this pass. */
    } while (desktop->private_process_pending);
    desktop->private_process_dispatching = false;
    return 0;
}

bool pu_private_process_watch(struct PuDesktop *desktop, enum PuPrivateProcess owner,
    void (*check)(struct PuDesktop *desktop))
{
    if (!desktop->display || desktop->stopping || !check) {
        wlr_log(WLR_ERROR, "Cannot watch private process in the current state");
        return false;
    }
    if (!desktop->private_process_exit) {
        desktop->private_process_exit = wl_event_loop_add_signal(
            wl_display_get_event_loop(desktop->display), SIGCHLD, processes_exited, desktop);
        if (!desktop->private_process_exit) {
            wlr_log_errno(WLR_ERROR, "Cannot monitor private process exits");
            return false;
        }
    }
    struct PuPrivateProcessWatch *watch = &desktop->private_processes[owner];
    if (watch->check != check) {
        watch->generation++;
        watch->check = check;
    }
    return true;
}

void pu_private_process_unwatch(struct PuDesktop *desktop, enum PuPrivateProcess owner)
{
    struct PuPrivateProcessWatch *watch = &desktop->private_processes[owner];
    watch->check = NULL;
    watch->generation++;
    for (unsigned i = 0; i < PU_PRIVATE_PROCESS_COUNT; i++)
        if (desktop->private_processes[i].check) return;
    if (desktop->private_process_exit) wl_event_source_remove(desktop->private_process_exit);
    desktop->private_process_exit = NULL;
}

bool pu_spawn_private(struct PuDesktop *desktop, char *const argv[], const char *label,
    struct wl_client **client, pid_t *pid, struct wl_listener *destroy)
{
    if (!desktop->display || !desktop->socket_name || desktop->stopping || *client || *pid ||
        !argv || !argv[0] || !*argv[0]) {
        wlr_log(WLR_ERROR, "Cannot start %s: invalid state or command", label);
        return false;
    }
    size_t count = 0;
    while (environ[count]) count++;
    char **environment = calloc(count + 3, sizeof(*environment));
    size_t display_size = strlen(desktop->socket_name) + sizeof("WAYLAND_DISPLAY=");
    char *display = malloc(display_size);
    if (!environment || !display) {
        free(environment); free(display);
        wlr_log(WLR_ERROR, "Cannot allocate %s environment", label);
        return false;
    }
    size_t next = 0;
    for (size_t i = 0; i < count; i++)
        if (strncmp(environ[i], "WAYLAND_SOCKET=", 15) && strncmp(environ[i], "WAYLAND_DISPLAY=", 16))
            environment[next++] = environ[i];
    snprintf(display, display_size, "WAYLAND_DISPLAY=%s", desktop->socket_name);
    environment[next++] = display;
    environment[next] = "WAYLAND_SOCKET=3";
    int sockets[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets) < 0) {
        wlr_log_errno(WLR_ERROR, "Cannot create %s connection", label);
        free(environment); free(display); return false;
    }
    *client = wl_client_create(desktop->display, sockets[0]);
    if (!*client) {
        close(sockets[0]); close(sockets[1]); free(environment); free(display);
        wlr_log(WLR_ERROR, "Cannot allocate trusted %s client", label); return false;
    }
    wl_client_add_destroy_listener(*client, destroy);
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
    sigemptyset(&mask); sigemptyset(&defaults);
    sigaddset(&defaults, SIGINT); sigaddset(&defaults, SIGTERM);
    sigaddset(&defaults, SIGCHLD); sigaddset(&defaults, SIGPIPE);
    if ((error = posix_spawnattr_setsigmask(&attributes, &mask)) ||
        (error = posix_spawnattr_setsigdefault(&attributes, &defaults)) ||
        (error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)) ||
        (error = posix_spawn_file_actions_addclose(&actions, sockets[0])) ||
        (error = posix_spawn_file_actions_adddup2(&actions, sockets[1], 3)) ||
        (sockets[1] != 3 && (error = posix_spawn_file_actions_addclose(&actions, sockets[1]))))
        goto done;
    error = posix_spawnp(pid, argv[0], &actions, &attributes, argv, environment);
done:
    if (attributes_ready) posix_spawnattr_destroy(&attributes);
    if (actions_ready) posix_spawn_file_actions_destroy(&actions);
    close(sockets[1]); free(environment); free(display);
    if (error) {
        *pid = 0;
        wl_client_destroy(*client);
        wlr_log(WLR_ERROR, "Cannot start %s %s: %s", label, argv[0], strerror(error));
        return false;
    }
    wlr_log(WLR_INFO, "Started trusted %s (pid %ld)", label, (long)*pid);
    return true;
}
