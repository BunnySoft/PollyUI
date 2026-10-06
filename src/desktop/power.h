#ifndef POLLYUI_DESKTOP_POWER_H
#define POLLYUI_DESKTOP_POWER_H
#include "quickjs.h"
int pu_power_install(JSContext *ctx, JSValueConst api);
int pu_power_pump(void);
void pu_power_shutdown(void);
#endif
