#ifndef POLLYUI_CANVAS_C_H
#define POLLYUI_CANVAS_C_H

#include "render/skia_c.h"
#include "render/gpu_canvas.h"

#ifdef __cplusplus
extern "C" {
#endif

/* HTML backing stores are device-independent raster images, not host surfaces. */
#define PU_CANVAS_PIXEL_LIMIT (16u * 1024u * 1024u)
#define PU_IMAGE_BYTE_LIMIT (64u * 1024u * 1024u)
typedef struct PuCanvas PuCanvas;
typedef struct PuCanvasResource PuCanvasResource;
typedef struct PuCanvasGpuSourceOps {
    /* Success commits the new dimensions; failure must leave the source unchanged. */
    int (*resize)(void *userdata, int width, int height);
    /* Exactly width*height*4 top-left RGBA8, unpremultiplied sRGB bytes. */
    int (*read_rgba)(void *userdata, uint8_t *pixels, size_t length);
    uint64_t (*revision)(void *userdata);
    void (*present)(void *userdata);
    void (*release)(void *userdata);
    /* Optional: exactly width*height*8, unpremultiplied, unclamped linear-sRGB RGBA16F. */
    int (*read_f16)(void *userdata, uint8_t *pixels, size_t length);
} PuCanvasGpuSourceOps;
/* Copies ops; successful attach transfers userdata ownership, failure does not. */
int pu_canvas_set_gpu_source(PuCanvas *canvas, const PuCanvasGpuSourceOps *ops, void *userdata);

PuCanvas *pu_canvas_create(int width, int height);
void pu_canvas_destroy(PuCanvas *canvas);
int pu_canvas_resize(PuCanvas *canvas, int width, int height);
int pu_canvas_width(const PuCanvas *canvas);
int pu_canvas_height(const PuCanvas *canvas);
PuGpuCanvas *pu_canvas_gpu(PuCanvas *canvas);
PuGpuCanvas *pu_canvas_acquire_gpu(PuCanvas *canvas, int alpha, int depth, int stencil,
                                  int premultiplied, int preserve, int power_preference,
                                  int strict_performance);
void pu_canvas_composite(PuSurface *surface, PuCanvas *canvas, float x, float y, float width,
                         float height);
PuCanvasResource *pu_canvas_resource(const char *kind, const double *args, size_t count,
                                     const char *text, PuCanvasResource *source);
void pu_canvas_resource_destroy(PuCanvasResource *resource);
/* Return -1 for invalid input, 0 for allocation/backend failure, 1 for success. */
int pu_canvas_command(PuCanvas *canvas, PuCanvasResource *target, const char *operation,
                      const double *args, size_t count, const char *text, size_t text_length,
                      PuCanvasResource *resource, double *result, size_t *result_count);
PuCanvasResource *pu_canvas_snapshot(PuCanvas *canvas);
PuCanvasResource *pu_canvas_image(const char *key);
PuCanvasResource *pu_canvas_rgba_image(int width, int height, const uint8_t *pixels,
                                     int display_width, int display_height,
                                     unsigned primaries, unsigned transfer, int full_range);
int pu_canvas_resource_info(PuCanvasResource *resource, int *width, int *height, int *linear);
/* Reads one bounded row; length is width*4 (sRGB RGBA8) or width*8 (linear RGBA16F). */
int pu_canvas_resource_read_row(PuCanvasResource *resource, int x, int y, int width,
                               int linear, uint8_t *pixels, size_t length);
int pu_canvas_resource_read(PuCanvasResource *resource, int width, int height, uint8_t *rgba);
int pu_canvas_read(PuCanvas *canvas, int x, int y, int width, int height, uint8_t *rgba);
int pu_canvas_write(PuCanvas *canvas, int width, int height, const uint8_t *rgba, int x, int y,
                    int dirty_x, int dirty_y, int dirty_width, int dirty_height);
/* Owned encoded bytes, released with pu_canvas_bytes_free. */
int pu_canvas_encode(PuCanvas *canvas, int jpeg, double quality, uint8_t **bytes, size_t *length);
void pu_canvas_bytes_free(uint8_t *bytes);
size_t pu_canvas_live_backings(void);
size_t pu_canvas_live_resources(void);

#ifdef __cplusplus
}
#endif
#endif
