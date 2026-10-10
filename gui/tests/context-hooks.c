#include "pollyui/context.h"
#include "quickjs.h"
#include <stdio.h>

typedef struct State {
    JSContext *ctx;
    int phase, fail_install, fail_script, fail_prelude, failed;
} State;

static void check(State *state, int valid, const char *message)
{
    if (!valid) { fprintf(stderr, "FAIL: %s\n", message); state->failed = 1; }
}

static int install(JSContext *ctx, PuDispatch *dispatch, int headless, void *user)
{
    State *state = user;
    check(state, state->phase == 0 && dispatch && headless, "install receives a live headless context");
    state->phase = 1; state->ctx = ctx;
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "failScript", JS_NewBool(ctx, state->fail_script));
    JS_SetPropertyStr(ctx, global, "failPrelude", JS_NewBool(ctx, state->fail_prelude));
    JS_FreeValue(ctx, global);
    return !state->fail_install;
}

static void stop(void *user)
{
    State *state = user;
    check(state, state->phase == 1, "producers stop before resources close");
    state->phase = 2;
}

static void windows_closed(void *user)
{
    State *state = user;
    check(state, state->phase == 2, "window cleanup follows producer shutdown");
    state->phase = 3;
}

static void dispose(void *user)
{
    State *state = user;
    check(state, state->phase == 3, "host disposal follows window cleanup");
    JSValue value = JS_NewObject(state->ctx);
    check(state, !JS_IsException(value), "VM remains alive through host disposal");
    JS_FreeValue(state->ctx, value);
    state->ctx = NULL; state->phase = 4;
}

int main(int argc, char **argv)
{
    if (argc != 4) { fprintf(stderr, "Pass the fixture script, prelude module and shared module root\n"); return 2; }
    const PuGuiHooks hooks = {
        .install = install, .stop = stop, .windows_closed = windows_closed, .dispose = dispose,
    };
    int failed = pu_gui_test(NULL) != 2;
    for (int mode = 0; mode < 5; mode++) {
        State state = { .fail_install = mode == 1, .fail_script = mode == 2, .fail_prelude = mode == 3 };
        PuGuiConfig config = { .script = argv[1], .prelude = mode == 4 ? "missing-prelude.mjs" : argv[2],
            .module_root = argv[3], .hooks = &hooks, .user = &state };
        int result = pu_gui_test(&config);
        check(&state, result == (mode ? 1 : 0), "success and failures preserve their result");
        check(&state, state.phase == 4 && !state.ctx, "all lifecycle hooks complete exactly once");
        failed |= state.failed;
    }
    pu_gui_shutdown();
    if (!failed) puts("PASS: GUI-only context hooks clean up before VM destruction on all outcomes");
    return failed;
}
