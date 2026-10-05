#ifndef POLLYUI_DESKTOP_THEME_FILES_H
#define POLLYUI_DESKTOP_THEME_FILES_H
#include "quickjs.h"
int pu_theme_files_install(JSContext *ctx, JSValueConst api);
void pu_theme_files_shutdown(void);
#endif
