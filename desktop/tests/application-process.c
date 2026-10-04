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
    if (getenv("WAYLAND_SOCKET") || getenv("DISPLAY") || getenv("SDL_APP_ID")) return 92;
    const char *bus = getenv("DBUS_SESSION_BUS_ADDRESS");
    if (!bus || strcmp(bus, "disabled:")) return 93;
    if (argc > 2 && !strcmp(argv[2], "--later")) sleep(1);
    FILE *file = fopen(argv[1], "wb");
    if (!file) return 94;
    for (int i = 2; i < argc; i++) fwrite(argv[i], 1, strlen(argv[i]) + 1, file);
    char cwd[PATH_MAX];
    if (!getcwd(cwd, sizeof(cwd))) return 95;
    fwrite(cwd, 1, strlen(cwd) + 1, file);
    const char *display = getenv("WAYLAND_DISPLAY");
    if (!display) return 96;
    fwrite(display, 1, strlen(display) + 1, file);
    if (fclose(file)) return 97;
    return argc > 2 && !strcmp(argv[2], "--exit23") ? 23 : 0;
}
