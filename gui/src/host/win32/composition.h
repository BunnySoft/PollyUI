#ifndef PU_WIN32_COMPOSITION_H
#define PU_WIN32_COMPOSITION_H

#ifdef __cplusplus
extern "C" {
#endif
typedef struct PuWinComposition PuWinComposition;
int pu_win_composition_supported(void);
PuWinComposition *pu_win_composition_create(void *hwnd);
/* UI-thread, premultiplied BGRA8; dimensions/stride are physical pixels/bytes. */
int pu_win_composition_present(PuWinComposition *composition, const void *pixels,
    int width, int height, int stride);
void pu_win_composition_destroy(PuWinComposition *composition);
#ifdef __cplusplus
}
#endif
#endif
