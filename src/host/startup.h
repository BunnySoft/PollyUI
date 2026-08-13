#ifndef POLLYUI_HOST_STARTUP_H
#define POLLYUI_HOST_STARTUP_H

#include "host/window.h"

#include <stddef.h>

typedef struct PuStartupOptions {
    PuBackend backend;
    PuRenderer renderer;
    const char *app_path;
    const char *test_path;
} PuStartupOptions;

const char *pu_backend_name(PuBackend backend);
const char *pu_renderer_name(PuRenderer renderer);

int pu_startup_parse(int argc, char **argv,
                     const char *backend_env, const char *renderer_env,
                     PuStartupOptions *out, char *error, size_t error_size);

/* Returns the ordered Wayland/X11 attempts for one-time SDL initialization. */
size_t pu_backend_plan(PuBackend requested,
                       const char *wayland_display, const char *x11_display,
                       PuBackend out[3]);

#endif /* POLLYUI_HOST_STARTUP_H */
