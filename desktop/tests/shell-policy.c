#include "server.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include <limits.h>
#include <wayland-client.h>
#include <wlr/util/log.h>

#define CHECK(expression) do { \
    if (!(expression)) { \
        fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expression); return false; \
    } \
} while (0)

static struct PuDesktop desktop;
/* No methods are needed to test binding the real production global. */
static const struct wl_interface restricted_interface = {
    .name = "zwlr_layer_shell_v1", .version = 1,
};
static const struct wl_interface foreign_interface = {
    .name = "zwlr_foreign_toplevel_manager_v1", .version = 1,
};
static const struct wl_interface appearance_interface = { .name = "polly_appearance_v1", .version = 1 };
static const struct wl_interface workspace_interface = { .name = "ext_workspace_manager_v1", .version = 1 };
static const struct wl_interface workspace_toplevel_interface = { .name = "polly_workspace_toplevel_manager_v1", .version = 1 };
static const char literal[] = "argument with spaces; $HOME is not expanded";

struct Registry {
    uint32_t restricted, foreign, appearance, workspace, workspace_toplevel, compositor;
};

static void registry_global(void *data, struct wl_registry *registry, uint32_t name,
                            const char *interface, uint32_t version)
{
    (void)registry;
    (void)version;
    struct Registry *state = data;
    if (strcmp(interface, restricted_interface.name) == 0) state->restricted = name;
    if (strcmp(interface, foreign_interface.name) == 0) state->foreign = name;
    if (strcmp(interface, appearance_interface.name) == 0) state->appearance = name;
    if (strcmp(interface, workspace_interface.name) == 0) state->workspace = name;
    if (strcmp(interface, workspace_toplevel_interface.name) == 0) state->workspace_toplevel = name;
    if (strcmp(interface, "wl_compositor") == 0) state->compositor = name;
}

static void registry_remove(void *data, struct wl_registry *registry, uint32_t name)
{
    (void)data;
    (void)registry;
    (void)name;
}

static const struct wl_registry_listener registry_listener = {
    .global = registry_global, .global_remove = registry_remove,
};

static bool probe(const char *socket_name, const char *mode, const char *argument)
{
    CHECK(strcmp(argument, literal) == 0);
    CHECK(getenv("WAYLAND_DISPLAY") && strcmp(getenv("WAYLAND_DISPLAY"), socket_name) == 0);
    CHECK(getenv("WAYLAND_SOCKET") && strcmp(getenv("WAYLAND_SOCKET"), "3") == 0);
    sigset_t mask;
    CHECK(sigprocmask(SIG_SETMASK, NULL, &mask) == 0);
    CHECK(!sigismember(&mask, SIGINT) && !sigismember(&mask, SIGTERM) &&
          !sigismember(&mask, SIGCHLD));
    struct wl_display *trusted = wl_display_connect(NULL);
    CHECK(trusted);
    CHECK(!getenv("WAYLAND_SOCKET"));
    CHECK(fcntl(wl_display_get_fd(trusted), F_GETFD) & FD_CLOEXEC);
    struct Registry privileged = {0};
    struct wl_registry *registry = wl_display_get_registry(trusted);
    CHECK(wl_registry_add_listener(registry, &registry_listener, &privileged) == 0);
    CHECK(wl_display_roundtrip(trusted) >= 0);
    CHECK(privileged.restricted && privileged.foreign && privileged.appearance && privileged.compositor);
    CHECK(privileged.workspace && privileged.workspace_toplevel);
    if (strcmp(mode, "--ignore-term") == 0) CHECK(signal(SIGTERM, SIG_IGN) != SIG_ERR);
    struct wl_proxy *capability = wl_registry_bind(
        registry, privileged.restricted, &restricted_interface, 1);
    CHECK(capability);
    if (strcmp(mode, "--wait") == 0 || strcmp(mode, "--ignore-term") == 0) {
        CHECK(wl_display_flush(trusted) >= 0);
        for (;;) pause();
    }
    CHECK(wl_display_roundtrip(trusted) >= 0);

    /* The very same process cannot obtain privilege through the public socket. */
    struct wl_display *ordinary = wl_display_connect(socket_name);
    CHECK(ordinary);
    struct Registry public = {0};
    struct wl_registry *public_registry = wl_display_get_registry(ordinary);
    CHECK(wl_registry_add_listener(public_registry, &registry_listener, &public) == 0);
    CHECK(wl_display_roundtrip(ordinary) >= 0);
    CHECK(public.compositor && !public.restricted && !public.foreign && !public.appearance);
    CHECK(!public.workspace && !public.workspace_toplevel);
    struct wl_proxy *forged = wl_registry_bind(
        public_registry, privileged.restricted, &restricted_interface, 1);
    CHECK(forged);
    CHECK(wl_display_roundtrip(ordinary) < 0);
    CHECK(wl_display_get_error(ordinary) == EPROTO);
    wl_proxy_destroy(forged);
    wl_registry_destroy(public_registry);
    wl_display_disconnect(ordinary);
    ordinary = wl_display_connect(socket_name);
    CHECK(ordinary);
    public_registry = wl_display_get_registry(ordinary);
    CHECK(wl_registry_add_listener(public_registry, &registry_listener, &public) == 0);
    CHECK(wl_display_roundtrip(ordinary) >= 0 && !public.appearance);
    forged = wl_registry_bind(public_registry, privileged.appearance, &appearance_interface, 1);
    CHECK(forged && wl_display_roundtrip(ordinary) < 0 && wl_display_get_error(ordinary) == EPROTO);
    wl_proxy_destroy(forged);
    wl_registry_destroy(public_registry);
    wl_display_disconnect(ordinary);
    ordinary = wl_display_connect(socket_name);
    CHECK(ordinary);
    public_registry = wl_display_get_registry(ordinary);
    CHECK(wl_registry_add_listener(public_registry, &registry_listener, &public) == 0);
    CHECK(wl_display_roundtrip(ordinary) >= 0);
    CHECK(!public.foreign);
    forged = wl_registry_bind(public_registry, privileged.foreign, &foreign_interface, 1);
    CHECK(forged && wl_display_roundtrip(ordinary) < 0 && wl_display_get_error(ordinary) == EPROTO);
    wl_proxy_destroy(forged);
    wl_registry_destroy(public_registry);
    wl_display_disconnect(ordinary);
    CHECK(wl_display_roundtrip(trusted) >= 0);
    const struct wl_interface *interfaces[] = { &workspace_interface, &workspace_toplevel_interface };
    uint32_t globals[] = { privileged.workspace, privileged.workspace_toplevel };
    for (size_t i = 0; i < 2; i++) {
        ordinary = wl_display_connect(socket_name);
        CHECK(ordinary);
        public_registry = wl_display_get_registry(ordinary);
        CHECK(wl_registry_add_listener(public_registry, &registry_listener, &public) == 0);
        CHECK(wl_display_roundtrip(ordinary) >= 0 && !public.workspace && !public.workspace_toplevel);
        forged = wl_registry_bind(public_registry, globals[i], interfaces[i], 1);
        CHECK(forged && wl_display_roundtrip(ordinary) < 0 && wl_display_get_error(ordinary) == EPROTO);
        wl_proxy_destroy(forged);
        wl_registry_destroy(public_registry);
        wl_display_disconnect(ordinary);
    }
    wl_proxy_destroy(capability);
    wl_registry_destroy(registry);
    wl_display_disconnect(trusted);
    return true;
}

static enum wl_iterator_result count_binding(struct wl_resource *resource, void *data)
{
    int *count = data;
    if (strcmp(wl_resource_get_class(resource), restricted_interface.name) == 0) (*count)++;
    return WL_ITERATOR_CONTINUE;
}

static bool pump(void)
{
    wl_display_flush_clients(desktop.display);
    CHECK(wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 5) >= 0);
    CHECK(!desktop.failed);
    return true;
}

static bool wait_shell(void)
{
    for (int i = 0; i < 1000 && desktop.shell_pid; i++) CHECK(pump());
    CHECK(!desktop.shell_pid && !desktop.shell_client && desktop.shell_exited);
    return true;
}

static bool wait_binding(void)
{
    int count = 0;
    for (int i = 0; i < 1000 && !count; i++) {
        CHECK(pump());
        if (desktop.shell_client) wl_client_for_each_resource(desktop.shell_client, count_binding, &count);
    }
    CHECK(count == 1 && desktop.shell_pid && desktop.shell_client);
    return true;
}

static bool suite(char *self)
{
    CHECK(setenv("WAYLAND_DISPLAY", "not-the-compositor", 1) == 0);
    CHECK(setenv("WAYLAND_SOCKET", "2147483647", 1) == 0);
    char *missing[] = { "/pollywm-test/nonexistent-shell", NULL };
    CHECK(!pu_desktop_spawn_shell(&desktop, missing));
    CHECK(!desktop.shell_pid && !desktop.shell_client && !desktop.failed);
    char *args[] = { self, "--probe", (char *)desktop.socket_name, (char *)literal, NULL };
    for (int i = 0; i < 8; i++) {
        CHECK(pu_desktop_spawn_shell(&desktop, args));
        CHECK(!pu_desktop_spawn_shell(&desktop, args));
        CHECK(wait_shell());
        CHECK(WIFEXITED(desktop.shell_status) && WEXITSTATUS(desktop.shell_status) == 0);
    }
    args[1] = "--wait";
    CHECK(pu_desktop_spawn_shell(&desktop, args));
    CHECK(wait_binding());
    CHECK(kill(desktop.shell_pid, SIGKILL) == 0);
    CHECK(wait_shell());
    CHECK(WIFSIGNALED(desktop.shell_status) && WTERMSIG(desktop.shell_status) == SIGKILL);

    CHECK(pu_desktop_spawn_shell(&desktop, args));
    CHECK(wait_binding());
    pu_desktop_stop_shell(&desktop);
    CHECK(!desktop.shell_pid && !desktop.shell_client);
    CHECK(WIFSIGNALED(desktop.shell_status) && WTERMSIG(desktop.shell_status) == SIGTERM);
    args[1] = "--ignore-term";
    CHECK(pu_desktop_spawn_shell(&desktop, args));
    CHECK(wait_binding());
    pu_desktop_stop_shell(&desktop);
    CHECK(!desktop.shell_pid && !desktop.shell_client);
    CHECK(WIFSIGNALED(desktop.shell_status) && WTERMSIG(desktop.shell_status) == SIGKILL);
    char *failure[] = { self, "--exit-failure", NULL };
    CHECK(pu_desktop_supervise_shell(&desktop, failure, 2));
    for (int i = 0; i < 2000 && (desktop.shell_pid || desktop.shell_restart_pending); i++) CHECK(pump());
    CHECK(!desktop.shell_pid && !desktop.shell_restart_pending && !desktop.shell_client);
    CHECK(desktop.shell_restarts_used == 2 && desktop.shell_restarts_left == 0);
    CHECK(WIFEXITED(desktop.shell_status) && WEXITSTATUS(desktop.shell_status) == 23);
    CHECK(!desktop.failed);
    pu_desktop_stop_shell(&desktop);

    args[1] = "--probe";
    CHECK(pu_desktop_supervise_shell(&desktop, args, 2));
    CHECK(wait_shell());
    for (int i = 0; i < 30; i++) CHECK(pump());
    CHECK(desktop.shell_restarts_used == 0 && !desktop.shell_restart_pending);
    CHECK(WIFEXITED(desktop.shell_status) && WEXITSTATUS(desktop.shell_status) == 0);
    pu_desktop_stop_shell(&desktop);

    char command_path[PATH_MAX];
    CHECK(strlen(self) < sizeof(command_path));
    strcpy(command_path, self);
    args[0] = command_path;
    args[1] = "--wait";
    CHECK(pu_desktop_supervise_shell(&desktop, args, 2));
    command_path[0] = '\0';
    CHECK(wait_binding());
    pid_t original = desktop.shell_pid;
    CHECK(kill(original, SIGKILL) == 0);
    for (int i = 0; i < 1000 && (!desktop.shell_pid || desktop.shell_pid == original); i++) CHECK(pump());
    CHECK(desktop.shell_pid && desktop.shell_pid != original);
    CHECK(wait_binding());
    CHECK(desktop.shell_restarts_used == 1 && desktop.shell_restarts_left == 1);
    pu_desktop_stop_shell(&desktop);
    for (int i = 0; i < 30; i++) CHECK(pump());
    CHECK(!desktop.shell_pid && !desktop.shell_command && !desktop.shell_restart_pending);

    CHECK(pu_desktop_supervise_shell(&desktop, failure, 2));
    CHECK(wait_shell());
    CHECK(desktop.shell_restart_pending);
    pu_desktop_stop_shell(&desktop);
    for (int i = 0; i < 50; i++) CHECK(pump());
    CHECK(!desktop.shell_pid && !desktop.shell_restart_pending && !desktop.shell_command);
    return true;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "--exit-failure") == 0) return 23;
    if (argc == 4) return probe(argv[2], argv[1], argv[3]) ? 0 : 1;
    if (argc != 1) return 2;
    char runtime[] = "/tmp/pollywm-shell-XXXXXX";
    if (!mkdtemp(runtime)) { perror("mkdtemp"); return 1; }
    setenv("XDG_RUNTIME_DIR", runtime, 1);
    setenv("WLR_BACKENDS", "headless", 1);
    setenv("WLR_HEADLESS_OUTPUTS", "1", 1);
    setenv("WLR_RENDERER", "pixman", 1);
    wlr_log_init(WLR_INFO, NULL);
    bool passed = pu_desktop_init(&desktop, NULL) && pu_desktop_start(&desktop) && suite(argv[0]);
    pu_desktop_finish(&desktop);
    if (rmdir(runtime) < 0) { perror("runtime cleanup"); passed = false; }
    if (passed) puts("PASS: shell capability, forced-bind rejection, revocation, respawn and shutdown");
    return passed ? 0 : 1;
}
