#ifndef POLLYUI_GREETER_CLIENT_H
#define POLLYUI_GREETER_CLIENT_H
#include "quickjs.h"
int pu_greeter_client_install(JSContext *ctx);
int pu_greeter_client_pump(void);
void pu_greeter_client_shutdown(void);
#endif
