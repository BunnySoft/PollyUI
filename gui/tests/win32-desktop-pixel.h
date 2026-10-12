#ifndef PU_TEST_DESKTOP_PIXEL_H
#define PU_TEST_DESKTOP_PIXEL_H
#include <windows.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct PuTestDesktopCapture PuTestDesktopCapture;
PuTestDesktopCapture *pu_test_desktop_capture_create(HWND fixture);
int pu_test_desktop_capture_refresh(PuTestDesktopCapture *capture);
/* Caller verifies fixture ownership. Only this one pixel is copied to CPU memory. */
int pu_test_desktop_pixel(PuTestDesktopCapture *capture, int x, int y, COLORREF *color);
void pu_test_desktop_capture_destroy(PuTestDesktopCapture *capture);
int pu_test_desktop_capture_denied(void);
#ifdef __cplusplus
}
#endif
#endif
