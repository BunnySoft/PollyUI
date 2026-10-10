#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static void fail(int error)
{
    const char *bytes = (const char *)&error;
    size_t remaining = sizeof(error);
    while (remaining) {
        ssize_t count = write(3, bytes, remaining);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        bytes += count;
        remaining -= (size_t)count;
    }
    _exit(127);
}

int main(int argc, char **argv)
{
    struct stat status;
    if (argc < 2 || fstat(3, &status) < 0 || !S_ISFIFO(status.st_mode)) {
        fputs("This internal launcher requires an exec-status pipe\n", stderr);
        return 2;
    }
    if (fcntl(3, F_SETFD, FD_CLOEXEC) < 0) fail(errno);
    int closed = 0;
#ifdef SYS_close_range
    closed = syscall(SYS_close_range, 4u, UINT_MAX, 0) == 0;
#endif
    if (!closed) {
        DIR *directory = opendir("/proc/self/fd");
        if (!directory) fail(errno);
        int keep = dirfd(directory);
        struct dirent *entry;
        for (;;) {
            errno = 0;
            entry = readdir(directory);
            if (!entry) {
                int error = errno;
                closedir(directory);
                if (error) fail(error);
                break;
            }
            char *end;
            long fd = strtol(entry->d_name, &end, 10);
            if (!*end && fd >= 4 && fd != keep && fd <= INT_MAX) close((int)fd);
        }
    }
    execv(argv[1], &argv[1]);
    fail(errno);
}
