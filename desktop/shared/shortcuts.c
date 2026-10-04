#include "shortcuts.h"
#include <string.h>
#include <xkbcommon/xkbcommon-keysyms.h>

const struct PuShortcutSpec pu_shortcut_specs[PU_SHORTCUT_COUNT] = {
    { "switch-window", "Switch windows", "Tab", PU_SHORTCUT_ALT },
    { "close-window", "Close window", "F4", PU_SHORTCUT_ALT },
    { "minimize-window", "Minimize window", "F9", PU_SHORTCUT_ALT },
    { "maximize-window", "Toggle maximize", "F10", PU_SHORTCUT_ALT },
    { "fullscreen-window", "Toggle fullscreen", "F11", PU_SHORTCUT_ALT },
    { "previous-workspace", "Previous workspace", "Left", PU_SHORTCUT_CTRL | PU_SHORTCUT_SUPER },
    { "next-workspace", "Next workspace", "Right", PU_SHORTCUT_CTRL | PU_SHORTCUT_SUPER },
};

void pu_shortcut_defaults(struct PuShortcutBinding *bindings)
{
    for (int i = 0; i < PU_SHORTCUT_COUNT; i++)
        bindings[i] = (struct PuShortcutBinding){ pu_shortcut_specs[i].modifiers,
            xkb_keysym_from_name(pu_shortcut_specs[i].key, XKB_KEYSYM_CASE_INSENSITIVE) };
}

bool pu_shortcut_key(const char *name, xkb_keysym_t *key)
{
    if (!*name) { *key = XKB_KEY_NoSymbol; return true; }
    *key = xkb_keysym_from_name(name, XKB_KEYSYM_CASE_INSENSITIVE);
    if (*key == XKB_KEY_NoSymbol && strlen(name) == 1 && (unsigned char)name[0] >= 32)
        *key = xkb_utf32_to_keysym((unsigned char)name[0]);
    *key = xkb_keysym_to_lower(*key);
    if (*key == XKB_KEY_ISO_Left_Tab) *key = XKB_KEY_Tab;
    return *key != XKB_KEY_NoSymbol;
}

const char *pu_shortcut_validate(const struct PuShortcutBinding *bindings)
{
    for (int i = 0; i < PU_SHORTCUT_COUNT; i++) {
        uint32_t mods = bindings[i].modifiers;
        xkb_keysym_t key = bindings[i].key;
        if (mods & ~15u) return "Unknown shortcut modifier";
        if (!key && !mods) continue;
        if (!key || !(mods & (PU_SHORTCUT_CTRL | PU_SHORTCUT_ALT | PU_SHORTCUT_SUPER)))
            return "A shortcut requires Ctrl, Alt or Super and a non-modifier key";
        if (key >= XKB_KEY_Shift_L && key <= XKB_KEY_Hyper_R) return "A modifier key cannot be the shortcut key";
        if ((mods & PU_SHORTCUT_ALT) && key == XKB_KEY_Escape) return "Alt+Escape is reserved for development-session exit";
        if (i == PU_SHORTCUT_SWITCH && ((mods & PU_SHORTCUT_SHIFT) || key == XKB_KEY_Escape))
            return "The switcher reserves Shift for reverse cycling and Escape for cancellation";
        for (int j = 0; j < i; j++) {
            if (!bindings[j].key || key != bindings[j].key) continue;
            if (mods == bindings[j].modifiers ||
                (j == PU_SHORTCUT_SWITCH && mods == (bindings[j].modifiers | PU_SHORTCUT_SHIFT)))
                return "Two actions use the same shortcut";
        }
    }
    return NULL;
}

int pu_shortcut_match(const struct PuShortcutBinding *bindings, xkb_keysym_t key, uint32_t modifiers)
{
    key = xkb_keysym_to_lower(key);
    if (key == XKB_KEY_ISO_Left_Tab) key = XKB_KEY_Tab;
    for (int i = 0; i < PU_SHORTCUT_COUNT; i++) {
        uint32_t mods = i == PU_SHORTCUT_SWITCH ? modifiers & ~PU_SHORTCUT_SHIFT : modifiers;
        if (bindings[i].key && key == bindings[i].key && mods == bindings[i].modifiers) return i;
    }
    return -1;
}
