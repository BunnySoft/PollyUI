#ifndef _XOPEN_SOURCE
#define _XOPEN_SOURCE 700
#endif
#include "core/app_paths.h"
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(__linux__)
#include <sys/stat.h>
#include <unistd.h>
#endif

static char *copy_string(const char *value)
{
    size_t length = strlen(value) + 1;
    char *copy = malloc(length);
    if (copy) memcpy(copy, value, length);
    return copy;
}

void pu_app_paths_free(PuAppPaths *paths)
{
    free(paths->id); free(paths->config); free(paths->data); free(paths->cache); free(paths->storage);
    memset(paths, 0, sizeof(*paths));
}

#if defined(__linux__)
static int valid_id(const char *id)
{
    size_t length = strlen(id);
    if (!length || length > 128 || id[0] == '.' || id[0] == '-') return 0;
    for (const unsigned char *p = (const unsigned char *)id; *p; p++)
        if (!( (*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
               (*p >= '0' && *p <= '9') || *p == '.' || *p == '-' || *p == '_')) return 0;
    return 1;
}

static int make_directory(const char *path)
{
    struct stat info;
    if (mkdir(path, 0700) < 0 && errno != EEXIST) return 0;
    return stat(path, &info) == 0 && S_ISDIR(info.st_mode);
}

static int private_directory(const char *path)
{
    char *copy = copy_string(path);
    if (!copy) return 0;
    for (char *p = copy + 1; *p; p++) {
        if (*p != '/') continue;
        *p = 0;
        if (!make_directory(copy)) { free(copy); return 0; }
        *p = '/';
    }
    int ok = make_directory(copy);
    struct stat info;
    if (ok) ok = lstat(copy, &info) == 0 && S_ISDIR(info.st_mode) &&
                 info.st_uid == geteuid() && (info.st_mode & 077) == 0;
    free(copy);
    return ok;
}

static char *xdg_directory(const char *variable, const char *fallback, const char *id)
{
    const char *base = getenv(variable);
    char *default_base = NULL;
    if (!base || !*base) {
        const char *home = getenv("HOME");
        if (!home || home[0] != '/') { fprintf(stderr, "[paths] HOME must be absolute when %s is unset\n", variable); return NULL; }
        size_t length = strlen(home) + strlen(fallback) + 2;
        default_base = malloc(length);
        if (!default_base) return NULL;
        snprintf(default_base, length, "%s/%s", home, fallback);
        base = default_base;
    }
    if (base[0] != '/') { fprintf(stderr, "[paths] %s must be absolute\n", variable); free(default_base); return NULL; }
    size_t length = strlen(base) + strlen(id) + 11;
    char *path = malloc(length);
    if (path) snprintf(path, length, "%s/pollyui/%s", base, id);
    free(default_base);
    if (!path || !private_directory(path)) {
        fprintf(stderr, "[paths] Cannot create a private, user-owned application directory for %s\n", variable);
        free(path); return NULL;
    }
    return path;
}
#endif

int pu_app_paths_init(PuAppPaths *paths, const char *script, const char *app_id)
{
    memset(paths, 0, sizeof(*paths));
#if defined(__linux__)
    char generated[32];
    if (app_id && !valid_id(app_id)) {
        fprintf(stderr, "[paths] Invalid application ID (use up to 128 letters, digits, dots, hyphens or underscores)\n");
        return 0;
    }
    char *canonical = realpath(script, NULL);
    if (!canonical) { perror("[paths] Cannot resolve application entry"); return 0; }
    if (!app_id) {
        uint64_t hash = UINT64_C(14695981039346656037);
        for (const unsigned char *p = (const unsigned char *)canonical; *p; p++)
            hash = (hash ^ *p) * UINT64_C(1099511628211);
        snprintf(generated, sizeof(generated), "script-%016llx", (unsigned long long)hash);
        app_id = generated;
    }
    free(canonical);
    paths->id = copy_string(app_id);
    if (!paths->id) { fprintf(stderr, "[paths] Cannot allocate application identity\n"); goto fail; }
    paths->config = xdg_directory("XDG_CONFIG_HOME", ".config", app_id);
    if (!paths->config) goto fail;
    paths->data = xdg_directory("XDG_DATA_HOME", ".local/share", app_id);
    if (!paths->data) goto fail;
    paths->cache = xdg_directory("XDG_CACHE_HOME", ".cache", app_id);
    if (!paths->cache) goto fail;
    size_t length = strlen(paths->data) + sizeof("/localstorage.dat");
    paths->storage = malloc(length);
    if (paths->storage) snprintf(paths->storage, length, "%s/localstorage.dat", paths->data);
    if (paths->storage && access(paths->storage, F_OK) != 0 &&
        access("pollyui_localstorage.dat", F_OK) == 0)
        fprintf(stderr, "[paths] Legacy working-directory storage was not migrated; choose an app ID and migrate data explicitly\n");
#else
    (void)script;
    if (app_id) { fprintf(stderr, "[paths] --app-id storage namespaces are currently Linux-only\n"); return 0; }
    paths->id = copy_string("pollyui");
    paths->storage = copy_string("pollyui_localstorage.dat");
#endif
    if (paths->id && paths->storage) return 1;
    fprintf(stderr, "[paths] Cannot allocate application paths\n");
#if defined(__linux__)
fail:
#endif
    pu_app_paths_free(paths);
    return 0;
}
