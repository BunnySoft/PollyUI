#ifndef POLLY_AUDIO_H
#define POLLY_AUDIO_H
#include "quickjs.h"
int pu_audio_install(JSContext *ctx, JSValueConst api);
int pu_audio_pump(void);
void pu_audio_shutdown(void);
#endif
