#ifndef PU_SYSTEMRT_LINUX_FILES_H
#define PU_SYSTEMRT_LINUX_FILES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PU_FILES_PATH 4096
#define PU_FILES_NAME 256
#define PU_FILES_ID 192
#define PU_FILES_CONTENT_ID 256
#define PU_FILES_COUNT 1024
#define PU_FILES_TEXT (1024 * 1024)

typedef struct {
    char name[PU_FILES_NAME], path[PU_FILES_PATH], identity[PU_FILES_ID];
    char type[16], permissions[8], link_target[PU_FILES_PATH];
    char target_type[16], target_identity[PU_FILES_ID];
    char content_identity[PU_FILES_CONTENT_ID];
    int target_error;
    uint64_t bytes;
    double mtime_ms;
    uint32_t uid, gid;
    bool readable, writable;
} PuFileEntry;

typedef struct {
    char path[PU_FILES_PATH], identity[PU_FILES_ID];
    PuFileEntry *entries;
    size_t count;
    bool complete;
} PuFileDirectory;

typedef struct {
    char home[PU_FILES_PATH], documents[PU_FILES_PATH];
    char downloads[PU_FILES_PATH], desktop[PU_FILES_PATH];
} PuFileLocations;

int pu_files_locations(PuFileLocations *locations);
bool pu_files_path_valid(const char *path);
bool pu_files_name_valid(const char *name);
int pu_files_stat(const char *path, bool follow, PuFileEntry *entry);
int pu_files_list(const char *path, const char *expected, PuFileDirectory *result);
void pu_files_list_free(PuFileDirectory *result);
int pu_files_read(const char *path, const char *expected, char **text, size_t *length, PuFileEntry *entry);
int pu_files_observe_text(const char *path, PuFileEntry *entry);
int pu_files_write(const char *parent, const char *name, const char *text, size_t length,
                   const char *expected_parent, PuFileEntry *entry);
int pu_files_replace(const char *path, const char *text, size_t length, const char *expected,
                     const char *expected_parent, PuFileEntry *entry);
int pu_files_mkdir(const char *parent, const char *name, const char *expected_parent, PuFileEntry *entry);
int pu_files_rename(const char *path, const char *name, const char *expected,
                    const char *expected_parent, PuFileEntry *entry);

#endif
