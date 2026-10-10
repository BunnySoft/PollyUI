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
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Validate system font discovery before running UI scripts. Logs on failure. */
int pu_font_system_init(void);
/* Release process render/font caches after all windows and scripts have stopped. */
void pu_render_shutdown(void);

typedef struct PuSurface PuSurface;

/* Create a raster (CPU) surface of the given pixel size (clamped to >= 1x1). */
PuSurface *pu_surface_create(int width, int height);

/* Create a GPU surface bound to a platform-native window handle. The handle is
 * opaque so the same seam serves every host backend:
 *   Windows  -> HWND                    (GL via ANGLE/D3D11)
 * Planned (currently return NULL, so the host must use raster):
 *   Wayland  -> struct wl_egl_window *   (GL via Mesa EGL)
 *   X11      -> Window                   (GL via Mesa EGL)
 *   Android  -> ANativeWindow *          (GLES)
 * Renders directly to the window framebuffer; present with pu_surface_present.
 * Returns NULL if a GPU context can't be created (caller may fall back to
 * pu_surface_create + blitting). width/height are physical pixels. */
PuSurface *pu_surface_create_gpu(void *native_window, int width, int height);

typedef void (*PuGlProc)(void);
typedef PuGlProc (*PuGlGetProc)(void *user, const char *name);
/* Linux: wrap framebuffer 0 of the caller's current GLES 3 RGBA8/stencil-8
 * context. The host owns that context and swaps buffers after present().
 * Keep it current during painting, resize, readback and destruction. */
PuSurface *pu_surface_create_current_gl(PuGlGetProc get_proc, void *user, int width, int height);
int pu_surface_valid(const PuSurface *s);
/* Bind an owned Windows EGL context before drawing/readback. Other backends
 * retain their host-owned context contract. Logs and returns zero on failure. */
int pu_surface_make_current(PuSurface *s);

/* Create a GPU surface backed by Skia's Metal backend, bound to a CAMetalLayer*
 * (macOS / iOS). Built only in the Apple render path (gui/src/render/skia_metal.mm);
 * the default GL/raster build provides a stub that returns NULL. */
PuSurface *pu_surface_create_metal(void *ca_metal_layer, int width, int height);

/* True if the surface is GPU-backed (present) vs raster (blit pixels). */
int pu_surface_is_gl(const PuSurface *s);

/* Flush GPU drawing. Windows/Metal also present; a borrowed GL context does not. */
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

/* Canvas state stack for clipping/scrolling: save, clip to a (rounded) rect,
 * translate (e.g. by the negated scroll offset), then restore to undo all. */
void pu_surface_save(PuSurface *s);
void pu_surface_clip_rrect(PuSurface *s, float x, float y, float w, float h, float radius);
void pu_surface_translate(PuSurface *s, float dx, float dy);
void pu_surface_rotate(PuSurface *s, float degrees);
void pu_surface_scale(PuSurface *s, float sx, float sy);

/* Fill a (rounded) rect with a two-stop linear gradient. horizontal != 0 runs
 * left->right; otherwise top->bottom. */
void pu_surface_fill_gradient(PuSurface *s, float x, float y, float w, float h,
                              float radius, int horizontal,
                              uint8_t r0, uint8_t g0, uint8_t b0, uint8_t a0,
                              uint8_t r1, uint8_t g1, uint8_t b1, uint8_t a1);

/* Decode (cached) the image at `path` and draw it scaled into the box, clipped
 * to the corner radius. Returns 1 if drawn, 0 if the image couldn't load. */
int pu_surface_draw_image(PuSurface *s, const char *path, float x, float y,
                          float w, float h, float radius);
/* Owned in-memory images; keys must use the polly-memory: namespace.
 * Bitmap decoding copies PNG/JPEG bytes within the caller's pixel budget. */
int pu_image_set_argb(const char *key, int width, int height, const uint8_t *bytes, size_t length);
int pu_image_set_bitmap(const char *key, const uint8_t *bytes, size_t length,
                        size_t pixel_limit, int *width, int *height);
void pu_image_remove(const char *key);

/* Measure a UTF-8 string at `font_size` (px), weight (e.g. 400/700), slant, and
 * font `family` (NULL/"" = default UI font; "monospace"/"serif" or a face name).
 * max line advance width + total height. Honors embedded '\n'. If max_width > 0,
 * the text is word-wrapped to that width (height grows with the line count). */
void pu_text_measure(const char *utf8, float font_size, int weight, int italic,
                     const char *family, float max_width, float *out_w, float *out_h);

typedef struct PuTextCluster {
    int start, end; /* UTF-16 indices */
    float x, width;
    int rtl;
} PuTextCluster;
typedef struct PuTextLayout {
    PuTextCluster *clusters;
    size_t count;
    float width;
} PuTextLayout;
/* Linux HarfBuzz/ICU single-line layout; output is owned until dispose. */
int pu_text_layout(const char *utf8, size_t length, float size, int weight, int italic,
    const char *family, PuTextLayout *out);
void pu_text_layout_dispose(PuTextLayout *layout);
int pu_text_graphemes(const char *utf8, size_t length, int **boundaries, size_t *count);

/* Draw a UTF-8 string with its top-left at (x, y), in the given size, weight,
 * slant, font `family`, and color. '\n'/word-wrap start new lines.
 * align: 0 left, 1 center, 2 right — each line positioned within align_width. */
void pu_surface_draw_text(PuSurface *s, const char *utf8, float x, float y,
                          float font_size, int weight, int italic, const char *family,
                          float max_width, int align, float align_width,
                          uint8_t r, uint8_t g, uint8_t b, uint8_t a);

/* Draw single-line text filled with a horizontal two-color gradient. */
void pu_surface_draw_text_gradient(PuSurface *s, const char *utf8, float x, float y,
                                   float font_size, int weight, int italic, const char *family,
                                   uint8_t r0, uint8_t g0, uint8_t b0,
                                   uint8_t r1, uint8_t g1, uint8_t b1);

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
