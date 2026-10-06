#define _GNU_SOURCE
#include "session-lock-client.h"
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>

static struct ext_session_lock_manager_v1 *manager;
static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct wl_output *outputs[8];
static unsigned output_count, configured;
struct Surface { struct wl_surface *surface; struct ext_session_lock_surface_v1 *lock; bool configured; };
static struct Surface surfaces[8];
static bool locked, finished;
static void global(void *data, struct wl_registry *registry, uint32_t id, const char *name, uint32_t version)
{
    (void)data; (void)version;
    if (!strcmp(name, "ext_session_lock_manager_v1"))
        manager = wl_registry_bind(registry, id, &ext_session_lock_manager_v1_interface, 1);
    else if (!strcmp(name, "wl_compositor")) compositor = wl_registry_bind(registry, id, &wl_compositor_interface, 4);
    else if (!strcmp(name, "wl_shm")) shm = wl_registry_bind(registry, id, &wl_shm_interface, 1);
    else if (!strcmp(name, "wl_output") && output_count < 8)
        outputs[output_count++] = wl_registry_bind(registry, id, &wl_output_interface, 1);
}
static void removed(void *data, struct wl_registry *registry, uint32_t id)
{ (void)data; (void)registry; (void)id; }
static const struct wl_registry_listener registry_listener = {.global = global, .global_remove = removed};
static void on_locked(void *data, struct ext_session_lock_v1 *lock) { (void)data; (void)lock; locked = true; }
static void on_finished(void *data, struct ext_session_lock_v1 *lock) { (void)data; (void)lock; finished = true; }
static const struct ext_session_lock_v1_listener listener = {.locked = on_locked, .finished = on_finished};
static void configure(void *data, struct ext_session_lock_surface_v1 *lock, uint32_t serial, uint32_t width, uint32_t height)
{
    struct Surface *surface = data;
    if (!width || !height || width > 4096 || height > 4096) exit(1);
    size_t length = (size_t)width * height * 4;
    int fd = memfd_create("lock-test-buffer", MFD_CLOEXEC);
    if (fd < 0 || ftruncate(fd, (off_t)length)) exit(1);
    uint32_t *pixels = mmap(NULL, length, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (pixels == MAP_FAILED) exit(1);
    for (size_t i = 0; i < length / 4; i++) pixels[i] = 0xff123456;
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, (int32_t)length);
    struct wl_buffer *buffer = wl_shm_pool_create_buffer(pool, 0, (int32_t)width, (int32_t)height,
        (int32_t)width * 4, WL_SHM_FORMAT_ARGB8888);
    ext_session_lock_surface_v1_ack_configure(lock, serial);
    wl_surface_attach(surface->surface, buffer, 0, 0);
    wl_surface_damage_buffer(surface->surface, 0, 0, (int32_t)width, (int32_t)height);
    wl_surface_commit(surface->surface);
    wl_buffer_destroy(buffer); wl_shm_pool_destroy(pool); munmap(pixels, length); close(fd);
    if (!surface->configured) { surface->configured = true; configured++; }
}
static const struct ext_session_lock_surface_v1_listener surface_listener = {.configure = configure};
int main(int argc, char **argv)
{
    if (argc != 2) return 2;
    struct wl_display *display = wl_display_connect(NULL);
    if (!display) return 1;
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    if (wl_display_roundtrip(display) < 0) return 1;
    if (!strcmp(argv[1], "public")) {
        bool denied = manager == NULL;
        if (manager) ext_session_lock_manager_v1_destroy(manager);
        for (unsigned i = 0; i < output_count; i++) wl_output_destroy(outputs[i]);
        if (compositor) wl_compositor_destroy(compositor);
        if (shm) wl_shm_destroy(shm);
        wl_registry_destroy(registry); wl_display_disconnect(display);
        return denied ? 0 : 1;
    }
    if (!manager || !compositor || !shm || !output_count) return 1;
    struct ext_session_lock_v1 *lock = ext_session_lock_manager_v1_lock(manager);
    ext_session_lock_v1_add_listener(lock, &listener, NULL);
    for (unsigned i = 0; i < output_count; i++) {
        surfaces[i].surface = wl_compositor_create_surface(compositor);
        surfaces[i].lock = ext_session_lock_v1_get_lock_surface(lock, surfaces[i].surface, outputs[i]);
        ext_session_lock_surface_v1_add_listener(surfaces[i].lock, &surface_listener, &surfaces[i]);
    }
    while ((!locked || configured != output_count) && !finished) if (wl_display_dispatch(display) < 0) return 1;
    if (!locked) return 1;
    if (!strcmp(argv[1], "crash")) { raise(SIGKILL); return 1; }
    if (strcmp(argv[1], "unlock")) return 2;
    struct timespec delay = {.tv_nsec = 100000000};
    nanosleep(&delay, NULL);
    ext_session_lock_v1_unlock_and_destroy(lock);
    if (wl_display_roundtrip(display) < 0) return 1;
    ext_session_lock_manager_v1_destroy(manager);
    for (unsigned i = 0; i < output_count; i++) {
        ext_session_lock_surface_v1_destroy(surfaces[i].lock);
        wl_surface_destroy(surfaces[i].surface); wl_output_destroy(outputs[i]);
    }
    wl_shm_destroy(shm); wl_compositor_destroy(compositor);
    wl_registry_destroy(registry);
    wl_display_disconnect(display);
    return 0;
}
