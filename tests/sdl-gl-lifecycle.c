#include <SDL3/SDL.h>
#include <stdio.h>
#include <string.h>

struct target {
    SDL_Window *window;
    SDL_Renderer *renderer;
};

#ifdef __GLIBC__
static long executable_mapping_bytes(void)
{
    FILE *maps = fopen("/proc/self/maps", "r");
    if (!maps) return -1;
    char line[1024];
    unsigned long total = 0;
    while (fgets(line, sizeof(line), maps)) {
        unsigned long start, end, offset, inode;
        char permissions[5], device[16], name[128];
        int fields = sscanf(line, "%lx-%lx %4s %lx %15s %lu %127s",
            &start, &end, permissions, &offset, device, &inode, name);
        if (fields == 6 && strcmp(permissions, "rwxp") == 0)
            total += end - start;
    }
    bool valid = !ferror(maps);
    fclose(maps);
    return valid ? (long)total : -1;
}
#endif

static bool create(struct target *target)
{
    target->window = SDL_CreateWindow("GL lifecycle fixture", 32, 32, SDL_WINDOW_HIDDEN);
    if (!target->window) return false;
    target->renderer = SDL_CreateRenderer(target->window, "opengles2");
    return target->renderer && strcmp(SDL_GetRendererName(target->renderer), "opengles2") == 0;
}

static void destroy(struct target *target)
{
    SDL_DestroyRenderer(target->renderer);
    SDL_DestroyWindow(target->window);
    target->renderer = NULL;
    target->window = NULL;
}

static bool paint(struct target *target)
{
    const SDL_FRect rectangle = {4, 4, 20, 20};
    if (!SDL_SetRenderDrawColor(target->renderer, 0, 0, 0, 255) ||
        !SDL_RenderClear(target->renderer) ||
        !SDL_SetRenderDrawColor(target->renderer, 128, 64, 32, 255) ||
        !SDL_RenderFillRect(target->renderer, &rectangle)) return false;
    SDL_Surface *surface = SDL_RenderReadPixels(target->renderer, NULL);
    if (!surface) return false;
    Uint8 red = 0, green = 0, blue = 0, alpha = 0;
    bool valid = SDL_ReadSurfacePixel(surface, 8, 8, &red, &green, &blue, &alpha) &&
        red == 128 && green == 64 && blue == 32 && alpha == 255;
    SDL_DestroySurface(surface);
    if (!valid) {
        fprintf(stderr, "FAIL: GL readback was %u,%u,%u,%u\n", red, green, blue, alpha);
        return false;
    }
    return SDL_RenderPresent(target->renderer);
}

int main(void)
{
#ifdef __GLIBC__
    const long initial_mapping_bytes = executable_mapping_bytes();
    if (initial_mapping_bytes < 0) {
        fputs("FAIL: cannot inspect this process's executable mappings\n", stderr);
        return 1;
    }
#endif
    for (int round = 0; round < 10; ++round) {
        struct target first = {0}, second = {0};
        bool valid = SDL_Init(SDL_INIT_VIDEO) && create(&first) && create(&second) &&
            paint(&first) && paint(&second);
        destroy(&first);
        if (valid) valid = paint(&second);
        if (!valid) fprintf(stderr, "FAIL: GL lifetime round %d: %s\n", round, SDL_GetError());
        destroy(&second);
        SDL_Quit();
#ifdef __GLIBC__
        long remaining = executable_mapping_bytes();
        if (remaining < 0 || remaining > initial_mapping_bytes) {
            fprintf(stderr, "FAIL: GL shutdown left %ld extra anonymous executable bytes\n",
                remaining - initial_mapping_bytes);
            valid = false;
        }
#endif
        if (!valid) return 1;
    }
    puts("PASS: ten complete GL load/unload cycles, two live contexts and surviving-context pixel readback");
    return 0;
}
