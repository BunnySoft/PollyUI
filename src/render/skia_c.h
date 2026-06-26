#ifndef POLLYUI_RENDER_SKIA_C_H
#define POLLYUI_RENDER_SKIA_C_H

/* RenderEngine — the C ABI over Skia (DESIGN.md §3).
 *
 * This is the ONLY seam where C++ enters PollyUI. The implementation
 * (skia_c.cpp) is C++ compiled against Skia's headers; everything else in the
 * project consumes Skia exclusively through these `extern "C"` functions.
 *
 * M0b surface: a CPU raster surface in BGRA8888 (so its pixels blit directly to
 * a Windows top-down DIB), plus clear + fill-rect. Grown per milestone. */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct PuSurface PuSurface;

/* Create a raster surface of the given pixel size (clamped to >= 1x1). */
PuSurface *pu_surface_create(int width, int height);

/* Destroy the surface. Safe with NULL. */
void pu_surface_destroy(PuSurface *s);

/* Resize the backing store to width x height (no-op if unchanged). */
void pu_surface_resize(PuSurface *s, int width, int height);

/* Clear the whole surface to an RGBA color (components 0..255). */
void pu_surface_clear(PuSurface *s, uint8_t r, uint8_t g, uint8_t b, uint8_t a);

/* Fill an axis-aligned rect (in pixels) with an RGBA color. */
void pu_surface_fill_rect(PuSurface *s, float x, float y, float w, float h,
                          uint8_t r, uint8_t g, uint8_t b, uint8_t a);

/* Read-only access to the BGRA8888 pixel buffer (for blitting to the window).
 * Returns NULL if unavailable. row_bytes is the stride in bytes. */
const void *pu_surface_pixels(const PuSurface *s);
int         pu_surface_width(const PuSurface *s);
int         pu_surface_height(const PuSurface *s);
int         pu_surface_row_bytes(const PuSurface *s);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* POLLYUI_RENDER_SKIA_C_H */
