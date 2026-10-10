#include "launcher.h"
#include "pollyui/context.h"
#include "pollyui/window.h"
#include "sysrt/providers/app_paths.h"
#include "sysrt/projection/quickjs/storage.h"
#include "sysrt/projection/quickjs/fetch.h"
#include "sysrt/ffi/ffi.h"
#if defined(PU_DESKTOP_SERVICES)
#include "native/applications.h"
#endif
#if defined(PU_LAYER_SHELL)
#include "host/sdl/layer_shell.h"
#endif
#if defined(PU_INPUT_METHOD)
#include "native/input-method-client.h"
#endif
#if defined(PU_SESSION_LOCK)
#include "native/lock-client.h"
#endif
#if defined(PU_GREETER)
#include "native/greeter-client.h"
#endif

#include <stdio.h>
#include <stdlib.h>
#if defined(__linux__)
#include <limits.h>
#include <string.h>
#include <unistd.h>
#ifndef PU_DATA_FROM_BIN
#define PU_DATA_FROM_BIN "../share/pollyui"
#endif
#endif

typedef struct LaunchState {
    const PuLaunchOptions *options;
    PuAppPaths paths;
    SrFfi *ffi;
#if defined(__linux__)
    char module_root[PATH_MAX];
#endif
} LaunchState;

#if defined(__linux__)
static int module_root(LaunchState *state)
{
    char executable[PATH_MAX];
    ssize_t size = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (size < 0) { perror("[runtime] Cannot resolve executable"); return 0; }
    if ((size_t)size == sizeof(executable) - 1) {
        fprintf(stderr, "[runtime] Executable path exceeds module-root bound\n"); return 0;
    }
    executable[size] = 0;
    char *name = strrchr(executable, '/');
    if (!name) { fprintf(stderr, "[runtime] Executable path is not absolute\n"); return 0; }
    *name = 0;
    int length = snprintf(state->module_root, sizeof(state->module_root), "%s/%s", executable, PU_DATA_FROM_BIN);
    if (length < 0 || (size_t)length >= sizeof(state->module_root)) {
        fprintf(stderr, "[runtime] Shared module root exceeds path bound\n"); return 0;
    }
    return 1;
}
#endif

static int install_application(JSContext *ctx, const LaunchState *state)
{
    const PuAppPaths *paths = &state->paths;
    const PuLaunchOptions *options = state->options;
    JSValue application = JS_NewObject(ctx), arguments = JS_NewArray(ctx);
    int ok = !JS_IsException(application) && !JS_IsException(arguments);
    if (ok) ok = JS_SetPropertyStr(ctx, application, "id", JS_NewString(ctx, paths->id)) >= 0;
    if (ok && paths->config) ok = JS_SetPropertyStr(ctx, application, "configDir", JS_NewString(ctx, paths->config)) >= 0;
    if (ok && paths->data) ok = JS_SetPropertyStr(ctx, application, "dataDir", JS_NewString(ctx, paths->data)) >= 0;
    if (ok && paths->cache) ok = JS_SetPropertyStr(ctx, application, "cacheDir", JS_NewString(ctx, paths->cache)) >= 0;
#if defined(__linux__)
    if (ok) ok = JS_SetPropertyStr(ctx, application, "moduleRoot", JS_NewString(ctx, state->module_root)) >= 0;
#endif
    for (int i = 0; i < options->argc && ok; i++)
        ok = JS_SetPropertyUint32(ctx, arguments, (uint32_t)i, JS_NewString(ctx, options->argv[i])) >= 0;
    if (ok) ok = JS_SetPropertyStr(ctx, application, "arguments", JS_DupValue(ctx, arguments)) >= 0;
    JSValue global = JS_GetGlobalObject(ctx);
    if (ok) ok = JS_SetPropertyStr(ctx, global, "application", JS_DupValue(ctx, application)) >= 0;
    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, arguments);
    JS_FreeValue(ctx, application);
    return ok;
}

static int install_services(JSContext *ctx, PuDispatch *dispatch, int headless, void *user)
{
    LaunchState *state = user;
    const PuLaunchOptions *options = state->options;
    const char *test_storage = getenv("PU_TEST_STORAGE");
    const char *storage = headless ? (test_storage ? test_storage : "build/_localstorage.dat") : state->paths.storage;
    if (!pu_storage_install(ctx, storage) || !pu_fetch_install(ctx, dispatch)) return 0;
    if ((headless || (!options->greeter_mode && !options->lock_mode && !options->input_method_mode)) &&
        !(state->ffi = sr_ffi_register(ctx, dispatch))) {
        fprintf(stderr, "[sysrt] Cannot register native FFI module\n"); return 0;
    }
    if (headless) {
        return 1;
    }
    if (!install_application(ctx, state)) {
        fprintf(stderr, "[application] Cannot install application metadata\n");
        return 0;
    }
#if defined(PU_LAYER_SHELL)
    PuLockSurfaceFn lock_surface = NULL;
    PuInputPopupFn input_popup = NULL;
#if defined(PU_SESSION_LOCK)
    if (options->lock_mode) lock_surface = pu_lock_client_surface;
#endif
#if defined(PU_INPUT_METHOD)
    if (options->input_method_mode) input_popup = pu_input_client_popup;
#endif
    pu_layer_set_role_factories(lock_surface, input_popup);
#endif
#if defined(PU_DESKTOP_SERVICES)
    if (options->desktop_mode && !pu_applications_install(ctx)) {
        fprintf(stderr, "[desktop] Cannot install desktop application APIs\n"); return 0;
    }
#endif
#if defined(PU_INPUT_METHOD)
    if (options->input_method_mode && !pu_input_client_install(ctx)) {
        fprintf(stderr, "[ime] Cannot install input-method APIs\n"); return 0;
    }
#endif
#if defined(PU_SESSION_LOCK)
    if (options->lock_mode && !pu_lock_client_install(ctx)) {
        fprintf(stderr, "[lock] Cannot install dedicated lock APIs\n"); return 0;
    }
#endif
#if defined(PU_GREETER)
    if (options->greeter_mode && !pu_greeter_client_install(ctx)) {
        fprintf(stderr, "[greeter] Cannot install dedicated authentication APIs\n"); return 0;
    }
#endif
    (void)options;
    return 1;
}

static int pump_services(void *user)
{
    (void)user;
    int work = 0;
#if defined(PU_DESKTOP_SERVICES)
    work += pu_applications_pump();
#endif
#if defined(PU_INPUT_METHOD)
    int input = pu_input_client_pump();
    if (input < 0) return -1;
    work += input;
#endif
#if defined(PU_SESSION_LOCK)
    int lock = pu_lock_client_pump();
    if (lock < 0) return -1;
    work += lock;
#endif
#if defined(PU_GREETER)
    int greeter = pu_greeter_client_pump();
    if (greeter < 0) return -1;
    work += greeter;
#endif
    return work;
}

static void stop_services(void *user)
{
    LaunchState *state = user;
    sr_ffi_shutdown(state->ffi);
    pu_fetch_shutdown();
#if defined(PU_DESKTOP_SERVICES)
    pu_applications_shutdown();
#endif
#if defined(PU_GREETER)
    pu_greeter_client_shutdown();
#endif
}

static void close_services(void *user)
{
    (void)user;
#if defined(PU_INPUT_METHOD)
    pu_input_client_shutdown();
#endif
#if defined(PU_SESSION_LOCK)
    pu_lock_client_shutdown();
#endif
#if defined(PU_LAYER_SHELL)
    pu_layer_set_role_factories(NULL, NULL);
#endif
}

static void dispose_services(void *user)
{
    (void)user;
    pu_storage_shutdown();
}

static const PuGuiHooks services = {
    .install = install_services, .pump = pump_services, .stop = stop_services,
    .windows_closed = close_services, .dispose = dispose_services,
};

int pu_application_run(const PuLaunchOptions *options)
{
    if (!options || !options->script || options->argc < 0 || (options->argc && !options->argv)) {
        fprintf(stderr, "[application] Invalid launch options\n"); return 2;
    }
    LaunchState state = { .options = options };
#if defined(__linux__)
    if (!module_root(&state)) return 1;
#endif
    if (!pu_app_paths_init(&state.paths, options->script, options->app_id)) return 1;
#if defined(__linux__)
    const char *sdl_id = getenv("SDL_APP_ID");
    if ((!sdl_id || !*sdl_id) && setenv("SDL_APP_ID", state.paths.id, 1) < 0) {
        perror("[paths] Cannot set application identity");
        pu_app_paths_free(&state.paths); return 1;
    }
#endif
    PuGuiConfig config = {
        .script = options->script, .hooks = &services, .user = &state,
#if defined(__linux__)
        .prelude = !options->greeter_mode && !options->lock_mode && !options->input_method_mode ?
            "./desktop/launcher/services.mjs" : NULL,
        .module_root = state.module_root,
#endif
        .keep_alive = options->input_method_mode || options->lock_mode || options->greeter_mode,
        .redact_errors = options->greeter_mode,
    };
    int result = pu_gui_run(&config);
    pu_app_paths_free(&state.paths);
    return result;
}

int pu_application_test(const char *script)
{
    LaunchState state = {0};
#if defined(__linux__)
    if (!module_root(&state)) return 1;
#endif
    PuGuiConfig config = { .script = script, .hooks = &services, .user = &state };
#if defined(__linux__)
    config.prelude = "./desktop/launcher/services.mjs";
    config.module_root = state.module_root;
#endif
    return pu_gui_test(&config);
}

int pu_application_demo(void) { return pu_gui_demo(); }
