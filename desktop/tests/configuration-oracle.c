#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

ssize_t write(int fd, const void *buffer, size_t count);
int fsync(int fd);
int renameat2(int oldfd, const char *old, int newfd, const char *name, unsigned flags);
int close(int fd);
void *dlsym(void *handle, const char *name)
{
    void *(*real)(void *, const char *) = dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.2.5");
    if (handle != RTLD_NEXT) {
        if (!strcmp(name, "write")) return write;
        if (!strcmp(name, "fsync")) return fsync;
        if (!strcmp(name, "renameat2")) return renameat2;
        if (!strcmp(name, "close")) return close;
    }
    return real(handle, name);
}
static int selected(int fd, int directory)
{
    char path[64], target[4096];
    snprintf(path, sizeof(path), "/proc/self/fd/%d", fd);
    ssize_t size = readlink(path, target, sizeof(target) - 1);
    if (size < 0) return 0;
    target[size] = 0;
    return directory ? strstr(target, "/config") && !strstr(target, ".configuration-") :
        strstr(target, "/.configuration-") != NULL;
}
static const char *fault(void) { const char *value = getenv("POLLY_CONFIG_FAULT"); return value ? value : ""; }
ssize_t write(int fd, const void *buffer, size_t count)
{
    static int interrupted;
    ssize_t (*real)(int, const void *, size_t) = dlsym(RTLD_NEXT, "write");
    if (selected(fd, 0)) {
        if (!strcmp(fault(), "write")) { errno = ENOSPC; return -1; }
        if (!strcmp(fault(), "zero")) return 0;
        if (!strcmp(fault(), "short")) {
            if (!interrupted++) { errno = EINTR; return -1; }
            if (count > 7) count = 7;
        }
    }
    return real(fd, buffer, count);
}
int fsync(int fd)
{
    int (*real)(int) = dlsym(RTLD_NEXT, "fsync");
    if ((!strcmp(fault(), "sync") && selected(fd, 0)) ||
        (!strcmp(fault(), "directory") && selected(fd, 1))) { errno = EIO; return -1; }
    return real(fd);
}
int renameat2(int oldfd, const char *old, int newfd, const char *name, unsigned flags)
{
    int (*real)(int, const char *, int, const char *, unsigned) = dlsym(RTLD_NEXT, "renameat2");
    if (!strcmp(fault(), "rename") && !strncmp(old, ".configuration-", 15)) { errno = EIO; return -1; }
    if (!strcmp(fault(), "race") && flags && !strncmp(old, ".configuration-", 15)) {
        int fd = openat(newfd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        if (fd < 0) return -1;
        const char data[] = "{\"version\":99}";
        if (write(fd, data, sizeof(data) - 1) != sizeof(data) - 1 || close(fd)) return -1;
    }
    return real(oldfd, old, newfd, name, flags);
}
int close(int fd)
{
    int (*real)(int) = dlsym(RTLD_NEXT, "close");
    int fail = !strcmp(fault(), "close") && selected(fd, 0);
    int result = real(fd);
    if (!result && fail) { errno = EIO; return -1; }
    return result;
}
