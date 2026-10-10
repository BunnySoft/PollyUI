#define _GNU_SOURCE
#include "native/documents.h"
#include "shared/thread.h"
#include <dbus/dbus.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define DOCUMENT_PATH_LIMIT 4095
#define MIME_FILE_LIMIT (1024 * 1024)
#define MIME_TOTAL_LIMIT (16 * 1024 * 1024)
#define MIME_FILES_LIMIT 128
#define MIME_TIMEOUT_MS 1500

static int hex(unsigned char c)
{
    return c >= '0' && c <= '9' ? c - '0' :
        c >= 'A' && c <= 'F' ? c - 'A' + 10 : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
}

static bool document_uri_path(const char *uri, size_t size, char *path)
{
    if (size < 8 || size > 8192 || memchr(uri, 0, size) || memcmp(uri, "file:///", 8)) return false;
    size_t next = 0;
    for (size_t i = 7; i < size; i++) {
        unsigned char c = (unsigned char)uri[i];
        if (c == '%') {
            if (i + 2 >= size || hex(uri[i + 1]) < 0 || hex(uri[i + 2]) < 0) return false;
            c = (unsigned char)(hex(uri[i + 1]) * 16 + hex(uri[i + 2]));
            i += 2;
            if (!c) return false;
        } else if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                     (c >= '0' && c <= '9') || strchr("/-._~", c))) return false;
        if (next >= DOCUMENT_PATH_LIMIT) return false;
        path[next++] = (char)c;
    }
    path[next] = 0;
    return next && path[0] == '/' && path[1] != '/' && dbus_validate_utf8(path, NULL);
}

bool pu_document_uri_valid(const char *uri, size_t size)
{
    char path[DOCUMENT_PATH_LIMIT + 1];
    if (!document_uri_path(uri, size, path)) return false;
    int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return false;
    struct stat status;
    bool regular = fstat(fd, &status) == 0 && S_ISREG(status.st_mode);
    close(fd);
    return regular;
}

static bool mime_valid(const char *value, size_t size)
{
    bool slash = false, first = true;
    if (!size || size > 255) return false;
    for (size_t i = 0; i < size; i++) {
        unsigned char c = (unsigned char)value[i];
        if (!c) return false;
        bool alphanumeric = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        if (c == '/' && !first && !slash) { slash = true; first = true; continue; }
        if (!alphanumeric && (first || !strchr("!#$&^_.+-", c))) return false;
        first = false;
    }
    return slash && !first;
}

static JSValue document_mime_type(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc != 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "documentMimeType requires one absolute local regular-file path");
    size_t size;
    const char *path = JS_ToCStringLen(ctx, &size, argv[0]);
    if (!path) return JS_EXCEPTION;
    if (!size || size > DOCUMENT_PATH_LIMIT || path[0] != '/' || path[1] == '/' || memchr(path, 0, size)) {
        JS_FreeCString(ctx, path);
        return JS_ThrowTypeError(ctx, "Invalid bounded absolute document path");
    }
    int document = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    JS_FreeCString(ctx, path);
    if (document < 0) return JS_ThrowInternalError(ctx, "Cannot read document: %s", strerror(errno));
    struct stat status;
    if (fstat(document, &status) || !S_ISREG(status.st_mode)) {
        close(document);
        return JS_ThrowTypeError(ctx, "Document must be a readable regular file");
    }
    int pipes[2];
    if (pipe2(pipes, O_CLOEXEC)) {
        int error = errno; close(document);
        return JS_ThrowInternalError(ctx, "Cannot create MIME utility pipe: %s", strerror(error));
    }
    /* Keep the validated document on a stable descriptor, not a re-opened name. */
    int source = fcntl(document, F_DUPFD_CLOEXEC, 4);
    int output_fd = source < 0 ? -1 : fcntl(pipes[1], F_DUPFD_CLOEXEC, 4);
    close(document);
    close(pipes[1]);
    if (source < 0 || output_fd < 0) {
        int error = errno; close(pipes[0]);
        if (source >= 0) close(source);
        if (output_fd >= 0) close(output_fd);
        return JS_ThrowInternalError(ctx, "Cannot retain MIME document: %s", strerror(error));
    }
    posix_spawn_file_actions_t actions;
    int error = posix_spawn_file_actions_init(&actions);
    bool ready = !error;
    pid_t pid = -1;
    char *args[] = { "/usr/bin/file", "--brief", "--mime-type", "--dereference", "--", "/proc/self/fd/3", NULL };
    char *environment[] = { "LC_ALL=C", "PATH=/usr/bin:/bin", NULL };
    if (!error) error = posix_spawn_file_actions_adddup2(&actions, source, 3);
    if (!error) error = posix_spawn_file_actions_adddup2(&actions, output_fd, 1);
    if (!error) error = posix_spawn_file_actions_adddup2(&actions, output_fd, 2);
    if (!error) error = posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0);
    if (!error) error = posix_spawn_file_actions_addclosefrom_np(&actions, 4);
    if (!error) error = posix_spawn(&pid, args[0], &actions, NULL, args, environment);
    if (ready) posix_spawn_file_actions_destroy(&actions);
    close(source); close(output_fd);
    if (error) {
        close(pipes[0]);
        return JS_ThrowInternalError(ctx, "MIME utility unavailable: %s", strerror(error));
    }
    char output[257];
    size_t used = 0;
    bool eof = false, exited = false;
    int wait_status = 0;
    long long deadline = pu_now_ms() + MIME_TIMEOUT_MS;
    while (!error && (!eof || !exited)) {
        long long remaining = deadline - pu_now_ms();
        if (remaining <= 0) { error = ETIMEDOUT; break; }
        struct pollfd fd = { .fd = pipes[0], .events = POLLIN };
        int polled = poll(eof ? NULL : &fd, eof ? 0 : 1, remaining > 10 ? 10 : (int)remaining);
        if (polled < 0) { if (errno == EINTR) continue; error = errno; break; }
        if (polled && (fd.revents & (POLLIN | POLLHUP))) {
            ssize_t bytes = read(pipes[0], output + used, sizeof(output) - used);
            if (bytes < 0) { if (errno == EINTR) continue; error = errno; break; }
            if (!bytes) eof = true;
            used += (size_t)bytes;
            if (used == sizeof(output)) { error = EOVERFLOW; break; }
        } else if (polled && (fd.revents & (POLLERR | POLLNVAL))) { error = EIO; break; }
        if (!exited) {
            pid_t waited = waitpid(pid, &wait_status, WNOHANG);
            if (waited == pid) exited = true;
            else if (waited < 0 && errno != EINTR) {
                error = errno;
                if (error == ECHILD) exited = true;
                break;
            }
        }
    }
    close(pipes[0]);
    if (!exited) {
        kill(pid, SIGKILL);
        while (waitpid(pid, &wait_status, 0) < 0 && errno == EINTR) {}
    }
    if (error) return JS_ThrowInternalError(ctx, "MIME utility failed (no guessed type): %s", strerror(error));
    if (!WIFEXITED(wait_status) || WEXITSTATUS(wait_status))
        return JS_ThrowInternalError(ctx, "MIME utility returned failure (no guessed type)");
    if (used && output[used - 1] == '\n') used--;
    if (!mime_valid(output, used)) return JS_ThrowInternalError(ctx, "MIME utility returned an invalid type (no guessed type)");
    return JS_NewStringLen(ctx, output, used);
}

struct MimeFiles { JSValue array; unsigned count; size_t total; };

static int mime_file(JSContext *ctx, struct MimeFiles *files, const char *directory, bool desktop_specific, bool data)
{
    char *path = NULL;
    if (asprintf(&path, "%s/%s", directory, desktop_specific ? "polly-mimeapps.list" : "mimeapps.list") < 0)
        return JS_ThrowOutOfMemory(ctx), 0;
    if (strlen(path) > DOCUMENT_PATH_LIMIT || files->count >= MIME_FILES_LIMIT) {
        free(path); JS_ThrowRangeError(ctx, "MIME association path/count limit"); return 0;
    }
    char *bytes = NULL;
    size_t size = 0;
    int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0 && errno != ENOENT) {
        JS_ThrowInternalError(ctx, "Cannot read MIME associations %s: %s", path, strerror(errno)); goto failed;
    }
    if (fd >= 0) {
        struct stat status;
        if (fstat(fd, &status) || !S_ISREG(status.st_mode) || status.st_size < 0 ||
            status.st_size > MIME_FILE_LIMIT || files->total + (size_t)status.st_size > MIME_TOTAL_LIMIT) {
            JS_ThrowTypeError(ctx, "MIME associations must be bounded regular files: %s", path); goto failed;
        }
        bytes = malloc((size_t)status.st_size + 1);
        if (!bytes) { JS_ThrowOutOfMemory(ctx); goto failed; }
        while (size <= (size_t)status.st_size) {
            ssize_t read_size = read(fd, bytes + size, (size_t)status.st_size + 1 - size);
            if (read_size < 0) {
                if (errno == EINTR) continue;
                JS_ThrowInternalError(ctx, "Cannot read MIME associations %s: %s", path, strerror(errno)); goto failed;
            }
            if (!read_size) break;
            size += (size_t)read_size;
        }
        if (size != (size_t)status.st_size || memchr(bytes, 0, size)) {
            JS_ThrowTypeError(ctx, "Changed, NUL-containing or malformed MIME associations: %s", path); goto failed;
        }
        bytes[size] = 0;
        if (!dbus_validate_utf8(bytes, NULL)) {
            JS_ThrowTypeError(ctx, "Malformed UTF-8 MIME associations: %s", path); goto failed;
        }
        close(fd); fd = -1;
    }
    JSValue item = JS_NewObject(ctx);
    if (JS_IsException(item)) goto failed;
    if (JS_SetPropertyStr(ctx, item, "path", JS_NewString(ctx, path)) < 0 ||
        JS_SetPropertyStr(ctx, item, "directory", JS_NewString(ctx, data && !desktop_specific ? directory : "")) < 0 ||
        JS_SetPropertyStr(ctx, item, "desktopSpecific", JS_NewBool(ctx, desktop_specific)) < 0 ||
        JS_SetPropertyStr(ctx, item, "contents", JS_NewStringLen(ctx, bytes ? bytes : "", size)) < 0) {
        JS_FreeValue(ctx, item); goto failed;
    }
    if (JS_SetPropertyUint32(ctx, files->array, files->count++, item) < 0) goto failed;
    files->total += size;
    free(bytes); free(path); return 1;
failed:
    if (fd >= 0) close(fd);
    free(bytes); free(path); return 0;
}

static int mime_root(JSContext *ctx, struct MimeFiles *files, const char *root, bool data)
{
    if (!root || root[0] != '/' || strlen(root) > DOCUMENT_PATH_LIMIT) {
        JS_ThrowTypeError(ctx, "MIME XDG directories must be bounded absolute paths"); return 0;
    }
    char *directory = NULL;
    if (asprintf(&directory, "%s%s", root, data ? "/applications" : "") < 0)
        return JS_ThrowOutOfMemory(ctx), 0;
    int ok = mime_file(ctx, files, directory, true, data) && mime_file(ctx, files, directory, false, data);
    free(directory); return ok;
}

static int mime_dirs(JSContext *ctx, struct MimeFiles *files, const char *variable, const char *fallback, bool data)
{
    const char *value = getenv(variable);
    if (!value || !*value) value = fallback;
    if (strlen(value) > 65536) { JS_ThrowRangeError(ctx, "MIME XDG directory list exceeds bound"); return 0; }
    char *copy = strdup(value);
    if (!copy) return JS_ThrowOutOfMemory(ctx), 0;
    int ok = 1;
    char *part = copy;
    while (ok) {
        char *next = strchr(part, ':');
        if (next) *next = 0;
        ok = mime_root(ctx, files, part, data);
        if (!next) break;
        part = next + 1;
    }
    free(copy); return ok;
}

static int mime_home(JSContext *ctx, struct MimeFiles *files, const char *variable, const char *suffix, bool data)
{
    const char *value = getenv(variable);
    if (value && *value) return mime_root(ctx, files, value, data);
    const char *home = getenv("HOME");
    if (!home || home[0] != '/' || strlen(home) > DOCUMENT_PATH_LIMIT) {
        JS_ThrowTypeError(ctx, "Absolute bounded HOME or XDG home is required"); return 0;
    }
    char *path = NULL;
    if (asprintf(&path, "%s/%s", home, suffix) < 0) return JS_ThrowOutOfMemory(ctx), 0;
    int ok = mime_root(ctx, files, path, data);
    free(path); return ok;
}

static JSValue mime_association_files(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argv;
    if (argc) return JS_ThrowTypeError(ctx, "mimeAssociationFiles takes no arguments");
    struct MimeFiles files = { .array = JS_NewArray(ctx) };
    if (JS_IsException(files.array)) return files.array;
    if (!mime_home(ctx, &files, "XDG_CONFIG_HOME", ".config", false) ||
        !mime_dirs(ctx, &files, "XDG_CONFIG_DIRS", "/etc/xdg", false) ||
        !mime_home(ctx, &files, "XDG_DATA_HOME", ".local/share", true) ||
        !mime_dirs(ctx, &files, "XDG_DATA_DIRS", "/usr/local/share:/usr/share", true)) {
        JS_FreeValue(ctx, files.array); return JS_EXCEPTION;
    }
    return files.array;
}

int pu_documents_install(JSContext *ctx, JSValue api)
{
    return JS_SetPropertyStr(ctx, api, "documentPlatform", JS_NewString(ctx, "linux")) >= 0 &&
        JS_SetPropertyStr(ctx, api, "documentMimeType", JS_NewCFunction(ctx, document_mime_type, "documentMimeType", 1)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "mimeAssociationFiles", JS_NewCFunction(ctx, mime_association_files, "mimeAssociationFiles", 0)) >= 0;
}
