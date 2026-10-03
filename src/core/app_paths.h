#ifndef POLLYUI_CORE_APP_PATHS_H
#define POLLYUI_CORE_APP_PATHS_H

typedef struct PuAppPaths {
    char *id, *config, *data, *cache, *storage;
} PuAppPaths;

/* Linux uses private XDG app directories. Other hosts retain their legacy
 * storage path until their native application-directory policy is implemented. */
int pu_app_paths_init(PuAppPaths *paths, const char *script, const char *app_id);
void pu_app_paths_free(PuAppPaths *paths);

#endif
