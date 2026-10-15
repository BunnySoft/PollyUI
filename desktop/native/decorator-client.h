#ifndef POLLYUI_DECORATOR_CLIENT_H
#define POLLYUI_DECORATOR_CLIENT_H
#include "quickjs.h"
int pu_decorator_client_install(JSContext *ctx);
int pu_decorator_client_pump(void);
int pu_decorator_client_wait(int timeout_ms);
void pu_decorator_client_wake(void);
void pu_decorator_client_stop(void);
void pu_decorator_client_close(void);
void pu_decorator_client_dispose(void);
#endif
