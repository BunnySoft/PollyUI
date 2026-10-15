#define _GNU_SOURCE
#include "decoration-frame.h"
#include <errno.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

bool pu_frame_fd_valid(int fd, uint32_t length)
{
    if (fd < 0 || length < PU_FRAME_HEADER_BYTES || length > PU_FRAME_BYTE_LIMIT) { errno = EINVAL; return false; }
    struct stat info;
    if (fstat(fd, &info)) return false;
    int flags = fcntl(fd, F_GETFL), seals = fcntl(fd, F_GET_SEALS);
    int required = F_SEAL_SEAL | F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK;
    if (!S_ISREG(info.st_mode) || info.st_size != length || flags < 0 || seals < 0 ||
        (flags & O_ACCMODE) == O_WRONLY || (seals & required) != required) { errno = EINVAL; return false; }
    return true;
}

int pu_frame_create(const uint32_t meta[PU_FRAME_META_WORDS], const uint8_t *rgba[PU_FRAME_STRIPS],
    const size_t lengths[PU_FRAME_STRIPS], uint32_t *length)
{
    struct PuFrameStrip strips[PU_FRAME_STRIPS];
    if (!pu_frame_strips(meta, strips, length)) { errno = EINVAL; return -1; }
    for (unsigned i = 0; i < PU_FRAME_STRIPS; i++)
        if (lengths[i] != (size_t)strips[i].width * strips[i].height * 4 ||
            (lengths[i] && !rgba[i])) { errno = EINVAL; return -1; }
    int fd = memfd_create("polly-decoration", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (fd < 0) return -1;
    if (ftruncate(fd, *length)) { int error = errno; close(fd); errno = error; return -1; }
    uint32_t *mapped = mmap(NULL, *length, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (mapped == MAP_FAILED) { int error = errno; close(fd); errno = error; return -1; }
    mapped[0] = PU_FRAME_MAGIC; mapped[1] = PU_FRAME_VERSION; mapped[2] = *length;
    memcpy(mapped + 3, meta, PU_FRAME_META_WORDS * sizeof(uint32_t));
    for (unsigned i = 0; i < PU_FRAME_STRIPS; i++) {
        uint32_t *record = mapped + 3 + PU_FRAME_META_WORDS + i * 4;
        record[0] = strips[i].width; record[1] = strips[i].height;
        record[2] = strips[i].stride; record[3] = strips[i].offset;
        uint32_t *pixels = (uint32_t *)((uint8_t *)mapped + strips[i].offset);
        for (size_t pixel = 0; pixel < lengths[i] / 4; pixel++) {
            const uint8_t *p = rgba[i] + pixel * 4;
            uint32_t a = p[3];
            pixels[pixel] = a << 24 | ((p[0] * a + 127) / 255) << 16 |
                ((p[1] * a + 127) / 255) << 8 | ((p[2] * a + 127) / 255);
        }
    }
    munmap(mapped, *length);
    if (fcntl(fd, F_ADD_SEALS, F_SEAL_SEAL | F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK) < 0) {
        int error = errno; close(fd); errno = error; return -1;
    }
    return fd;
}
