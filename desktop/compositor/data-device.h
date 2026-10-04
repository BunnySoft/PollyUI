#ifndef POLLYWM_DATA_DEVICE_H
#define POLLYWM_DATA_DEVICE_H
#include <stdbool.h>
struct PuDesktop;
struct wlr_surface;
bool pu_data_device_init(struct PuDesktop *desktop);
void pu_data_device_finish(struct PuDesktop *desktop);
void pu_data_device_motion(struct PuDesktop *desktop);
void pu_data_device_cancel_drag(struct PuDesktop *desktop);
bool pu_data_device_drag_active(struct PuDesktop *desktop);
bool pu_desktop_surface_visible(struct PuDesktop *desktop, struct wlr_surface *surface);
void pu_desktop_restore_input(struct PuDesktop *desktop);
#endif
