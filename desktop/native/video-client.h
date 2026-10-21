#ifndef POLLY_VIDEO_CLIENT_H
#define POLLY_VIDEO_CLIENT_H

#include "quickjs.h"
int pu_video_client_install(JSContext *context, JSValueConst api);
int pu_video_client_pump(void);
void pu_video_client_shutdown(void);

#endif
