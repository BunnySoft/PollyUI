#include "host/win32/window.h"
#include <SDL3/SDL.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

static PuWindow *window;
static SDL_WindowID window_id;
static int received, pointers, wheels, failed, ticks;
static int preedits, cancellations;
static int drop_enters, drop_motions, drops, drop_leaves, drop_errors;
static char *large_drop;
static const char committed[] = "\xe4\xb8\xad\xe6\x96\x87\xf0\x9f\x98\x80";

static void check(int valid, const char *description)
{
    if (!valid) { fprintf(stderr, "FAIL: %s\n", description); failed = 1; }
}

static int on_key(const PuKeyEvent *event, void *user)
{
    (void)user;
    if (event->type == PU_KEY_PREEDIT) {
        if (event->text && *event->text) {
            preedits++;
            check(event->start == 2 && event->length == 1, "preedit character offsets become UTF-16 offsets");
        } else cancellations++;
        return PU_INPUT_REDRAW;
    }
    switch (received++) {
    case 0:
        check(event->type == PU_KEY_DOWN && strcmp(event->code, "KeyA") == 0 &&
              strcmp(event->key, "A") == 0, "SDL physical key/code");
        check(event->modifiers == (PU_MOD_CTRL | PU_MOD_SHIFT) && event->repeat, "SDL modifiers/repeat");
        return PU_INPUT_REDRAW | PU_INPUT_PREVENT_DEFAULT;
    case 1:
        check(event->type == PU_KEY_UP && strcmp(event->code, "KeyA") == 0, "suppressed text is not delivered");
        break;
    case 2:
        check(event->type == PU_KEY_DOWN && strcmp(event->key, "b") == 0 && !event->repeat, "ordinary SDL keydown");
        break;
    case 3:
        check(event->type == PU_KEY_TEXT && event->text &&
              strcmp(event->text, committed) == 0, "SDL committed UTF-8 payload");
        break;
    case 4:
        check(event->type == PU_KEY_UP && strcmp(event->code, "KeyB") == 0, "ordinary SDL keyup");
        break;
    case 5:
        check(event->type == PU_KEY_DOWN && strcmp(event->key, "F5") == 0 &&
              strcmp(event->code, "F5") == 0, "function key mapping");
        break;
    case 6:
        check(event->type == PU_KEY_UP && strcmp(event->key, "F5") == 0, "function key release");
        break;
    case 7:
    case 8:
        check(strcmp(event->key, "1") == 0 && strcmp(event->code, "Numpad1") == 0 &&
              (event->modifiers & PU_MOD_NUM), "keypad key/code with NumLock");
        break;
    default:
        check(0, "unexpected keyboard event"); pu_window_close(window);
    }
    return PU_INPUT_REDRAW;
}

static int on_pointer(const PuPointerEvent *event, void *user)
{
    (void)user;
    if (received < 9) return 0;
    switch (pointers++) {
    case 0: check(event->type == PU_POINTER_DOWN && event->button == 2 && event->buttons == 2 &&
                  event->x == 10.5f, "right button metadata"); break;
    case 1: check(event->type == PU_POINTER_MOVE && event->button == -1 && event->buttons == 2,
                  "drag button mask"); break;
    case 2: check(event->type == PU_POINTER_UP && event->buttons == 0, "right button release"); break;
    case 3: check(event->type == PU_POINTER_CONTEXT_MENU && event->button == 2,
                  "right click is contextmenu, not primary click"); break;
    default: check(0, "unexpected pointer event");
    }
    return PU_INPUT_REDRAW;
}

static int on_wheel(const PuWheelEvent *event, void *user)
{
    (void)user;
    wheels++;
    check(event->x == 12.5f && event->y == 23.0f &&
          event->delta_x == 20.0f && event->delta_y == 10.0f, "fractional two-axis wheel metadata");
    return PU_INPUT_REDRAW;
}

static int on_drop(const PuDropEvent *event, void *user)
{
    (void)user;
    switch (event->type) {
    case PU_DROP_ENTER:
        drop_enters++;
        check(event->x == 12.5f && event->y == 23.0f && event->file_count == 0 && !event->text,
              "drop entry coordinates and clean payload");
        break;
    case PU_DROP_MOTION: drop_motions++; break;
    case PU_DROP_DATA:
        drops++;
        check(event->file_count == 2 && !strcmp(event->files[0], "/tmp/one") &&
              !strcmp(event->files[1], "/tmp/two"), "dropped files are aggregated");
        check(event->text && !strcmp(event->text, "first\nsecond") &&
              event->source && !strcmp(event->source, "fixture"), "dropped text and source are retained");
        break;
    case PU_DROP_LEAVE:
        drop_leaves++;
        check(!event->file_count && !event->text, "cancelled drop does not reuse prior payload");
        break;
    case PU_DROP_ERROR:
        check(event->error != NULL, "drop limit failures are explicit");
        if (++drop_errors == 2) pu_window_close(window);
        break;
    }
    return PU_INPUT_REDRAW;
}

static void push_drop(SDL_EventType type, const char *data)
{
    SDL_Event event;
    SDL_zero(event);
    event.type = type; event.drop.windowID = window_id;
    event.drop.x = 12.5f; event.drop.y = 23.0f;
    event.drop.source = "fixture"; event.drop.data = data;
    check(SDL_PushEvent(&event), "queue SDL drop event");
}

static void push_key(SDL_Scancode scan, SDL_Keycode key, SDL_Keymod mods, int down, int repeat)
{
    SDL_Event event;
    SDL_zero(event);
    event.type = down ? SDL_EVENT_KEY_DOWN : SDL_EVENT_KEY_UP;
    event.key.scancode = scan;
    event.key.windowID = window_id;
    event.key.key = key;
    event.key.mod = mods;
    event.key.repeat = repeat != 0;
    check(SDL_PushEvent(&event), "queue SDL key event");
}

static void push_text(const char *text)
{
    SDL_Event event;
    SDL_zero(event);
    event.type = SDL_EVENT_TEXT_INPUT;
    event.text.windowID = window_id;
    event.text.text = text;
    check(SDL_PushEvent(&event), "queue SDL text event");
}

static int tick(void *user)
{
    (void)user;
    if (ticks++ == 0) {
        PuTextInputState input = { .enabled = 1, .purpose = 1, .x = 11, .y = 19, .width = 2, .height = 18 };
        check(pu_window_set_text_input(window, &input, 1), "configure sensitive text input");
        SDL_Rect rect;
        int cursor;
        check(SDL_GetTextInputArea(SDL_GetWindowFromID(window_id), &rect, &cursor) &&
            rect.x == 11 && rect.y == 19 && rect.w == 2 && rect.h == 18 && cursor == 0, "native input-method caret rectangle");
        input.purpose = 0;
        check(pu_window_set_text_input(window, &input, 1), "restore ordinary text input");
        push_key(SDL_SCANCODE_A, SDLK_A, SDL_KMOD_CTRL | SDL_KMOD_SHIFT, 1, 1);
        push_text("A");
        push_key(SDL_SCANCODE_A, SDLK_A, SDL_KMOD_NONE, 0, 0);
        push_key(SDL_SCANCODE_B, SDLK_B, SDL_KMOD_NONE, 1, 0);
        push_text(committed);
        push_key(SDL_SCANCODE_B, SDLK_B, SDL_KMOD_NONE, 0, 0);
        push_key(SDL_SCANCODE_F5, SDLK_F5, SDL_KMOD_NONE, 1, 0);
        push_key(SDL_SCANCODE_F5, SDLK_F5, SDL_KMOD_NONE, 0, 0);
        push_key(SDL_SCANCODE_KP_1, SDLK_KP_1, SDL_KMOD_NUM, 1, 0);
        push_key(SDL_SCANCODE_KP_1, SDLK_KP_1, SDL_KMOD_NUM, 0, 0);
        SDL_Event event;
        SDL_zero(event);
        event.type = SDL_EVENT_TEXT_EDITING;
        event.edit.windowID = window_id;
        event.edit.text = "\xf0\x9f\x99\x82\xe4\xb8\xad";
        event.edit.start = 1; event.edit.length = 1;
        check(SDL_PushEvent(&event), "queue Unicode preedit");
        event.edit.text = ""; event.edit.start = event.edit.length = -1;
        check(SDL_PushEvent(&event), "queue preedit cancellation");
        SDL_zero(event);
        event.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
        event.button.windowID = window_id;
        event.button.button = SDL_BUTTON_RIGHT;
        event.button.x = 10.5f; event.button.y = 20.25f;
        check(SDL_PushEvent(&event), "queue right button");
        SDL_zero(event);
        event.type = SDL_EVENT_MOUSE_MOTION;
        event.motion.windowID = window_id;
        event.motion.state = SDL_BUTTON_RMASK;
        event.motion.x = 12.5f; event.motion.y = 23.0f;
        check(SDL_PushEvent(&event), "queue drag motion");
        SDL_zero(event);
        event.type = SDL_EVENT_MOUSE_BUTTON_UP;
        event.button.windowID = window_id;
        event.button.button = SDL_BUTTON_RIGHT;
        event.button.x = 12.5f; event.button.y = 23.0f;
        check(SDL_PushEvent(&event), "queue right release");
        SDL_zero(event);
        event.type = SDL_EVENT_MOUSE_WHEEL;
        event.wheel.windowID = window_id;
        event.wheel.x = 0.5f; event.wheel.y = -0.25f;
        event.wheel.mouse_x = 12.5f; event.wheel.mouse_y = 23.0f;
        check(SDL_PushEvent(&event), "queue wheel");
        push_drop(SDL_EVENT_DROP_BEGIN, NULL);
        push_drop(SDL_EVENT_DROP_POSITION, NULL);
        push_drop(SDL_EVENT_DROP_FILE, "/tmp/one");
        push_drop(SDL_EVENT_DROP_FILE, "/tmp/two");
        push_drop(SDL_EVENT_DROP_TEXT, "first");
        push_drop(SDL_EVENT_DROP_TEXT, "second");
        push_drop(SDL_EVENT_DROP_COMPLETE, NULL);
        push_drop(SDL_EVENT_DROP_BEGIN, NULL);
        push_drop(SDL_EVENT_DROP_COMPLETE, NULL);
        push_drop(SDL_EVENT_DROP_BEGIN, NULL);
        push_drop(SDL_EVENT_DROP_TEXT, large_drop);
        push_drop(SDL_EVENT_DROP_TEXT, "overflow");
        push_drop(SDL_EVENT_DROP_COMPLETE, NULL);
        push_drop(SDL_EVENT_DROP_BEGIN, NULL);
        for (int i = 0; i < 1025; i++) push_drop(SDL_EVENT_DROP_FILE, "/tmp/limit");
        push_drop(SDL_EVENT_DROP_COMPLETE, NULL);
    } else if (ticks > 500) {
        check(0, "SDL input fixture timed out"); pu_window_close(window);
    }
    return 0;
}

int main(void)
{
    PuWindowConfig config = { .title = "PollyUI input adapter test", .width = 360, .height = 280 };
    window = pu_window_create(&config);
    if (!window) return 1;
    large_drop = malloc(16u * 1024u * 1024u + 1);
    if (!large_drop) { pu_window_destroy(window); return 1; }
    memset(large_drop, 'x', 16u * 1024u * 1024u);
    large_drop[16u * 1024u * 1024u] = 0;
    int count = 0;
    SDL_Window **windows = SDL_GetWindows(&count);
    if (!windows || count != 1) return 1;
    window_id = SDL_GetWindowID(windows[0]);
    SDL_free(windows);
    pu_window_set_key(window, on_key, NULL);
    pu_window_set_pointer(window, on_pointer, NULL);
    pu_window_set_wheel(window, on_wheel, NULL);
    pu_window_set_drop(window, on_drop, NULL);
    pu_window_set_async(window, tick, NULL);
    int result = pu_window_run(window);
    pu_window_keep_alive(1);
    SDL_Event quit;
    SDL_zero(quit);
    quit.type = SDL_EVENT_QUIT;
    check(SDL_PushEvent(&quit), "queue service shutdown without an open window");
    check(pu_window_run_all(NULL, NULL) == 0, "SDL quit terminates a hidden service keep-alive loop");
    pu_window_destroy(window);
    free(large_drop);
    pu_render_shutdown();
    check(received == 9, "exactly one event for each key or committed text");
    check(preedits == 1 && cancellations == 1, "exact preedit and cancellation event sequence");
    check(pointers == 4 && wheels == 1, "exact pointer/wheel event sequence");
    check(drop_enters == 4 && drop_motions == 1 && drops == 1 && drop_leaves == 1 && drop_errors == 2,
          "exact drop sequence with bounded payload rejection");
    if (!result && !failed) puts("PASS: SDL native keyboard/text adapter");
    return result || failed;
}
