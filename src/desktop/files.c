#define _GNU_SOURCE
#include "files.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <openssl/evp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>

static bool utf8(const char *text, size_t size)
{
    for (size_t i = 0; i < size;) {
        unsigned char c = (unsigned char)text[i++];
        if (!c) return false;
        if (c < 128) continue;
        unsigned count, value, minimum;
        if (c >= 0xc2 && c <= 0xdf) { count = 1; value = c & 31; minimum = 128; }
        else if (c >= 0xe0 && c <= 0xef) { count = 2; value = c & 15; minimum = 2048; }
        else if (c >= 0xf0 && c <= 0xf4) { count = 3; value = c & 7; minimum = 65536; }
        else return false;
        if (size - i < count) return false;
        while (count--) {
            c = (unsigned char)text[i++];
            if ((c & 0xc0) != 0x80) return false;
            value = (value << 6) | (c & 63);
        }
        if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return false;
    }
    return true;
}

bool pu_files_name_valid(const char *name)
{
    size_t size = name ? strnlen(name, PU_FILES_NAME) : 0;
    return size && size < PU_FILES_NAME && !strchr(name, '/') &&
        strcmp(name, ".") && strcmp(name, "..") && utf8(name, size);
}

bool pu_files_path_valid(const char *path)
{
    size_t size = path ? strnlen(path, PU_FILES_PATH) : 0;
    if (!size || size >= PU_FILES_PATH || path[0] != '/' || !utf8(path, size)) return false;
    if (size == 1) return true;
    const char *part = path + 1;
    for (const char *at = part;; at++) {
        if (*at && *at != '/') continue;
        size_t length = (size_t)(at - part);
        if (!length || length >= PU_FILES_NAME || (length == 1 && part[0] == '.') ||
            (length == 2 && part[0] == '.' && part[1] == '.')) return false;
        if (!*at) return true;
        part = at + 1;
    }
}

static int ordinary(void)
{
    if (!geteuid() || getuid() != geteuid() || getgid() != getegid()) { errno = EPERM; return -1; }
    return 0;
}

static void identity(const struct stat *status, char *out)
{
    snprintf(out, PU_FILES_ID, "%" PRIuMAX ":%" PRIuMAX ":%o:%" PRIdMAX ":%" PRIdMAX
        ":%ld:%" PRIdMAX ":%ld", (uintmax_t)status->st_dev, (uintmax_t)status->st_ino,
        (unsigned)status->st_mode, (intmax_t)status->st_size, (intmax_t)status->st_mtim.tv_sec,
        status->st_mtim.tv_nsec, (intmax_t)status->st_ctim.tv_sec, status->st_ctim.tv_nsec);
}

static int matches(const struct stat *status, const char *expected)
{
    char value[PU_FILES_ID];
    if (!expected || !*expected || strlen(expected) >= PU_FILES_ID) { errno = EINVAL; return -1; }
    identity(status, value);
    if (strcmp(value, expected)) { errno = ESTALE; return -1; }
    return 0;
}

static const char *kind(mode_t mode)
{
    return S_ISDIR(mode) ? "directory" : S_ISREG(mode) ? "file" : S_ISLNK(mode) ? "symlink" : "other";
}

static int fd_path(int fd, char *path)
{
    char descriptor[64];
    snprintf(descriptor, sizeof(descriptor), "/proc/self/fd/%d", fd);
    ssize_t length = readlink(descriptor, path, PU_FILES_PATH - 1);
    if (length < 0) return -1;
    path[length] = 0;
    if (length == PU_FILES_PATH - 1 || !pu_files_path_valid(path)) { errno = ENAMETOOLONG; return -1; }
    return 0;
}

static int join(const char *parent, const char *name, char *path)
{
    int length = snprintf(path, PU_FILES_PATH, "%s%s%s", parent, strcmp(parent, "/") ? "/" : "", name);
    if (length < 0 || length >= PU_FILES_PATH) { errno = ENAMETOOLONG; return -1; }
    return 0;
}

static int directory(const char *path, const char *expected, char *canonical)
{
    if (ordinary()) return -1;
    if (!pu_files_path_valid(path)) { errno = EINVAL; return -1; }
    int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return -1;
    struct stat status;
    int result = fstat(fd, &status);
    if (!result && expected) result = matches(&status, expected);
    if (!result) result = fd_path(fd, canonical);
    if (result) { int error = errno; close(fd); errno = error; return -1; }
    return fd;
}

static int describe(int parent, const char *name, const char *path, PuFileEntry *entry)
{
    struct stat status;
    if (fstatat(parent, name, &status, AT_SYMLINK_NOFOLLOW)) return -1;
    memset(entry, 0, sizeof(*entry));
    snprintf(entry->name, sizeof(entry->name), "%s", name);
    snprintf(entry->path, sizeof(entry->path), "%s", path);
    snprintf(entry->type, sizeof(entry->type), "%s", kind(status.st_mode));
    snprintf(entry->permissions, sizeof(entry->permissions), "%04o", (unsigned)(status.st_mode & 07777));
    identity(&status, entry->identity);
    entry->bytes = status.st_size < 0 ? 0 : (uint64_t)status.st_size;
    entry->mtime_ms = (double)status.st_mtim.tv_sec * 1000 + (double)status.st_mtim.tv_nsec / 1000000;
    entry->uid = status.st_uid; entry->gid = status.st_gid;
    if (S_ISLNK(status.st_mode)) {
        ssize_t length = readlinkat(parent, name, entry->link_target, sizeof(entry->link_target) - 1);
        if (length < 0) return -1;
        if ((size_t)length == sizeof(entry->link_target) - 1 ||
            !utf8(entry->link_target, (size_t)length)) { errno = EILSEQ; return -1; }
        entry->link_target[length] = 0;
        if (!fstatat(parent, name, &status, 0)) {
            snprintf(entry->target_type, sizeof(entry->target_type), "%s", kind(status.st_mode));
            identity(&status, entry->target_identity);
        } else {
            entry->target_error = errno;
            strcpy(entry->target_type, "unavailable");
        }
    } else {
        int search = S_ISDIR(status.st_mode) ? X_OK : 0;
        entry->readable = !faccessat(parent, name, R_OK | search, AT_EACCESS);
        entry->writable = !faccessat(parent, name, W_OK | search, AT_EACCESS);
    }
    return 0;
}

static int split(const char *path, char *parent, char *name)
{
    if (!pu_files_path_valid(path) || !strcmp(path, "/")) { errno = EINVAL; return -1; }
    const char *last = strrchr(path, '/');
    size_t length = (size_t)(last - path);
    if (!length) strcpy(parent, "/");
    else { memcpy(parent, path, length); parent[length] = 0; }
    strcpy(name, last + 1);
    return 0;
}

int pu_files_stat(const char *path, bool follow, PuFileEntry *entry)
{
    if (ordinary()) return -1;
    char parent[PU_FILES_PATH], name[PU_FILES_NAME], canonical[PU_FILES_PATH], resolved[PU_FILES_PATH];
    if (!strcmp(path ? path : "", "/")) {
        int fd = directory(path, NULL, canonical);
        if (fd < 0) return -1;
        int result = describe(fd, ".", "/", entry);
        strcpy(entry->name, "/");
        int error = errno; close(fd); errno = error; return result;
    }
    if (split(path, parent, name)) return -1;
    int fd = directory(parent, NULL, canonical);
    if (fd < 0) return -1;
    int result = join(canonical, name, resolved);
    if (!result) result = describe(fd, name, resolved, entry);
    int error = errno; close(fd); errno = error;
    if (result || !follow || strcmp(entry->type, "symlink")) return result;
    int target = open(path, O_PATH | O_CLOEXEC);
    if (target < 0) return -1;
    result = fd_path(target, resolved);
    error = errno; close(target); errno = error;
    return result ? -1 : pu_files_stat(resolved, false, entry);
}

int pu_files_list(const char *path, const char *expected, PuFileDirectory *result)
{
    memset(result, 0, sizeof(*result));
    int fd = directory(path, expected, result->path);
    if (fd < 0) return -1;
    struct stat status;
    if (fstat(fd, &status)) { int error = errno; close(fd); errno = error; return -1; }
    identity(&status, result->identity);
    DIR *stream = fdopendir(fd);
    if (!stream) { int error = errno; close(fd); errno = error; return -1; }
    result->entries = calloc(PU_FILES_COUNT, sizeof(*result->entries));
    if (!result->entries) { closedir(stream); errno = ENOMEM; return -1; }
    result->complete = true;
    for (;;) {
        errno = 0;
        struct dirent *item = readdir(stream);
        if (!item) {
            if (errno) goto failed;
            break;
        }
        if (!strcmp(item->d_name, ".") || !strcmp(item->d_name, "..")) continue;
        if (result->count == PU_FILES_COUNT) { result->complete = false; break; }
        if (!pu_files_name_valid(item->d_name)) { errno = EILSEQ; goto failed; }
        char full[PU_FILES_PATH];
        if (join(result->path, item->d_name, full) ||
            describe(dirfd(stream), item->d_name, full, &result->entries[result->count])) goto failed;
        result->count++;
    }
    if (fstat(dirfd(stream), &status) || matches(&status, result->identity)) goto failed;
    closedir(stream);
    return 0;
failed: {
    int error = errno;
    closedir(stream); pu_files_list_free(result); errno = error; return -1;
}
}

void pu_files_list_free(PuFileDirectory *result)
{
    free(result->entries); result->entries = NULL; result->count = 0;
}

static int read_regular(int fd, const char *expected, char **text, size_t *length)
{
    *text = NULL; *length = 0;
    struct stat status;
    if (fstat(fd, &status) || matches(&status, expected)) return -1;
    if (!S_ISREG(status.st_mode) || status.st_size < 0 || status.st_size > PU_FILES_TEXT) { errno = EFBIG; return -1; }
    size_t size = (size_t)status.st_size;
    char *buffer = malloc(size + 1);
    if (!buffer) { errno = ENOMEM; return -1; }
    size_t offset = 0;
    while (offset < size) {
        ssize_t count = read(fd, buffer + offset, size - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { if (!count) errno = ESTALE; free(buffer); return -1; }
        offset += (size_t)count;
    }
    char extra;
    ssize_t trailing;
    do { trailing = read(fd, &extra, 1); } while (trailing < 0 && errno == EINTR);
    if (trailing || fstat(fd, &status) || matches(&status, expected)) {
        if (trailing > 0) errno = ESTALE;
        free(buffer); return -1;
    }
    if (!utf8(buffer, size)) { free(buffer); errno = EILSEQ; return -1; }
    buffer[size] = 0; *text = buffer; *length = size;
    return 0;
}

static int content_identity(const char *metadata, const char *text, size_t length, char *out)
{
    unsigned char digest[32]; unsigned size = 0;
    if (!EVP_Digest(text, length, digest, &size, EVP_sha256(), NULL) || size != sizeof(digest)) {
        errno = EIO; return -1;
    }
    int offset = snprintf(out, PU_FILES_CONTENT_ID, "sha256:%s:", metadata);
    if (offset < 0 || offset + 64 >= PU_FILES_CONTENT_ID) { errno = EOVERFLOW; return -1; }
    for (unsigned i = 0; i < size; i++) snprintf(out + offset + i * 2, 3, "%02x", digest[i]);
    return 0;
}

int pu_files_read(const char *path, const char *expected, char **text, size_t *length, PuFileEntry *entry)
{
    *text = NULL; *length = 0;
    if (pu_files_stat(path, false, entry)) return -1;
    if (strcmp(entry->type, "file")) { errno = EINVAL; return -1; }
    bool strong = expected && !strncmp(expected, "sha256:", 7);
    if (!expected || (!strong && strcmp(entry->identity, expected))) { errno = ESTALE; return -1; }
    int fd = open(entry->path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return -1;
    int result = read_regular(fd, strong ? entry->identity : expected, text, length);
    if (!result) result = content_identity(entry->identity, *text, *length, entry->content_identity);
    if (!result && strong && strcmp(entry->content_identity, expected)) { errno = ESTALE; result = -1; }
    int error = errno; close(fd); errno = error;
    if (result) { free(*text); *text = NULL; *length = 0; }
    return result;
}

int pu_files_observe_text(const char *path, PuFileEntry *entry)
{
    PuFileEntry metadata;
    if (pu_files_stat(path, false, &metadata)) return -1;
    char *text; size_t length;
    int result = pu_files_read(path, metadata.identity, &text, &length, entry);
    free(text); return result;
}

static int mutation_parent(const char *parent, const char *name, const char *expected, char *canonical)
{
    if (!pu_files_name_valid(name) || !expected || !*expected) { errno = EINVAL; return -1; }
    return directory(parent, expected, canonical);
}

int pu_files_mkdir(const char *parent, const char *name, const char *expected, PuFileEntry *entry)
{
    char canonical[PU_FILES_PATH], full[PU_FILES_PATH];
    int fd = mutation_parent(parent, name, expected, canonical);
    if (fd < 0) return -1;
    int result = join(canonical, name, full);
    if (!result) result = mkdirat(fd, name, 0700);
    if (!result) result = describe(fd, name, full, entry);
    int error = errno; close(fd); errno = error; return result;
}

int pu_files_rename(const char *path, const char *name, const char *expected,
                    const char *expected_parent, PuFileEntry *entry)
{
    char parent[PU_FILES_PATH], old[PU_FILES_NAME], canonical[PU_FILES_PATH], full[PU_FILES_PATH];
    if (split(path, parent, old)) return -1;
    int fd = mutation_parent(parent, name, expected_parent, canonical);
    if (fd < 0) return -1;
    struct stat status;
    int result = join(canonical, name, full);
    if (!result) result = fstatat(fd, old, &status, AT_SYMLINK_NOFOLLOW);
    if (!result) result = matches(&status, expected);
    if (!result && (status.st_uid != geteuid() ||
        (!S_ISREG(status.st_mode) && !S_ISDIR(status.st_mode) && !S_ISLNK(status.st_mode)))) {
        errno = EPERM; result = -1;
    }
    if (!result) result = renameat2(fd, old, fd, name, RENAME_NOREPLACE);
    if (!result) result = describe(fd, name, full, entry);
    int error = errno; close(fd); errno = error; return result;
}

static int writable_target(int parent, const char *name, const char *expected, mode_t *mode)
{
    int fd = openat(parent, name, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
        if (errno == ENOENT || errno == ELOOP) errno = ESTALE;
        return -1;
    }
    struct stat status;
    int result = fstat(fd, &status);
    if (!result && (!S_ISREG(status.st_mode) || status.st_uid != geteuid() ||
        (status.st_mode & (S_ISUID | S_ISGID)))) { errno = EPERM; result = -1; }
    if (!result) {
        char metadata[PU_FILES_ID], observed[PU_FILES_CONTENT_ID];
        identity(&status, metadata);
        char *text; size_t length;
        result = read_regular(fd, metadata, &text, &length);
        if (!result) result = content_identity(metadata, text, length, observed);
        free(text);
        if (!result && strcmp(observed, expected)) { errno = ESTALE; result = -1; }
    }
    if (!result) *mode = status.st_mode & 0777;
    int error = errno; close(fd); errno = error; return result;
}

static int publish(const char *parent, const char *name, const char *text, size_t length,
                   const char *expected_parent, const char *expected, PuFileEntry *entry)
{
    if (length > PU_FILES_TEXT) { errno = EFBIG; return -1; }
    if ((!text && length) || !utf8(text, length)) { errno = EILSEQ; return -1; }
    char canonical[PU_FILES_PATH], full[PU_FILES_PATH], temporary[64] = "";
    int fd = mutation_parent(parent, name, expected_parent, canonical);
    if (fd < 0) return -1;
    if (join(canonical, name, full)) { int error = errno; close(fd); errno = error; return -1; }
    struct stat parent_status;
    if (fstat(fd, &parent_status)) { int error = errno; close(fd); errno = error; return -1; }
    mode_t mode = 0600;
    if (expected && writable_target(fd, name, expected, &mode)) {
        int error = errno; close(fd); errno = error; return -1;
    }
    unsigned char random[16];
    ssize_t count;
    do { count = getrandom(random, sizeof(random), 0); } while (count < 0 && errno == EINTR);
    if (count != sizeof(random)) { int error = count < 0 ? errno : EIO; close(fd); errno = error; return -1; }
    strcpy(temporary, ".polly-save-");
    for (size_t i = 0; i < sizeof(random); i++) snprintf(temporary + 12 + i * 2, 3, "%02x", random[i]);
    int output = openat(fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (output < 0) { int error = errno; close(fd); errno = error; return -1; }
    int result = 0;
    for (size_t offset = 0; offset < length;) {
        ssize_t written = write(output, text + offset, length - offset);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) { if (!written) errno = EIO; result = -1; break; }
        offset += (size_t)written;
    }
    if (!result) result = fsync(output);
    if (!result) result = fchmod(output, mode);
    if (!result) result = fsync(output);
    int error = errno;
    if (close(output) && !result) { result = -1; error = errno; }
    errno = error;
    if (!result && expected) {
        struct stat current_parent;
        if (stat(canonical, &current_parent)) { errno = ESTALE; result = -1; }
        else if (current_parent.st_dev != parent_status.st_dev || current_parent.st_ino != parent_status.st_ino) {
            errno = ESTALE; result = -1;
        }
        if (!result) result = writable_target(fd, name, expected, &mode);
        if (!result) result = renameat(fd, temporary, fd, name);
    } else if (!result) result = linkat(fd, temporary, fd, name, 0);
    error = errno;
    if (unlinkat(fd, temporary, 0) && !(expected && !result && errno == ENOENT)) {
        fprintf(stderr, "[files] Cannot remove private staged file %s: %s\n", temporary, strerror(errno));
        if (!result) { result = -1; error = errno; }
    }
    errno = error;
    if (!result) result = describe(fd, name, full, entry);
    error = errno; close(fd); errno = error; return result;
}

int pu_files_write(const char *parent, const char *name, const char *text, size_t length,
                   const char *expected_parent, PuFileEntry *entry)
{
    return publish(parent, name, text, length, expected_parent, NULL, entry);
}

int pu_files_replace(const char *path, const char *text, size_t length, const char *expected,
                     const char *expected_parent, PuFileEntry *entry)
{
    char parent[PU_FILES_PATH], name[PU_FILES_NAME];
    if (!expected || strncmp(expected, "sha256:", 7) || strlen(expected) >= PU_FILES_CONTENT_ID ||
        split(path, parent, name)) { errno = EINVAL; return -1; }
    return publish(parent, name, text, length, expected_parent, expected, entry);
}

#ifndef PU_FILES_CORE_ONLY
static const char *error_code(int error)
{
    switch (error) {
    case EACCES: return "EACCES"; case EPERM: return "EPERM"; case ENOENT: return "ENOENT";
    case EEXIST: return "EEXIST"; case ESTALE: return "ESTALE"; case EINVAL: return "EINVAL";
    case EFBIG: return "EFBIG"; case ELOOP: return "ELOOP"; case ENOTDIR: return "ENOTDIR";
    case ENAMETOOLONG: return "ENAMETOOLONG"; case EILSEQ: return "EILSEQ";
    case ENOSPC: return "ENOSPC"; case EROFS: return "EROFS"; case ENOMEM: return "ENOMEM";
    default: return "EIO";
    }
}

static JSValue failure(JSContext *ctx, const char *operation)
{
    int error = errno;
    JSValue value = JS_NewError(ctx);
    if (JS_IsException(value)) return value;
    JS_SetPropertyStr(ctx, value, "message", JS_NewString(ctx, strerror(error)));
    JS_SetPropertyStr(ctx, value, "code", JS_NewString(ctx, error_code(error)));
    JS_SetPropertyStr(ctx, value, "operation", JS_NewString(ctx, operation));
    return JS_Throw(ctx, value);
}

static int property(JSContext *ctx, JSValueConst object, const char *name, JSValue value)
{
    return !JS_IsException(value) && JS_SetPropertyStr(ctx, object, name, value) >= 0;
}

static const char *string(JSContext *ctx, JSValueConst value, size_t limit)
{
    if (!JS_IsString(value)) { JS_ThrowTypeError(ctx, "File API requires explicit string arguments"); return NULL; }
    size_t length;
    const char *text = JS_ToCStringLen(ctx, &length, value);
    if (!text) return NULL;
    if (length > limit || memchr(text, 0, length)) {
        JS_FreeCString(ctx, text);
        JS_ThrowRangeError(ctx, "File API string exceeds its bound or contains NUL");
        return NULL;
    }
    return text;
}

static JSValue entry_value(JSContext *ctx, const PuFileEntry *entry)
{
    JSValue value = JS_NewObject(ctx);
    if (JS_IsException(value)) return value;
#define SET(key, expression) do { if (!property(ctx, value, key, expression)) goto failed; } while (0)
    SET("name", JS_NewString(ctx, entry->name)); SET("path", JS_NewString(ctx, entry->path));
    SET("identity", JS_NewString(ctx, entry->identity)); SET("type", JS_NewString(ctx, entry->type));
    SET("permissions", JS_NewString(ctx, entry->permissions)); SET("bytes", JS_NewFloat64(ctx, (double)entry->bytes));
    SET("mtimeMs", JS_NewFloat64(ctx, entry->mtime_ms));
    SET("uid", JS_NewUint32(ctx, entry->uid)); SET("gid", JS_NewUint32(ctx, entry->gid));
    SET("readable", JS_NewBool(ctx, entry->readable)); SET("writable", JS_NewBool(ctx, entry->writable));
    SET("linkTarget", JS_NewString(ctx, entry->link_target));
    SET("targetType", JS_NewString(ctx, entry->target_type));
    SET("targetIdentity", JS_NewString(ctx, entry->target_identity));
    SET("contentIdentity", JS_NewString(ctx, entry->content_identity));
    SET("targetError", entry->target_error ? JS_NewString(ctx, error_code(entry->target_error)) : JS_NULL);
#undef SET
    return value;
failed:
    JS_FreeValue(ctx, value); return JS_EXCEPTION;
}

enum { LIST, STAT, READ, WRITE, MKDIR, RENAME, REPLACE, OBSERVE };
static JSValue request(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int operation)
{
    (void)self;
    const int counts[] = { 2, 2, 2, 4, 3, 4, 4, 1 };
    if (argc != counts[operation]) return JS_ThrowTypeError(ctx, "Wrong file API argument count");
    const char *args[4] = { NULL };
    for (int i = 0; i < argc; i++) {
        if (operation == STAT && i == 1) {
            if (!JS_IsBool(argv[i])) { JS_ThrowTypeError(ctx, "stat followLinks must be boolean"); goto failed; }
            continue;
        }
        if (operation == LIST && i == 1 && JS_IsNull(argv[i])) continue;
        size_t limit = ((operation == WRITE && i == 2) || (operation == REPLACE && i == 1)) ?
            PU_FILES_TEXT : PU_FILES_PATH - 1;
        args[i] = string(ctx, argv[i], limit);
        if (!args[i]) goto failed;
    }
    PuFileEntry entry;
    JSValue value;
    int result;
    if (operation == LIST) {
        PuFileDirectory snapshot;
        result = pu_files_list(args[0], args[1], &snapshot);
        if (result) value = failure(ctx, "listDirectory");
        else {
            value = JS_NewObject(ctx);
            JSValue entries = JS_NewArray(ctx);
            if (!JS_IsException(value) && !JS_IsException(entries)) {
                int ok = 1;
                for (size_t i = 0; i < snapshot.count && ok; i++) {
                    JSValue item = entry_value(ctx, &snapshot.entries[i]);
                    ok = !JS_IsException(item) && JS_SetPropertyUint32(ctx, entries, (uint32_t)i, item) >= 0;
                }
                ok = ok && property(ctx, value, "version", JS_NewInt32(ctx, 1)) &&
                    property(ctx, value, "path", JS_NewString(ctx, snapshot.path)) &&
                    property(ctx, value, "identity", JS_NewString(ctx, snapshot.identity)) &&
                    property(ctx, value, "complete", JS_NewBool(ctx, snapshot.complete));
                if (ok) ok = property(ctx, value, "entries", JS_DupValue(ctx, entries));
                JS_FreeValue(ctx, entries);
                if (!ok) { JS_FreeValue(ctx, value); value = JS_EXCEPTION; }
            } else { JS_FreeValue(ctx, entries); JS_FreeValue(ctx, value); value = JS_EXCEPTION; }
            pu_files_list_free(&snapshot);
        }
    } else if (operation == READ) {
        char *text; size_t length;
        result = pu_files_read(args[0], args[1], &text, &length, &entry);
        value = result ? failure(ctx, "readText") : entry_value(ctx, &entry);
        if (!result) {
            if (!JS_IsException(value) && !property(ctx, value, "text", JS_NewStringLen(ctx, text, length))) {
                JS_FreeValue(ctx, value); value = JS_EXCEPTION;
            }
            if (!JS_IsException(value) && !strncmp(args[1], "sha256:", 7) &&
                (!property(ctx, value, "metadataIdentity", JS_NewString(ctx, entry.identity)) ||
                 !property(ctx, value, "identity", JS_NewString(ctx, entry.content_identity)))) {
                JS_FreeValue(ctx, value); value = JS_EXCEPTION;
            }
            free(text);
        }
    } else {
        switch (operation) {
        case STAT: result = pu_files_stat(args[0], JS_ToBool(ctx, argv[1]), &entry); break;
        case WRITE: result = pu_files_write(args[0], args[1], args[2], strlen(args[2]), args[3], &entry); break;
        case MKDIR: result = pu_files_mkdir(args[0], args[1], args[2], &entry); break;
        case REPLACE: result = pu_files_replace(args[0], args[1], strlen(args[1]), args[2], args[3], &entry); break;
        case OBSERVE: result = pu_files_observe_text(args[0], &entry); break;
        default: result = pu_files_rename(args[0], args[1], args[2], args[3], &entry); break;
        }
        value = result ? failure(ctx, operation == STAT ? "stat" : operation == WRITE ? "writeText" :
            operation == MKDIR ? "createDirectory" : operation == REPLACE ? "replaceText" :
            operation == OBSERVE ? "observeText" : "rename") : entry_value(ctx, &entry);
        if (!result && operation == OBSERVE && !JS_IsException(value) &&
            (!property(ctx, value, "metadataIdentity", JS_NewString(ctx, entry.identity)) ||
             !property(ctx, value, "identity", JS_NewString(ctx, entry.content_identity)))) {
            JS_FreeValue(ctx, value); value = JS_EXCEPTION;
        }
    }
    for (int i = 0; i < argc; i++) JS_FreeCString(ctx, args[i]);
    return value;
failed:
    for (int i = 0; i < argc; i++) JS_FreeCString(ctx, args[i]);
    return JS_EXCEPTION;
}

static JSValue locations(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    const char *home = getenv("HOME");
    if (ordinary()) return failure(ctx, "locations");
    if (!pu_files_path_valid(home)) { errno = EINVAL; return failure(ctx, "locations"); }
    JSValue value = JS_NewObject(ctx);
    if (JS_IsException(value)) return value;
    const char *keys[] = { "home", "documents", "downloads", "desktop" };
    const char *names[] = { NULL, "Documents", "Downloads", "Desktop" };
    for (size_t i = 0; i < 4; i++) {
        char path[PU_FILES_PATH];
        if (names[i] ? join(home, names[i], path) : (strcpy(path, home), 0)) {
            JS_FreeValue(ctx, value); return failure(ctx, "locations");
        }
        if (!property(ctx, value, keys[i], JS_NewString(ctx, path))) {
            JS_FreeValue(ctx, value); return JS_EXCEPTION;
        }
    }
    return value;
}

int pu_files_install(JSContext *ctx, JSValueConst api)
{
    JSValue value = JS_NewObject(ctx);
    if (JS_IsException(value)) return 0;
    const char *names[] = { "listDirectory", "stat", "readText", "writeText", "createDirectory", "rename", "replaceText", "observeText" };
    const int counts[] = { 2, 2, 2, 4, 3, 4, 4, 1 };
    for (int i = 0; i < 8; i++)
        if (JS_SetPropertyStr(ctx, value, names[i], JS_NewCFunctionMagic(ctx, request, names[i], counts[i], JS_CFUNC_generic_magic, i)) < 0)
            goto failed;
    if (JS_SetPropertyStr(ctx, value, "version", JS_NewInt32(ctx, 1)) < 0 ||
        JS_SetPropertyStr(ctx, value, "implementation", JS_NewString(ctx, "posix-ordinary-v1")) < 0 ||
        JS_SetPropertyStr(ctx, value, "maxEntries", JS_NewInt32(ctx, PU_FILES_COUNT)) < 0 ||
        JS_SetPropertyStr(ctx, value, "maxTextBytes", JS_NewInt32(ctx, PU_FILES_TEXT)) < 0 ||
        JS_SetPropertyStr(ctx, value, "overwrite", JS_TRUE) < 0 ||
        JS_SetPropertyStr(ctx, value, "textObservation", JS_NewString(ctx, "sha256-v1")) < 0 ||
        JS_SetPropertyStr(ctx, value, "locations", JS_NewCFunction(ctx, locations, "locations", 0)) < 0) goto failed;
    return JS_SetPropertyStr(ctx, api, "fileSystem", value) >= 0;
failed:
    JS_FreeValue(ctx, value); return 0;
}
#endif
