#ifndef POLLY_DECORATION_FRAME_H
#define POLLY_DECORATION_FRAME_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

enum {
    PU_FRAME_TOKEN, PU_FRAME_REVISION, PU_FRAME_GENERATION_LO, PU_FRAME_GENERATION_HI,
    PU_FRAME_CLIENT_WIDTH, PU_FRAME_CLIENT_HEIGHT, PU_FRAME_SCALE, PU_FRAME_STATE,
    PU_FRAME_BORDER, PU_FRAME_TITLE,
    PU_FRAME_CLOSE, PU_FRAME_MAXIMIZE = PU_FRAME_CLOSE + 4,
    PU_FRAME_MINIMIZE = PU_FRAME_MAXIMIZE + 4, PU_FRAME_TEXT = PU_FRAME_MINIMIZE + 4,
    PU_FRAME_META_WORDS = PU_FRAME_TEXT + 4,
};
enum { PU_FRAME_TOP, PU_FRAME_LEFT, PU_FRAME_RIGHT, PU_FRAME_BOTTOM, PU_FRAME_STRIPS };
enum { PU_FRAME_MAGIC = 0x50554446, PU_FRAME_VERSION = 1 };
#define PU_FRAME_HEADER_WORDS (3 + PU_FRAME_META_WORDS + PU_FRAME_STRIPS * 4)
#define PU_FRAME_HEADER_BYTES (PU_FRAME_HEADER_WORDS * sizeof(uint32_t))
#define PU_FRAME_PIXEL_LIMIT (16u * 1024u * 1024u)
#define PU_FRAME_BYTE_LIMIT (PU_FRAME_HEADER_BYTES + PU_FRAME_PIXEL_LIMIT * 4u)

struct PuFrameStrip { uint32_t width, height, stride, offset; };
static inline uint32_t pu_frame_scale_word(float scale)
{ uint32_t bits; memcpy(&bits, &scale, sizeof(bits)); return bits; }
static inline float pu_frame_scale(const uint32_t *meta)
{ float scale; memcpy(&scale, &meta[PU_FRAME_SCALE], sizeof(scale)); return scale; }

static inline bool pu_frame_strips(const uint32_t *meta, struct PuFrameStrip strips[PU_FRAME_STRIPS],
    uint32_t *bytes)
{
    float scale = pu_frame_scale(meta);
    uint32_t width = meta[PU_FRAME_CLIENT_WIDTH], height = meta[PU_FRAME_CLIENT_HEIGHT];
    uint32_t border = meta[PU_FRAME_BORDER], title = meta[PU_FRAME_TITLE], state = meta[PU_FRAME_STATE];
    if (!meta[PU_FRAME_TOKEN] || !meta[PU_FRAME_REVISION] ||
        !(meta[PU_FRAME_GENERATION_LO] | meta[PU_FRAME_GENERATION_HI]) ||
        !width || !height || width > 32700 || height > 32700 || border > 8 ||
        title < 16 || title > 96 || !isfinite(scale) || scale <= 0 || scale > 8 ||
        (state & ~127u) || (((state >> 2) & 7) && (((state >> 2) & 7) & (((state >> 2) & 7) - 1))))
        return false;
    uint32_t outer = width + 2 * border;
    for (unsigned i = PU_FRAME_CLOSE; i < PU_FRAME_TEXT; i += 4) {
        uint32_t x = meta[i], y = meta[i + 1], w = meta[i + 2], h = meta[i + 3];
        if (!w && !h) continue;
        if (w < 8 || w > 96 || h < 8 || h > 64 || x > outer || w > outer - x ||
            y > title || h > title - y) return false;
    }
    if (meta[PU_FRAME_TEXT] > outer || meta[PU_FRAME_TEXT + 2] > outer - meta[PU_FRAME_TEXT] ||
        meta[PU_FRAME_TEXT + 1] > title ||
        meta[PU_FRAME_TEXT + 3] > title - meta[PU_FRAME_TEXT + 1]) return false;
    const uint32_t logical[PU_FRAME_STRIPS][2] = {{outer, title}, {border, height},
        {border, height}, {outer, border}};
    uint64_t offset = PU_FRAME_HEADER_BYTES, pixels = 0;
    for (unsigned i = 0; i < PU_FRAME_STRIPS; i++) {
        double pw = ceil(logical[i][0] * (double)scale), ph = ceil(logical[i][1] * (double)scale);
        if (pw > 32768 || ph > 32768) return false;
        uint64_t count = (uint64_t)pw * (uint64_t)ph;
        pixels += count;
        if (pixels > PU_FRAME_PIXEL_LIMIT) return false;
        strips[i] = (struct PuFrameStrip) {(uint32_t)pw, (uint32_t)ph, (uint32_t)pw * 4, (uint32_t)offset};
        offset += count * 4;
    }
    if (offset > PU_FRAME_BYTE_LIMIT) return false;
    *bytes = (uint32_t)offset;
    return true;
}

static inline bool pu_frame_validate(const void *data, size_t length,
    const uint32_t expected[PU_FRAME_META_WORDS], struct PuFrameStrip strips[PU_FRAME_STRIPS])
{
    if (!data || length < PU_FRAME_HEADER_BYTES || length > PU_FRAME_BYTE_LIMIT) return false;
    uint32_t words[PU_FRAME_HEADER_WORDS];
    memcpy(words, data, sizeof(words));
    if (words[0] != PU_FRAME_MAGIC || words[1] != PU_FRAME_VERSION || words[2] != length ||
        memcmp(words + 3, expected, PU_FRAME_META_WORDS * sizeof(uint32_t))) return false;
    uint32_t bytes;
    if (!pu_frame_strips(expected, strips, &bytes) || bytes != length) return false;
    for (unsigned i = 0; i < PU_FRAME_STRIPS; i++) {
        const uint32_t *record = words + 3 + PU_FRAME_META_WORDS + i * 4;
        if (record[0] != strips[i].width || record[1] != strips[i].height ||
            record[2] != strips[i].stride || record[3] != strips[i].offset) return false;
    }
    return true;
}
bool pu_frame_fd_valid(int fd, uint32_t length);
int pu_frame_create(const uint32_t meta[PU_FRAME_META_WORDS], const uint8_t *rgba[PU_FRAME_STRIPS],
    const size_t lengths[PU_FRAME_STRIPS], uint32_t *length);
#endif
