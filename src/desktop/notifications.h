#ifndef POLLY_NOTIFICATIONS_H
#define POLLY_NOTIFICATIONS_H
#include "quickjs.h"
int pu_notifications_install(JSContext *ctx, JSValueConst api);
int pu_notifications_pump(void);
void pu_notifications_shutdown(void);
#endif
