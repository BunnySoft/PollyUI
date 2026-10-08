#ifndef POLLYUI_DESKTOP_APPLICATIONS_H
#define POLLYUI_DESKTOP_APPLICATIONS_H
#include "quickjs.h"

int pu_applications_install(JSContext *ctx);
int pu_applications_pump(void);
void pu_applications_shutdown(void);
void pu_applications_begin_exit(void);
void pu_applications_cancel_exit(void);
int pu_applications_exit_ready(void);
JSValue pu_applications_exit_snapshot(JSContext *ctx);

#endif
