#define _GNU_SOURCE
#include "appearance-document.h"
#include "appearance-config.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

static const int seals = F_SEAL_SEAL | F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK;

bool pu_appearance_document_valid(int fd, uint32_t length)
{
    if (fd < 0 || !length || length > PU_APPEARANCE_DOCUMENT_LIMIT) { errno = EINVAL; return false; }
    struct stat info;
    if (fstat(fd, &info)) return false;
    if (!S_ISREG(info.st_mode) || info.st_size != (off_t)length) { errno = EINVAL; return false; }
    int flags = fcntl(fd, F_GETFL), actual = fcntl(fd, F_GET_SEALS);
    if (flags < 0 || actual < 0) return false;
    if ((flags & O_ACCMODE) == O_WRONLY || (actual & seals) != seals) { errno = EPERM; return false; }
    return true;
}

int pu_appearance_document_create(const char *bytes, size_t length)
{
    if (!bytes || !length || length > PU_APPEARANCE_DOCUMENT_LIMIT || memchr(bytes, 0, length)) {
        errno = EINVAL; return -1;
    }
    int fd = memfd_create("polly-theme", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (fd < 0) return -1;
    size_t offset = 0;
    while (offset < length) {
        ssize_t written = write(fd, bytes + offset, length - offset);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) {
            int error = written < 0 ? errno : EIO;
            close(fd); errno = error; return -1;
        }
        offset += (size_t)written;
    }
    if (fcntl(fd, F_ADD_SEALS, seals) < 0) {
        int error = errno; close(fd); errno = error; return -1;
    }
    return fd;
}

char *pu_appearance_document_read(int fd, uint32_t length)
{
    if (!pu_appearance_document_valid(fd, length)) return NULL;
    char *text = malloc((size_t)length + 1);
    if (!text) return NULL;
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = pread(fd, text + offset, length - offset, (off_t)offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { int error = count < 0 ? errno : EIO; free(text); errno = error; return NULL; }
        offset += (size_t)count;
    }
    if (memchr(text, 0, length)) { free(text); errno = EINVAL; return NULL; }
    text[length] = 0;
    return text;
}
