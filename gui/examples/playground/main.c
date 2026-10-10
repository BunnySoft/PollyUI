#include "pollyui/context.h"
#include "quickjs.h"

#include <stdio.h>
#include <string.h>

typedef struct Arguments { int count; char **values; } Arguments;

static int install_arguments(JSContext *ctx, PuDispatch *dispatch, int headless, void *user)
{
    (void)dispatch; (void)headless;
    Arguments *args = user;
    JSValue application = JS_NewObject(ctx), values = JS_NewArray(ctx);
    int ok = !JS_IsException(application) && !JS_IsException(values);
    for (int i = 0; i < args->count && ok; i++)
        ok = JS_SetPropertyUint32(ctx, values, (uint32_t)i, JS_NewString(ctx, args->values[i])) >= 0;
    if (ok) ok = JS_SetPropertyStr(ctx, application, "arguments", JS_DupValue(ctx, values)) >= 0;
    JSValue global = JS_GetGlobalObject(ctx);
    if (ok) ok = JS_SetPropertyStr(ctx, global, "application", JS_DupValue(ctx, application)) >= 0;
    JS_FreeValue(ctx, global); JS_FreeValue(ctx, values); JS_FreeValue(ctx, application);
    if (!ok) fprintf(stderr, "[playground] Cannot install example arguments\n");
    return ok;
}

int main(int argc, char **argv)
{
    if (argc > 1 && !strcmp(argv[1], "--help")) {
        puts("Usage: pollyui-playground [app.mjs [arguments...]]\n"
             "       pollyui-playground --test test.mjs\n"
             "Run from the repository root. This example uses only the GUI library.");
        return 0;
    }
    int result;
    if (argc == 1) result = pu_gui_demo();
    else {
        int headless = !strcmp(argv[1], "--test");
        if ((headless && argc != 3) || (!headless && argv[1][0] == '-')) {
            fprintf(stderr, "[playground] Invalid arguments; use --help\n"); return 2;
        }
        Arguments args = { .count = headless ? 0 : argc - 2, .values = argv + 2 };
        const PuGuiHooks hooks = { .install = install_arguments };
        PuGuiConfig config = { .script = argv[headless ? 2 : 1], .hooks = &hooks, .user = &args };
        result = headless ? pu_gui_test(&config) : pu_gui_run(&config);
    }
    pu_gui_shutdown();
    return result;
}
