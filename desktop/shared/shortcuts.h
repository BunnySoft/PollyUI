#ifndef POLLY_SHORTCUTS_H
#define POLLY_SHORTCUTS_H
#include <stdbool.h>
#include <stdint.h>
#include <xkbcommon/xkbcommon.h>
#define PU_SHORTCUT_MAX_WINDOWS 10000u

enum PuShortcutAction {
    PU_SHORTCUT_SWITCH, PU_SHORTCUT_CLOSE, PU_SHORTCUT_MINIMIZE,
    PU_SHORTCUT_MAXIMIZE, PU_SHORTCUT_FULLSCREEN,
    PU_SHORTCUT_WORKSPACE_PREVIOUS, PU_SHORTCUT_WORKSPACE_NEXT, PU_SHORTCUT_COUNT,
};
enum PuShortcutModifier {
    PU_SHORTCUT_SHIFT = 1, PU_SHORTCUT_CTRL = 2, PU_SHORTCUT_ALT = 4, PU_SHORTCUT_SUPER = 8,
};
struct PuShortcutBinding { uint32_t modifiers; xkb_keysym_t key; };
struct PuShortcutSpec { const char *id, *label, *key; uint32_t modifiers; };
extern const struct PuShortcutSpec pu_shortcut_specs[PU_SHORTCUT_COUNT];
void pu_shortcut_defaults(struct PuShortcutBinding *bindings);
bool pu_shortcut_key(const char *name, xkb_keysym_t *key);
const char *pu_shortcut_validate(const struct PuShortcutBinding *bindings);
int pu_shortcut_match(const struct PuShortcutBinding *bindings, xkb_keysym_t key, uint32_t modifiers);
#endif
