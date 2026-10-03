#include "host/win32/window.h"
#include <SDL3/SDL.h>
#include <stdio.h>
#include <string.h>

static PuWindow *window;
static int received, pointers, wheels, failed, ticks;
static const char committed[] = "\xe4\xb8\xad\xe6\x96\x87\xf0\x9f\x98\x80";

static void check(int valid, const char *description)
{
    if (!valid) { fprintf(stderr, "FAIL: %s\n", description); failed = 1; }
}

static int on_key(const PuKeyEvent *event, void *user)
{
    (void)user;
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
    pu_window_close(window);
    return PU_INPUT_REDRAW;
}

static void push_key(SDL_Scancode scan, SDL_Keycode key, SDL_Keymod mods, int down, int repeat)
{
    SDL_Event event;
    SDL_zero(event);
    event.type = down ? SDL_EVENT_KEY_DOWN : SDL_EVENT_KEY_UP;
    event.key.scancode = scan;
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
    event.text.text = text;
    check(SDL_PushEvent(&event), "queue SDL text event");
}

static int tick(void *user)
{
    (void)user;
    if (ticks++ == 0) {
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
        event.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
        event.button.button = SDL_BUTTON_RIGHT;
        event.button.x = 10.5f; event.button.y = 20.25f;
        check(SDL_PushEvent(&event), "queue right button");
        SDL_zero(event);
        event.type = SDL_EVENT_MOUSE_MOTION;
        event.motion.state = SDL_BUTTON_RMASK;
        event.motion.x = 12.5f; event.motion.y = 23.0f;
        check(SDL_PushEvent(&event), "queue drag motion");
        SDL_zero(event);
        event.type = SDL_EVENT_MOUSE_BUTTON_UP;
        event.button.button = SDL_BUTTON_RIGHT;
        event.button.x = 12.5f; event.button.y = 23.0f;
        check(SDL_PushEvent(&event), "queue right release");
        SDL_zero(event);
        event.type = SDL_EVENT_MOUSE_WHEEL;
        event.wheel.x = 0.5f; event.wheel.y = -0.25f;
        event.wheel.mouse_x = 12.5f; event.wheel.mouse_y = 23.0f;
        check(SDL_PushEvent(&event), "queue wheel");
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
    pu_window_set_key(window, on_key, NULL);
    pu_window_set_pointer(window, on_pointer, NULL);
    pu_window_set_wheel(window, on_wheel, NULL);
    pu_window_set_async(window, tick, NULL);
    int result = pu_window_run(window);
    pu_window_destroy(window);
    pu_render_shutdown();
    check(received == 9, "exactly one event for each key or committed text");
    check(pointers == 4 && wheels == 1, "exact pointer/wheel event sequence");
    if (!result && !failed) puts("PASS: SDL native keyboard/text adapter");
    return result || failed;
}
