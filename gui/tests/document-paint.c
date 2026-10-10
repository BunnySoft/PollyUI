#include "pollyui/context.h"
#include "render/skia_c.h"
#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static PuSurface *surfaces[4];
static int frames[4], first = -1, second = -1;
static int before[2], after[2], last[2], failed;

int __real_pu_surface_save_png(PuSurface *surface, const char *path);
int __wrap_pu_surface_save_png(PuSurface *surface, const char *path)
{
    int slot = 0;
    while (slot < 4 && surfaces[slot] && surfaces[slot] != surface) slot++;
    if (slot == 4) { failed = 1; return 0; }
    surfaces[slot] = surface;
    frames[slot]++;
    if (strstr(path, "-first.png")) first = slot;
    if (strstr(path, "-second.png")) second = slot;
    return __real_pu_surface_save_png(surface, path);
}

static JSValue probe(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc != 1 || first < 0 || second < 0 || first == second)
        return JS_ThrowTypeError(ctx, "Both actual native surface captures are required");
    const char *phase = JS_ToCString(ctx, argv[0]);
    if (!phase) return JS_EXCEPTION;
    int *snapshot = !strcmp(phase, "before") ? before : !strcmp(phase, "after") ? after :
        !strcmp(phase, "second") ? last : NULL;
    if (snapshot) { snapshot[0] = frames[first]; snapshot[1] = frames[second]; }
    else failed = 1;
    JS_FreeCString(ctx, phase);
    return JS_UNDEFINED;
}

static int install(JSContext *ctx, PuDispatch *dispatch, int headless, void *user)
{
    (void)dispatch;
    if (headless) return 0;
    JSValue global = JS_GetGlobalObject(ctx);
    int ok = JS_SetPropertyStr(ctx, global, "paintProbe", JS_NewCFunction(ctx, probe, "paintProbe", 1)) >= 0 &&
        JS_SetPropertyStr(ctx, global, "capturePrefix", JS_NewString(ctx, user)) >= 0;
    JS_FreeValue(ctx, global);
    return ok;
}

int main(int argc, char **argv)
{
    if (argc != 2) return 2;
    char directory[] = "/tmp/polly-document-paint-XXXXXX";
    if (!mkdtemp(directory)) { perror("mkdtemp"); return 1; }
    char prefix[128], capture[128], left[128], right[128];
    snprintf(prefix, sizeof(prefix), "%s/frame", directory);
    snprintf(capture, sizeof(capture), "%s/automatic.png", directory);
    snprintf(left, sizeof(left), "%s/frame-first.png", directory);
    snprintf(right, sizeof(right), "%s/frame-second.png", directory);
    if (setenv("PU_CAPTURE_FRAME", capture, 1) < 0) { perror("setenv"); return 1; }
    const PuGuiHooks hooks = { .install = install };
    const PuGuiConfig config = { .script = argv[1], .hooks = &hooks, .user = prefix };
    int result = pu_gui_run(&config);
    unsetenv("PU_CAPTURE_FRAME");
    unlink(capture); unlink(left); unlink(right); rmdir(directory);
    pu_gui_shutdown();
    printf("Actual surface paints: first mutation=(%d,%d), second mutation=(%d,%d)\n",
        after[0] - before[0], after[1] - before[1], last[0] - after[0], last[1] - after[1]);
    if (result || failed || after[0] <= before[0] || after[1] != before[1] ||
        last[0] != after[0] || last[1] <= after[1]) {
        fputs("FAIL: one document mutation repainted an unrelated native surface\n", stderr);
        return 1;
    }
    puts("PASS: real raster capture preserves independent surface invalidation in one shared realm");
    return 0;
}
