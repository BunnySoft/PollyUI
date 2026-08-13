#include "host/startup.h"

#include <stdio.h>
#include <string.h>

static int has_value(const char *value)
{
    return value && value[0] != '\0';
}

const char *pu_backend_name(PuBackend backend)
{
    switch (backend) {
    case PU_BACKEND_AUTO: return "auto";
    case PU_BACKEND_WAYLAND: return "wayland";
    case PU_BACKEND_X11: return "x11";
    }
    return "unknown";
}

const char *pu_renderer_name(PuRenderer renderer)
{
    switch (renderer) {
    case PU_RENDERER_AUTO: return "auto";
    case PU_RENDERER_GL: return "gl";
    case PU_RENDERER_RASTER: return "raster";
    }
    return "unknown";
}

static int parse_backend(const char *value, PuBackend *out)
{
    if (!value || strcmp(value, "auto") == 0) *out = PU_BACKEND_AUTO;
    else if (strcmp(value, "wayland") == 0) *out = PU_BACKEND_WAYLAND;
    else if (strcmp(value, "x11") == 0) *out = PU_BACKEND_X11;
    else return 0;
    return 1;
}

static int parse_renderer(const char *value, PuRenderer *out)
{
    if (!value || strcmp(value, "auto") == 0) *out = PU_RENDERER_AUTO;
    else if (strcmp(value, "gl") == 0) *out = PU_RENDERER_GL;
    else if (strcmp(value, "raster") == 0) *out = PU_RENDERER_RASTER;
    else return 0;
    return 1;
}

static int fail(char *error, size_t error_size, const char *format, const char *value)
{
    if (error && error_size > 0)
        snprintf(error, error_size, format, value ? value : "");
    return 0;
}

int pu_startup_parse(int argc, char **argv,
                     const char *backend_env, const char *renderer_env,
                     PuStartupOptions *out, char *error, size_t error_size)
{
    if (!out)
        return fail(error, error_size, "%s", "missing output");

    memset(out, 0, sizeof(*out));
    int backend_cli = 0;
    int renderer_cli = 0;
    int options_done = 0;
    for (int i = 1; i < argc; ++i) {
        const char *arg = argv[i];
        if (!options_done && strcmp(arg, "--") == 0) {
            options_done = 1;
            continue;
        }
        if (!options_done && strncmp(arg, "--backend=", 10) == 0) {
            if (!parse_backend(arg + 10, &out->backend))
                return fail(error, error_size,
                            "invalid backend '%s' (expected auto, wayland, or x11)",
                            arg + 10);
            backend_cli = 1;
            continue;
        }
        if (!options_done && strcmp(arg, "--backend") == 0) {
            if (++i >= argc || !parse_backend(argv[i], &out->backend))
                return fail(error, error_size,
                            "invalid or missing backend '%s' (expected auto, wayland, or x11)",
                            i < argc ? argv[i] : "");
            backend_cli = 1;
            continue;
        }
        if (!options_done && strncmp(arg, "--renderer=", 11) == 0) {
            if (!parse_renderer(arg + 11, &out->renderer))
                return fail(error, error_size,
                            "invalid renderer '%s' (expected auto, gl, or raster)",
                            arg + 11);
            renderer_cli = 1;
            continue;
        }
        if (!options_done && strcmp(arg, "--renderer") == 0) {
            if (++i >= argc || !parse_renderer(argv[i], &out->renderer))
                return fail(error, error_size,
                            "invalid or missing renderer '%s' (expected auto, gl, or raster)",
                            i < argc ? argv[i] : "");
            renderer_cli = 1;
            continue;
        }
        if (!options_done && strcmp(arg, "--test") == 0) {
            if (++i >= argc || strncmp(argv[i], "--", 2) == 0)
                return fail(error, error_size, "%s", "--test requires a script path");
            if (out->test_path)
                return fail(error, error_size, "%s", "--test may only be specified once");
            out->test_path = argv[i];
            continue;
        }
        if (!options_done && strncmp(arg, "--", 2) == 0)
            return fail(error, error_size, "unknown option '%s'", arg);
        if (out->app_path)
            return fail(error, error_size, "unexpected extra argument '%s'", arg);
        out->app_path = arg;
    }

    if (out->test_path && out->app_path)
        return fail(error, error_size, "%s", "--test cannot be combined with an app path");
    if (!backend_cli &&
        !parse_backend(has_value(backend_env) ? backend_env : "auto", &out->backend))
        return fail(error, error_size,
                    "invalid PU_BACKEND '%s' (expected auto, wayland, or x11)",
                    backend_env);
    if (!renderer_cli &&
        !parse_renderer(has_value(renderer_env) ? renderer_env : "auto", &out->renderer))
        return fail(error, error_size,
                    "invalid PU_RENDERER '%s' (expected auto, gl, or raster)",
                    renderer_env);
    if (error && error_size > 0) error[0] = '\0';
    return 1;
}

size_t pu_backend_plan(PuBackend requested,
                       const char *wayland_display, const char *x11_display,
                       PuBackend out[3])
{
    if (!out) return 0;
    if (requested != PU_BACKEND_AUTO) {
        out[0] = requested;
        return 1;
    }

    size_t count = 0;
    if (has_value(wayland_display)) out[count++] = PU_BACKEND_WAYLAND;
    if (has_value(x11_display)) out[count++] = PU_BACKEND_X11;
    if (count == 0) {
        out[count++] = PU_BACKEND_WAYLAND;
        out[count++] = PU_BACKEND_X11;
    } else if (count == 1) {
        out[count++] = out[0] == PU_BACKEND_WAYLAND
            ? PU_BACKEND_X11 : PU_BACKEND_WAYLAND;
    }
    return count;
}
