#ifndef POLLYWM_DECORATOR_PROCESS_H
#define POLLYWM_DECORATOR_PROCESS_H
#include <stdbool.h>
#include <stdint.h>
#include <sys/types.h>
struct PuDesktop;
struct wl_client;
bool pu_decorator_spawn(struct PuDesktop *desktop, char *const argv[]);
bool pu_decorator_allowed(const struct PuDesktop *desktop, const struct wl_client *client);
bool pu_decorator_configured(const struct PuDesktop *desktop);
uint32_t pu_decorator_status(const struct PuDesktop *desktop, const char **message);
pid_t pu_decorator_pid(const struct PuDesktop *desktop);
void pu_decorator_ready(struct PuDesktop *desktop);
void pu_decorator_fail(struct PuDesktop *desktop, const char *message);
void pu_decorator_stop(struct PuDesktop *desktop);
#endif
