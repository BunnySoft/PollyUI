#define _GNU_SOURCE
#include "bundles.h"
#include "bundle-schema.h"
#include <archive.h>
#include <archive_entry.h>
#include <openssl/evp.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#define FILE_LIMIT (256u * 1024u * 1024u)
#define TOTAL_LIMIT (512u * 1024u * 1024u)
#define ENTRY_LIMIT 4096
#define RECORD_LIMIT (192u * 1024u)
struct Store { int root, apps, objects, lock; bool absent; char path[PATH_MAX]; char error[512]; };
struct Budget { uint64_t bytes; unsigned entries; time_t start; };
struct Schema { JSRuntime *runtime; JSContext *ctx; JSValue module; };

static int error(struct Store *s, const char *format, ...)
{
    va_list args;
    va_start(args, format); vsnprintf(s->error, sizeof(s->error), format, args); va_end(args);
    return -1;
}
static int failure(struct Store *s, const char *operation)
{ int code = errno; return error(s, "%s: %s", operation, strerror(code)); }
static bool safe_component(const char *name)
{
    if (!*name || !strcmp(name, ".") || !strcmp(name, "..") || strlen(name) > 255) return false;
    for (const unsigned char *p = (const unsigned char *)name; *p; p++)
        if (*p < 32 || *p == 127 || *p == '/' || *p == '\\' || *p == ':') return false;
    return true;
}
static bool relative(const char *path)
{
    if (!path || !*path || *path == '/' || strlen(path) > 1024) return false;
    char copy[1025]; strcpy(copy, path);
    char *part = copy;
    unsigned depth = 0;
    for (;;) {
        char *slash = strchr(part, '/');
        if (slash) *slash = 0;
        if (++depth > 32 || !safe_component(part)) return false;
        if (!slash) return true;
        part = slash + 1;
    }
}
static int directory(struct Store *s, int parent, const char *name, bool create, bool private)
{
    if (!safe_component(name)) return error(s, "Invalid directory component");
    if (create && mkdirat(parent, name, 0700) < 0 && errno != EEXIST) return failure(s, "Cannot create directory");
    int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) { s->absent = errno == ENOENT; return failure(s, "Cannot open directory without following links"); }
    struct stat info;
    if (fstat(fd, &info) < 0) { close(fd); return failure(s, "Cannot inspect directory"); }
    if (private && (info.st_uid != getuid() || (info.st_mode & 077))) {
        close(fd); return error(s, "Managed directories must be owned by this user with mode 0700 or stricter");
    }
    return fd;
}
static int absolute_directory(struct Store *s, const char *path, bool create, bool private)
{
    if (!path || path[0] != '/' || strlen(path) >= PATH_MAX || (path[1] && path[strlen(path)-1] == '/'))
        return error(s, "Expected a normalized absolute directory");
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return failure(s, "Cannot open filesystem root");
    if (!path[1]) {
        if (private) { close(fd); return error(s, "Filesystem root cannot be application storage"); }
        return fd;
    }
    char copy[PATH_MAX]; strcpy(copy, path + 1);
    char *part = copy;
    for (;;) {
        char *slash = strchr(part, '/');
        if (slash) *slash = 0;
        int next = directory(s, fd, part, create, private && !slash);
        close(fd);
        if (next < 0) return -1;
        fd = next;
        if (!slash) return fd;
        part = slash + 1;
    }
}
static int file_open(struct Store *s, int parent, const char *path, int flags, mode_t mode)
{
    if (!relative(path)) return error(s, "Invalid path inside application package");
    char copy[1025]; strcpy(copy, path);
    int fd = dup(parent);
    if (fd < 0) return failure(s, "Cannot duplicate directory handle");
    char *part = copy, *slash;
    while ((slash = strchr(part, '/'))) {
        *slash = 0;
        int next = directory(s, fd, part, false, false);
        close(fd); if (next < 0) return -1; fd = next; part = slash + 1;
    }
    int result = openat(fd, part, flags | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, mode);
    close(fd);
    if (result < 0) return failure(s, "Cannot open application file");
    return result;
}
static char *read_text(struct Store *s, int parent, const char *path, size_t limit, bool owned)
{
    int fd = file_open(s, parent, path, O_RDONLY, 0);
    if (fd < 0) return NULL;
    struct stat info;
    if (fstat(fd, &info) < 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1 ||
        info.st_size < 1 || (uint64_t)info.st_size > limit ||
        (owned && (info.st_uid != getuid() || (info.st_mode & 022)))) {
        close(fd); error(s, "Invalid, unsafe or oversized application metadata"); return NULL;
    }
    size_t length = (size_t)info.st_size, offset = 0;
    char *text = malloc(length + 1);
    if (!text) { close(fd); error(s, "Cannot allocate metadata buffer"); return NULL; }
    while (offset < length) {
        ssize_t n = read(fd, text + offset, length - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { free(text); close(fd); error(s, "Application metadata changed while reading"); return NULL; }
        offset += (size_t)n;
    }
    char extra;
    ssize_t tail;
    do { tail = read(fd, &extra, 1); } while (tail < 0 && errno == EINTR);
    close(fd);
    if (tail != 0 || memchr(text, 0, length)) { free(text); error(s, "Metadata grew or contains NUL"); return NULL; }
    text[length] = 0;
    return text;
}
static int write_all(struct Store *s, int fd, const void *bytes, size_t size)
{
    const char *p = bytes;
    while (size) {
        ssize_t n = write(fd, p, size);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return failure(s, "Cannot write application payload");
        p += n; size -= (size_t)n;
    }
    return 0;
}
static int random_name(struct Store *s, char name[40])
{
    unsigned char bytes[16];
    ssize_t n;
    do { n = getrandom(bytes, sizeof(bytes), 0); } while (n < 0 && errno == EINTR);
    if (n != sizeof(bytes)) return failure(s, "Cannot generate staging identity");
    strcpy(name, ".stage-");
    for (unsigned i = 0; i < sizeof(bytes); i++) snprintf(name + 7 + i*2, 3, "%02x", bytes[i]);
    return 0;
}
static void store_close(struct Store *s)
{
    if (s->apps >= 0) close(s->apps);
    if (s->objects >= 0) close(s->objects);
    if (s->lock >= 0) close(s->lock);
    if (s->root >= 0) close(s->root);
}
static int store_open(struct Store *s, bool create, bool exclusive)
{
    *s = (struct Store){ .root=-1, .apps=-1, .objects=-1, .lock=-1 };
    if (getuid() != geteuid() || getgid() != getegid()) return error(s, "Set-ID application management is not supported");
    const char *base = getenv("XDG_DATA_HOME");
    char fallback[PATH_MAX];
    if (!base || !*base) {
        const char *home = getenv("HOME");
        int n = home ? snprintf(fallback, sizeof(fallback), "%s/.local/share", home) : -1;
        if (n < 0 || n >= (int)sizeof(fallback)) return error(s, "Absolute HOME or XDG_DATA_HOME is required");
        base = fallback;
    }
    int n = snprintf(s->path, sizeof(s->path), "%s/polly-apps", base);
    if (n < 0 || n >= (int)sizeof(s->path)) return error(s, "Application store path is too long");
    s->root = absolute_directory(s, s->path, create, true);
    if (s->root < 0) return -1;
    s->lock = openat(s->root, "lock", O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | (create ? O_CREAT : 0), 0600);
    struct stat info;
    if (s->lock < 0 || fstat(s->lock, &info) < 0 || !S_ISREG(info.st_mode) ||
        info.st_uid != getuid() || info.st_nlink != 1 || (info.st_mode & 077))
        return error(s, "Invalid application store lock");
    if (flock(s->lock, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB) < 0)
        return failure(s, "Application store is busy");
    s->apps = directory(s, s->root, "apps", create, true);
    s->objects = directory(s, s->root, "objects", create, true);
    return s->apps < 0 || s->objects < 0 ? -1 : 0;
}
static int budget(struct Store *s, struct Budget *b, uint64_t size)
{
    if (++b->entries > ENTRY_LIMIT || size > FILE_LIMIT || b->bytes + size > TOTAL_LIMIT ||
        time(NULL) - b->start > 60) return error(s, "Application package exceeds file/count/size/time limits");
    b->bytes += size;
    return 0;
}
static int copy_tree(struct Store *s, int source, int target, unsigned depth, struct Budget *b)
{
    if (depth > 32) return error(s, "Application directory depth limit exceeded");
    DIR *dir = fdopendir(openat(source, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
    if (!dir) return failure(s, "Cannot enumerate package directory");
    int result = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(dir);
        if (!entry) { if (errno) result = failure(s, "Cannot enumerate package directory"); break; }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        if (!safe_component(entry->d_name)) { result = error(s, "Unsafe package filename"); break; }
        int in = openat(source, entry->d_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
        struct stat before, after;
        if (in < 0 || fstat(in, &before) < 0) {
            if (in >= 0) close(in);
            result = failure(s, "Cannot inspect package member"); break;
        }
        if (S_ISDIR(before.st_mode)) {
            struct stat store;
            if (fstat(s->root, &store) || (store.st_dev == before.st_dev && store.st_ino == before.st_ino)) {
                close(in); result = error(s, "Source cannot contain the managed application store"); break;
            }
            result = budget(s, b, 0);
            int out = result == 0 ? directory(s, target, entry->d_name, true, true) : -1;
            if (out < 0) result = -1;
            else { result = copy_tree(s, in, out, depth+1, b); if (!result && fsync(out)) result = failure(s, "Cannot sync package directory"); close(out); }
        } else if (!S_ISREG(before.st_mode) || before.st_nlink != 1 || before.st_size < 0 ||
                   (before.st_mode & (S_ISUID | S_ISGID))) result = error(s, "Only regular files and directories are allowed; links and special files are rejected");
        else if (!(result = budget(s, b, (uint64_t)before.st_size))) {
            int out = openat(target, entry->d_name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
            if (out < 0) result = failure(s, "Cannot create staged file");
            else {
                char buffer[65536]; uint64_t copied = 0;
                while (!result) {
                    ssize_t n = read(in, buffer, sizeof(buffer));
                    if (n < 0 && errno == EINTR) continue;
                    if (n < 0) { result = failure(s, "Cannot read source file"); break; }
                    if (!n) break;
                    copied += (uint64_t)n;
                    if (copied > (uint64_t)before.st_size || time(NULL) - b->start > 60)
                        result = error(s, "Source changed or exceeded copy deadline");
                    else result = write_all(s, out, buffer, (size_t)n);
                }
                if (!result && (fstat(in, &after) || copied != (uint64_t)before.st_size ||
                    before.st_mtim.tv_sec != after.st_mtim.tv_sec || before.st_mtim.tv_nsec != after.st_mtim.tv_nsec ||
                    before.st_ctim.tv_sec != after.st_ctim.tv_sec || before.st_ctim.tv_nsec != after.st_ctim.tv_nsec))
                    result = error(s, "Source file changed during staging");
                if (!result && (fchmod(out, before.st_mode & 0111 ? 0500 : 0400) || fsync(out)))
                    result = failure(s, "Cannot finalize staged file");
                close(out);
            }
        }
        close(in);
        if (result) break;
    }
    closedir(dir);
    return result;
}
static int extract_archive(struct Store *s, int source, int target)
{
    struct archive *a = archive_read_new();
    if (!a) return error(s, "Cannot allocate archive reader");
    archive_read_support_filter_gzip(a);
    archive_read_support_format_tar(a); archive_read_support_format_zip(a);
    int result = 0;
    struct Budget b = {.start=time(NULL)};
    if (archive_read_open_fd(a, source, 65536) != ARCHIVE_OK) result = error(s, "Cannot open tar/zip: %s", archive_error_string(a));
    struct archive_entry *entry;
    while (!result) {
        int status = archive_read_next_header(a, &entry);
        if (status == ARCHIVE_EOF) break;
        if (status != ARCHIVE_OK) { result = error(s, "Invalid archive header: %s", archive_error_string(a)); break; }
        const char *name = archive_entry_pathname(entry);
        if (!name || strlen(name) > 1024) { result = error(s, "Archive path exceeds limit"); break; }
        while (!strncmp(name, "./", 2)) name += 2;
        if ((!*name || !strcmp(name, ".")) && archive_entry_filetype(entry) == AE_IFDIR) {
            if (budget(s, &b, 0)) result = -1;
            continue;
        }
        char path[1025]; strcpy(path, name);
        bool is_dir = archive_entry_filetype(entry) == AE_IFDIR;
        if (is_dir && *path && path[strlen(path)-1] == '/') path[strlen(path)-1] = 0;
        int64_t size = archive_entry_size(entry);
        if (!relative(path) || archive_entry_symlink(entry) || archive_entry_hardlink(entry) ||
            archive_entry_is_encrypted(entry) || (archive_entry_mode(entry) & (S_ISUID | S_ISGID)) ||
            (!is_dir && archive_entry_filetype(entry) != AE_IFREG) || size < 0 ||
            (is_dir && size != 0) || budget(s, &b, (uint64_t)size)) {
            result = error(s, "Unsafe archive member, encryption, link or size/count limit"); break;
        }
        char *part = path, *slash;
        int parent = dup(target);
        if (parent < 0) { result = failure(s, "Cannot open staging directory"); break; }
        while ((slash = strchr(part, '/'))) {
            *slash = 0;
            int next = directory(s, parent, part, true, true); close(parent); parent = next;
            if (parent < 0) break;
            part = slash+1;
        }
        if (parent < 0) { result = -1; break; }
        if (is_dir) {
            int dir = directory(s, parent, part, true, true);
            if (dir < 0) result = -1; else close(dir);
        } else {
            int fd = openat(parent, part, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
            if (fd < 0) result = failure(s, "Duplicate/conflicting archive member");
            else {
                char buffer[65536]; int64_t copied = 0;
                while (!result) {
                    la_ssize_t n = archive_read_data(a, buffer, sizeof(buffer));
                    if (n < 0) { result = error(s, "Cannot decompress archive: %s", archive_error_string(a)); break; }
                    if (!n) break;
                    copied += n;
                    if (copied > size || time(NULL) - b.start > 60) result = error(s, "Archive data exceeds declared size or deadline");
                    else result = write_all(s, fd, buffer, (size_t)n);
                }
                if (!result && copied != size) result = error(s, "Truncated archive member");
                if (!result && (fchmod(fd, archive_entry_perm(entry) & 0111 ? 0500 : 0400) || fsync(fd)))
                    result = failure(s, "Cannot finalize archive member");
                close(fd);
            }
        }
        close(parent);
    }
    if (archive_read_close(a) != ARCHIVE_OK && !result) result = error(s, "Archive trailer validation failed");
    archive_read_free(a);
    return result;
}
static int remove_tree(struct Store *s, int parent, const char *name)
{
    int fd = directory(s, parent, name, false, true);
    if (fd < 0) return -1;
    if (fchmod(fd, 0700)) { close(fd); return failure(s, "Cannot unlock owned staging directory"); }
    DIR *dir = fdopendir(fd);
    if (!dir) { close(fd); return failure(s, "Cannot enumerate owned staging directory"); }
    int result = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(dir);
        if (!entry) { if (errno) result = failure(s, "Cannot enumerate staging cleanup"); break; }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        struct stat info;
        if (fstatat(fd, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) || info.st_uid != getuid()) {
            result = error(s, "Staging cleanup encountered an unowned member"); break;
        }
        result = S_ISDIR(info.st_mode) ? remove_tree(s, fd, entry->d_name) :
            unlinkat(fd, entry->d_name, 0) ? failure(s, "Cannot remove staging file") : 0;
        if (result) break;
    }
    closedir(dir);
    if (!result && unlinkat(parent, name, AT_REMOVEDIR)) result = failure(s, "Cannot remove owned staging directory");
    return result;
}
static int hash_number(EVP_MD_CTX *hash, uint64_t number)
{
    unsigned char bytes[8];
    for (unsigned i = 0; i < sizeof(bytes); i++) bytes[i] = (unsigned char)(number >> (8*i));
    return EVP_DigestUpdate(hash, bytes, sizeof(bytes)) == 1 ? 0 : -1;
}
static int sort_names(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }
static int hash_tree(struct Store *s, int fd, EVP_MD_CTX *hash, struct Budget *b, unsigned depth, bool seal)
{
    if (depth > 32) return error(s, "Installed package nesting exceeds limit");
    DIR *dir = fdopendir(openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
    if (!dir) return failure(s, "Cannot enumerate installed payload");
    char **names = calloc(ENTRY_LIMIT, sizeof(*names));
    unsigned count = 0;
    int result = names ? 0 : error(s, "Cannot allocate package inventory");
    while (!result) {
        errno = 0;
        struct dirent *entry = readdir(dir);
        if (!entry) { if (errno) result = failure(s, "Cannot enumerate payload"); break; }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        if (count == ENTRY_LIMIT || !safe_component(entry->d_name)) { result = error(s, "Invalid package inventory"); break; }
        names[count] = strdup(entry->d_name);
        if (!names[count++]) result = error(s, "Cannot allocate inventory name");
    }
    closedir(dir);
    if (!result) qsort(names, count, sizeof(*names), sort_names);
    if (!result && hash_number(hash, count)) result = error(s, "Cannot hash directory boundaries");
    for (unsigned i = 0; i < count && !result; i++) {
        int in = openat(fd, names[i], O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
        struct stat info;
        if (in < 0 || fstat(in, &info) || info.st_uid != getuid() || (info.st_mode & 022) ||
            (!S_ISDIR(info.st_mode) && (!S_ISREG(info.st_mode) || info.st_nlink != 1))) {
            if (in >= 0) close(in);
            result = error(s, "Installed application contains unsafe file metadata"); break;
        }
        bool is_dir = S_ISDIR(info.st_mode);
        if (budget(s, b, is_dir ? 0 : (uint64_t)info.st_size) ||
            hash_number(hash, strlen(names[i])) || EVP_DigestUpdate(hash, names[i], strlen(names[i])) != 1 ||
            hash_number(hash, is_dir ? 2 : (info.st_mode & 0111 ? 1 : 0)) ||
            hash_number(hash, is_dir ? 0 : (uint64_t)info.st_size)) result = error(s, "Cannot hash bounded package inventory");
        else if (is_dir) result = hash_tree(s, in, hash, b, depth+1, seal);
        else {
            char bytes[65536]; uint64_t copied = 0;
            while (!result) {
                ssize_t n = read(in, bytes, sizeof(bytes));
                if (n < 0 && errno == EINTR) continue;
                if (n < 0) { result = failure(s, "Cannot read payload for verification"); break; }
                if (!n) break;
                copied += (uint64_t)n;
                if (copied > (uint64_t)info.st_size || time(NULL) - b->start > 60 ||
                    EVP_DigestUpdate(hash, bytes, (size_t)n) != 1) result = error(s, "Application changed during verification");
            }
            if (!result && copied != (uint64_t)info.st_size) result = error(s, "Application payload was truncated");
        }
        close(in);
    }
    if (names) { for (unsigned i = 0; i < count; i++) free(names[i]); free(names); }
    if (!result && seal && (fchmod(fd, 0500) || fsync(fd))) result = failure(s, "Cannot seal staged directory");
    return result;
}
static int digest_tree(struct Store *s, int fd, char digest[65], bool seal)
{
    EVP_MD_CTX *hash = EVP_MD_CTX_new();
    if (!hash || EVP_DigestInit_ex(hash, EVP_sha256(), NULL) != 1) {
        EVP_MD_CTX_free(hash); return error(s, "Cannot initialize SHA256 inventory");
    }
    struct Budget b = {.start=time(NULL)};
    int result = hash_tree(s, fd, hash, &b, 0, seal);
    unsigned char bytes[32]; unsigned length = 0;
    if (!result && (EVP_DigestFinal_ex(hash, bytes, &length) != 1 || length != sizeof(bytes)))
        result = error(s, "Cannot finalize package checksum");
    EVP_MD_CTX_free(hash);
    if (!result) for (unsigned i = 0; i < sizeof(bytes); i++) snprintf(digest + i*2, 3, "%02x", bytes[i]);
    return result;
}
static void exception(struct Store *s, JSContext *ctx)
{
    JSValue value = JS_GetException(ctx);
    const char *message = JS_ToCString(ctx, value);
    error(s, "%s", message ? message : "Application schema error");
    JS_FreeCString(ctx, message); JS_FreeValue(ctx, value);
}
static int schema_open(struct Store *s, struct Schema *schema)
{
    *schema = (struct Schema){.module=JS_UNDEFINED};
    schema->runtime = JS_NewRuntime();
    if (!schema->runtime) return error(s, "Cannot allocate bundle validation runtime");
    JS_SetMemoryLimit(schema->runtime, 16 * 1024 * 1024);
    JS_SetMaxStackSize(schema->runtime, 512 * 1024);
    schema->ctx = JS_NewContext(schema->runtime);
    if (!schema->ctx) return error(s, "Cannot allocate bundle validation context");
    JSValue compiled = JS_Eval(schema->ctx, (const char *)bundle_schema, sizeof(bundle_schema)-1,
        "app-bundle.mjs", JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(compiled)) { exception(s, schema->ctx); return -1; }
    JSModuleDef *module = JS_VALUE_GET_PTR(compiled);
    JSValue evaluated = JS_EvalFunction(schema->ctx, compiled);
    int result = JS_IsException(evaluated) ? -1 : 0;
    if (result) exception(s, schema->ctx);
    else if (JS_IsPromise(evaluated) && JS_PromiseState(schema->ctx, evaluated) != JS_PROMISE_FULFILLED)
        result = error(s, "Embedded bundle schema did not initialize synchronously");
    if (!result) {
        schema->module = JS_GetModuleNamespace(schema->ctx, module);
        if (JS_IsException(schema->module)) { exception(s,schema->ctx); result=-1; }
    }
    JS_FreeValue(schema->ctx, evaluated);
    return result;
}
static void schema_close(struct Schema *schema)
{
    if (schema->ctx) { JS_FreeValue(schema->ctx, schema->module); JS_FreeContext(schema->ctx); }
    if (schema->runtime) JS_FreeRuntime(schema->runtime);
}
static JSValue schema_call(struct Store *s, struct Schema *schema, const char *name, int argc, JSValue *argv)
{
    JSValue fn = JS_GetPropertyStr(schema->ctx, schema->module, name);
    JSValue result = JS_IsException(fn) ? JS_EXCEPTION : JS_Call(schema->ctx, fn, JS_UNDEFINED, argc, argv);
    JS_FreeValue(schema->ctx, fn);
    if (JS_IsException(result)) exception(s, schema->ctx);
    return result;
}
static JSValue metadata(struct Store *s, struct Schema *schema, int fd, const char *name, bool record)
{
    char *text = read_text(s, fd, name, record ? RECORD_LIMIT : 65536, true);
    if (!text) return JS_EXCEPTION;
    JSValue parsed = record ? JS_ParseJSON(schema->ctx, text, strlen(text), "installed-record") :
        JS_NewString(schema->ctx, text);
    free(text);
    if (JS_IsException(parsed)) { exception(s, schema->ctx); return JS_EXCEPTION; }
    JSValue result = schema_call(s, schema, record ? "validateBundleRecord" : "parseBundleManifest", 1, &parsed);
    JS_FreeValue(schema->ctx, parsed); return result;
}
static char *field(struct Store *s, JSContext *ctx, JSValueConst object, const char *name)
{
    JSValue value = JS_GetPropertyStr(ctx, object, name);
    const char *text = JS_IsException(value) ? NULL : JS_ToCString(ctx, value);
    char *copy = text ? strdup(text) : NULL;
    JS_FreeCString(ctx, text); JS_FreeValue(ctx, value);
    if (!copy) error(s, "Cannot read application field: %s", name);
    return copy;
}
static JSValue environment_object(JSContext *ctx)
{
    JSValue result = JS_NewObject(ctx);
    const char *names[] = {"HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"};
    for (unsigned i = 0; i < sizeof(names)/sizeof(names[0]); i++) {
        const char *value = getenv(names[i]);
        if (value) JS_SetPropertyStr(ctx, result, names[i], JS_NewString(ctx, value));
    }
    return result;
}
static int own_executable(struct Store *s, const char *name, char path[PATH_MAX])
{
    ssize_t n = readlink("/proc/self/exe", path, PATH_MAX-1);
    if (n <= 0 || n >= PATH_MAX-1) return failure(s, "Cannot locate bundle executable");
    path[n] = 0; char *slash = strrchr(path, '/');
    if (!slash || (size_t)(slash-path)+1+strlen(name) >= PATH_MAX) return error(s, "Invalid bundle executable location");
    strcpy(slash+1, name); return 0;
}
static JSValue launch_plan(struct Store *s, struct Schema *schema, JSValue manifest, const char *root)
{
    JSContext *ctx = schema->ctx;
    JSValue options = JS_NewObject(ctx), target = JS_NewObject(ctx);
    char runtime[PATH_MAX];
    if (own_executable(s, "pollyui", runtime)) { JS_FreeValue(ctx, options); JS_FreeValue(ctx, target); return JS_EXCEPTION; }
    JS_SetPropertyStr(ctx, target, "os", JS_NewString(ctx, "linux"));
#if defined(__x86_64__)
    JS_SetPropertyStr(ctx, target, "architecture", JS_NewString(ctx, "x86_64"));
#else
    JS_SetPropertyStr(ctx, target, "architecture", JS_NewString(ctx, "unsupported"));
#endif
#if defined(__GLIBC__)
    JS_SetPropertyStr(ctx, target, "libc", JS_NewString(ctx, "glibc"));
#else
    JS_SetPropertyStr(ctx, target, "libc", JS_NewString(ctx, "musl"));
#endif
    JS_SetPropertyStr(ctx, options, "bundleRoot", JS_NewString(ctx, root));
    JS_SetPropertyStr(ctx, options, "platform", target);
    JS_SetPropertyStr(ctx, options, "environment", environment_object(ctx));
    JS_SetPropertyStr(ctx, options, "pollyuiExecutable", JS_NewString(ctx, runtime));
    JSValue args[] = {manifest, options};
    JSValue result = schema_call(s, schema, "planBundleLaunch", 2, args);
    JS_FreeValue(ctx, options); return result;
}
static int validate_entry(struct Store *s, JSContext *ctx, JSValue manifest, int fd)
{
    JSValue launch = JS_GetPropertyStr(ctx, manifest, "launch");
    char *entry = field(s, ctx, launch, "entry"), *kind = field(s, ctx, launch, "kind");
    JS_FreeValue(ctx, launch);
    int result = -1;
    if (entry && kind) {
        int file = file_open(s, fd, entry, O_RDONLY, 0);
        struct stat info;
        if (file >= 0) {
            if (fstat(file, &info) || !S_ISREG(info.st_mode) || !info.st_size ||
                (!strcmp(kind, "native") && !(info.st_mode & S_IXUSR)))
                error(s, "Bundle entry must be a nonempty regular file, executable for native apps");
            else result = 0;
            close(file);
        }
    }
    free(entry); free(kind);
    JSValue icon = JS_GetPropertyStr(ctx, manifest, "icon");
    if (!result && !JS_IsUndefined(icon)) {
        const char *name = JS_ToCString(ctx, icon);
        int file = name ? file_open(s, fd, name, O_RDONLY, 0) : -1;
        struct stat info;
        if (file < 0) result = -1;
        else {
            if (fstat(file, &info) || !S_ISREG(info.st_mode) || info.st_size < 1 || info.st_size > 4*1024*1024)
                result = error(s, "Bundle icon must be a regular bitmap of at most 4 MiB");
            close(file);
        }
        JS_FreeCString(ctx, name);
    }
    JS_FreeValue(ctx, icon);
    return result;
}
static int publish_record(struct Store *s, JSContext *ctx, const char *name, JSValue record)
{
    JSValue json = JS_JSONStringify(ctx, record, JS_UNDEFINED, JS_UNDEFINED);
    size_t size = 0;
    const char *text = JS_IsException(json) ? NULL : JS_ToCStringLen(ctx, &size, json);
    char temporary[40];
    int result = -1, fd = -1;
    if (!text || size > RECORD_LIMIT) error(s, "Cannot encode bounded registry record");
    else if (!random_name(s, temporary)) {
        fd = openat(s->apps, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (fd < 0) failure(s, "Cannot stage application registry");
        else {
            result = write_all(s, fd, text, size);
            if (!result && fsync(fd)) result = failure(s, "Cannot sync application registry");
            close(fd); fd = -1;
            if (!result && renameat(s->apps, temporary, s->apps, name)) result = failure(s, "Cannot commit application registry");
            if (!result && fsync(s->apps))
                result = error(s, "Registry was replaced but directory sync failed; inspect installed state before retrying");
            if (result && unlinkat(s->apps, temporary, 0) && errno != ENOENT)
                fprintf(stderr, "[bundles] Registry staging cleanup failed: %s\n", strerror(errno));
        }
    }
    JS_FreeCString(ctx, text); JS_FreeValue(ctx, json);
    return result;
}
static int stage_source(struct Store *s, const char *path, int target)
{
    if (!path || path[0] != '/' || strlen(path) >= PATH_MAX) return error(s, "Bundle source must be an absolute path");
    char copy[PATH_MAX]; strcpy(copy, path);
    char *slash = strrchr(copy, '/');
    if (!slash || !safe_component(slash+1)) return error(s, "Invalid bundle source name");
    char name[256]; strcpy(name, slash+1);
    if (slash == copy) slash[1] = 0; else *slash = 0;
    int parent = absolute_directory(s, copy, false, false);
    if (parent < 0) return -1;
    int source = openat(parent, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    close(parent);
    if (source < 0) return failure(s, "Cannot open bundle source");
    struct stat info;
    int result;
    if (fstat(source, &info)) result = failure(s, "Cannot inspect bundle source");
    else if (S_ISDIR(info.st_mode)) {
        struct stat current;
        if (!fstat(s->root, &current) && current.st_dev == info.st_dev && current.st_ino == info.st_ino)
            result = error(s, "Application store cannot be installed as its own package");
        else { struct Budget b = {.start=time(NULL)}; result = copy_tree(s, source, target, 0, &b); }
    } else if (S_ISREG(info.st_mode) && info.st_nlink == 1 && info.st_size > 0 && (uint64_t)info.st_size <= TOTAL_LIMIT)
        result = extract_archive(s, source, target);
    else result = error(s, "Source must be a directory or bounded regular tar/zip file");
    close(source); return result;
}
static JSValue get_record(struct Store *s, struct Schema *schema, const char *id, bool optional)
{
    JSValue value = JS_NewString(schema->ctx, id);
    JSValue valid = schema_call(s, schema, "validateBundleId", 1, &value);
    JS_FreeValue(schema->ctx, value);
    if (JS_IsException(valid)) return valid;
    JS_FreeValue(schema->ctx, valid);
    char name[140]; snprintf(name, sizeof(name), "%s.json", id);
    struct stat info;
    if (optional && fstatat(s->apps, name, &info, AT_SYMLINK_NOFOLLOW) && errno == ENOENT) return JS_NULL;
    JSValue record = metadata(s, schema, s->apps, name, true);
    if (JS_IsException(record)) return record;
    JSValue current = JS_GetPropertyStr(schema->ctx, record, "current");
    JSValue manifest = JS_GetPropertyStr(schema->ctx, current, "manifest");
    char *actual = field(s, schema->ctx, manifest, "id");
    bool matches = actual && !strcmp(actual, id);
    free(actual); JS_FreeValue(schema->ctx, manifest); JS_FreeValue(schema->ctx, current);
    if (!matches) { JS_FreeValue(schema->ctx, record); error(s, "Registry ID does not match its filename"); return JS_EXCEPTION; }
    return record;
}
static int install_bundle(struct Store *s, struct Schema *schema, const char *source, const char *expected)
{
    char stage[40] = "", digest[65], root[PATH_MAX], record_name[140];
    JSContext *ctx = schema->ctx;
    JSValue manifest = JS_UNDEFINED, record = JS_UNDEFINED, old = JS_UNDEFINED, descriptor = JS_UNDEFINED;
    int result = -1, fd = -1;
    bool staged = false, unchanged = false;
    char *id = NULL;
    if (random_name(s, stage)) goto done;
    if (mkdirat(s->objects, stage, 0700)) { failure(s, "Cannot create unique application staging directory"); goto done; }
    staged = true;
    fd = directory(s, s->objects, stage, false, true);
    if (fd < 0 || stage_source(s, source, fd)) goto done;
    manifest = metadata(s, schema, fd, "manifest.json", false);
    if (JS_IsException(manifest) || validate_entry(s, ctx, manifest, fd)) goto done;
    id = field(s, ctx, manifest, "id");
    if (!id || digest_tree(s, fd, digest, true)) goto done;
    int n = snprintf(root, sizeof(root), "%s/objects/%s", s->path, digest);
    if (n < 0 || n >= (int)sizeof(root)) { error(s, "Installed application path exceeds limit"); goto done; }
    JSValue plan = launch_plan(s, schema, manifest, root);
    bool valid = !JS_IsException(plan); JS_FreeValue(ctx, plan); if (!valid) goto done;
    old = get_record(s, schema, id, true);
    if (JS_IsException(old)) goto done;
    if (JS_IsNull(old)) {
        if (!strcmp(id, "org.pollyui.shell") || !strcmp(id, "org.pollyui.ime")) {
            error(s, "System Shell/input-method identities cannot be installed as user bundles"); goto done;
        }
        struct stat retired_info;
        if (!fstatat(s->root,"retired",&retired_info,AT_SYMLINK_NOFOLLOW)) {
            int retired=directory(s,s->root,"retired",false,true);
            if(retired<0) goto done;
            char retired_name[140]; snprintf(retired_name,sizeof(retired_name),"%s.json",id);
            int exists=fstatat(retired,retired_name,&retired_info,AT_SYMLINK_NOFOLLOW);
            int saved_errno=errno; close(retired);
            if(!exists || saved_errno!=ENOENT) {
                error(s,"Application ID has retained registration; restore it explicitly before replacing"); goto done;
            }
        } else if(errno!=ENOENT) { failure(s,"Cannot inspect retained identities"); goto done; }
        JSValue fresh_plan = launch_plan(s, schema, manifest, root);
        if (JS_IsException(fresh_plan)) goto done;
        JSValue paths = JS_GetPropertyStr(ctx, fresh_plan, "paths");
        const char *fields[] = {"configDir","dataDir","cacheDir","stateDir"};
        bool free_identity = true;
        for (unsigned i=0;i<4;i++) {
            char *path = field(s,ctx,paths,fields[i]);
            struct stat info;
            if (!path || !lstat(path,&info) || errno != ENOENT) free_identity = false;
            free(path);
        }
        JS_FreeValue(ctx,paths); JS_FreeValue(ctx,fresh_plan);
        if (!free_identity) { error(s,"Unregistered application data already exists; explicit data adoption is not implemented"); goto done; }
        DIR *dir = fdopendir(openat(s->apps, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
        if (!dir) { failure(s, "Cannot inspect catalog capacity"); goto done; }
        unsigned count = 0;
        bool ok = true;
        for (;;) {
            errno = 0; struct dirent *item = readdir(dir);
            if (!item) { if (errno) ok = false; break; }
            if (item->d_name[0] != '.') count++;
        }
        closedir(dir);
        if (!ok || count >= 256) { error(s, "Cannot install beyond the 256-application catalog limit"); goto done; }
    }
    if (!JS_IsNull(old)) {
        if (!expected) { error(s, "Application ID already installed; an explicit replace with its current digest is required"); goto done; }
        descriptor = JS_GetPropertyStr(ctx, old, "current");
        char *current = field(s, ctx, descriptor, "digest");
        bool matches = current && !strcmp(current, expected);
        unchanged = matches && !strcmp(current, digest);
        free(current);
        if (!matches) { error(s, "Installed application changed; replacement digest is stale"); goto done; }
    } else if (expected) { error(s, "Cannot replace an application that is not installed"); goto done; }
    JSValue next = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, next, "digest", JS_NewString(ctx, digest));
    JS_SetPropertyStr(ctx, next, "manifest", JS_DupValue(ctx, manifest));
    record = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, record, "schemaVersion", JS_NewInt32(ctx, 1));
    JS_SetPropertyStr(ctx, record, "current", next);
    JS_SetPropertyStr(ctx, record, "previous", JS_IsNull(old) ? JS_NULL : JS_DupValue(ctx, descriptor));
    JSValue checked = schema_call(s, schema, "validateBundleRecord", 1, &record);
    valid = !JS_IsException(checked); JS_FreeValue(ctx, checked); if (!valid) goto done;
    struct stat exists;
    if (!fstatat(s->objects, digest, &exists, AT_SYMLINK_NOFOLLOW)) {
        int current = directory(s, s->objects, digest, false, true);
        char actual[65];
        if (current < 0) goto done;
        int verified = digest_tree(s, current, actual, false);
        close(current);
        if (verified || strcmp(actual, digest)) { error(s, "Existing content object failed verification"); goto done; }
    } else if (errno != ENOENT) { failure(s, "Cannot inspect installed content"); goto done; }
    else {
        if (renameat(s->objects, stage, s->objects, digest)) { failure(s, "Cannot publish application content"); goto done; }
        staged = false;
        if (fsync(s->objects)) { error(s, "Content published but sync failed; no registry change performed"); goto done; }
    }
    if (unchanged) {
        result = 0;
        printf("%s %s\n", id, digest);
        goto done;
    }
    snprintf(record_name, sizeof(record_name), "%s.json", id);
    result = publish_record(s, ctx, record_name, record);
    if (!result) printf("%s %s\n", id, digest);
done:
    if (fd >= 0) close(fd);
    if (staged) {
        char prior[sizeof(s->error)]; strcpy(prior, s->error);
        if (remove_tree(s, s->objects, stage)) { fprintf(stderr, "[bundles] %s\n", s->error); result = -1; }
        if (*prior) strcpy(s->error, prior);
    }
    free(id); JS_FreeValue(ctx, manifest); JS_FreeValue(ctx, record);
    JS_FreeValue(ctx, descriptor); JS_FreeValue(ctx, old);
    return result;
}
static JSValue catalog(struct Store *s, JSContext *ctx)
{
    JSValue result = JS_NewArray(ctx);
    DIR *dir = fdopendir(openat(s->apps, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
    if (!dir) { failure(s, "Cannot enumerate registered applications"); JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    uint32_t count = 0;
    for (;;) {
        errno = 0; struct dirent *entry = readdir(dir);
        if (!entry) { if (errno) failure(s, "Cannot read application registry"); break; }
        if (entry->d_name[0] == '.') continue;
        size_t n = strlen(entry->d_name);
        if (n <= 5 || strcmp(entry->d_name+n-5, ".json") || count >= 256) {
            error(s, "Unexpected registry file or catalog limit exceeded"); break;
        }
        char *text = read_text(s, s->apps, entry->d_name, RECORD_LIMIT, true);
        if (!text) break;
        JSValue item = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, item, "id", JS_NewStringLen(ctx, entry->d_name, n-5));
        JS_SetPropertyStr(ctx, item, "contents", JS_NewString(ctx, text));
        JS_SetPropertyStr(ctx, item, "store", JS_NewString(ctx, s->path));
        free(text);
        if (JS_SetPropertyUint32(ctx, result, count++, item) < 0) { error(s, "Cannot allocate registry snapshot"); break; }
    }
    closedir(dir);
    if (*s->error) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    return result;
}
static int run_bundle(struct Store *s, struct Schema *schema, const char *id, const char *expected)
{
    JSContext *ctx = schema->ctx;
    JSValue record = get_record(s, schema, id, false), current = JS_UNDEFINED, manifest = JS_UNDEFINED, plan = JS_UNDEFINED;
    char *digest = NULL, *cwd = NULL, **argv = NULL;
    int fd = -1, result = -1;
    if (JS_IsException(record)) goto done;
    current = JS_GetPropertyStr(ctx, record, "current");
    digest = field(s, ctx, current, "digest");
    if (!digest || (expected && strcmp(digest, expected))) { error(s, "Application selection is stale; refresh the catalog"); goto done; }
    manifest = JS_GetPropertyStr(ctx, current, "manifest");
    fd = directory(s, s->objects, digest, false, true);
    char actual[65], root[PATH_MAX];
    if (fd < 0 || digest_tree(s, fd, actual, false)) goto done;
    if (strcmp(actual, digest)) { error(s, "Installed application content was modified"); goto done; }
    JSValue content_manifest = metadata(s, schema, fd, "manifest.json", false);
    JSValue first = JS_JSONStringify(ctx, manifest, JS_UNDEFINED, JS_UNDEFINED);
    JSValue second = JS_JSONStringify(ctx, content_manifest, JS_UNDEFINED, JS_UNDEFINED);
    const char *a = JS_ToCString(ctx, first), *b = JS_ToCString(ctx, second);
    bool same = a && b && !strcmp(a,b);
    JS_FreeCString(ctx,a); JS_FreeCString(ctx,b);
    JS_FreeValue(ctx,first); JS_FreeValue(ctx,second); JS_FreeValue(ctx,content_manifest);
    if (!same) { error(s, "Registry manifest does not match installed content"); goto done; }
    if (validate_entry(s, ctx, manifest, fd)) goto done;
    int n = snprintf(root, sizeof(root), "%s/objects/%s", s->path, digest);
    if (n < 0 || n >= (int)sizeof(root)) { error(s, "Installed path exceeds limit"); goto done; }
    plan = launch_plan(s, schema, manifest, root);
    if (JS_IsException(plan)) goto done;
    JSValue paths = JS_GetPropertyStr(ctx, plan, "paths");
    const char *keys[] = {"configDir","dataDir","cacheDir","stateDir"};
    for (unsigned i=0; i<4; i++) {
        char *path = field(s, ctx, paths, keys[i]);
        int dir = path ? absolute_directory(s, path, true, true) : -1;
        free(path); if (dir < 0) { JS_FreeValue(ctx, paths); goto done; } close(dir);
    }
    JS_FreeValue(ctx, paths);
    JSValue values = JS_GetPropertyStr(ctx, plan, "argv"), length = JS_GetPropertyStr(ctx, values, "length");
    uint32_t count = 0;
    int converted = JS_ToUint32(ctx, &count, length);
    JS_FreeValue(ctx, length);
    if (converted < 0 || !count || count > 68) { JS_FreeValue(ctx, values); error(s, "Invalid managed launch arguments"); goto done; }
    argv = calloc(count+1, sizeof(*argv));
    if (!argv) { JS_FreeValue(ctx, values); error(s, "Cannot allocate launch arguments"); goto done; }
    for (uint32_t i=0; i<count; i++) {
        JSValue arg = JS_GetPropertyUint32(ctx, values, i);
        const char *text = JS_ToCString(ctx, arg);
        argv[i] = text ? strdup(text) : NULL;
        JS_FreeCString(ctx,text); JS_FreeValue(ctx,arg);
        if (!argv[i]) { JS_FreeValue(ctx,values); error(s, "Cannot copy launch arguments"); goto done; }
    }
    JS_FreeValue(ctx,values);
    JSValue overrides = JS_GetPropertyStr(ctx, plan, "environmentOverrides");
    const char *variables[] = {"XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_CACHE_HOME","XDG_STATE_HOME"};
    for (unsigned i=0; i<4; i++) {
        JSValue value = JS_GetPropertyStr(ctx, overrides, variables[i]);
        if (!JS_IsUndefined(value)) {
            const char *text = JS_ToCString(ctx,value);
            bool ok = text && setenv(variables[i],text,1) == 0;
            JS_FreeCString(ctx,text);
            if (!ok) { JS_FreeValue(ctx,value); JS_FreeValue(ctx,overrides); failure(s,"Cannot configure data environment"); goto done; }
        }
        JS_FreeValue(ctx,value);
    }
    JS_FreeValue(ctx,overrides);
    cwd = field(s,ctx,plan,"cwd");
    if (!cwd || chdir(cwd)) { failure(s,"Cannot enter application code directory"); goto done; }
    const char *drop[] = {"WAYLAND_SOCKET","DISPLAY","SDL_APP_ID","DESKTOP_STARTUP_ID","XDG_ACTIVATION_TOKEN",
        "PU_CAPTURE_FRAME","PU_TRACE_FRAMES","PU_TRACE_STARTUP","DBUS_STARTER_ADDRESS","DBUS_STARTER_BUS_TYPE"};
    for (unsigned i=0;i<sizeof(drop)/sizeof(drop[0]);i++)
        if (unsetenv(drop[i])) { failure(s,"Cannot remove inherited application authority"); goto done; }
    /* Version objects are retained: detached descendants cannot lose code after an update. */
    if (flock(s->lock, LOCK_UN)) { failure(s,"Cannot release registry lock"); goto done; }
    DIR *descriptors = opendir("/proc/self/fd");
    if (!descriptors) { failure(s,"Cannot close inherited descriptors"); goto done; }
    for (;;) {
        errno=0; struct dirent *entry = readdir(descriptors);
        if (!entry) { if (errno) { failure(s,"Cannot enumerate inherited descriptors"); closedir(descriptors); goto done; } break; }
        char *end; long number = strtol(entry->d_name,&end,10);
        if (!*end && number >= 3 && number <= INT_MAX && number != dirfd(descriptors))
            if (fcntl((int)number,F_SETFD,FD_CLOEXEC) < 0 && errno != EBADF) {
                failure(s,"Cannot seal inherited descriptor"); closedir(descriptors); goto done;
            }
    }
    closedir(descriptors);
    execv(argv[0], argv);
    failure(s,"Managed application exec failed");
done:
    if (fd >= 0) close(fd);
    free(digest); free(cwd);
    if (argv) { for (unsigned i=0;argv[i];i++) free(argv[i]); free(argv); }
    JS_FreeValue(ctx,plan); JS_FreeValue(ctx,manifest); JS_FreeValue(ctx,current); JS_FreeValue(ctx,record);
    return result;
}
static int rollback_bundle(struct Store *s, struct Schema *schema, const char *id, const char *expected)
{
    JSContext *ctx = schema->ctx;
    JSValue record = get_record(s, schema, id, false);
    if (JS_IsException(record)) return -1;
    JSValue current = JS_GetPropertyStr(ctx, record, "current"), previous = JS_GetPropertyStr(ctx, record, "previous");
    char *digest = field(s, ctx, current, "digest"), *target = NULL;
    int result = -1;
    if (!digest || strcmp(digest, expected)) error(s, "Application changed; rollback digest is stale");
    else if (JS_IsNull(previous)) error(s, "No previous application version is registered");
    else {
        target = field(s, ctx, previous, "digest");
        int fd = target ? directory(s, s->objects, target, false, true) : -1;
        char actual[65];
        if (fd >= 0) {
            result = digest_tree(s, fd, actual, false);
            close(fd);
            if (!result && strcmp(actual,target)) result = error(s, "Previous application content was modified");
            if (!result) {
                JSValue next = JS_NewObject(ctx);
                JS_SetPropertyStr(ctx,next,"schemaVersion",JS_NewInt32(ctx,1));
                JS_SetPropertyStr(ctx,next,"current",JS_DupValue(ctx,previous));
                JS_SetPropertyStr(ctx,next,"previous",JS_DupValue(ctx,current));
                char name[140]; snprintf(name,sizeof(name),"%s.json",id);
                result = publish_record(s,ctx,name,next);
                JS_FreeValue(ctx,next);
                if (!result) printf("%s %s\n",id,target);
            }
        }
    }
    free(digest); free(target);
    JS_FreeValue(ctx,current); JS_FreeValue(ctx,previous); JS_FreeValue(ctx,record);
    return result;
}
static int registration(struct Store *s, struct Schema *schema, const char *id, const char *expected, bool restore)
{
    int retired = directory(s, s->root, "retired", true, true);
    if (retired < 0) return -1;
    int active = s->apps;
    if (restore) s->apps = retired;
    JSValue record = get_record(s, schema, id, false);
    s->apps = active;
    if (JS_IsException(record)) { close(retired); return -1; }
    JSContext *ctx = schema->ctx;
    JSValue current = JS_GetPropertyStr(ctx, record, "current");
    char *digest = field(s, ctx, current, "digest");
    int result = -1;
    char name[140]; snprintf(name, sizeof(name), "%s.json", id);
    struct stat info;
    int destination = restore ? active : retired;
    if (!digest || strcmp(digest, expected)) error(s, "Application identity/version changed; registration digest is stale");
    else if (!fstatat(destination, name, &info, AT_SYMLINK_NOFOLLOW) || errno != ENOENT)
        error(s, "Destination application registration already exists or cannot be inspected");
    else {
        if (restore) {
            DIR *dir = fdopendir(openat(active, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
            if (!dir) { failure(s, "Cannot inspect catalog capacity"); goto done; }
            unsigned count = 0;
            bool ok = true;
            for (;;) {
                errno = 0; struct dirent *entry = readdir(dir);
                if (!entry) { if (errno) ok = false; break; }
                if (entry->d_name[0] != '.') count++;
            }
            closedir(dir);
            if (!ok || count >= 256) { error(s, "Cannot restore beyond the catalog limit"); goto done; }
        }
        int fd = directory(s, s->objects, digest, false, true);
        char actual[65];
        if (fd >= 0) {
            result = digest_tree(s, fd, actual, false);
            close(fd);
            if (!result && strcmp(actual, digest)) result = error(s, "Cannot change registration of a modified application");
            if (!result && renameat(restore ? retired : active, name, destination, name))
                result = failure(s, "Cannot change application registration");
            if (!result && (fsync(retired) || fsync(active)))
                result = error(s, "Registration changed but directory sync failed; inspect state before retrying");
            if (!result) printf("%s %s %s; version cache and appdata retained\n", restore ? "Restored" : "Removed", id, digest);
        }
    }
done:
    free(digest); JS_FreeValue(ctx, current); JS_FreeValue(ctx, record);
    close(retired); return result;
}
static bool staging_name(const char *name)
{
    return strlen(name) == 39 && !strncmp(name, ".stage-", 7) &&
        strspn(name+7, "0123456789abcdef") == 32;
}
static int recover_staging(struct Store *s)
{
    int parents[] = {s->apps,s->objects};
    for (unsigned i=0;i<2;i++) {
        DIR *dir = fdopendir(openat(parents[i],".",O_RDONLY|O_DIRECTORY|O_CLOEXEC));
        if (!dir) return failure(s,"Cannot inspect interrupted staging");
        int result=0;
        for (;;) {
            errno=0; struct dirent *entry=readdir(dir);
            if (!entry) { if(errno) result=failure(s,"Cannot enumerate interrupted staging"); break; }
            if (!staging_name(entry->d_name)) continue;
            struct stat info;
            if (fstatat(parents[i],entry->d_name,&info,AT_SYMLINK_NOFOLLOW) || info.st_uid!=getuid()) {
                result=error(s,"Interrupted staging is not owned by this user"); break;
            }
            if (i==1 && S_ISDIR(info.st_mode)) result=remove_tree(s,parents[i],entry->d_name);
            else if (i==0 && S_ISREG(info.st_mode) && info.st_nlink==1)
                result=unlinkat(parents[i],entry->d_name,0) ? failure(s,"Cannot remove interrupted record") : 0;
            else result=error(s,"Unexpected interrupted staging type");
            if(result) break;
        }
        closedir(dir);
        if(result) return result;
        if(fsync(parents[i])) return failure(s,"Cannot sync recovered staging");
    }
    puts("Recovered interrupted staging; registered versions and appdata were not removed.");
    return 0;
}
static JSValue bundle_files(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    struct Store store;
    if (store_open(&store, false, false)) {
        bool absent = store.root < 0 && store.absent;
        store_close(&store);
        return absent ? JS_NewArray(ctx) : JS_ThrowInternalError(ctx, "%s", store.error);
    }
    JSValue files = catalog(&store, ctx);
    if (JS_IsException(files) && !JS_HasException(ctx)) JS_ThrowInternalError(ctx, "%s", store.error);
    store_close(&store); return files;
}
int pu_bundles_install(JSContext *ctx, JSValueConst api)
{
    struct Store s = {0}; char helper[PATH_MAX];
    if (own_executable(&s,"polly-app",helper)) { JS_ThrowInternalError(ctx,"%s",s.error); return 0; }
    return JS_SetPropertyStr(ctx,api,"bundleFiles",JS_NewCFunction(ctx,bundle_files,"bundleFiles",0)) >= 0 &&
        JS_SetPropertyStr(ctx,api,"bundleManager",JS_NewString(ctx,helper)) >= 0;
}
int pu_bundle_command(int argc, char **argv)
{
    if (argc == 2 && !strcmp(argv[1],"--help")) {
        puts("Usage: polly-app install ABSOLUTE_DIRECTORY_OR_TAR_ZIP\n"
             "       polly-app replace ABSOLUTE_DIRECTORY_OR_TAR_ZIP EXPECTED_CURRENT_SHA256\n"
             "       polly-app list\n"
             "       polly-app run APP_ID [EXPECTED_CURRENT_SHA256]\n"
             "       polly-app rollback APP_ID EXPECTED_CURRENT_SHA256\n"
             "       polly-app remove APP_ID EXPECTED_CURRENT_SHA256\n"
             "       polly-app restore APP_ID EXPECTED_RETIRED_SHA256\n"
             "       polly-app recover\n"
             "Local per-user packages only. No install scripts or publisher authentication.\n"
             "Replacement requires an explicit current digest; incompatible data schemas are rejected.\n"
             "Previous code versions and all appdata are retained; no garbage collection or data deletion.");
        return 0;
    }
    bool install = argc == 3 && !strcmp(argv[1],"install");
    bool replace = argc == 4 && !strcmp(argv[1],"replace");
    bool list = argc == 2 && !strcmp(argv[1],"list");
    bool run = (argc == 3 || argc == 4) && !strcmp(argv[1],"run");
    bool rollback = argc == 4 && !strcmp(argv[1],"rollback");
    bool remove = argc == 4 && !strcmp(argv[1],"remove");
    bool restore = argc == 4 && !strcmp(argv[1],"restore");
    bool recover = argc == 2 && !strcmp(argv[1],"recover");
    if (!install && !replace && !list && !run && !rollback && !recover && !remove && !restore) {
        fputs("Invalid command; use polly-app --help\n",stderr); return 2;
    }
    if (getuid() == 0) { fputs("[bundles] Run application management as an ordinary user, not root\n",stderr); return 1; }
    struct Store s; struct Schema schema = { .module=JS_UNDEFINED };
    int result = store_open(&s,install || replace,install || replace || rollback || recover || remove || restore);
    if (result && list && s.root < 0 && s.absent) { puts("[]"); store_close(&s); return 0; }
    if (!result) result = schema_open(&s,&schema);
    if (!result) {
        if (install || replace) result = install_bundle(&s,&schema,argv[2],replace ? argv[3] : NULL);
        else if (run) result = run_bundle(&s,&schema,argv[2],argc == 4 ? argv[3] : NULL);
        else if (rollback) result = rollback_bundle(&s,&schema,argv[2],argv[3]);
        else if (remove || restore) result = registration(&s,&schema,argv[2],argv[3],restore);
        else if (recover) result = recover_staging(&s);
        else {
            JSValue files = catalog(&s,schema.ctx);
            JSValue validated = JS_NewArray(schema.ctx);
            if (!JS_IsException(files)) {
                JSValue size = JS_GetPropertyStr(schema.ctx,files,"length");
                uint32_t count = 0;
                if (JS_ToUint32(schema.ctx,&count,size) < 0) result=-1;
                JS_FreeValue(schema.ctx,size);
                for (uint32_t i=0;i<count && !result;i++) {
                    JSValue item=JS_GetPropertyUint32(schema.ctx,files,i);
                    char *id=field(&s,schema.ctx,item,"id");
                    JSValue record=id ? get_record(&s,&schema,id,false) : JS_EXCEPTION;
                    free(id); JS_FreeValue(schema.ctx,item);
                    if (JS_IsException(record)) result=-1;
                    else if (JS_SetPropertyUint32(schema.ctx,validated,i,record) < 0) result=-1;
                }
            } else result=-1;
            JSValue json = result ? JS_EXCEPTION : JS_JSONStringify(schema.ctx,validated,JS_UNDEFINED,JS_UNDEFINED);
            const char *text = JS_IsException(json) ? NULL : JS_ToCString(schema.ctx,json);
            if (!text) { result=-1; if (!*s.error) error(&s,"Cannot encode application catalog"); }
            else puts(text);
            JS_FreeCString(schema.ctx,text); JS_FreeValue(schema.ctx,json); JS_FreeValue(schema.ctx,files);
            JS_FreeValue(schema.ctx,validated);
        }
    }
    if (result) fprintf(stderr,"[bundles] %s\n",*s.error ? s.error : "Application operation failed");
    schema_close(&schema); store_close(&s);
    return result ? 1 : 0;
}
