#ifndef POLLY_PRIVATE_PROCESS_H
#define POLLY_PRIVATE_PROCESS_H
#include <stdbool.h>
#include <sys/types.h>
#include <wayland-server-core.h>
struct PuDesktop;
bool pu_spawn_private(struct PuDesktop *desktop, char *const argv[], const char *label,
    struct wl_client **client, pid_t *pid, struct wl_listener *destroy);
#endif
