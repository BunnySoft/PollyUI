#define _GNU_SOURCE
#include "decoration-frame.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void)
{
    uint32_t meta[PU_FRAME_META_WORDS] = {1, 2, 3, 0, 10, 10, 0, 1, 1, 16};
    meta[PU_FRAME_SCALE] = pu_frame_scale_word(1);
    struct PuFrameStrip strips[PU_FRAME_STRIPS]; uint32_t length;
    assert(pu_frame_strips(meta, strips, &length));
    uint8_t *rgba[PU_FRAME_STRIPS]; const uint8_t *pixels[PU_FRAME_STRIPS];
    size_t lengths[PU_FRAME_STRIPS];
    for (unsigned i = 0; i < PU_FRAME_STRIPS; i++) {
        lengths[i] = (size_t)strips[i].width * strips[i].height * 4;
        rgba[i] = malloc(lengths[i]); assert(rgba[i]);
        for (size_t offset = 0; offset < lengths[i]; offset += 4) {
            rgba[i][offset] = 200; rgba[i][offset + 1] = 100;
            rgba[i][offset + 2] = 50; rgba[i][offset + 3] = 128;
        }
        pixels[i] = rgba[i];
    }
    int fd = pu_frame_create(meta, pixels, lengths, &length);
    assert(fd >= 0 && pu_frame_fd_valid(fd, length));
    assert(!pu_frame_fd_valid(fd, length + 4) && !pu_frame_fd_valid(fd, 0));
    void *data = mmap(NULL, length, PROT_READ, MAP_PRIVATE, fd, 0);
    assert(data != MAP_FAILED && pu_frame_validate(data, length, meta, strips));
    uint32_t pixel;
    memcpy(&pixel, (uint8_t *)data + strips[0].offset, sizeof(pixel));
    assert(pixel == 0x80643219);
    assert(pwrite(fd, &pixel, sizeof(pixel), 0) < 0 && errno == EPERM);
    assert(ftruncate(fd, length + 4) < 0 && errno == EPERM);
    uint32_t changed[PU_FRAME_META_WORDS]; memcpy(changed, meta, sizeof(meta));
    changed[PU_FRAME_REVISION]++; assert(!pu_frame_validate(data, length, changed, strips));
    changed[PU_FRAME_REVISION]--; changed[PU_FRAME_GENERATION_LO]++;
    assert(!pu_frame_validate(data, length, changed, strips));
    munmap(data, length); close(fd);
    int mutable = memfd_create("invalid-decoration", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    assert(mutable >= 0 && ftruncate(mutable, length) == 0 && !pu_frame_fd_valid(mutable, length));
    close(mutable);
    int pipe_fds[2]; assert(pipe(pipe_fds) == 0 && !pu_frame_fd_valid(pipe_fds[0], length));
    close(pipe_fds[0]); close(pipe_fds[1]);
    lengths[0]--; assert(pu_frame_create(meta, pixels, lengths, &length) < 0);
    for (unsigned i = 0; i < PU_FRAME_STRIPS; i++) free(rgba[i]);
    puts("PASS: real sealed FD, exact size, read-only mapping, premultiplied RGBA, stale identity and malformed input");
    return 0;
}
