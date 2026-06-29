// RenderEngine — internal (C++) surface definition shared between the Skia
// shim (skia_c.cpp) and the per-GPU-API backends (skia_metal.mm). This header is
// NOT part of the public C ABI (skia_c.h); it exists only so a backend that
// *creates* a PuSurface (e.g. Metal) produces the exact same layout that all the
// backend-agnostic drawing code in skia_c.cpp reads via `s->surface`.
//
// Keep this header free of platform headers (no <windows.h>, no Cocoa) so it can
// be included from every translation unit and target. Backend-specific handles
// are stored as `void *`.

#ifndef POLLYUI_RENDER_SKIA_INTERNAL_H
#define POLLYUI_RENDER_SKIA_INTERNAL_H

#include "include/core/SkSurface.h"
#include "include/gpu/GrDirectContext.h"

// BGRA8888 + premul raster; or a GPU-backed surface (GL/ANGLE on Windows, Metal
// on Apple). Backend handles are opaque void* so this struct compiles anywhere.
struct PuSurface {
    sk_sp<SkSurface> surface;
    int  width  = 0;
    int  height = 0;

    // GPU-backed (true => pu_surface_present must be called to show a frame).
    bool gl = false;
    sk_sp<GrDirectContext> grctx;

    // Windows GL/ANGLE backend state (HWND + EGL handles, all opaque here).
    void *hwnd        = nullptr;
    void *egl_display = nullptr;
    void *egl_surface = nullptr;
    void *egl_context = nullptr;

    // Apple Metal backend state: an owned PuMetalState* (defined in
    // skia_metal.mm). Non-null only in the PU_METAL_BACKEND build.
    void *metal = nullptr;
};

#endif // POLLYUI_RENDER_SKIA_INTERNAL_H
