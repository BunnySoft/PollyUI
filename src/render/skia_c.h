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

/* Create a raster (CPU) surface of the given pixel size (clamped to >= 1x1). */
PuSurface *pu_surface_create(int width, int height);

/* Create a GPU (OpenGL) surface bound to a native window (HWND). Renders
 * directly to the window's framebuffer; present with pu_surface_present.
 * Returns NULL if a GL context can't be created (caller may fall back to
 * pu_surface_create + blitting). width/height are physical pixels. */
PuSurface *pu_surface_create_gl(void *hwnd, int width, int height);

/* True if the surface is GPU-backed (present) vs raster (blit pixels). */
int pu_surface_is_gl(const PuSurface *s);

/* Present the current frame to the window (flush GPU + swap buffers). GL only. */
void pu_surface_present(PuSurface *s);

/* Destroy the surface. Safe with NULL. */
void pu_surface_destroy(PuSurface *s);

/* Resize the backing store to width x height (no-op if unchanged). */
void pu_surface_resize(PuSurface *s, int width, int height);

/* Clear the whole surface to an RGBA color (components 0..255). */
void pu_surface_clear(PuSurface *s, uint8_t r, uint8_t g, uint8_t b, uint8_t a);

/* Fill an axis-aligned rect (in pixels) with an RGBA color. */
void pu_surface_fill_rect(PuSurface *s, float x, float y, float w, float h,
                          uint8_t r, uint8_t g, uint8_t b, uint8_t a);

/* Fill a rounded rect (corner radius). radius 0 == sharp rect. */
void pu_surface_fill_rrect(PuSurface *s, float x, float y, float w, float h,
                           float radius, uint8_t r, uint8_t g, uint8_t b, uint8_t a);

/* Stroke (outline) a rounded rect with the given border width. */
void pu_surface_stroke_rrect(PuSurface *s, float x, float y, float w, float h,
                             float radius, float stroke_w,
                             uint8_t r, uint8_t g, uint8_t b, uint8_t a);

/* Draw a blurred drop shadow for a rounded rect (offset by dx,dy). */
void pu_surface_shadow(PuSurface *s, float x, float y, float w, float h,
                       float radius, float blur, float dx, float dy,
                       uint8_t r, uint8_t g, uint8_t b, uint8_t a);

/* Push/pop a layer with alpha (0..1) for sub-tree element opacity. */
void pu_surface_save_layer_alpha(PuSurface *s, float alpha);
void pu_surface_restore(PuSurface *s);

/* Measure a UTF-8 string at `font_size` (px) in the given weight (e.g. 400/700)
 * and slant: max line advance width + total height. Honors embedded '\n'. */
void pu_text_measure(const char *utf8, float font_size, int weight, int italic,
                     float *out_w, float *out_h);

/* Draw a UTF-8 string with its top-left at (x, y), in the given size, weight,
 * slant, and color. Embedded '\n' starts a new line. */
void pu_surface_draw_text(PuSurface *s, const char *utf8, float x, float y,
                          float font_size, int weight, int italic,
                          uint8_t r, uint8_t g, uint8_t b, uint8_t a);

/* Reset the canvas transform to a uniform scale (DPI: logical -> physical px).
 * Call before clearing/drawing a frame. */
void pu_surface_set_scale(PuSurface *s, float scale);

/* Read one pixel as RGBA (0..255 each) into rgba[4]. For headless tests. */
void pu_surface_read_pixel(const PuSurface *s, int x, int y, uint8_t *rgba);

/* Encode the surface to a PNG file. Returns 1 on success, 0 on failure. */
int pu_surface_save_png(const PuSurface *s, const char *path);

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
