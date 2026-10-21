#ifndef POLLY_VIDEO_WALLPAPER_H
#define POLLY_VIDEO_WALLPAPER_H

#include <stdint.h>

#define PU_VIDEO_MAGIC UINT32_C(0x50564944)
#define PU_VIDEO_VERSION 1
#define PU_VIDEO_INIT_LOOP 1u
#define PU_VIDEO_INIT_PAUSED 2u
#define PU_VIDEO_WIDTH 1280
#define PU_VIDEO_HEIGHT 720
#define PU_VIDEO_BYTES ((uint32_t)PU_VIDEO_WIDTH * PU_VIDEO_HEIGHT * 4)
#define PU_VIDEO_SOURCE_PIXELS (1920 * 1080)

enum PuVideoOperation {
    PU_VIDEO_INIT = 1, PU_VIDEO_ACK, PU_VIDEO_PAUSE, PU_VIDEO_PLAY, PU_VIDEO_STOP,
    PU_VIDEO_FRAME = 16, PU_VIDEO_END, PU_VIDEO_ERROR, PU_VIDEO_STATUS, PU_VIDEO_INITIALIZED
};

struct PuVideoMessage {
    uint32_t magic, version, operation, flags;
    uint32_t width, height, stride, bytes;
    int64_t timestamp, duration;
    uint32_t loop, reserved;
    char error[192];
};

_Static_assert(sizeof(struct PuVideoMessage) == 248, "The local video helper ABI must stay explicit");

#endif
