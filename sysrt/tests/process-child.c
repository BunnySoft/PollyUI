#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

int main(int argc, char **argv)
{
    if (argc == 2 && !strcmp(argv[1], "--exit")) return 23;
    if (argc == 3 && !strcmp(argv[1], "--probe")) {
        const char *value = getenv("SYSRT_PROCESS_VALUE");
        return !strcmp(argv[2], "literal %u; $(not a shell)") && value && !strcmp(value, "explicit environment") ? 19 : 99;
    }
    if (argc == 2 && !strcmp(argv[1], "--linger")) {
#ifdef _WIN32
        Sleep(30000);
#else
        sleep(30);
#endif
        return 97;
    }
    return 98;
}
