#include "pollyui/window.h"
#include "render/skia_c.h"
#include <stdio.h>
#include <string.h>
#if defined(PU_TEST_SDL)
#include <SDL3/SDL.h>
#else
#include "win32-test-window.h"
#endif

static int failed;
static PuWindow *callback_peer;
static int state_calls;
static void check(int ok, const char *message)
{
    printf("%s: %s\n", ok ? "PASS" : "FAIL", message);
    if (!ok) failed = 1;
}
static int native_exists(const char *title)
{
#if defined(PU_TEST_SDL)
    int count, found = 0;
    SDL_Window **windows = SDL_GetWindows(&count);
    for (int i = 0; windows && i < count; i++)
        if (!strcmp(SDL_GetWindowTitle(windows[i]), title)) found = 1;
    SDL_free(windows);
    return found;
#else
    return pu_test_find_window(title) != NULL;
#endif
}

static void destroy_from_state(const PuWindowState *state, void *user)
{
    check(state->width > 0 && state->height > 0, "state callback observes native client geometry before reentrant teardown");
    state_calls++;
    pu_window_destroy(callback_peer);
    callback_peer = NULL;
    pu_window_destroy(user);
}

int main(void)
{
    if (!pu_window_system_init()) return 1;
    PuWindowConfig owner_config = { .title = "Lifetime.owner", .width = 240, .height = 160 };
    PuWindow *owner = pu_window_create(&owner_config);
    if (!owner) return 1;
    PuWindowConfig child_config = { .title = "Lifetime.first", .width = 180, .height = 120,
        .parent = owner, .modal = 1 };
    PuWindow *first = pu_window_create(&child_config);
    child_config.title = "Lifetime.second";
    PuWindow *second = pu_window_create(&child_config);
    check(first && second, "native owned/modal children created for resource lifetime check");
    if (!first || !second) return 1;
    pu_window_destroy(owner);
    check(native_exists("Lifetime.owner") && pu_window_is_open(first) && pu_window_is_open(second),
        "low-level owner destruction retains native resources instead of implicitly destroying children");
    check(!pu_window_create(&child_config), "destroy-pending retained owner cannot accept new children");
    pu_window_destroy(first);
    check(native_exists("Lifetime.owner") && native_exists("Lifetime.second") && pu_window_is_open(second),
        "releasing one modal child preserves its sibling and the retained native owner");
    pu_window_destroy(second);
    check(!native_exists("Lifetime.owner") && !native_exists("Lifetime.first") && !native_exists("Lifetime.second"),
        "last child release reclaims all retained native owner resources leaf-first");
    owner_config.title = "Lifetime.callback-owner";
    owner = pu_window_create(&owner_config);
    owner_config.title = "Lifetime.callback-peer";
    callback_peer = pu_window_create(&owner_config);
    check(owner && callback_peer, "callback lifetime fixtures created");
    if (!owner || !callback_peer) return 1;
    pu_window_set_state(owner, destroy_from_state, owner);
    check(!pu_window_run_all(NULL, NULL) && state_calls == 1 && !callback_peer &&
        !native_exists("Lifetime.callback-owner") && !native_exists("Lifetime.callback-peer"),
        "state callback may destroy itself and a peer without dangling callback iteration");
    pu_window_system_shutdown();
    pu_render_shutdown();
    return failed;
}
