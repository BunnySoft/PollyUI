#ifndef POLLYUI_DESKTOP_APPLICATIONS_H
#define POLLYUI_DESKTOP_APPLICATIONS_H
#include "quickjs.h"

int pu_applications_install(JSContext *ctx);
int pu_applications_pump(void);
void pu_applications_shutdown(void);

#endif
