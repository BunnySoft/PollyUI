#ifndef POLLYUI_CLIPBOARD_H
#define POLLYUI_CLIPBOARD_H
#include "quickjs.h"
int pu_clipboard_install(JSContext *ctx, int memory_only);
void pu_clipboard_shutdown(void);
#endif
