#include "server.h"
#include "window-opacity.h"
#include "private-process.h"
#include "session-lock.h"
#include "input-method.h"
#include "decorator-process.h"

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <wlr/util/log.h>

static bool spawn_shell(struct PuDesktop *desktop, char *const argv[]);
static void schedule_restart(struct PuDesktop *desktop);

bool pu_desktop_global_filter(const struct wl_client *client,
                              const struct wl_global *global, void *data)
{
    const struct PuDesktop *desktop = data;
    const char *name = wl_global_get_interface(global)->name;
    if (pu_decorator_allowed(desktop, client))
        return !strcmp(name, "polly_appearance_v1") || !strcmp(name, "polly_theme_manager_v1");
    if (!strcmp(name, "polly_appearance_v1"))
        return desktop->shell_client && client == desktop->shell_client;
    if (!strcmp(name, "ext_session_lock_manager_v1"))
        return pu_session_lock_allowed(desktop, client);
    if (!strcmp(name, "polly_session_status_v1"))
        return (desktop->shell_client && client == desktop->shell_client) || pu_input_method_allowed(desktop, client);
    if (!strcmp(name, "zwp_input_method_manager_v2") || !strcmp(name, "zwp_virtual_keyboard_manager_v1"))
        return pu_input_method_allowed(desktop, client);
    if (strcmp(name, "zwlr_layer_shell_v1") == 0 ||
        strcmp(name, "zwlr_foreign_toplevel_manager_v1") == 0 ||
        strcmp(name, "ext_workspace_manager_v1") == 0 ||
        strcmp(name, "polly_workspace_toplevel_manager_v1") == 0 ||
        strcmp(name, "polly_shortcuts_v1") == 0 ||
        strcmp(name, "zwlr_output_manager_v1") == 0 ||
        strcmp(name, "polly_output_guard_v1") == 0)
        return desktop->shell_client && client == desktop->shell_client;
    return true;
}

static void shell_disconnected(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDesktop *desktop = wl_container_of(listener, desktop, shell_client_destroy);
    desktop->shell_client = NULL;
    if (!desktop->stopping && desktop->window_opacity_percent != 100 &&
        !pu_desktop_set_window_opacity(desktop, 100)) {
        wlr_log(WLR_ERROR, "Cannot restore opaque windows after Shell ownership loss");
        desktop->failed = true;
    }
    if (!desktop->session_exit_sealed) desktop->session_exit_pending = false;
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
    uint64_t generation = desktop->private_processes[PU_PRIVATE_SHELL].generation;
    revoke_shell(desktop);
    if (desktop->shell_pid || generation != desktop->private_processes[PU_PRIVATE_SHELL].generation)
        return true;
    if (result > 0 && !desktop->stopping) {
        if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
            if (desktop->exit_with_shell && !pu_session_lock_active(desktop)) {
                if (desktop->require_session_exit && !desktop->session_exit_sealed) {
                    wlr_log(WLR_ERROR, "Shell exited without committing logout; retaining ordinary applications");
                    return true;
                }
                wlr_log(WLR_INFO, "Shell exited normally; ending the requested session");
                wl_display_terminate(desktop->display);
            }
        } else {
            schedule_restart(desktop);
        }
    }
    return true;
}

static void shell_exited(struct PuDesktop *desktop)
{
    reap_shell(desktop, WNOHANG);
}

static bool spawn_shell(struct PuDesktop *desktop, char *const argv[])
{
    if (!desktop->display || !desktop->socket_name || desktop->stopping || desktop->shell_stopping ||
        desktop->shell_pid || !argv || !argv[0] || !*argv[0]) {
        wlr_log(WLR_ERROR, "Cannot start shell: invalid state, command, or shell already running");
        return false;
    }
    if (!pu_private_process_watch(desktop, PU_PRIVATE_SHELL, shell_exited)) return false;
    desktop->session_exit_pending = desktop->session_exit_sealed = false;
    desktop->shell_client_destroy.notify = shell_disconnected;
    if (!pu_spawn_private(desktop, argv, "shell", &desktop->shell_client,
        &desktop->shell_pid, &desktop->shell_client_destroy)) {
        pu_private_process_unwatch(desktop, PU_PRIVATE_SHELL);
        return false;
    }
    desktop->shell_exited = false;
    return true;
}

static void clear_supervision(struct PuDesktop *desktop)
{
    if (desktop->shell_restart_timer) wl_event_source_remove(desktop->shell_restart_timer);
    desktop->shell_restart_timer = NULL;
    desktop->shell_restart_pending = false;
    if (desktop->shell_command) {
        for (size_t i = 0; desktop->shell_command[i]; i++) free(desktop->shell_command[i]);
        free(desktop->shell_command);
    }
    desktop->shell_command = NULL;
    desktop->shell_restarts_left = desktop->shell_restarts_used = 0;
}

static void schedule_restart(struct PuDesktop *desktop)
{
    if (desktop->stopping || desktop->shell_stopping || desktop->shell_restart_pending) return;
    if (!desktop->shell_restarts_left) {
        if (desktop->exit_on_shell_failure && !pu_session_lock_active(desktop)) {
            wlr_log(WLR_ERROR, "Shell restart budget exhausted; ending the requested session with failure");
            desktop->failed = true;
            wl_display_terminate(desktop->display);
            return;
        }
        if (!desktop->shell_command) return;
        wlr_log(WLR_ERROR, "Shell restart budget exhausted; ordinary clients remain running");
        return;
    }
    unsigned shift = desktop->shell_restarts_used < 4 ? desktop->shell_restarts_used : 4;
    int delay = 100 << shift;
    if (wl_event_source_timer_update(desktop->shell_restart_timer, delay) < 0) {
        wlr_log_errno(WLR_ERROR, "Cannot schedule shell restart");
        return;
    }
    desktop->shell_restart_pending = true;
    wlr_log(WLR_INFO, "Shell restart %u scheduled in %d ms", desktop->shell_restarts_used + 1, delay);
}

static int restart_shell(void *data)
{
    struct PuDesktop *desktop = data;
    desktop->shell_restart_pending = false;
    if (desktop->stopping || !desktop->shell_command || !desktop->shell_restarts_left) return 0;
    desktop->shell_restarts_left--;
    desktop->shell_restarts_used++;
    if (!spawn_shell(desktop, desktop->shell_command)) schedule_restart(desktop);
    return 0;
}

bool pu_desktop_spawn_shell(struct PuDesktop *desktop, char *const argv[])
{
    if (desktop->shell_command) {
        wlr_log(WLR_ERROR, "Shell supervision is already configured");
        return false;
    }
    return spawn_shell(desktop, argv);
}

bool pu_desktop_supervise_shell(struct PuDesktop *desktop, char *const argv[], unsigned restarts)
{
    if (!restarts) return pu_desktop_spawn_shell(desktop, argv);
    if (!desktop->display || desktop->stopping || desktop->shell_pid || desktop->shell_command ||
        !argv || !argv[0] || !*argv[0]) {
        wlr_log(WLR_ERROR, "Cannot configure shell supervision in the current state");
        return false;
    }
    size_t count = 0;
    while (argv[count]) count++;
    desktop->shell_command = calloc(count + 1, sizeof(*desktop->shell_command));
    if (!desktop->shell_command) {
        wlr_log(WLR_ERROR, "Cannot allocate shell command");
        return false;
    }
    for (size_t i = 0; i < count; i++) {
        desktop->shell_command[i] = strdup(argv[i]);
        if (!desktop->shell_command[i]) {
            clear_supervision(desktop);
            wlr_log(WLR_ERROR, "Cannot copy shell command");
            return false;
        }
    }
    desktop->shell_restart_timer = wl_event_loop_add_timer(
        wl_display_get_event_loop(desktop->display), restart_shell, desktop);
    if (!desktop->shell_restart_timer) {
        clear_supervision(desktop);
        wlr_log_errno(WLR_ERROR, "Cannot allocate shell restart timer");
        return false;
    }
    desktop->shell_restarts_left = restarts;
    if (!spawn_shell(desktop, desktop->shell_command)) {
        clear_supervision(desktop);
        return false;
    }
    return true;
}

void pu_desktop_stop_shell(struct PuDesktop *desktop)
{
    if (desktop->shell_stopping) return;
    desktop->shell_stopping = true;
    pu_private_process_unwatch(desktop, PU_PRIVATE_SHELL);
    clear_supervision(desktop);
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
    desktop->shell_stopping = false;
}
