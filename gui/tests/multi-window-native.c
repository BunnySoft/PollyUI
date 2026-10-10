#include "pollyui/window.h"
#include "render/skia_c.h"
#include <SDL3/SDL.h>
#include <stdio.h>
#include <string.h>

static PuWindow *windows[4];
static SDL_WindowID ids[4];
static int painted[4], keys[4], pointers[4], wheels[4], closed[4];
static int close_requests[4], close_retried;
static int failed, ticks, phase;
static int indices[] = { 0, 1, 2, 3 };

static void check(int ok, const char *message)
{
    if (!ok) { fprintf(stderr, "FAIL: %s\n", message); failed = 1; }
}

static void paint(PuSurface *surface, int width, int height, float scale, void *user)
{
    (void)width; (void)height; (void)scale;
    int index = *(int *)user;
    pu_surface_clear(surface, (uint8_t)(20 + 40 * index), 50, 90, 255);
    painted[index]++;
}

static int key(const PuKeyEvent *event, void *user)
{
    int index = *(int *)user;
    keys[index]++;
    check(index == 1 && event->type != PU_KEY_TEXT && strcmp(event->code, "KeyB") == 0,
          "keyboard and text suppression are scoped to the addressed window");
    return PU_INPUT_REDRAW | PU_INPUT_PREVENT_DEFAULT;
}

static int pointer(const PuPointerEvent *event, void *user)
{
    if (event->x == -1 && event->y == -1) return 0; /* Native leave notifications are expected. */
    int index = *(int *)user;
    pointers[index]++;
    check(index == 1, "pointer event belongs only to its addressed window");
    return PU_INPUT_REDRAW;
}

static int wheel(const PuWheelEvent *event, void *user)
{
    (void)event;
    int index = *(int *)user;
    wheels[index]++;
    check(index == 1, "wheel event belongs only to its addressed window");
    return PU_INPUT_REDRAW;
}

static void create(int index);
static int request_close(PuWindow *window, void *user)
{
    (void)window;
    int index = *(int *)user;
    return ++close_requests[index] > 1;
}
static void close_window(PuWindow *window, void *user)
{
    int index = *(int *)user;
    closed[index]++;
    check(closed[index] == 1, "each close callback runs once");
    pu_window_destroy(window);
    windows[index] = NULL;
    if (index == 2) create(3);
}

static void create(int index)
{
    char title[40];
    snprintf(title, sizeof(title), "PollyUI native test %d", index);
    PuWindowConfig config = { .title = title, .width = 360, .height = 280 };
    windows[index] = pu_window_create(&config);
    check(windows[index] != NULL, "create native window");
    if (!windows[index]) return;
    pu_window_set_paint(windows[index], paint, &indices[index]);
    pu_window_set_key(windows[index], key, &indices[index]);
    pu_window_set_pointer(windows[index], pointer, &indices[index]);
    pu_window_set_wheel(windows[index], wheel, &indices[index]);
    pu_window_set_close(windows[index], close_window, &indices[index]);
    pu_window_set_close_request(windows[index], request_close, &indices[index]);
    int count;
    SDL_Window **native = SDL_GetWindows(&count);
    for (int i = 0; i < count; i++)
        if (strcmp(SDL_GetWindowTitle(native[i]), title) == 0) ids[index] = SDL_GetWindowID(native[i]);
    SDL_free(native);
    check(ids[index] != 0, "find this process's native window ID");
}

static int frame(void *user)
{
    (void)user;
    if (++ticks > 1000) {
        check(0, "native multi-window fixture timed out");
        for (int i = 0; i < 4; i++) pu_window_close(windows[i]);
        return 0;
    }
    if (phase == 0) {
        SDL_Event e;
        SDL_zero(e); e.type = SDL_EVENT_KEY_DOWN; e.key.windowID = ids[1];
        e.key.scancode = SDL_SCANCODE_B; e.key.key = SDLK_B;
        check(SDL_PushEvent(&e), "queue addressed key");
        SDL_zero(e); e.type = SDL_EVENT_TEXT_INPUT; e.text.windowID = ids[1]; e.text.text = "b";
        check(SDL_PushEvent(&e), "queue suppressed text");
        SDL_zero(e); e.type = SDL_EVENT_KEY_UP; e.key.windowID = ids[1];
        e.key.scancode = SDL_SCANCODE_B; e.key.key = SDLK_B;
        check(SDL_PushEvent(&e), "queue addressed key release");
        e.key.windowID = UINT32_MAX;
        check(SDL_PushEvent(&e), "queue an unknown window ID");
        SDL_zero(e); e.type = SDL_EVENT_MOUSE_MOTION; e.motion.windowID = ids[1];
        check(SDL_PushEvent(&e), "queue addressed pointer");
        SDL_zero(e); e.type = SDL_EVENT_MOUSE_WHEEL; e.wheel.windowID = ids[1]; e.wheel.y = 1;
        check(SDL_PushEvent(&e), "queue addressed wheel");
        SDL_zero(e); e.type = SDL_EVENT_WINDOW_CLOSE_REQUESTED; e.window.windowID = ids[0];
        check(SDL_PushEvent(&e), "queue first-window close");
        phase = 1;
    } else if (phase == 1 && !closed[0] && close_requests[0] == 1 && !close_retried) {
        check(pu_window_is_open(windows[0]), "declined WM close preserves the window for Save or Cancel");
        SDL_Event e;
        SDL_zero(e); e.type = SDL_EVENT_WINDOW_CLOSE_REQUESTED; e.window.windowID = ids[0];
        check(SDL_PushEvent(&e), "request close again after the application declined");
        close_retried = 1;
    } else if (phase == 1 && closed[0]) {
        check(close_requests[0] == 2, "accepted external close is followed by one actual close notification");
        check(keys[0] == 0 && keys[1] == 2 && pointers[1] == 1 && wheels[1] == 1,
              "events are delivered exactly once, without cross-window leakage");
        check(pu_window_is_open(windows[1]) && painted[1], "second window survives the first");
        SDL_SetHintWithPriority(SDL_HINT_RENDER_DRIVER, "pollyui-invalid", SDL_HINT_OVERRIDE);
        PuWindowConfig config = { .title = "Expected creation failure", .width = 360, .height = 280 };
        PuWindow *invalid = pu_window_create(&config);
        check(!invalid, "failed renderer creation is reported");
        pu_window_destroy(invalid);
        SDL_SetHintWithPriority(SDL_HINT_RENDER_DRIVER, "software", SDL_HINT_OVERRIDE);
        check(SDL_WasInit(SDL_INIT_VIDEO) && pu_window_is_open(windows[1]),
              "failed creation cannot shut down a surviving SDL window");
        create(2);
        phase = 2;
    } else if (phase == 2 && painted[2]) {
        pu_window_close(windows[1]);
        phase = 3;
    } else if (phase == 3 && closed[1]) {
        pu_window_close(windows[2]);
        phase = 4;
    } else if (phase == 4 && painted[3]) {
        check(closed[2] && pu_window_is_open(windows[3]), "replacement survives last-window close callback");
        pu_window_close(windows[3]);
        phase = 5;
    }
    return 1;
}

int main(void)
{
    create(0);
    create(1);
    int result = failed ? 1 : pu_window_run_all(frame, NULL);
    for (int i = 0; i < 4; i++) {
        pu_window_destroy(windows[i]);
        check(closed[i] == 1, "all native windows received close notifications");
        check(i == 0 || close_requests[i] == 0, "explicit application close bypasses the external-request hook");
    }
    pu_render_shutdown();
    if (!result && !failed) puts("PASS: native multi-window routing, creation failures, replacement and shutdown");
    return result || failed;
}
