#include "server.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include <wayland-client.h>
#include <wlr/util/log.h>

#define CHECK(expression) do { \
    if (!(expression)) { \
        fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expression); return false; \
    } \
} while (0)

static struct PuDesktop desktop;
static int bindings;
/* Only the fixture advertises this request-free placeholder. */
static const struct wl_interface restricted_interface = {
    .name = "zwlr_layer_shell_v1", .version = 1,
};
static const char literal[] = "argument with spaces; $HOME is not expanded";

struct Registry {
    uint32_t restricted, compositor;
};

static void registry_global(void *data, struct wl_registry *registry, uint32_t name,
                            const char *interface, uint32_t version)
{
    (void)registry;
    (void)version;
    struct Registry *state = data;
    if (strcmp(interface, restricted_interface.name) == 0) state->restricted = name;
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
    CHECK(privileged.restricted && privileged.compositor);
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
    CHECK(public.compositor && !public.restricted);
    struct wl_proxy *forged = wl_registry_bind(
        public_registry, privileged.restricted, &restricted_interface, 1);
    CHECK(forged);
    CHECK(wl_display_roundtrip(ordinary) < 0);
    CHECK(wl_display_get_error(ordinary) == EPROTO);
    wl_proxy_destroy(forged);
    wl_registry_destroy(public_registry);
    wl_display_disconnect(ordinary);
    CHECK(wl_display_roundtrip(trusted) >= 0);
    wl_proxy_destroy(capability);
    wl_registry_destroy(registry);
    wl_display_disconnect(trusted);
    return true;
}

static void bind_restricted(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
    (void)data;
    if (!wl_resource_create(client, &restricted_interface, (int)version, id))
        wl_client_post_no_memory(client);
    else bindings++;
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

static bool wait_binding(int before)
{
    for (int i = 0; i < 1000 && bindings == before; i++) CHECK(pump());
    CHECK(bindings == before + 1 && desktop.shell_pid && desktop.shell_client);
    return true;
}

static bool suite(char *self)
{
    CHECK(wl_global_create(desktop.display, &restricted_interface, 1, NULL, bind_restricted));
    CHECK(setenv("WAYLAND_DISPLAY", "not-the-compositor", 1) == 0);
    CHECK(setenv("WAYLAND_SOCKET", "2147483647", 1) == 0);
    char *missing[] = { "/pollywm-test/nonexistent-shell", NULL };
    CHECK(!pu_desktop_spawn_shell(&desktop, missing));
    CHECK(!desktop.shell_pid && !desktop.shell_client && !desktop.failed);
    char *args[] = { self, "--probe", (char *)desktop.socket_name, (char *)literal, NULL };
    for (int i = 0; i < 8; i++) {
        int before = bindings;
        CHECK(pu_desktop_spawn_shell(&desktop, args));
        CHECK(!pu_desktop_spawn_shell(&desktop, args));
        CHECK(wait_shell());
        CHECK(WIFEXITED(desktop.shell_status) && WEXITSTATUS(desktop.shell_status) == 0);
        CHECK(bindings == before + 1);
    }
    args[1] = "--wait";
    int before = bindings;
    CHECK(pu_desktop_spawn_shell(&desktop, args));
    CHECK(wait_binding(before));
    CHECK(kill(desktop.shell_pid, SIGKILL) == 0);
    CHECK(wait_shell());
    CHECK(WIFSIGNALED(desktop.shell_status) && WTERMSIG(desktop.shell_status) == SIGKILL);

    before = bindings;
    CHECK(pu_desktop_spawn_shell(&desktop, args));
    CHECK(wait_binding(before));
    pu_desktop_stop_shell(&desktop);
    CHECK(!desktop.shell_pid && !desktop.shell_client);
    CHECK(WIFSIGNALED(desktop.shell_status) && WTERMSIG(desktop.shell_status) == SIGTERM);
    args[1] = "--ignore-term";
    before = bindings;
    CHECK(pu_desktop_spawn_shell(&desktop, args));
    CHECK(wait_binding(before));
    pu_desktop_stop_shell(&desktop);
    CHECK(!desktop.shell_pid && !desktop.shell_client);
    CHECK(WIFSIGNALED(desktop.shell_status) && WTERMSIG(desktop.shell_status) == SIGKILL);
    return true;
}

int main(int argc, char **argv)
{
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
