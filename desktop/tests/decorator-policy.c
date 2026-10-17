#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L
#include "server.h"
#include "decorator-process.h"
#include "decoration-layout-fixtures.h"
#include "appearance-document.h"
#include "polly-appearance-client.h"
#include "layer-shell-client-protocol.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#include <wlr/util/log.h>
#include <wlr/types/wlr_scene.h>

enum Command { QUERY, ENABLE, PREPARE, COMMIT, CANCEL, PUBLIC_PROBE, DUPLICATE, FORBIDDEN,
    MAP_BACKDROP, PREPARE_REGIONAL, STAGE_REGIONAL, RECOMMIT_SURFACE, UNMAP_SURFACE, BACKDROP_CAPABILITY,
    SHELL_BACKDROP_CAPABILITY };
struct Reply { uint32_t state, bootstrap, accepted, serial, globals; bool denied; };
struct Probe {
    struct wl_display *display;
    struct wl_registry *registry;
    struct polly_appearance_v1 *appearance;
    struct wl_compositor *compositor;
    struct wl_shm *shm;
    struct zwlr_layer_shell_v1 *layer_shell;
    struct zwlr_layer_surface_v1 *layer;
    struct wl_surface *surface;
    struct wl_buffer *buffer;
    bool configured;
    uint32_t name, version, serial;
    struct Reply reply;
};
static struct PuDesktop desktop;
#define CHECK(test) do { if (!(test)) { \
    fprintf(stderr, "FAIL decorator policy line %d: %s\n", __LINE__, #test); return false; \
} } while (0)
static void prepared(void *data, struct polly_appearance_v1 *object, uint32_t serial,
    uint32_t accepted, const char *message)
{
    (void)object; (void)message;
    struct Probe *probe = data;
    probe->reply.accepted = accepted; probe->reply.serial = serial;
}
static void enabled(void *data, struct polly_appearance_v1 *object, uint32_t accepted, const char *message)
{ (void)object; (void)message; ((struct Probe *)data)->reply.accepted = accepted; }
static void requested(void *data, struct polly_appearance_v1 *object, struct wl_array *meta,
    const char *title, int32_t fd, uint32_t length)
{ (void)data; (void)object; (void)meta; (void)title; (void)length; close(fd); }
static void result(void *data, struct polly_appearance_v1 *object, uint32_t token,
    uint32_t revision, uint32_t status, const char *message)
{ (void)data; (void)object; (void)token; (void)revision; (void)status; (void)message; }
static void cancelled(void *data, struct polly_appearance_v1 *object, uint32_t token)
{ (void)data; (void)object; (void)token; }
static void status(void *data, struct polly_appearance_v1 *object, uint32_t state,
    uint32_t bootstrap, const char *message)
{
    (void)object; (void)message;
    struct Probe *probe = data; probe->reply.state = state; probe->reply.bootstrap = bootstrap;
}
static void capability(void *data, struct polly_appearance_v1 *object, uint32_t supported)
{ (void)object; ((struct Probe *)data)->reply.accepted = supported; }
static const struct polly_appearance_v1_listener listener = {
    .prepared = prepared, .applied = prepared, .renderer_enabled = enabled, .render_request = requested,
    .frame_result = result, .render_cancelled = cancelled, .renderer_status = status,
    .backdrop_prepared = prepared, .backdrop_capability = capability,
    .shell_backdrop_capability = capability,
};
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version)
{
    struct Probe *probe = data;
    if (!strcmp(interface, "polly_appearance_v1")) {
        probe->name = name; probe->reply.globals |= 1;
        probe->appearance = wl_registry_bind(registry, name, &polly_appearance_v1_interface,
            probe->version < version ? probe->version : version);
        polly_appearance_v1_add_listener(probe->appearance, &listener, probe);
    } else if (!strcmp(interface, "polly_theme_manager_v1")) probe->reply.globals |= 2;
    else {
        probe->reply.globals |= 4;
        if (!strcmp(interface, "wl_compositor"))
            probe->compositor = wl_registry_bind(registry, name, &wl_compositor_interface, 4);
        else if (!strcmp(interface, "wl_shm"))
            probe->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
        else if (!strcmp(interface, "zwlr_layer_shell_v1"))
            probe->layer_shell = wl_registry_bind(registry, name, &zwlr_layer_shell_v1_interface, 4);
    }
}
static void removed(void *data, struct wl_registry *registry, uint32_t name)
{ (void)data; (void)registry; (void)name; }
static const struct wl_registry_listener registry_listener = {.global = global, .global_remove = removed};
static bool prepare(struct Probe *probe, uint32_t count)
{
    const struct PuDecorationLayout *layout = &pu_decoration_layouts[0].layout;
    uint32_t words[PU_APPEARANCE_WORDS] = {PU_APPEARANCE_SCHEMA, layout->left_controls};
    unsigned position = 2;
#define ENCODE(type, field, token, minimum, maximum, scale) words[position++] = (uint32_t)(layout->field * (scale) + 0.5);
    PU_APPEARANCE_METRICS(ENCODE)
#undef ENCODE
    const char document[] = "{\"fixtureLayout\":0}";
    int fd = pu_appearance_document_create(document, sizeof(document) - 1);
    CHECK(fd >= 0);
    struct wl_array configuration = {.size = sizeof(words), .data = words};
    polly_appearance_v1_prepare(probe->appearance, ++probe->serial, "policy", &configuration,
        fd, sizeof(document) - 1, count);
    close(fd);
    return true;
}
static void configured(void *data, struct zwlr_layer_surface_v1 *layer,
    uint32_t serial, uint32_t width, uint32_t height)
{
    (void)width; (void)height;
    zwlr_layer_surface_v1_ack_configure(layer, serial);
    ((struct Probe *)data)->configured = true;
}
static void layer_closed(void *data, struct zwlr_layer_surface_v1 *layer)
{ (void)data; (void)layer; }
static const struct zwlr_layer_surface_v1_listener layer_listener = {.configure = configured, .closed = layer_closed};
static bool map_backdrop(struct Probe *probe)
{
    CHECK(probe->compositor && probe->shm && probe->layer_shell);
    probe->surface = wl_compositor_create_surface(probe->compositor);
    probe->layer = zwlr_layer_shell_v1_get_layer_surface(probe->layer_shell, probe->surface,
        NULL, ZWLR_LAYER_SHELL_V1_LAYER_TOP, "not-an-authorization-token");
    CHECK(probe->surface && probe->layer);
    zwlr_layer_surface_v1_add_listener(probe->layer, &layer_listener, probe);
    zwlr_layer_surface_v1_set_size(probe->layer, 96, 64);
    zwlr_layer_surface_v1_set_anchor(probe->layer, ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM);
    zwlr_layer_surface_v1_set_exclusive_zone(probe->layer, 64);
    wl_surface_commit(probe->surface);
    CHECK(wl_display_roundtrip(probe->display) >= 0 && probe->configured);
    int fd = memfd_create("polly-backdrop-policy", MFD_CLOEXEC);
    CHECK(fd >= 0 && !ftruncate(fd, 96 * 64 * 4));
    struct wl_shm_pool *pool = wl_shm_create_pool(probe->shm, fd, 96 * 64 * 4);
    close(fd);
    CHECK(pool);
    probe->buffer = wl_shm_pool_create_buffer(pool, 0, 96, 64, 96 * 4, WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool);
    CHECK(probe->buffer);
    wl_surface_attach(probe->surface, probe->buffer, 0, 0);
    wl_surface_damage(probe->surface, 0, 0, 96, 64);
    wl_surface_commit(probe->surface);
    return true;
}
static bool public_probe(struct Probe *probe)
{
    const char *name = getenv("WAYLAND_DISPLAY");
    struct wl_display *display = wl_display_connect(name);
    CHECK(display);
    struct wl_registry *registry = wl_display_get_registry(display);
    struct polly_appearance_v1 *forged = wl_registry_bind(registry, probe->name, &polly_appearance_v1_interface, 8);
    CHECK(forged && wl_display_roundtrip(display) < 0 && wl_display_get_error(display) == EPROTO);
    wl_proxy_destroy((struct wl_proxy *)forged); wl_registry_destroy(registry); wl_display_disconnect(display);
    return true;
}
static bool child(int fd, uint32_t version)
{
    if (version < 7) CHECK(signal(SIGTERM, SIG_IGN) != SIG_ERR);
    struct Probe probe = {.version = version};
    probe.display = wl_display_connect(NULL);
    CHECK(probe.display);
    probe.registry = wl_display_get_registry(probe.display);
    CHECK(probe.registry && !wl_registry_add_listener(probe.registry, &registry_listener, &probe));
    CHECK(wl_display_roundtrip(probe.display) >= 0);
    int initial = wl_display_roundtrip(probe.display);
    if (version < 7) {
        probe.reply.denied = initial < 0 && wl_display_get_error(probe.display) == EPROTO;
        CHECK(send(fd, &probe.reply, sizeof(probe.reply), MSG_NOSIGNAL) == sizeof(probe.reply));
        return probe.reply.denied;
    }
    CHECK(initial >= 0 && probe.appearance);
    CHECK(send(fd, &probe.reply, sizeof(probe.reply), MSG_NOSIGNAL) == sizeof(probe.reply));
    for (;;) {
        CHECK(wl_display_dispatch_pending(probe.display) >= 0 && wl_display_flush(probe.display) >= 0);
        struct pollfd pollers[] = {{.fd = fd, .events = POLLIN},
            {.fd = wl_display_get_fd(probe.display), .events = POLLIN}};
        int polled = poll(pollers, 2, -1);
        if (polled < 0 && errno == EINTR) continue;
        CHECK(polled >= 0);
        if (pollers[0].revents & (POLLHUP | POLLERR)) break;
        if (pollers[1].revents & POLLIN) CHECK(wl_display_dispatch(probe.display) >= 0);
        if (!(pollers[0].revents & POLLIN)) continue;
        enum Command command;
        CHECK(recv(fd, &command, sizeof(command), 0) == sizeof(command));
        probe.reply.accepted = 0;
        switch (command) {
        case QUERY: break;
        case ENABLE: case FORBIDDEN: polly_appearance_v1_enable_renderer(probe.appearance); break;
        case PREPARE: CHECK(prepare(&probe, 0)); break;
        case PREPARE_REGIONAL: CHECK(prepare(&probe, 1)); break;
        case MAP_BACKDROP: CHECK(map_backdrop(&probe)); probe.reply.accepted = 1; break;
        case STAGE_REGIONAL: {
            uint32_t words[] = {2, 1, 12000, 2, 0xe7e7e7, 28};
            struct wl_array material = {.size = sizeof(words), .data = words};
            polly_appearance_v1_prepare_backdrop(probe.appearance, probe.serial, probe.surface, &material);
            break;
        }
        case RECOMMIT_SURFACE:
            wl_surface_damage(probe.surface, 0, 0, 96, 64); wl_surface_commit(probe.surface); break;
        case UNMAP_SURFACE:
            wl_surface_attach(probe.surface, NULL, 0, 0); wl_surface_commit(probe.surface); break;
        case BACKDROP_CAPABILITY: polly_appearance_v1_get_backdrop_capability(probe.appearance); break;
        case SHELL_BACKDROP_CAPABILITY: polly_appearance_v1_get_shell_backdrop_capability(probe.appearance); break;
        case COMMIT: polly_appearance_v1_commit(probe.appearance, probe.serial); break;
        case CANCEL: polly_appearance_v1_cancel(probe.appearance, probe.serial); break;
        case PUBLIC_PROBE: probe.reply.denied = public_probe(&probe); break;
        case DUPLICATE:
            CHECK(signal(SIGTERM, SIG_IGN) != SIG_ERR);
            wl_registry_bind(probe.registry, probe.name, &polly_appearance_v1_interface, 7); break;
        }
        int roundtrip = wl_display_roundtrip(probe.display);
        if (command == FORBIDDEN || command == DUPLICATE) {
            probe.reply.denied = roundtrip < 0 && wl_display_get_error(probe.display) == EPROTO;
            CHECK(send(fd, &probe.reply, sizeof(probe.reply), MSG_NOSIGNAL) == sizeof(probe.reply));
            return probe.reply.denied;
        }
        CHECK(roundtrip >= 0);
        CHECK(send(fd, &probe.reply, sizeof(probe.reply), MSG_NOSIGNAL) == sizeof(probe.reply));
    }
    polly_appearance_v1_destroy(probe.appearance); wl_registry_destroy(probe.registry);
    wl_display_disconnect(probe.display);
    return true;
}
static bool receive(int fd, struct Reply *reply)
{
    for (int i = 0; i < 800; i++) {
        ssize_t count = recv(fd, reply, sizeof(*reply), MSG_DONTWAIT);
        if (count == sizeof(*reply)) return true;
        CHECK(count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
        wl_display_flush_clients(desktop.display);
        CHECK(wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 5) >= 0);
    }
    CHECK(false);
}
static bool command(int fd, enum Command command, struct Reply *reply)
{
    CHECK(send(fd, &command, sizeof(command), MSG_NOSIGNAL) == sizeof(command));
    return receive(fd, reply);
}
static int start(const char *self, bool renderer, const char *version, struct Reply *reply)
{
    int sockets[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sockets)) return -1;
    int inherited = fcntl(sockets[1], F_DUPFD, 4);
    close(sockets[1]);
    if (inherited < 0) { close(sockets[0]); return -1; }
    char number[32]; snprintf(number, sizeof(number), "%d", inherited);
    char *args[] = {(char *)self, "--probe", number, (char *)version, NULL};
    bool started = renderer ? pu_decorator_spawn(&desktop, args) : pu_desktop_spawn_shell(&desktop, args);
    close(inherited);
    if (!started || !receive(sockets[0], reply)) { close(sockets[0]); return -1; }
    return sockets[0];
}
static bool suite(const char *self)
{
    struct Reply r, p;
    int renderer = start(self, true, "7", &r);
    CHECK(renderer >= 0 && r.globals == 3);
    CHECK(command(renderer, ENABLE, &r) && r.accepted && r.bootstrap);
    CHECK(command(renderer, PUBLIC_PROBE, &r) && r.denied);
    CHECK(command(renderer, PREPARE, &r) && r.accepted);
    int publisher = start(self, false, "8", &p);
    CHECK(publisher >= 0 && (p.globals & 4));
    CHECK(command(publisher, PREPARE, &p) && p.accepted);
    CHECK(command(renderer, COMMIT, &r) && !r.accepted);
    CHECK(command(renderer, QUERY, &r) && !r.bootstrap);
    CHECK(command(publisher, CANCEL, &p));
    CHECK(command(renderer, QUERY, &r) && r.bootstrap);
    CHECK(command(renderer, PREPARE, &r) && r.accepted);
    CHECK(command(renderer, COMMIT, &r) && r.accepted && !r.bootstrap);
    pu_decorator_stop(&desktop); close(renderer);
    renderer = start(self, true, "7", &r);
    CHECK(renderer >= 0);
    CHECK(command(renderer, ENABLE, &r) && r.accepted && !r.bootstrap);
    CHECK(command(renderer, PREPARE, &r) && !r.accepted);
    CHECK(command(publisher, PREPARE, &p) && p.accepted);
    CHECK(command(publisher, COMMIT, &p) && p.accepted);
    CHECK(command(renderer, BACKDROP_CAPABILITY, &r) && !r.accepted);
    CHECK(command(publisher, BACKDROP_CAPABILITY, &p) && p.accepted);
    CHECK(command(publisher, SHELL_BACKDROP_CAPABILITY, &p) && p.accepted);
    CHECK(command(publisher, MAP_BACKDROP, &p) && p.accepted);
    CHECK(command(publisher, PREPARE_REGIONAL, &p) && p.accepted);
    CHECK(command(publisher, COMMIT, &p) && !p.accepted);
    CHECK(wl_list_empty(&desktop.scene->backdrops));
    CHECK(command(publisher, CANCEL, &p));
    CHECK(command(publisher, PREPARE_REGIONAL, &p) && p.accepted);
    CHECK(command(publisher, STAGE_REGIONAL, &p) && p.accepted);
    CHECK(command(publisher, COMMIT, &p) && p.accepted);
    struct PuDesktopLayer *dock = wl_container_of(desktop.layers.next, dock, link);
    struct wlr_scene_rect *committed = dock->backdrop;
    CHECK(committed && wl_list_length(&desktop.scene->backdrops) == 1);
    CHECK(command(publisher, PREPARE_REGIONAL, &p) && p.accepted);
    CHECK(command(publisher, STAGE_REGIONAL, &p) && p.accepted);
    desktop.backdrop_epoch++;
    wlr_scene_backdrop_clear(desktop.scene);
    CHECK(command(publisher, COMMIT, &p) && !p.accepted && dock->backdrop == committed);
    CHECK(command(publisher, CANCEL, &p));
    CHECK(command(publisher, PREPARE_REGIONAL, &p) && p.accepted);
    CHECK(command(publisher, STAGE_REGIONAL, &p) && p.accepted);
    CHECK(command(publisher, RECOMMIT_SURFACE, &p));
    CHECK(command(publisher, COMMIT, &p) && !p.accepted);
    CHECK(dock->backdrop == committed);
    CHECK(command(publisher, CANCEL, &p));
    CHECK(wl_list_length(&desktop.scene->backdrops) == 1);
    CHECK(command(publisher, PREPARE_REGIONAL, &p) && p.accepted);
    CHECK(command(publisher, STAGE_REGIONAL, &p) && p.accepted);
    CHECK(command(publisher, UNMAP_SURFACE, &p));
    CHECK(command(publisher, COMMIT, &p) && !p.accepted);
    CHECK(command(publisher, CANCEL, &p));
    CHECK(wl_list_empty(&desktop.scene->backdrops));
    puts("PASS: real Shell-owned mapped wl_surface capability/count staging; privacy epoch and late actual surface commit reject without replacing committed node; unmap cancels samples; unrelated namespace grants no authority");
    CHECK(command(publisher, FORBIDDEN, &p) && p.denied);
    pu_desktop_stop_shell(&desktop); close(publisher);
    CHECK(command(renderer, QUERY, &r) && !r.bootstrap);
    CHECK(command(renderer, DUPLICATE, &r) && r.denied);
    pu_decorator_stop(&desktop); close(renderer);
    renderer = start(self, true, "6", &r);
    CHECK(renderer >= 0 && r.denied);
    pu_decorator_stop(&desktop); close(renderer);
    char *failed[] = {"/bin/false", NULL};
    CHECK(pu_decorator_spawn(&desktop, failed));
    for (int i = 0; i < 1000 && (pu_decorator_pid(&desktop) ||
        pu_decorator_status(&desktop, NULL) != 3); i++) {
        wl_display_flush_clients(desktop.display);
        CHECK(wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 5) >= 0);
    }
    const char *message;
    CHECK(!pu_decorator_pid(&desktop) && pu_decorator_status(&desktop, &message) == 3);
    CHECK(strstr(message, "budget exhausted") && !desktop.failed);
    pu_decorator_stop(&desktop);
    puts("PASS: real private roles, public second connection, bootstrap prepare race/cancel/one-shot/reconnect, publisher override, duplicate role and old v6 rejection");
    puts("PASS: renderer restart budget exhaustion is explicit and does not end the WM session");
    return true;
}
static void legacy_bind(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
    (void)data; (void)version; (void)id;
    wl_client_post_implementation_error(client, "New renderer must not bind an old private interface");
}
static bool legacy_server(const char *ui)
{
    struct wl_display *display = wl_display_create();
    CHECK(display);
    const char *socket = wl_display_add_socket_auto(display);
    CHECK(socket && wl_global_create(display, &polly_appearance_v1_interface, 6, NULL, legacy_bind));
    int errors[2];
    CHECK(!pipe(errors));
    pid_t pid = fork();
    CHECK(pid >= 0);
    if (!pid) {
        close(errors[0]);
        if (dup2(errors[1], STDERR_FILENO) < 0) _exit(126);
        close(errors[1]);
        unsetenv("WAYLAND_SOCKET"); setenv("WAYLAND_DISPLAY", socket, 1);
        execl(ui, ui, "--decorator", "desktop/decorator/main.mjs", (char *)NULL);
        _exit(127);
    }
    close(errors[1]);
    int status = 0;
    bool reaped = false;
    for (int i = 0; i < 1000; i++) {
        wl_display_flush_clients(display);
        CHECK(wl_event_loop_dispatch(wl_display_get_event_loop(display), 5) >= 0);
        pid_t result = waitpid(pid, &status, WNOHANG);
        if (result == pid) { reaped = true; break; }
        CHECK(result == 0 || (result < 0 && errno == EINTR));
    }
    if (!reaped) {
        kill(pid, SIGKILL);
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    }
    char message[2048];
    ssize_t length = read(errors[0], message, sizeof(message) - 1);
    close(errors[0]);
    wl_display_destroy_clients(display); wl_display_destroy(display);
    CHECK(length > 0); message[length] = 0;
    CHECK(reaped && WIFEXITED(status) && WEXITSTATUS(status) == 1);
    CHECK(strstr(message, "appearance v7 is required"));
    puts("PASS: production v6 renderer explicitly rejects a real old-version Wayland server");
    return true;
}
int main(int argc, char **argv)
{
    if (argc == 4 && !strcmp(argv[1], "--probe"))
        return child(atoi(argv[2]), (uint32_t)atoi(argv[3])) ? 0 : 1;
    if (argc != 1 && argc != 2) return 2;
    char runtime[] = "/tmp/polly-decorator-policy-XXXXXX";
    if (!mkdtemp(runtime)) return 1;
    setenv("XDG_RUNTIME_DIR", runtime, 1); setenv("WLR_BACKENDS", "headless", 1);
    setenv("WLR_HEADLESS_OUTPUTS", "1", 1); setenv("WLR_RENDERER", "pixman", 1);
    wlr_log_init(WLR_INFO, NULL);
    bool passed = pu_desktop_init(&desktop, NULL) && pu_desktop_start(&desktop) && suite(argv[0]);
    pu_desktop_finish(&desktop);
    if (passed && argc == 2) passed = legacy_server(argv[1]);
    if (rmdir(runtime)) passed = false;
    return passed ? 0 : 1;
}
