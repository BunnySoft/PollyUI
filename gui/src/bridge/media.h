#ifndef POLLYUI_BRIDGE_MEDIA_H
#define POLLYUI_BRIDGE_MEDIA_H
#include "model/node.h"
#include "quickjs.h"
int pu_media_install(JSContext *ctx, JSValueConst node_prototype);
int pu_media_prototype(JSContext *ctx, JSValueConst object, const char *tag);
PuNode *pu_bridge_node(JSValueConst value);
const char *pu_bridge_bitmap_key(JSValueConst value);
int pu_bridge_media_event(JSContext *ctx, PuNode *node, const char *type);
int pu_bridge_media_event_status(JSContext *ctx, PuNode *node, const char *type,const char *status);
#endif
