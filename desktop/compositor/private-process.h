#ifndef POLLY_PRIVATE_PROCESS_H
#define POLLY_PRIVATE_PROCESS_H
#include <stdbool.h>
#include <stdint.h>
#include <sys/types.h>
#include <wayland-server-core.h>
struct PuDesktop;
enum PuPrivateProcess {
    PU_PRIVATE_SHELL,
    PU_PRIVATE_DECORATOR,
    PU_PRIVATE_INPUT_METHOD,
    PU_PRIVATE_SESSION_LOCK,
    PU_PRIVATE_PROCESS_COUNT,
};
struct PuPrivateProcessWatch {
    void (*check)(struct PuDesktop *desktop);
    uint64_t generation;
};
bool pu_private_process_watch(struct PuDesktop *desktop, enum PuPrivateProcess owner,
    void (*check)(struct PuDesktop *desktop));
void pu_private_process_unwatch(struct PuDesktop *desktop, enum PuPrivateProcess owner);
bool pu_spawn_private(struct PuDesktop *desktop, char *const argv[], const char *label,
    struct wl_client **client, pid_t *pid, struct wl_listener *destroy);
#endif
