#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    if (argc < 2) return 2;
    for (int fd = 3; fd < 128; fd++)
        if (fcntl(fd, F_GETFD) >= 0 || errno != EBADF) return 91;
    if (getenv("WAYLAND_SOCKET") || getenv("DISPLAY") || getenv("SDL_APP_ID") ||
        getenv("DBUS_STARTER_ADDRESS") || getenv("DBUS_STARTER_BUS_TYPE")) return 92;
    const char *bus = getenv("DBUS_SESSION_BUS_ADDRESS"), *display = getenv("WAYLAND_DISPLAY");
    if (!bus || strncmp(bus, "unix:path=", 10) || !display) return 93;
    FILE *file = fopen(argv[1], "wb");
    if (!file) return 94;
    for (int i = 2; i < argc; i++) if (fwrite(argv[i], 1, strlen(argv[i]) + 1, file) != strlen(argv[i]) + 1) return 95;
    char cwd[PATH_MAX];
    if (!getcwd(cwd, sizeof(cwd))) return 96;
    const char *tail[] = { cwd, bus, display };
    for (size_t i = 0; i < sizeof(tail) / sizeof(tail[0]); i++)
        if (fwrite(tail[i], 1, strlen(tail[i]) + 1, file) != strlen(tail[i]) + 1) return 97;
    return fclose(file) ? 98 : 0;
}
