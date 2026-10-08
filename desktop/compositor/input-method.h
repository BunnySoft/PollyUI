#ifndef POLLY_INPUT_METHOD_H
#define POLLY_INPUT_METHOD_H
#include <stdbool.h>
#include <stdint.h>
struct PuDesktop;
struct wl_client;
struct wlr_keyboard;
struct wlr_keyboard_key_event;
bool pu_input_method_init(struct PuDesktop *desktop);
void pu_input_method_finish(struct PuDesktop *desktop);
bool pu_input_method_spawn(struct PuDesktop *desktop, char *const argv[]);
void pu_input_method_stop(struct PuDesktop *desktop);
bool pu_input_method_allowed(const struct PuDesktop *desktop, const struct wl_client *client);
bool pu_input_method_key(struct PuDesktop *desktop, struct wlr_keyboard *keyboard,
    const struct wlr_keyboard_key_event *event);
void pu_input_method_modifiers(struct PuDesktop *desktop, struct wlr_keyboard *keyboard);
uint32_t pu_input_method_epoch(struct PuDesktop *desktop);
void pu_input_method_reposition(struct PuDesktop *desktop);
bool pu_input_method_ready(struct PuDesktop *desktop);
bool pu_input_method_active(struct PuDesktop *desktop);
bool pu_desktop_request_logout(struct PuDesktop *desktop);
#endif
