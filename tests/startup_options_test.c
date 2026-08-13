#include "host/startup.h"

#include <stdio.h>
#include <string.h>

static int failures;

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
        ++failures; \
    } \
} while (0)

static void test_defaults_and_legacy_forms(void)
{
    char *demo[] = { "pollyui" };
    char *app[] = { "pollyui", "app.js" };
    char *test[] = { "pollyui", "--test", "test.js" };
    char *configured_test[] = {
        "pollyui", "--renderer=raster", "--test", "test.js", "--backend=x11"
    };
    PuStartupOptions options;
    char error[160];

    CHECK(pu_startup_parse(1, demo, NULL, NULL, &options, error, sizeof(error)));
    CHECK(options.backend == PU_BACKEND_AUTO);
    CHECK(options.renderer == PU_RENDERER_AUTO);
    CHECK(!options.app_path && !options.test_path);

    CHECK(pu_startup_parse(2, app, NULL, NULL, &options, error, sizeof(error)));
    CHECK(options.app_path && strcmp(options.app_path, "app.js") == 0);

    CHECK(pu_startup_parse(3, test, NULL, NULL, &options, error, sizeof(error)));
    CHECK(options.test_path && strcmp(options.test_path, "test.js") == 0);

    CHECK(pu_startup_parse(5, configured_test, NULL, NULL,
                           &options, error, sizeof(error)));
    CHECK(options.backend == PU_BACKEND_X11);
    CHECK(options.renderer == PU_RENDERER_RASTER);
    CHECK(options.test_path && strcmp(options.test_path, "test.js") == 0);
}

static void test_precedence_and_validation(void)
{
    char *args[] = {
        "pollyui", "--backend=wayland", "--renderer", "gl", "app.js"
    };
    char *bad[] = { "pollyui", "--backend=mir", "app.js" };
    PuStartupOptions options;
    char error[160];

    CHECK(pu_startup_parse(5, args, "x11", "raster",
                           &options, error, sizeof(error)));
    CHECK(options.backend == PU_BACKEND_WAYLAND);
    CHECK(options.renderer == PU_RENDERER_GL);
    CHECK(options.app_path && strcmp(options.app_path, "app.js") == 0);

    CHECK(pu_startup_parse(1, bad, "x11", "raster",
                           &options, error, sizeof(error)));
    CHECK(options.backend == PU_BACKEND_X11);
    CHECK(options.renderer == PU_RENDERER_RASTER);

    CHECK(pu_startup_parse(5, args, "mir", "software",
                           &options, error, sizeof(error)));
    CHECK(options.backend == PU_BACKEND_WAYLAND);
    CHECK(options.renderer == PU_RENDERER_GL);

    CHECK(!pu_startup_parse(3, bad, NULL, NULL, &options, error, sizeof(error)));
    CHECK(strstr(error, "invalid backend") != NULL);
    CHECK(!pu_startup_parse(1, bad, "mir", NULL, &options, error, sizeof(error)));
    CHECK(strstr(error, "PU_BACKEND") != NULL);
}

static void test_backend_plan(void)
{
    PuBackend plan[3];
    size_t count = pu_backend_plan(PU_BACKEND_AUTO, "wayland-0", ":0", plan);
    CHECK(count == 2);
    CHECK(plan[0] == PU_BACKEND_WAYLAND);
    CHECK(plan[1] == PU_BACKEND_X11);

    count = pu_backend_plan(PU_BACKEND_AUTO, NULL, ":0", plan);
    CHECK(count == 2);
    CHECK(plan[0] == PU_BACKEND_X11);
    CHECK(plan[1] == PU_BACKEND_WAYLAND);

    count = pu_backend_plan(PU_BACKEND_AUTO, NULL, NULL, plan);
    CHECK(count == 2);
    CHECK(plan[0] == PU_BACKEND_WAYLAND);
    CHECK(plan[1] == PU_BACKEND_X11);

    count = pu_backend_plan(PU_BACKEND_WAYLAND, NULL, ":0", plan);
    CHECK(count == 1);
    CHECK(plan[0] == PU_BACKEND_WAYLAND);
}

int main(void)
{
    test_defaults_and_legacy_forms();
    test_precedence_and_validation();
    test_backend_plan();
    if (failures) {
        fprintf(stderr, "%d startup option test(s) failed\n", failures);
        return 1;
    }
    puts("startup option tests passed");
    return 0;
}
