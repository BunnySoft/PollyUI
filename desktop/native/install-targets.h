#ifndef POLLYUI_DESKTOP_INSTALL_TARGETS_H
#define POLLYUI_DESKTOP_INSTALL_TARGETS_H
#include "quickjs.h"
int pu_install_targets_install(JSContext *ctx, JSValueConst api);
int pu_install_targets_pump(void);
void pu_install_targets_shutdown(void);
#endif
