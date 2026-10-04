#include "shortcuts.h"
#include <stdio.h>
#include <string.h>
#include <xkbcommon/xkbcommon-keysyms.h>
#define CHECK(value) do { if (!(value)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #value); return 1; } } while (0)
int main(void)
{
    struct PuShortcutBinding bindings[PU_SHORTCUT_COUNT];
    pu_shortcut_defaults(bindings);
    CHECK(!pu_shortcut_validate(bindings));
    CHECK(pu_shortcut_match(bindings, XKB_KEY_Tab, PU_SHORTCUT_ALT) == PU_SHORTCUT_SWITCH);
    CHECK(pu_shortcut_match(bindings, XKB_KEY_ISO_Left_Tab, PU_SHORTCUT_ALT | PU_SHORTCUT_SHIFT) == PU_SHORTCUT_SWITCH);
    CHECK(pu_shortcut_match(bindings, XKB_KEY_Tab, PU_SHORTCUT_CTRL) == -1);
    bindings[PU_SHORTCUT_CLOSE] = (struct PuShortcutBinding){ PU_SHORTCUT_ALT | PU_SHORTCUT_SHIFT, XKB_KEY_Tab };
    CHECK(pu_shortcut_validate(bindings));
    pu_shortcut_defaults(bindings);
    bindings[PU_SHORTCUT_CLOSE] = (struct PuShortcutBinding){ PU_SHORTCUT_ALT, XKB_KEY_Escape };
    CHECK(pu_shortcut_validate(bindings));
    bindings[PU_SHORTCUT_CLOSE] = (struct PuShortcutBinding){ 0 };
    CHECK(!pu_shortcut_validate(bindings));
    CHECK(pu_shortcut_match(bindings, XKB_KEY_F4, PU_SHORTCUT_ALT) == -1);
    bindings[PU_SHORTCUT_CLOSE] = (struct PuShortcutBinding){ 0, XKB_KEY_a };
    CHECK(pu_shortcut_validate(bindings));
    bindings[PU_SHORTCUT_CLOSE] = (struct PuShortcutBinding){ PU_SHORTCUT_CTRL, XKB_KEY_Shift_L };
    CHECK(pu_shortcut_validate(bindings));
    xkb_keysym_t key;
    CHECK(pu_shortcut_key("A", &key) && key == XKB_KEY_a);
    CHECK(pu_shortcut_key("+", &key) && key == XKB_KEY_plus);
    CHECK(!pu_shortcut_key("not-a-key", &key));
    puts("PASS: shortcut defaults, reverse matching, conflicts, reserved keys and disabling");
    return 0;
}
