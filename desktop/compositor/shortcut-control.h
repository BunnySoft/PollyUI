#ifndef POLLYWM_SHORTCUT_CONTROL_H
#define POLLYWM_SHORTCUT_CONTROL_H
#include "shortcuts.h"
struct PuDesktop;
struct PuDesktopView;
struct wlr_keyboard;
bool pu_shortcuts_init(struct PuDesktop *desktop);
void pu_shortcuts_finish(struct PuDesktop *desktop);
bool pu_shortcuts_key(struct PuDesktop *desktop, struct wlr_keyboard *keyboard, xkb_keysym_t key);
void pu_shortcuts_modifiers(struct PuDesktop *desktop, struct wlr_keyboard *keyboard);
void pu_shortcuts_cancel(struct PuDesktop *desktop);
void pu_shortcuts_unmap(struct PuDesktopView *view);
void pu_shortcuts_metadata(struct PuDesktopView *view);
void pu_shortcuts_keyboard_removed(struct PuDesktop *desktop, struct wlr_keyboard *keyboard);
bool pu_shortcuts_switching(struct PuDesktop *desktop);
void pu_desktop_shortcut_action(struct PuDesktop *desktop, int action, bool reverse);
void pu_desktop_focus_mapped(struct PuDesktop *desktop, uint64_t id);
#endif
