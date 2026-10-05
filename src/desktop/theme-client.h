#ifndef POLLYUI_DESKTOP_THEME_CLIENT_H
#define POLLYUI_DESKTOP_THEME_CLIENT_H
#include "quickjs.h"
int pu_theme_client_install(JSContext *ctx, JSValueConst api);
int pu_theme_client_pump(void);
void pu_theme_client_shutdown(void);
#endif
