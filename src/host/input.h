#ifndef POLLYUI_HOST_INPUT_H
#define POLLYUI_HOST_INPUT_H
#include <stddef.h>

enum PuModifiers {
    PU_MOD_SHIFT = 1u << 0,
    PU_MOD_CTRL = 1u << 1,
    PU_MOD_ALT = 1u << 2,
    PU_MOD_META = 1u << 3,
    PU_MOD_CAPS = 1u << 4,
    PU_MOD_NUM = 1u << 5,
};

enum PuInputResult {
    PU_INPUT_REDRAW = 1,
    PU_INPUT_PREVENT_DEFAULT = 2,
};

typedef enum PuKeyType { PU_KEY_DOWN, PU_KEY_UP, PU_KEY_TEXT } PuKeyType;

/* String pointers are borrowed for the duration of the synchronous callback.
 * TEXT contains committed UTF-8, not key names or an IME preedit string. */
typedef struct PuKeyEvent {
    PuKeyType type;
    const char *key;
    const char *code;
    const char *text;
    unsigned modifiers;
    int repeat;
} PuKeyEvent;

typedef enum PuPointerType {
    PU_POINTER_CLICK, PU_POINTER_DOWN, PU_POINTER_UP, PU_POINTER_MOVE,
    PU_POINTER_CONTEXT_MENU, PU_POINTER_AUXCLICK
} PuPointerType;

typedef struct PuPointerEvent {
    PuPointerType type;
    float x, y;
    int button;          /* DOM order: left=0, middle=1, right=2; -1 for motion */
    unsigned buttons;    /* left=1, right=2, middle=4, back=8, forward=16 */
    unsigned modifiers;
} PuPointerEvent;

typedef struct PuWheelEvent {
    float x, y;
    float delta_x, delta_y; /* logical pixels, positive right/down */
    unsigned modifiers;
} PuWheelEvent;

typedef enum PuDropType { PU_DROP_ENTER, PU_DROP_MOTION, PU_DROP_DATA, PU_DROP_LEAVE, PU_DROP_ERROR } PuDropType;
/* All strings and file entries are borrowed until the callback returns. */
typedef struct PuDropEvent {
    PuDropType type;
    float x, y;
    const char *text, *source, *error;
    const char *const *files;
    size_t file_count;
} PuDropEvent;

static inline const char *pu_pointer_name(PuPointerType type)
{
    switch (type) {
    case PU_POINTER_CLICK: return "click";
    case PU_POINTER_DOWN: return "mousedown";
    case PU_POINTER_UP: return "mouseup";
    case PU_POINTER_MOVE: return "mousemove";
    case PU_POINTER_CONTEXT_MENU: return "contextmenu";
    case PU_POINTER_AUXCLICK: return "auxclick";
    }
    return "unknown";
}

static inline unsigned pu_button_mask(int button)
{
    static const unsigned masks[] = { 1, 4, 2, 8, 16 };
    return button >= 0 && button < 5 ? masks[button] : 0;
}

#endif
