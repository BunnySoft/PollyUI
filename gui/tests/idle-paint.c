#include "pollyui/context.h"
#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct State {
    const char *capture;
    struct timespec last;
    int frames, idle_start, idle_end, detached, mutated, focused, failed;
} State;

static State *active;

static void observe(State *state)
{
    struct stat info;
    if (stat(state->capture, &info) < 0) return;
    if (info.st_mtim.tv_sec != state->last.tv_sec || info.st_mtim.tv_nsec != state->last.tv_nsec) {
        state->last = info.st_mtim;
        state->frames++;
    }
}

static JSValue probe(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc != 1) return JS_ThrowTypeError(ctx, "One paint phase is required");
    const char *phase = JS_ToCString(ctx, argv[0]);
    if (!phase) return JS_EXCEPTION;
    observe(active);
    if (!strcmp(phase, "idle-start")) active->idle_start = active->frames;
    else if (!strcmp(phase, "idle-end")) active->idle_end = active->frames;
    else if (!strcmp(phase, "detached")) active->detached = active->frames;
    else if (!strcmp(phase, "mutated")) active->mutated = active->frames;
    else if (!strcmp(phase, "focused")) active->focused = active->frames;
    else active->failed = 1;
    JS_FreeCString(ctx, phase);
    return JS_UNDEFINED;
}

static int install(JSContext *ctx, PuDispatch *dispatch, int headless, void *user)
{
    (void)dispatch; (void)user;
    if (headless) return 0;
    JSValue global = JS_GetGlobalObject(ctx);
    int installed = JS_SetPropertyStr(ctx, global, "paintProbe", JS_NewCFunction(ctx, probe, "paintProbe", 1)) >= 0;
    JS_FreeValue(ctx, global);
    return installed;
}

static int pump(void *user)
{
    observe(user);
    return 1; /* An active service poll must not imply a visual mutation. */
}

int main(int argc, char **argv)
{
    if (argc != 2) return 2;
    char file[] = "/tmp/polly-idle-paint-XXXXXX";
    int fd = mkstemp(file);
    if (fd < 0) { perror("mkstemp"); return 1; }
    close(fd); unlink(file);
    State state = { .capture = file };
    active = &state;
    if (setenv("PU_CAPTURE_FRAME", file, 1) < 0) { perror("setenv"); return 1; }
    const PuGuiHooks hooks = { .install = install, .pump = pump };
    const PuGuiConfig config = { .script = argv[1], .hooks = &hooks, .user = &state };
    int result = pu_gui_run(&config);
    unsetenv("PU_CAPTURE_FRAME");
    unlink(file);
    pu_gui_shutdown();
    printf("Native captured frames: idle=%d detached=%d mutation=%d focus=%d\n",
        state.idle_end - state.idle_start, state.detached - state.idle_end,
        state.mutated - state.detached, state.focused - state.mutated);
    if (result || state.failed || !state.idle_start || state.idle_end - state.idle_start > 2 ||
        state.detached != state.idle_end || state.mutated <= state.detached || state.focused <= state.mutated) {
        fputs("FAIL: idle polls repainted or a real DOM/Promise/focus change did not paint\n", stderr);
        return 1;
    }
    puts("PASS: native GUI keeps idle service/timer polling alive without repainting; real DOM/Promise/focus changes paint");
    return 0;
}
