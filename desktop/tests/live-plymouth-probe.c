#define _POSIX_C_SOURCE 200809L
#include <dlfcn.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define LOAD(handle, name) do { \
    void *symbol = dlsym(handle, #name); \
    if (!symbol) { fprintf(stderr, "%s: %s\n", #name, dlerror()); return 1; } \
    _Static_assert(sizeof(name) == sizeof(symbol), "POSIX function pointer size"); \
    memcpy(&name, &symbol, sizeof(name)); \
} while (0)

int main(int argc, char **argv)
{
    if (argc == 2 && !strcmp(argv[1], "--ignore-term")) {
        if (signal(SIGTERM, SIG_IGN) == SIG_ERR) return 1;
        puts("IGNORE_TERM_READY");
        fflush(stdout);
        for (;;) pause();
    }
    if (argc == 4 && !strcmp(argv[1], "--signals")) {
        for (int i = 2; i < 4; i++) {
            int number = atoi(argv[i]);
            struct sigaction action;
            if (number <= 0 || sigaction(number, NULL, &action) || action.sa_handler != SIG_DFL)
                return 1;
        }
        puts("PASS: caught bootstrap realtime signals reset to SIG_DFL on exec");
        return 0;
    }
    void *script = dlopen("/usr/lib/x86_64-linux-gnu/plymouth/script.so", RTLD_NOW | RTLD_LOCAL);
    if (!script) { fprintf(stderr, "%s\n", dlerror()); return 1; }
    void *(*script_parse_file)(const char *);
    void (*script_parse_op_free)(void *);
    LOAD(script, script_parse_file);
    LOAD(script, script_parse_op_free);
    void *parsed = script_parse_file("/usr/share/plymouth/themes/polly/polly.script");
    if (!parsed) { fputs("Polly Plymouth script parse failed\n", stderr); return 1; }
    script_parse_op_free(parsed);
    dlclose(script);
    void *graphics = dlopen("libply-splash-graphics.so.5", RTLD_NOW | RTLD_LOCAL);
    if (!graphics) { fprintf(stderr, "%s\n", dlerror()); return 1; }
    void *(*ply_label_new)(void);
    void (*ply_label_set_text)(void *, const char *);
    void (*ply_label_set_font)(void *, const char *);
    long (*ply_label_get_width)(void *);
    long (*ply_label_get_height)(void *);
    void (*ply_label_free)(void *);
    LOAD(graphics, ply_label_new);
    LOAD(graphics, ply_label_set_text);
    LOAD(graphics, ply_label_set_font);
    LOAD(graphics, ply_label_get_width);
    LOAD(graphics, ply_label_get_height);
    LOAD(graphics, ply_label_free);
    void *label = ply_label_new();
    if (!label) return 1;
    ply_label_set_font(label, "DejaVu Sans 14");
    ply_label_set_text(label, "Copying compressed root to RAM | Esc: boot details");
    long width = ply_label_get_width(label), height = ply_label_get_height(label);
    if (width <= 0 || width > 4096 || height <= 0 || height > 256) {
        fprintf(stderr, "Plymouth label/font failed: %ld x %ld\n", width, height);
        return 1;
    }
    printf("PASS: real Plymouth script parser and exported label-pango/font shaping %ld x %ld; no display/frame/animation claim\n",
           width, height);
    ply_label_free(label);
    dlclose(graphics);
    return 0;
}
