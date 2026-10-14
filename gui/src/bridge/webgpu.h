#ifndef POLLYUI_BRIDGE_WEBGPU_H
#define POLLYUI_BRIDGE_WEBGPU_H
#include "quickjs.h"
#ifdef __cplusplus
extern "C" {
#endif
JSValue pu_webgpu_factory(JSContext* context);
int pu_webgpu_pump(JSContext* context);
int pu_webgpu_pending(JSContext* context);
void pu_webgpu_shutdown(JSContext* context);
size_t pu_webgpu_live_resources(void);
size_t pu_webgpu_live_readbacks(void);
#ifdef __cplusplus
}
#endif
#endif
