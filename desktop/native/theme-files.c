#define _POSIX_C_SOURCE 200809L
#include "theme-files.h"
#include "windows.h"
#include "appearance-config.h"
#include "render/skia_c.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <inttypes.h>
#include <sys/stat.h>
#include <unistd.h>

#define THEME_FILE_LIMIT (128 * 1024)
#define THEME_TOTAL_LIMIT (512 * 1024)
#define THEME_ASSET_PIXELS (16 * 1024 * 1024)

struct ThemeAsset {
    struct ThemeAsset *next;
    char key[64];
    size_t pixels;
};
static struct ThemeAsset *assets;
static size_t asset_pixels;
static unsigned asset_count;
static uint64_t asset_serial;

static int fail(JSContext *ctx, const char *operation)
{
    JS_ThrowInternalError(ctx, "%s: %s", operation, strerror(errno));
    return -1;
}

static int owned_directory(JSContext *ctx, int parent, const char *name)
{
    int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return errno == ENOENT ? -2 : fail(ctx, "Cannot open theme directory");
    struct stat info;
    if (fstat(fd, &info) || info.st_uid != geteuid() || (info.st_mode & 022)) {
        close(fd);
        JS_ThrowTypeError(ctx, "Theme directories must be user-owned and not writable by other users");
        return -1;
    }
    return fd;
}

static int root_directory(JSContext *ctx, const char *variable, const char *fallback, const char *child)
{
    const char *base = getenv(variable);
    char path[PATH_MAX];
    if (base && *base) {
        if (*base != '/' || strlen(base) >= sizeof(path)) {
            JS_ThrowTypeError(ctx, "%s must be a bounded absolute path", variable); return -1;
        }
        strcpy(path, base);
    } else {
        const char *home = getenv("HOME");
        int length = home && *home == '/' ? snprintf(path, sizeof(path), "%s/%s", home, fallback) : -1;
        if (length < 0 || length >= (int)sizeof(path)) {
            JS_ThrowTypeError(ctx, "Theme paths require an absolute HOME"); return -1;
        }
    }
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return fail(ctx, "Cannot open filesystem root for theme lookup");
    char *state, *part = strtok_r(path, "/", &state);
    while (part) {
        if (!strcmp(part, ".") || !strcmp(part, "..")) {
            close(fd); JS_ThrowTypeError(ctx, "Theme paths cannot contain relative components"); return -1;
        }
        int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        int failure = errno;
        close(fd);
        if (next < 0) {
            errno = failure;
            return failure == ENOENT ? -2 : fail(ctx, "Cannot traverse theme path");
        }
        fd = next;
        part = strtok_r(NULL, "/", &state);
    }
    int next = owned_directory(ctx, fd, "pollyui");
    close(fd);
    if (next < 0 || !child) return next;
    fd = owned_directory(ctx, next, child);
    close(next);
    return fd;
}

static char *read_owned_file(JSContext *ctx, int parent, const char *name, size_t limit, bool text_only, size_t *length)
{
    *length = 0;
    int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
        if (errno != ENOENT) fail(ctx, "Cannot open theme definition");
        return NULL;
    }
    struct stat info;
    if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != geteuid() ||
        (info.st_mode & 022) || info.st_size < 1 || (uint64_t)info.st_size > limit) {
        close(fd);
        JS_ThrowTypeError(ctx, "Theme definitions must be bounded, regular, user-owned files");
        return NULL;
    }
    size_t size = (size_t)info.st_size;
    char *text = malloc(size + 1);
    if (!text) { close(fd); JS_ThrowOutOfMemory(ctx); return NULL; }
    size_t offset = 0;
    while (offset < size) {
        ssize_t count = read(fd, text + offset, size - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) {
            free(text); close(fd);
            JS_ThrowInternalError(ctx, "Theme definition changed or could not be read"); return NULL;
        }
        offset += (size_t)count;
    }
    char extra;
    ssize_t trailing;
    do { trailing = read(fd, &extra, 1); } while (trailing < 0 && errno == EINTR);
    close(fd);
    if (trailing != 0 || (text_only && memchr(text, 0, size))) {
        free(text); JS_ThrowTypeError(ctx, "Theme definition grew or contains a NUL"); return NULL;
    }
    text[size] = 0; *length = size;
    return text;
}

static char *read_definition(JSContext *ctx, int parent, const char *name, size_t *length)
{ return read_owned_file(ctx, parent, name, THEME_FILE_LIMIT, true, length); }

static int property(JSContext *ctx, JSValueConst object, const char *name, JSValue value)
{
    return !JS_IsException(value) && JS_SetPropertyStr(ctx, object, name, value) >= 0;
}

static JSValue read_files(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!pu_desktop_windows_ready(ctx)) return JS_EXCEPTION;
    JSValue result = JS_NewObject(ctx), files = JS_NewArray(ctx);
    DIR *directory = NULL;
    int fd = -1;
    if (JS_IsException(result) || JS_IsException(files)) goto failed;
    fd = root_directory(ctx, "XDG_DATA_HOME", ".local/share", "themes");
    if (fd == -1) goto failed;
    if (fd >= 0) {
        directory = fdopendir(fd);
        if (!directory) { fail(ctx, "Cannot enumerate theme definitions"); goto failed; }
        fd = -1;
        unsigned count = 0;
        size_t total = 0;
        for (;;) {
            errno = 0;
            struct dirent *entry = readdir(directory);
            if (!entry) {
                if (errno) { fail(ctx, "Cannot enumerate theme definitions"); goto failed; }
                break;
            }
            if (entry->d_name[0] == '.') continue;
            struct stat info;
            if (fstatat(dirfd(directory), entry->d_name, &info, AT_SYMLINK_NOFOLLOW)) {
                fail(ctx, "Cannot inspect theme entry"); goto failed;
            }
            if (S_ISLNK(info.st_mode)) {
                JS_ThrowTypeError(ctx, "Theme directory links are not supported"); goto failed;
            }
            if (!S_ISDIR(info.st_mode)) continue;
            if (!pu_appearance_identifier(entry->d_name)) {
                JS_ThrowTypeError(ctx, "Invalid theme directory name"); goto failed;
            }
            int child = owned_directory(ctx, dirfd(directory), entry->d_name);
            if (child < 0) {
                if (child == -2) JS_ThrowInternalError(ctx, "Theme directory disappeared");
                goto failed;
            }
            size_t length;
            char *text = read_definition(ctx, child, "theme.json", &length);
            close(child);
            if (!text) {
                if (JS_HasException(ctx)) goto failed;
                continue;
            }
            total += length;
            if (count >= 64 || total > THEME_TOTAL_LIMIT) {
                free(text); JS_ThrowRangeError(ctx, "Theme catalog file limits exceeded"); goto failed;
            }
            JSValue item = JS_NewObject(ctx);
            int ok = !JS_IsException(item) && property(ctx, item, "id", JS_NewString(ctx, entry->d_name)) &&
                property(ctx, item, "text", JS_NewStringLen(ctx, text, length));
            free(text);
            if (!ok) { JS_FreeValue(ctx, item); goto failed; }
            if (JS_SetPropertyUint32(ctx, files, count++, item) < 0) goto failed;
        }
        closedir(directory); directory = NULL;
    }
    fd = root_directory(ctx, "XDG_CONFIG_HOME", ".config", NULL);
    if (fd == -1) goto failed;
    JSValue overrides = JS_NULL;
    if (fd >= 0) {
        size_t length;
        char *text = read_definition(ctx, fd, "theme-overrides.json", &length);
        close(fd); fd = -1;
        if (!text && JS_HasException(ctx)) goto failed;
        if (text) { overrides = JS_NewStringLen(ctx, text, length); free(text); }
    }
    if (!property(ctx, result, "overrides", overrides)) goto failed;
    if (!property(ctx, result, "files", JS_DupValue(ctx, files))) goto failed;
    JS_FreeValue(ctx, files);
    return result;
failed:
    if (directory) closedir(directory);
    if (fd >= 0) close(fd);
    JS_FreeValue(ctx, result); JS_FreeValue(ctx, files);
    return JS_EXCEPTION;
}

static JSValue load_asset(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!pu_desktop_windows_ready(ctx)) return JS_EXCEPTION;
    if (argc != 2 || !JS_IsString(argv[0]) || !JS_IsString(argv[1]))
        return JS_ThrowTypeError(ctx, "Theme asset requires an ID and relative bitmap path");
    size_t id_length, path_length;
    const char *id = JS_ToCStringLen(ctx, &id_length, argv[0]);
    const char *input = JS_ToCStringLen(ctx, &path_length, argv[1]);
    JSValue result = JS_EXCEPTION;
    int fd = -1;
    char *bytes = NULL;
    if (!id || !input) goto done;
    if (strlen(id) != id_length || !pu_appearance_identifier(id) || !path_length || path_length > 192 ||
        strlen(input) != path_length || input[0] == '/' || input[path_length - 1] == '/' || strstr(input, "//")) {
        JS_ThrowTypeError(ctx, "Invalid theme bitmap path"); goto done;
    }
    const char *suffix = strrchr(input, '.');
    if (!suffix || (strcasecmp(suffix, ".png") && strcasecmp(suffix, ".jpg") && strcasecmp(suffix, ".jpeg"))) {
        JS_ThrowTypeError(ctx, "Theme bitmaps must be PNG or JPEG"); goto done;
    }
    if (asset_count >= 8 || asset_serial == UINT64_MAX) {
        JS_ThrowRangeError(ctx, "Theme asset limit reached"); goto done;
    }
    fd = root_directory(ctx, "XDG_DATA_HOME", ".local/share", "themes");
    if (fd < 0) {
        if (fd == -2) JS_ThrowTypeError(ctx, "Theme resource directory is missing");
        goto done;
    }
    int child = owned_directory(ctx, fd, id);
    close(fd); fd = child;
    if (fd < 0) {
        if (fd == -2) JS_ThrowTypeError(ctx, "Theme resource owner is missing");
        goto done;
    }
    char path[193];
    memcpy(path, input, path_length + 1);
    char *state, *part = strtok_r(path, "/", &state);
    unsigned depth = 0;
    while (part) {
        if (++depth > 8 || part[0] == '.') {
            JS_ThrowTypeError(ctx, "Theme asset paths cannot contain hidden or relative components"); goto done;
        }
        for (const char *p = part; *p; p++)
            if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
                (*p >= '0' && *p <= '9') || *p == '_' || *p == '-' || *p == '.')) {
                JS_ThrowTypeError(ctx, "Unsupported theme asset path character"); goto done;
            }
        char *next = strtok_r(NULL, "/", &state);
        if (next) {
            child = owned_directory(ctx, fd, part);
            close(fd); fd = child;
            if (fd < 0) {
                if (fd == -2) JS_ThrowTypeError(ctx, "Theme asset subdirectory is missing");
                goto done;
            }
        } else {
            size_t length;
            bytes = read_owned_file(ctx, fd, part, 4 * 1024 * 1024, false, &length);
            if (!bytes) {
                if (!JS_HasException(ctx)) JS_ThrowTypeError(ctx, "Theme bitmap is missing");
                goto done;
            }
            struct ThemeAsset *asset = calloc(1, sizeof(*asset));
            if (!asset) { JS_ThrowOutOfMemory(ctx); goto done; }
            snprintf(asset->key, sizeof(asset->key), "polly-memory:theme-%" PRIu64, ++asset_serial);
            int width, height;
            if (!pu_image_set_bitmap(asset->key, (uint8_t *)bytes, length,
                THEME_ASSET_PIXELS - asset_pixels, &width, &height)) {
                free(asset); JS_ThrowTypeError(ctx, "Cannot decode theme bitmap within supported limits"); goto done;
            }
            result = JS_NewString(ctx, asset->key);
            if (JS_IsException(result)) { pu_image_remove(asset->key); free(asset); goto done; }
            asset->pixels = (size_t)width * (size_t)height;
            asset_pixels += asset->pixels; asset_count++;
            asset->next = assets; assets = asset;
        }
        part = next;
    }
done:
    if (fd >= 0) close(fd);
    free(bytes);
    JS_FreeCString(ctx, id); JS_FreeCString(ctx, input);
    return result;
}

static JSValue release_asset(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!pu_desktop_windows_ready(ctx)) return JS_EXCEPTION;
    if (argc != 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "A live theme asset key is required");
    size_t length;
    const char *key = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!key) return JS_EXCEPTION;
    struct ThemeAsset **slot = &assets;
    while (*slot && (strlen((*slot)->key) != length || memcmp((*slot)->key, key, length))) slot = &(*slot)->next;
    JS_FreeCString(ctx, key);
    if (!*slot) return JS_ThrowTypeError(ctx, "Theme asset is no longer owned");
    struct ThemeAsset *asset = *slot;
    *slot = asset->next;
    asset_pixels -= asset->pixels; asset_count--;
    pu_image_remove(asset->key); free(asset);
    return JS_UNDEFINED;
}

int pu_theme_files_install(JSContext *ctx, JSValueConst api)
{
    return property(ctx, api, "readThemeFiles", JS_NewCFunction(ctx, read_files, "readThemeFiles", 0)) &&
        property(ctx, api, "loadThemeAsset", JS_NewCFunction(ctx, load_asset, "loadThemeAsset", 2)) &&
        property(ctx, api, "releaseThemeAsset", JS_NewCFunction(ctx, release_asset, "releaseThemeAsset", 1));
}

void pu_theme_files_shutdown(void)
{
    while (assets) {
        struct ThemeAsset *next = assets->next;
        pu_image_remove(assets->key); free(assets); assets = next;
    }
    asset_count = 0; asset_pixels = 0; asset_serial = 0;
}
