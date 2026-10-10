#ifndef POLLY_NETWORK_H
#define POLLY_NETWORK_H
#include "quickjs.h"
int pu_network_install(JSContext *ctx, JSValueConst api);
int pu_network_pump(void);
void pu_network_shutdown(void);
#endif
