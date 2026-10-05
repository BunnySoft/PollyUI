#ifndef POLLY_TRAY_H
#define POLLY_TRAY_H
#include "quickjs.h"
int pu_tray_install(JSContext *ctx, JSValueConst api);
int pu_tray_pump(void);
void pu_tray_shutdown(void);
#endif
