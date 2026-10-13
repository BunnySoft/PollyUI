#ifndef POLLYUI_GPU_CANVAS_H
#define POLLYUI_GPU_CANVAS_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct PuGpuCanvas PuGpuCanvas;
PuGpuCanvas* pu_gpu_canvas_create(int width, int height, int alpha, int depth, int stencil,
    int premultiplied, int preserve, int power_preference, int strict_performance);
const char* pu_gpu_canvas_creation_error(void);
void pu_gpu_canvas_ref(PuGpuCanvas* canvas);
void pu_gpu_canvas_unref(PuGpuCanvas* canvas);
void pu_gpu_canvas_close(PuGpuCanvas* canvas);
int pu_gpu_canvas_resize(PuGpuCanvas* canvas, int width, int height);
int pu_gpu_canvas_read(PuGpuCanvas* canvas, uint8_t* rgba, size_t length);
void pu_gpu_canvas_present(PuGpuCanvas* canvas);
uint64_t pu_gpu_canvas_revision(PuGpuCanvas* canvas);
int pu_gpu_canvas_lost(PuGpuCanvas* canvas);
size_t pu_gpu_canvas_live_contexts(void);
#ifdef __cplusplus
}
#endif
#endif
