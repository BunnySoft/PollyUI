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
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>

enum Command { QUERY, ENABLE, PREPARE, COMMIT, CANCEL, PUBLIC_PROBE, DUPLICATE, FORBIDDEN,
    MAP_BACKDROP, PREPARE_REGIONAL, STAGE_REGIONAL, RECOMMIT_SURFACE, UNMAP_SURFACE, BACKDROP_CAPABILITY,
    SHELL_BACKDROP_CAPABILITY,
    DOCK_HEIGHT_512, DOCK_HEIGHT_513, DOCK_HEIGHT_640, DOCK_HEIGHT_660, DOCK_HEIGHT_64,
    START_BACKDROP_CAPABILITY, MAP_PAIR, PAIR_HEIGHT_512, PAIR_HEIGHT_513, PAIR_HEIGHT_640, PAIR_HEIGHT_660,
    PAIR_HEIGHT_769, PREPARE_PAIR, STAGE_PANEL, STAGE_START, STAGE_STANDARD, NEW_PANEL_ROLE,
    V8_STANDARD_SCHEMA, V9_OLD_SCHEMA, RECOMMIT_PANEL, RECOMMIT_START, UNMAP_PANEL, COMMIT_OLD,
    PREPARE_EIGHT, PREPARE_NINE };
struct Reply { uint32_t state, bootstrap, accepted, serial, globals; bool denied; };
struct PairSurface {
    struct wl_surface *surface;
    struct zwlr_layer_surface_v1 *layer;
    struct wl_buffer *buffer;
    uint32_t width, height;
    bool configured;
};
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
    struct PairSurface panel, start;
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
    .start_backdrop_capability = capability,
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
static bool resize_backdrop(struct Probe *probe, int height)
{
    probe->configured = false;
    zwlr_layer_surface_v1_set_size(probe->layer, 96, height);
    zwlr_layer_surface_v1_set_exclusive_zone(probe->layer, height);
    wl_surface_commit(probe->surface);
    CHECK(wl_display_roundtrip(probe->display) >= 0 && probe->configured);
    int fd = memfd_create("polly-backdrop-policy", MFD_CLOEXEC);
    CHECK(fd >= 0 && !ftruncate(fd, 96 * height * 4));
    struct wl_shm_pool *pool = wl_shm_create_pool(probe->shm, fd, 96 * height * 4);
    close(fd);
    CHECK(pool);
    if (probe->buffer) wl_buffer_destroy(probe->buffer);
    probe->buffer = wl_shm_pool_create_buffer(pool, 0, 96, height, 96 * 4, WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool);
    CHECK(probe->buffer);
    wl_surface_attach(probe->surface, probe->buffer, 0, 0);
    wl_surface_damage(probe->surface, 0, 0, 96, height);
    wl_surface_commit(probe->surface);
    return true;
}
static bool map_backdrop(struct Probe *probe)
{
    CHECK(probe->compositor && probe->shm && probe->layer_shell);
    probe->surface = wl_compositor_create_surface(probe->compositor);
    probe->layer = zwlr_layer_shell_v1_get_layer_surface(probe->layer_shell, probe->surface,
        NULL, ZWLR_LAYER_SHELL_V1_LAYER_TOP, "not-an-authorization-token");
    CHECK(probe->surface && probe->layer);
    zwlr_layer_surface_v1_add_listener(probe->layer, &layer_listener, probe);
    zwlr_layer_surface_v1_set_anchor(probe->layer, ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM);
    return resize_backdrop(probe, 64);
}
static void pair_configured(void *data, struct zwlr_layer_surface_v1 *layer,
    uint32_t serial, uint32_t width, uint32_t height)
{
    struct PairSurface *surface = data;
    zwlr_layer_surface_v1_ack_configure(layer, serial);
    surface->width = width; surface->height = height; surface->configured = true;
}
static const struct zwlr_layer_surface_v1_listener pair_listener = {
    .configure = pair_configured, .closed = layer_closed,
};
static bool resize_pair_surface(struct Probe *probe, struct PairSurface *surface, bool panel, uint32_t height)
{
    surface->configured = false;
    zwlr_layer_surface_v1_set_size(surface->layer, panel ? 0 : 640, height);
    zwlr_layer_surface_v1_set_exclusive_zone(surface->layer, panel ? (int32_t)height : -1);
    wl_surface_commit(surface->surface);
    CHECK(wl_display_roundtrip(probe->display) >= 0 && surface->configured);
    size_t bytes = (size_t)surface->width * surface->height * 4;
    int fd = memfd_create("polly-paired-policy", MFD_CLOEXEC);
    CHECK(fd >= 0 && !ftruncate(fd, (off_t)bytes));
    struct wl_shm_pool *pool = wl_shm_create_pool(probe->shm, fd, (int32_t)bytes);
    close(fd);
    CHECK(pool);
    if (surface->buffer) wl_buffer_destroy(surface->buffer);
    surface->buffer = wl_shm_pool_create_buffer(pool, 0, surface->width, surface->height,
        surface->width * 4, WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool);
    CHECK(surface->buffer);
    wl_surface_attach(surface->surface, surface->buffer, 0, 0);
    wl_surface_damage(surface->surface, 0, 0, surface->width, surface->height);
    wl_surface_commit(surface->surface);
    return true;
}
static bool map_pair(struct Probe *probe)
{
    struct PairSurface *surfaces[] = {&probe->panel, &probe->start};
    for (unsigned i = 0; i < 2; i++) {
        struct PairSurface *surface = surfaces[i];
        surface->surface = wl_compositor_create_surface(probe->compositor);
        surface->layer = zwlr_layer_shell_v1_get_layer_surface(probe->layer_shell, surface->surface,
            NULL, i ? ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY : ZWLR_LAYER_SHELL_V1_LAYER_TOP, "raw-paired-policy");
        CHECK(surface->surface && surface->layer);
        zwlr_layer_surface_v1_add_listener(surface->layer, &pair_listener, surface);
        zwlr_layer_surface_v1_set_anchor(surface->layer, ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM |
            (i ? 0 : ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT | ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT));
        zwlr_layer_surface_v1_set_keyboard_interactivity(surface->layer,
            i ? ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE :
                ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE);
        if (i) zwlr_layer_surface_v1_set_margin(surface->layer, 0, 0, 48, 0);
        CHECK(resize_pair_surface(probe, surface, !i, i ? 512 : 48));
    }
    return true;
}
static void stage_pair(struct Probe *probe, enum Command command)
{
    bool panel = command == STAGE_PANEL || command == NEW_PANEL_ROLE;
    bool standard = command == STAGE_STANDARD || command == NEW_PANEL_ROLE || command == V9_OLD_SCHEMA;
    uint32_t words[] = {standard || command == V8_STANDARD_SCHEMA ? 4 : 3, panel ? 2 : 3,
        0, 16, 0xf3f3f3, 72};
    if (command == V9_OLD_SCHEMA) words[0] = 3;
    struct wl_array material = {.size = sizeof(words), .data = words};
    struct wl_surface *surface = panel ? probe->panel.surface : probe->start.surface;
    if (standard)
        polly_appearance_v1_prepare_start_backdrop(probe->appearance, probe->serial, surface,
            probe->panel.surface, &material);
    else polly_appearance_v1_prepare_shell_backdrop(probe->appearance, probe->serial, surface,
        probe->panel.surface, &material);
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
        case PREPARE_PAIR: CHECK(prepare(&probe, 2)); break;
        case PREPARE_EIGHT: CHECK(prepare(&probe, 8)); break;
        case PREPARE_NINE: CHECK(prepare(&probe, 9)); break;
        case MAP_BACKDROP: CHECK(map_backdrop(&probe)); probe.reply.accepted = 1; break;
        case DOCK_HEIGHT_512: CHECK(resize_backdrop(&probe, 512)); break;
        case DOCK_HEIGHT_513: CHECK(resize_backdrop(&probe, 513)); break;
        case DOCK_HEIGHT_640: CHECK(resize_backdrop(&probe, 640)); break;
        case DOCK_HEIGHT_660: CHECK(resize_backdrop(&probe, 660)); break;
        case DOCK_HEIGHT_64: CHECK(resize_backdrop(&probe, 64)); break;
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
        case START_BACKDROP_CAPABILITY: polly_appearance_v1_get_start_backdrop_capability(probe.appearance); break;
        case MAP_PAIR: CHECK(map_pair(&probe)); probe.reply.accepted = 1; break;
        case PAIR_HEIGHT_512: CHECK(resize_pair_surface(&probe, &probe.start, false, 512)); break;
        case PAIR_HEIGHT_513: CHECK(resize_pair_surface(&probe, &probe.start, false, 513)); break;
        case PAIR_HEIGHT_640: CHECK(resize_pair_surface(&probe, &probe.start, false, 640)); break;
        case PAIR_HEIGHT_660: CHECK(resize_pair_surface(&probe, &probe.start, false, 660)); break;
        case PAIR_HEIGHT_769: CHECK(resize_pair_surface(&probe, &probe.start, false, 769)); break;
        case STAGE_PANEL: case STAGE_START: case STAGE_STANDARD: case NEW_PANEL_ROLE:
        case V8_STANDARD_SCHEMA: case V9_OLD_SCHEMA: stage_pair(&probe, command); break;
        case RECOMMIT_PANEL: wl_surface_commit(probe.panel.surface); break;
        case RECOMMIT_START: wl_surface_commit(probe.start.surface); break;
        case UNMAP_PANEL:
            wl_surface_attach(probe.panel.surface, NULL, 0, 0); wl_surface_commit(probe.panel.surface); break;
        case COMMIT_OLD: polly_appearance_v1_commit(probe.appearance, probe.serial - 1); break;
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
static bool paired_policy(const char *self, int publisher, struct Reply *p)
{
    CHECK(command(publisher, MAP_PAIR, p) && p->accepted);
    const enum Command sizes[] = {PAIR_HEIGHT_512, PAIR_HEIGHT_513, PAIR_HEIGHT_640, PAIR_HEIGHT_660};
    for (unsigned i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
        CHECK(command(publisher, sizes[i], p));
        CHECK(command(publisher, PREPARE_PAIR, p) && p->accepted);
        CHECK(command(publisher, STAGE_PANEL, p) && p->accepted);
        CHECK(command(publisher, STAGE_START, p) && p->accepted == (i == 0));
        CHECK(wl_list_length(&desktop.scene->backdrops) == (i == 0 ? 2 : 1));
        CHECK(command(publisher, CANCEL, p));
        CHECK(wl_list_empty(&desktop.scene->backdrops));
    }
    puts("PASS: actual bound-v8/schema3/role3 raw request accepts512 and rejects513/640/660; original taskbar authority and 512 boundary unchanged");
    CHECK(command(publisher, FORBIDDEN, p) && p->denied);
    pu_desktop_stop_shell(&desktop); close(publisher);
    publisher = start(self, false, "9", p);
    CHECK(publisher >= 0);
    CHECK(command(publisher, START_BACKDROP_CAPABILITY, p) && p->accepted);
    CHECK(command(publisher, MAP_PAIR, p) && p->accepted);
    for (unsigned i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
        CHECK(command(publisher, sizes[i], p));
        CHECK(command(publisher, PREPARE_PAIR, p) && p->accepted);
        CHECK(command(publisher, STAGE_PANEL, p) && p->accepted);
        CHECK(command(publisher, STAGE_STANDARD, p) && p->accepted);
        CHECK(wl_list_length(&desktop.scene->backdrops) == 2);
        CHECK(command(publisher, CANCEL, p));
        CHECK(wl_list_empty(&desktop.scene->backdrops));
    }
    CHECK(command(publisher, PAIR_HEIGHT_769, p));
    CHECK(command(publisher, PREPARE_PAIR, p) && p->accepted);
    CHECK(command(publisher, STAGE_STANDARD, p) && !p->accepted);
    CHECK(command(publisher, CANCEL, p));
    CHECK(command(publisher, PAIR_HEIGHT_660, p));
    const enum Command invalid[] = {NEW_PANEL_ROLE, V8_STANDARD_SCHEMA, V9_OLD_SCHEMA};
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        CHECK(command(publisher, PREPARE_PAIR, p) && p->accepted);
        CHECK(command(publisher, invalid[i], p) && !p->accepted);
        CHECK(command(publisher, CANCEL, p));
        CHECK(wl_list_empty(&desktop.scene->backdrops));
    }
    CHECK(command(publisher, PREPARE_NINE, p) && !p->accepted);
    CHECK(wl_list_empty(&desktop.scene->backdrops));
    CHECK(command(publisher, PREPARE_EIGHT, p) && p->accepted);
    CHECK(command(publisher, STAGE_PANEL, p) && p->accepted);
    CHECK(command(publisher, STAGE_STANDARD, p) && p->accepted);
    CHECK(command(publisher, COMMIT, p) && !p->accepted);
    CHECK(command(publisher, CANCEL, p));
    CHECK(command(publisher, PREPARE_REGIONAL, p) && p->accepted);
    CHECK(command(publisher, STAGE_STANDARD, p) && p->accepted);
    CHECK(command(publisher, COMMIT, p) && !p->accepted);
    CHECK(command(publisher, CANCEL, p));
    CHECK(command(publisher, PREPARE_PAIR, p) && p->accepted);
    CHECK(command(publisher, STAGE_STANDARD, p) && p->accepted);
    CHECK(command(publisher, COMMIT, p) && !p->accepted);
    CHECK(command(publisher, STAGE_STANDARD, p) && !p->accepted);
    CHECK(command(publisher, CANCEL, p));
    CHECK(command(publisher, PREPARE_PAIR, p) && p->accepted);
    CHECK(command(publisher, STAGE_PANEL, p) && p->accepted);
    CHECK(command(publisher, STAGE_STANDARD, p) && p->accepted);
    CHECK(command(publisher, COMMIT, p) && p->accepted);
    struct PuDesktopLayer *layer;
    struct wlr_scene_rect *committed[2] = {0};
    unsigned count = 0;
    wl_list_for_each(layer, &desktop.layers, link) if (layer->backdrop) {
        CHECK(count < 2); committed[count++] = layer->backdrop;
    }
    CHECK(count == 2);
    const enum Command obsolete[] = {RECOMMIT_START, RECOMMIT_PANEL, QUERY, COMMIT_OLD};
    for (unsigned i = 0; i < sizeof(obsolete) / sizeof(obsolete[0]); i++) {
        CHECK(command(publisher, PREPARE_PAIR, p) && p->accepted);
        CHECK(command(publisher, STAGE_PANEL, p) && p->accepted);
        CHECK(command(publisher, STAGE_STANDARD, p) && p->accepted);
        if (obsolete[i] == QUERY) { desktop.backdrop_epoch++; wlr_scene_backdrop_clear(desktop.scene); }
        CHECK(command(publisher, obsolete[i], p));
        if (obsolete[i] != COMMIT_OLD) CHECK(command(publisher, COMMIT, p) && !p->accepted);
        else CHECK(!p->accepted);
        CHECK(command(publisher, CANCEL, p));
        count = 0;
        wl_list_for_each(layer, &desktop.layers, link) if (layer->backdrop) {
            CHECK(count < 2 && layer->backdrop == committed[count]); count++;
        }
        CHECK(count == 2 && wl_list_length(&desktop.scene->backdrops) == 2);
    }
    CHECK(command(publisher, PREPARE_PAIR, p) && p->accepted);
    CHECK(command(publisher, STAGE_PANEL, p) && p->accepted);
    CHECK(command(publisher, STAGE_STANDARD, p) && p->accepted);
    CHECK(command(publisher, UNMAP_PANEL, p));
    CHECK(command(publisher, COMMIT, p) && !p->accepted);
    CHECK(command(publisher, CANCEL, p));
    CHECK(wl_list_empty(&desktop.scene->backdrops));
    pu_desktop_stop_shell(&desktop); close(publisher);
    puts("PASS: raw v9 standard Start accepts full640/660 only through schema4/role3; wrong request/schema/role, duplicate, missing pair, old serial, both surface sequences, privacy epoch and unpair reject without changing committed nodes");
    return true;
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
    const enum Command sizes[] = {DOCK_HEIGHT_512, DOCK_HEIGHT_513, DOCK_HEIGHT_640, DOCK_HEIGHT_660};
    for (unsigned i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
        CHECK(command(publisher, sizes[i], &p));
        CHECK(command(publisher, PREPARE_REGIONAL, &p) && p.accepted);
        CHECK(command(publisher, STAGE_REGIONAL, &p) && p.accepted == (i == 0));
        CHECK(wl_list_length(&desktop.scene->backdrops) == (i == 0 ? 1 : 0));
        CHECK(command(publisher, CANCEL, &p));
        CHECK(wl_list_empty(&desktop.scene->backdrops));
    }
    CHECK(command(publisher, DOCK_HEIGHT_64, &p));
    puts("PASS: raw v7/schema2/role1 Dock accepts height512 but rejects 513/640/660 despite effects4 generic extent; failed staging creates no cache or authority");
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
    struct wlr_output_layout_output *output;
    wl_list_for_each(output, &desktop.layout->outputs, link) {
        struct wlr_output_state state;
        wlr_output_state_init(&state);
        wlr_output_state_set_custom_mode(&state, 1280, 1000, 60000);
        bool committed = wlr_output_commit_state(output->output, &state);
        wlr_output_state_finish(&state);
        CHECK(committed);
    }
    CHECK(paired_policy(self, publisher, &p));
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
