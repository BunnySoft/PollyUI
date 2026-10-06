#ifndef POLLY_SESSION_LOCK_H
#define POLLY_SESSION_LOCK_H
#include <stdbool.h>
#include <stdint.h>
#include <sys/types.h>
struct PuDesktop;
struct wl_client;
struct wlr_output;
struct wlr_surface;
bool pu_session_lock_init(struct PuDesktop *desktop);
void pu_session_lock_finish(struct PuDesktop *desktop);
bool pu_session_lock_spawn(struct PuDesktop *desktop, char *const argv[]);
bool pu_session_lock_active(struct PuDesktop *desktop);
pid_t pu_session_lock_pid(struct PuDesktop *desktop);
bool pu_session_lock_client_succeeded(struct PuDesktop *desktop);
bool pu_session_lock_allowed(const struct PuDesktop *desktop, const struct wl_client *client);
bool pu_session_lock_output(struct PuDesktop *desktop, struct wlr_output *output);
void pu_session_lock_arrange(struct PuDesktop *desktop);
void pu_session_lock_prepare_frame(struct PuDesktop *desktop, struct wlr_output *output);
void pu_session_lock_focus(struct PuDesktop *desktop);
void pu_session_lock_motion(struct PuDesktop *desktop, uint32_t time);
bool pu_session_lock_surface(struct PuDesktop *desktop, struct wlr_surface *surface);
void pu_desktop_isolate_input(struct PuDesktop *desktop);
void pu_desktop_restore_input(struct PuDesktop *desktop);
#endif
