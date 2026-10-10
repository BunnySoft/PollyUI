#define _GNU_SOURCE
#include "sysrt/providers/linux/files.h"
#include <assert.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static unsigned checks;
#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "FAIL line %d: %s (errno=%d)\n", __LINE__, #condition, errno); exit(1); } checks++; } while (0)
static const char *retiring_directory;
DIR *pu_files_fixture_fdopendir(int fd)
{
    if (retiring_directory) {
        CHECK(!rmdir(retiring_directory));
        retiring_directory = NULL;
    }
    return fdopendir(fd);
}
static PuFileEntry inspect(const char *path)
{
    PuFileEntry entry;
    CHECK(!pu_files_stat(path, false, &entry));
    return entry;
}
static void path(char *out, const char *parent, const char *name)
{
    CHECK(snprintf(out, PU_FILES_PATH, "%s/%s", parent, name) < PU_FILES_PATH);
}
static void contents(const char *file, const char *text)
{
    static time_t timestamp = 1000;
    int fd = open(file, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    CHECK(fd >= 0);
    CHECK(write(fd, text, strlen(text)) == (ssize_t)strlen(text));
    CHECK(!close(fd));
    struct timespec times[2] = { { .tv_nsec = UTIME_OMIT }, { .tv_sec = timestamp++ } };
    CHECK(!utimensat(AT_FDCWD, file, times, 0));
}

int main(int argc, char **argv)
{
    if (argc == 2 && !strcmp(argv[1], "--refuse-root")) {
        CHECK(geteuid() == 0);
        PuFileEntry entry;
        CHECK(pu_files_stat("/", false, &entry) == -1 && errno == EPERM);
        PuFileLocations locations;
        CHECK(pu_files_locations(&locations) == -1 && errno == EPERM);
        printf("PASS: UID0 file operations refused before filesystem access\n");
        return 0;
    }
    CHECK(getuid() == 1000 && geteuid() == 1000);
    char root[] = "/tmp/polly-files-core-XXXXXX";
    CHECK(mkdtemp(root) != NULL);
    CHECK(!setenv("HOME", root, 1));
    PuFileLocations locations;
    CHECK(!pu_files_locations(&locations));
    CHECK(!strcmp(locations.home, root));
    char expected[PU_FILES_PATH];
    path(expected, root, "Documents"); CHECK(!strcmp(locations.documents, expected));
    path(expected, root, "Downloads"); CHECK(!strcmp(locations.downloads, expected));
    path(expected, root, "Desktop"); CHECK(!strcmp(locations.desktop, expected));
    CHECK(!setenv("HOME", "relative-home", 1));
    CHECK(pu_files_locations(&locations) == -1 && errno == EINVAL);
    CHECK(!setenv("HOME", root, 1));
    PuFileDirectory snapshot;
    CHECK(!pu_files_list(root, NULL, &snapshot));
    CHECK(snapshot.complete && snapshot.count == 0);
    pu_files_list_free(&snapshot);
    PuFileEntry parent = inspect(root), entry;
    CHECK(pu_files_mkdir(root, "bad/name", parent.identity, &entry) == -1 && errno == EINVAL);
    CHECK(!pu_files_mkdir(root, "Documents", parent.identity, &entry));
    CHECK(!strcmp(entry.type, "directory") && !strcmp(entry.permissions, "0700"));
    PuFileEntry observed_parent = inspect(root);
    printf("OBSERVATION mkdir: before=%s after=%s same=%d\n", parent.identity, observed_parent.identity,
        !strcmp(parent.identity, observed_parent.identity));
    struct timespec changed[2] = { { .tv_nsec = UTIME_OMIT }, { .tv_sec = 1 } };
    CHECK(!utimensat(AT_FDCWD, root, changed, 0));
    int stale_result = pu_files_mkdir(root, "stale", parent.identity, &entry);
    if (stale_result != -1 || errno != ESTALE)
        fprintf(stderr, "stale parent: %s identity=%s result=%d errno=%d\n", root, parent.identity, stale_result, errno);
    CHECK(stale_result == -1 && errno == ESTALE);
    parent = inspect(root);
    CHECK(pu_files_mkdir(root, "Documents", parent.identity, &entry) == -1 && errno == EEXIST);
    CHECK(!pu_files_write(root, "space %u; $(literal).txt", "hello\n", 6, parent.identity, &entry));
    char file[PU_FILES_PATH]; strcpy(file, entry.path);
    char *text; size_t size;
    CHECK(!pu_files_read(file, entry.identity, &text, &size, &entry));
    CHECK(size == 6 && !strcmp(text, "hello\n")); free(text);
    parent = inspect(root);
    CHECK(pu_files_write(root, "space %u; $(literal).txt", "wrong", 5, parent.identity, &entry) == -1 && errno == EEXIST);
    entry = inspect(file);
    CHECK(!pu_files_read(file, entry.identity, &text, &size, &entry));
    CHECK(!strcmp(text, "hello\n")); free(text);
    parent = inspect(root);
    CHECK(pu_files_replace(file, "replaced", 8, entry.identity, parent.identity, &entry) == -1 && errno == EINVAL);
    CHECK(!pu_files_observe_text(file, &entry));
    CHECK(!pu_files_replace(file, "replaced", 8, entry.content_identity, parent.identity, &entry));
    CHECK(!pu_files_read(file, entry.identity, &text, &size, &entry));
    CHECK(!strcmp(text, "replaced")); free(text);
    char old_identity[PU_FILES_ID], old_content[PU_FILES_CONTENT_ID];
    bool alias = false;
    unsigned attempts = 0;
    for (; attempts < 64 && !alias; attempts++) {
        int original = open(file, O_WRONLY | O_TRUNC | O_CLOEXEC);
        CHECK(original >= 0 && write(original, "replaced", 8) == 8 && !close(original));
        CHECK(!pu_files_observe_text(file, &entry));
        strcpy(old_identity, entry.identity); strcpy(old_content, entry.content_identity);
        int external = open(file, O_WRONLY | O_TRUNC | O_CLOEXEC);
        CHECK(external >= 0 && write(external, "external", 8) == 8 && !close(external));
        PuFileEntry raw_external = inspect(file);
        alias = !strcmp(old_identity, raw_external.identity);
        if (alias) printf("OBSERVATION same-size external write: before=%s after=%s same=1\n", old_identity, raw_external.identity);
    }
    printf("OBSERVATION alias sampling: observed=%d attempts=%u bound=64\n", alias, attempts);
    parent = inspect(root);
    CHECK(pu_files_replace(file, "bad", 3, old_content, parent.identity, &entry) == -1 && errno == ESTALE);
    CHECK(pu_files_read(file, old_content, &text, &size, &entry) == -1 && errno == ESTALE);
    CHECK(!pu_files_observe_text(file, &entry));
    if (alias) CHECK(!strcmp(old_identity, entry.identity));
    CHECK(strcmp(old_content + strlen(old_content) - 64, entry.content_identity + strlen(entry.content_identity) - 64));
    printf("OBSERVATION strong content: before=%s after=%s old-token-refused=ESTALE\n", old_content, entry.content_identity);
    CHECK(!pu_files_replace(file, "new confirmation", 16, entry.content_identity, parent.identity, &entry));
    CHECK(!pu_files_read(file, entry.identity, &text, &size, &entry));
    CHECK(size == 16 && !strcmp(text, "new confirmation")); free(text);
    CHECK(!pu_files_observe_text(file, &entry));
    strcpy(old_content, entry.content_identity); strcpy(old_identity, entry.identity);
    contents(file, "external");
    parent = inspect(root);
    CHECK(pu_files_replace(file, "bad", 3, old_content, parent.identity, &entry) == -1 && errno == ESTALE);
    entry = inspect(file);
    CHECK(!pu_files_read(file, entry.identity, &text, &size, &entry));
    CHECK(!strcmp(text, "external")); free(text);
    CHECK(pu_files_read(file, old_identity, &text, &size, &entry) == -1 && errno == ESTALE);
    CHECK(!pu_files_observe_text(file, &entry)); strcpy(old_content, entry.content_identity);
    CHECK(!unlink(file)); parent = inspect(root);
    CHECK(pu_files_replace(file, "bad", 3, old_content, parent.identity, &entry) == -1 && errno == ESTALE);
    contents(file, "new inode"); parent = inspect(root);
    CHECK(pu_files_replace(file, "bad", 3, old_content, parent.identity, &entry) == -1 && errno == ESTALE);
    CHECK(!pu_files_observe_text(file, &entry)); strcpy(old_content, entry.content_identity);
    CHECK(!chmod(file, 0400)); entry = inspect(file); parent = inspect(root);
    CHECK(pu_files_replace(file, "bad", 3, old_content, parent.identity, &entry) == -1 && errno == EACCES);
    CHECK(!chmod(file, 0600)); entry = inspect(file); parent = inspect(root);
    CHECK(!pu_files_rename(file, "\xe6\x96\x87\xe4\xbb\xb6 renamed.txt", entry.identity, parent.identity, &entry));
    char renamed[PU_FILES_PATH]; strcpy(renamed, entry.path);
    char collision[PU_FILES_PATH]; path(collision, root, "collision"); contents(collision, "retain");
    entry = inspect(renamed); parent = inspect(root);
    CHECK(pu_files_rename(renamed, "collision", entry.identity, parent.identity, &entry) == -1 && errno == EEXIST);
    CHECK(pu_files_rename(renamed, "wrong-observation", "wrong identity", parent.identity, &entry) == -1 && errno == ESTALE);
    entry = inspect(collision);
    CHECK(!pu_files_read(collision, entry.identity, &text, &size, &entry));
    CHECK(!strcmp(text, "retain")); free(text);
    char hard_original[PU_FILES_PATH], hard_other[PU_FILES_PATH];
    path(hard_original, root, "hard-original.txt"); path(hard_other, root, "hard-other.txt");
    contents(hard_original, "shared");
    CHECK(!link(hard_original, hard_other));
    CHECK(!pu_files_observe_text(hard_original, &entry)); parent = inspect(root);
    CHECK(!pu_files_replace(hard_original, "independent", 11, entry.content_identity, parent.identity, &entry));
    entry = inspect(hard_other);
    CHECK(!pu_files_read(hard_other, entry.identity, &text, &size, &entry));
    CHECK(!strcmp(text, "shared")); free(text);
    struct stat original_info, other_info;
    CHECK(!stat(hard_original, &original_info) && !stat(hard_other, &other_info));
    CHECK(original_info.st_ino != other_info.st_ino && original_info.st_nlink == 1 && other_info.st_nlink == 1);
    char link[PU_FILES_PATH], documents[PU_FILES_PATH];
    path(link, root, "folder link"); path(documents, root, "Documents");
    CHECK(!symlink("Documents", link));
    entry = inspect(link);
    CHECK(!strcmp(entry.type, "symlink") && !strcmp(entry.target_type, "directory") && !strcmp(entry.link_target, "Documents"));
    CHECK(!pu_files_stat(link, true, &entry));
    CHECK(!strcmp(entry.path, documents) && !strcmp(entry.type, "directory"));
    CHECK(!pu_files_list(link, entry.identity, &snapshot));
    CHECK(!strcmp(snapshot.path, documents) && snapshot.count == 0); pu_files_list_free(&snapshot);
    CHECK(!unlink(link)); CHECK(!symlink(renamed, link)); entry = inspect(link); parent = inspect(root);
    CHECK(pu_files_replace(link, "bad", 3, old_content, parent.identity, &entry) == -1 && errno == ESTALE);
    CHECK(pu_files_read(link, entry.identity, &text, &size, &entry) == -1 && errno == EINVAL);
    CHECK(!unlink(link)); CHECK(!symlink("folder link", link)); entry = inspect(link);
    CHECK(entry.target_error == ELOOP);
    CHECK(pu_files_stat(link, true, &entry) == -1 && errno == ELOOP);
    CHECK(!unlink(link)); CHECK(!symlink("missing target", link)); entry = inspect(link);
    CHECK(entry.target_error == ENOENT);
    char denied[PU_FILES_PATH]; path(denied, root, "denied");
    CHECK(!mkdir(denied, 0000));
    CHECK(pu_files_list(denied, NULL, &snapshot) == -1 && errno == EACCES);
    entry = inspect(denied); CHECK(!entry.readable && !entry.writable);
    char retired[PU_FILES_PATH]; path(retired, root, "retired-directory"); CHECK(!mkdir(retired, 0700));
    retiring_directory = retired;
    CHECK(pu_files_list(retired, NULL, &snapshot) == -1 && (errno == ESTALE || errno == ENOENT));
    int retirement_error = errno;
    CHECK(retiring_directory == NULL && !snapshot.entries);
    printf("PASS: actual directory removed after open fails with errno=%d, not empty-success\n", retirement_error);
    char pipe[PU_FILES_PATH]; path(pipe, root, "pipe"); CHECK(!mkfifo(pipe, 0600)); entry = inspect(pipe);
    CHECK(!strcmp(entry.type, "other"));
    CHECK(pu_files_read(pipe, entry.identity, &text, &size, &entry) == -1 && errno == EINVAL);
    parent = inspect(root);
    CHECK(pu_files_write(root, "nul", "x\0y", 3, parent.identity, &entry) == -1 && errno == EILSEQ);
    CHECK(pu_files_write(root, "utf8", "\xc0\x80", 2, parent.identity, &entry) == -1 && errno == EILSEQ);
    CHECK(pu_files_write(root, "large", "", PU_FILES_TEXT + 1, parent.identity, &entry) == -1 && errno == EFBIG);
    char *maximum = malloc(PU_FILES_TEXT);
    CHECK(maximum != NULL); memset(maximum, 'x', PU_FILES_TEXT); parent = inspect(root);
    CHECK(!pu_files_write(root, "exact-limit.txt", maximum, PU_FILES_TEXT, parent.identity, &entry));
    free(maximum);
    CHECK(!pu_files_read(entry.path, entry.identity, &text, &size, &entry));
    CHECK(size == PU_FILES_TEXT && text[0] == 'x' && text[size - 1] == 'x'); free(text);
    CHECK(!truncate(entry.path, PU_FILES_TEXT + 1)); entry = inspect(entry.path);
    CHECK(pu_files_read(entry.path, entry.identity, &text, &size, &entry) == -1 && errno == EFBIG);
    CHECK(!pu_files_path_valid("/tmp/../escape") && !pu_files_path_valid("//tmp") && !pu_files_path_valid("/tmp/"));
    char oversized[PU_FILES_PATH + 1]; memset(oversized, 'x', sizeof(oversized)); oversized[0] = '/'; oversized[PU_FILES_PATH] = 0;
    CHECK(!pu_files_path_valid(oversized));
    char many[PU_FILES_PATH]; path(many, root, "many"); CHECK(!mkdir(many, 0700));
    for (int i = 0; i < PU_FILES_COUNT + 1; i++) {
        char name[32], item[PU_FILES_PATH]; snprintf(name, sizeof(name), "entry-%04d", i); path(item, many, name); contents(item, "");
    }
    CHECK(!pu_files_list(many, NULL, &snapshot));
    CHECK(snapshot.count == PU_FILES_COUNT && !snapshot.complete); pu_files_list_free(&snapshot);
    printf("PASS: %u ordinary UID1000 filesystem checks; private fixture %s\n", checks, root);
    return 0;
}
