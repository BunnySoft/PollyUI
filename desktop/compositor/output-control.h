#ifndef POLLYWM_OUTPUT_CONTROL_H
#define POLLYWM_OUTPUT_CONTROL_H
#include <stdbool.h>
struct PuDesktop;
struct wlr_output;
bool pu_output_control_init(struct PuDesktop *desktop);
void pu_output_control_finish(struct PuDesktop *desktop);
bool pu_output_control_add(struct PuDesktop *desktop, struct wlr_output *output);
void pu_output_control_changed(struct PuDesktop *desktop);
void pu_output_control_locking(struct PuDesktop *desktop);
#endif
