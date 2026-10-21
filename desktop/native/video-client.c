#define _GNU_SOURCE
#include "native/video-client.h"
#include "shared/video-wallpaper.h"
#include "gui/src/context/native-window.h"
#include "gui/src/render/skia_c.h"
#include "gui/src/model/node.h"
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
static struct {
    JSContext *ctx;
    JSValue api, targets[8];
    unsigned target_count;
    int channel;
    pid_t pid;
    const uint8_t *pixels;
    uint64_t serial, frames;
    int64_t started, timestamp;
    uint32_t width, height, loops;
    bool ready, initialized, paused, requested_pause, ended, changed, busy, exited;
    char key[96], error[192];
} video;

static int property(JSContext *ctx, JSValueConst object, const char *name, JSValue value)
{
    return !JS_IsException(value) && JS_SetPropertyStr(ctx, object, name, value) >= 0;
}
static int64_t milliseconds(void)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) return -1;
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static bool command(uint32_t operation, uint32_t flags)
{
    struct PuVideoMessage message = {.magic = PU_VIDEO_MAGIC, .version = PU_VIDEO_VERSION,
        .operation = operation, .flags = flags};
    return video.channel >= 0 && send(video.channel, &message, sizeof(message), MSG_DONTWAIT | MSG_NOSIGNAL) == sizeof(message);
}
static bool helper_path(char path[PATH_MAX])
{
#if defined(PU_DESKTOP_VIDEO)
    char executable[PATH_MAX];
    ssize_t size = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (size < 1 || size >= (ssize_t)sizeof(executable) - 1) return false;
    executable[size] = 0;
    const char *slash = strrchr(executable, '/');
    if (!slash) return false;
    size_t length = (size_t)(slash - executable);
    bool build = !strncmp(executable, PU_VIDEO_BUILD_DIRECTORY, strlen(PU_VIDEO_BUILD_DIRECTORY)) &&
        executable[strlen(PU_VIDEO_BUILD_DIRECTORY)] == '/';
    int written = snprintf(path, PATH_MAX, "%.*s/%s", (int)length, executable,
        build ? "polly-video-decoder" : PU_VIDEO_HELPER_FROM_BIN);
    struct stat status;
    return written > 0 && written < PATH_MAX && lstat(path, &status) == 0 &&
        S_ISREG(status.st_mode) && access(path, X_OK) == 0;
#else
    (void)path;
    return false;
#endif
}
static void release_targets(void)
{
    for (unsigned index = 0; index < video.target_count; index++) JS_FreeValue(video.ctx, video.targets[index]);
    video.target_count = 0;
}
static bool stop_decoder(void)
{
    if (video.channel >= 0) {
        command(PU_VIDEO_STOP, 0);
        close(video.channel); video.channel = -1;
    }
    if (video.pid > 0) {
        kill(video.pid, SIGTERM);
        int64_t deadline = milliseconds() + 500;
        int status;
        while (video.pid > 0) {
            pid_t result = waitpid(video.pid, &status, WNOHANG);
            if (result == video.pid || (result < 0 && errno == ECHILD)) { video.pid = 0; break; }
            if (result < 0 && errno != EINTR) break;
            if (milliseconds() >= deadline) { kill(video.pid, SIGKILL); break; }
            struct timespec delay = {.tv_nsec = 1000000};
            nanosleep(&delay, NULL);
        }
    }
    if (video.pixels) munmap((void *)video.pixels, PU_VIDEO_BYTES);
    video.pixels = NULL;
    if (video.key[0]) pu_image_remove(video.key);
    video.key[0] = 0;
    release_targets();
    video.ready = false;
    video.changed = true;
    return video.pid == 0;
}
static void fail(const char *message)
{
    char copy[sizeof(video.error)];
    snprintf(copy, sizeof(copy), "%s", message);
    stop_decoder();
    snprintf(video.error, sizeof(video.error), "%s", copy);
    fprintf(stderr, "[video wallpaper] %s\n", video.error);
}
static bool collect_targets(JSContext *ctx, JSValueConst array, JSValue targets[8], unsigned *count, bool empty)
{
    if (!JS_IsArray(array)) { JS_ThrowTypeError(ctx, "Owned wallpaper Windows must be an array"); return false; }
    JSValue length = JS_GetPropertyStr(ctx, array, "length");
    double number;
    bool valid = !JS_IsException(length) && JS_IsNumber(length) && JS_ToFloat64(ctx, &number, length) == 0 &&
        number >= (empty ? 0 : 1) && number <= 8 && number == (unsigned)number;
    JS_FreeValue(ctx, length);
    if (!valid) { JS_ThrowRangeError(ctx, "Video wallpaper supports one to eight owned outputs"); return false; }
    *count = (unsigned)number;
    for (unsigned index = 0; index < *count; index++) {
        targets[index] = JS_GetPropertyUint32(ctx, array, index);
        if (JS_IsException(targets[index])) return false;
    }
    for (unsigned index = 0; index < *count; index++) {
        PuWindow *window = pu_gui_window_from_value(ctx, targets[index]);
        if (!window || !pu_window_layer_surface_peek(window)) {
            if (!JS_HasException(ctx)) JS_ThrowTypeError(ctx, "Video targets must be live owned layer Windows");
            return false;
        }
    }
    return true;
}
static JSValue state(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    char path[PATH_MAX];
    JSValue result = JS_NewObject(ctx);
    if (JS_IsException(result)) return result;
    if (!property(ctx, result, "available", JS_NewBool(ctx, helper_path(path))) ||
        !property(ctx, result, "ready", JS_NewBool(ctx, video.ready)) ||
        !property(ctx, result, "paused", JS_NewBool(ctx, video.paused)) ||
        !property(ctx, result, "ended", JS_NewBool(ctx, video.ended)) ||
        !property(ctx, result, "frames", JS_NewInt64(ctx, (int64_t)video.frames)) ||
        !property(ctx, result, "width", JS_NewUint32(ctx, video.width)) ||
        !property(ctx, result, "height", JS_NewUint32(ctx, video.height)) ||
        !property(ctx, result, "loop", JS_NewUint32(ctx, video.loops)) ||
        !property(ctx, result, "key", JS_NewString(ctx, video.key)) ||
        !property(ctx, result, "error", JS_NewString(ctx, video.error))) {
        JS_FreeValue(ctx, result);
        return JS_EXCEPTION;
    }
    return result;
}
static JSValue stop(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (video.busy) return JS_ThrowInternalError(ctx, "Video configuration is already in progress");
    if (!stop_decoder()) return JS_ThrowInternalError(ctx, "Video helper is still stopping; no new process was launched");
    video.error[0] = 0;
    return JS_UNDEFINED;
}
static JSValue pause_video(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (video.busy) return JS_ThrowInternalError(ctx, "Video configuration is already in progress");
    if (argc != 1 || !JS_IsBool(argv[0])) return JS_ThrowTypeError(ctx, "Video pause policy must be boolean");
    bool paused = JS_ToBool(ctx, argv[0]);
    if (paused == video.requested_pause) return JS_UNDEFINED;
    if (!command(paused ? PU_VIDEO_PAUSE : PU_VIDEO_PLAY, 0))
        return JS_ThrowInternalError(ctx, "Video pause request transport failed; outcome is unknown");
    video.requested_pause = paused;
    if (!paused && !video.ready) video.started = milliseconds();
    return JS_UNDEFINED;
}
static JSValue targets(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (video.busy) return JS_ThrowInternalError(ctx, "Video configuration is already in progress");
    JSValue values[8];
    for (unsigned index = 0; index < 8; index++) values[index] = JS_UNDEFINED;
    unsigned count = 0;
    bool valid = argc == 1 && collect_targets(ctx, argv[0], values, &count, true);
    if (valid) {
        release_targets();
        memcpy(video.targets, values, sizeof(values));
        video.target_count = count;
    } else for (unsigned index = 0; index < 8; index++) JS_FreeValue(ctx, values[index]);
    return valid ? JS_UNDEFINED : JS_HasException(ctx) ? JS_EXCEPTION :
        JS_ThrowTypeError(ctx, "Owned video target array required");
}
static JSValue start(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    char helper[PATH_MAX];
    if (!helper_path(helper)) return JS_ThrowTypeError(ctx, "This runtime excludes the optional local-video decoder");
    if (getuid() == 0 || getuid() != geteuid() || getgid() != getegid())
        return JS_ThrowTypeError(ctx, "Video wallpaper requires the ordinary desktop user");
    if (video.busy || argc != 4 || !JS_IsString(argv[0]) || !JS_IsBool(argv[1]) || !JS_IsBool(argv[3]))
        return JS_ThrowTypeError(ctx, "Video start requires a local path, loop boolean, owned target Windows and pause boolean");
    video.busy = true;
    JSValue values[8], result = JS_EXCEPTION;
    for (unsigned index = 0; index < 8; index++) values[index] = JS_UNDEFINED;
    unsigned count = 0;
    bool replaced = false;
    const char *path = NULL;
    int input = -1, shared = -1, pair[2] = {-1, -1}, copies[3] = {-1, -1, -1};
    size_t length = 0;
    path = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!path || !length || length > 4096 || path[0] != '/' || memchr(path, 0, length)) {
        if (!JS_HasException(ctx)) JS_ThrowTypeError(ctx, "Video source must be one bounded absolute local pathname");
        goto done;
    }
    if (!collect_targets(ctx, argv[2], values, &count, false)) goto done;
    input = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    struct stat status;
    if (input < 0 || fstat(input, &status) || !S_ISREG(status.st_mode) || status.st_size < 1 ||
        status.st_size > INT64_C(2147483648)) {
        JS_ThrowTypeError(ctx, "Video source must be a readable regular non-symlink file of at most 2GiB");
        goto done;
    }
    if (!stop_decoder()) { JS_ThrowInternalError(ctx, "Previous video helper is still stopping"); goto done; }
    replaced = true;
    shared = memfd_create("polly-video-frame", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (shared < 0 || ftruncate(shared, PU_VIDEO_BYTES) ||
        fcntl(shared, F_ADD_SEALS, F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL) < 0 ||
        socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0, pair)) {
        JS_ThrowInternalError(ctx, "Cannot allocate bounded shared video transport: %s", strerror(errno)); goto done;
    }
    video.pixels = mmap(NULL, PU_VIDEO_BYTES, PROT_READ, MAP_SHARED, shared, 0);
    if (video.pixels == MAP_FAILED) {
        video.pixels = NULL; JS_ThrowInternalError(ctx, "Cannot map the shared video frame"); goto done;
    }
    if (fcntl(pair[1], F_SETFL, fcntl(pair[1], F_GETFL) & ~O_NONBLOCK) < 0) {
        JS_ThrowInternalError(ctx, "Cannot configure the private decoder channel"); goto done;
    }
    copies[0] = fcntl(input, F_DUPFD_CLOEXEC, 10);
    copies[1] = fcntl(pair[1], F_DUPFD_CLOEXEC, 10);
    copies[2] = fcntl(shared, F_DUPFD_CLOEXEC, 10);
    if (copies[0] < 0 || copies[1] < 0 || copies[2] < 0) {
        JS_ThrowInternalError(ctx, "Cannot prepare the private decoder descriptors"); goto done;
    }
    posix_spawn_file_actions_t actions;
    int error = posix_spawn_file_actions_init(&actions);
    if (!error) {
        for (unsigned index = 0; index < 3 && !error; index++)
            error = posix_spawn_file_actions_adddup2(&actions, copies[index], (int)index + 3);
        char *arguments[] = {helper, NULL};
        if (!error) error = posix_spawn(&video.pid, helper, &actions, NULL, arguments, environ);
        posix_spawn_file_actions_destroy(&actions);
    }
    if (error) { video.pid = 0; JS_ThrowInternalError(ctx, "Cannot start the native video helper: %s", strerror(error)); goto done; }
    video.channel = pair[0]; pair[0] = -1;
    video.frames = 0; video.width = video.height = video.loops = 0;
    video.timestamp = 0;
    video.ready = video.initialized = video.ended = video.paused = video.requested_pause = video.exited = false;
    video.requested_pause = JS_ToBool(ctx, argv[3]);
    video.error[0] = 0;
    uint32_t flags = (JS_ToBool(ctx, argv[1]) ? PU_VIDEO_INIT_LOOP : 0) |
        (video.requested_pause ? PU_VIDEO_INIT_PAUSED : 0);
    if (video.serial == UINT64_MAX || !command(PU_VIDEO_INIT, flags)) {
        JS_ThrowInternalError(ctx, "Cannot initialize the private video decoder"); goto done;
    }
    snprintf(video.key, sizeof(video.key), "polly-memory:video-wallpaper-%" PRIu64, ++video.serial);
    memcpy(video.targets, values, sizeof(values));
    video.target_count = count;
    for (unsigned index = 0; index < 8; index++) values[index] = JS_UNDEFINED;
    video.started = milliseconds();
    video.changed = true;
    result = state(ctx, self, 0, NULL);
done:
    if (JS_IsException(result) && replaced) stop_decoder();
    for (unsigned index = 0; index < 8; index++) JS_FreeValue(ctx, values[index]);
    JS_FreeCString(ctx, path);
    if (input >= 0) close(input);
    if (shared >= 0) close(shared);
    for (unsigned index = 0; index < 2; index++) if (pair[index] >= 0) close(pair[index]);
    for (unsigned index = 0; index < 3; index++) if (copies[index] >= 0) close(copies[index]);
    video.busy = false;
    return result;
}

int pu_video_client_install(JSContext *context, JSValueConst api)
{
    video.ctx = context;
    video.api = JS_DupValue(context, api);
    video.channel = -1;
    return property(context, api, "videoWallpaperState", JS_NewCFunction(context, state, "videoWallpaperState", 0)) &&
        property(context, api, "startVideoWallpaper", JS_NewCFunction(context, start, "startVideoWallpaper", 4)) &&
        property(context, api, "stopVideoWallpaper", JS_NewCFunction(context, stop, "stopVideoWallpaper", 0)) &&
        property(context, api, "pauseVideoWallpaper", JS_NewCFunction(context, pause_video, "pauseVideoWallpaper", 1)) &&
        property(context, api, "setVideoWallpaperTargets", JS_NewCFunction(context, targets, "setVideoWallpaperTargets", 1)) &&
        property(context, api, "onVideoWallpaperChanged", JS_NULL);
}
int pu_video_client_pump(void)
{
    if (!video.ctx) return 0;
    int worked = 0;
    for (unsigned attempt = 0; video.channel >= 0 && attempt < 4; attempt++) {
        struct PuVideoMessage message;
        ssize_t size = recv(video.channel, &message, sizeof(message), MSG_DONTWAIT | MSG_TRUNC);
        if (size < 0 && (errno == EAGAIN || errno == EINTR)) break;
        if (size == 0 && video.ended) { close(video.channel); video.channel = -1; break; }
        if (size != sizeof(message) || message.magic != PU_VIDEO_MAGIC || message.version != PU_VIDEO_VERSION) {
            fail("Decoder closed or sent an invalid bounded video message"); break;
        }
        worked++;
        if (message.operation == PU_VIDEO_INITIALIZED) { video.initialized = true; continue; }
        if (message.operation == PU_VIDEO_ERROR) {
            if (!memchr(message.error, 0, sizeof(message.error))) fail("Invalid decoder error message");
            else fail(message.error);
            break;
        }
        if (message.operation == PU_VIDEO_STATUS && message.flags <= 1) {
            bool paused = message.flags == 1;
            if (paused != video.paused) video.changed = true;
            video.paused = paused;
            continue;
        }
        if (message.operation == PU_VIDEO_END) { video.ended = video.changed = true; continue; }
        if (message.operation != PU_VIDEO_FRAME || !message.width || !message.height ||
            message.width > PU_VIDEO_WIDTH || message.height > PU_VIDEO_HEIGHT ||
            message.stride != message.width * 4 || message.bytes != message.stride * message.height ||
            message.bytes > PU_VIDEO_BYTES || message.timestamp < 0 || message.timestamp > INT64_C(86400000000) ||
            message.duration < 1 || message.duration > 10000000 || message.loop < video.loops ||
            (video.ready && message.loop == video.loops && message.timestamp < video.timestamp)) {
            fail("Decoder frame shape/timestamp exceeded the admitted video transport"); break;
        }
        if (!pu_image_set_video_frame(video.key, (int)message.width, (int)message.height, video.pixels, message.bytes)) {
            fail("Cannot retain the bounded native video frame"); break;
        }
        if (!video.ready || video.width != message.width || video.height != message.height) video.changed = true;
        video.ready = true; video.width = message.width; video.height = message.height;
        video.timestamp = message.timestamp; video.loops = message.loop; video.frames++;
        pu_node_mark_paint_dirty(NULL);
        for (unsigned index = 0; index < video.target_count; index++) {
            PuWindow *window = pu_gui_window_from_value(video.ctx, video.targets[index]);
            if (window) pu_window_redraw(window);
            else {
                JSValue error = JS_GetException(video.ctx);
                const char *message = JS_ToCString(video.ctx, error);
                char detail[192];
                snprintf(detail, sizeof(detail), "Video wallpaper target retired: %.120s", message ? message : "closed owner");
                JS_FreeCString(video.ctx, message);
                JS_FreeValue(video.ctx, error);
                fail(detail);
                break;
            }
        }
        if (video.channel < 0) break;
        if (!command(PU_VIDEO_ACK, 0)) { fail("Cannot release the shared decoder frame"); break; }
    }
    if (video.pid > 0) {
        int status;
        pid_t reaped = waitpid(video.pid, &status, WNOHANG);
        if (reaped == video.pid) {
            video.pid = 0;
            video.exited = true;
            if ((!WIFEXITED(status) || WEXITSTATUS(status)) && !video.error[0])
                fail("The native video decoder exited unexpectedly");
        } else if (reaped < 0 && errno != EINTR) fail("Cannot observe the native video helper lifetime");
    }
    if (video.channel >= 0 && (!video.initialized || (!video.ready && !video.requested_pause)) &&
        milliseconds() - video.started > 10000)
        fail("Local video initialization exceeded its 10-second deadline");
    if (video.changed) {
        video.changed = false;
        JSValue callback = JS_GetPropertyStr(video.ctx, video.api, "onVideoWallpaperChanged");
        JSValue result = JS_IsException(callback) ? JS_EXCEPTION : JS_IsFunction(video.ctx, callback) ?
            JS_Call(video.ctx, callback, video.api, 0, NULL) : JS_UNDEFINED;
        if (JS_IsException(result)) {
            JSValue error = JS_GetException(video.ctx);
            const char *text = JS_ToCString(video.ctx, error);
            fprintf(stderr, "[video wallpaper] Observer failed: %s\n", text ? text : "unknown error");
            JS_FreeCString(video.ctx, text); JS_FreeValue(video.ctx, error);
        }
        JS_FreeValue(video.ctx, result); JS_FreeValue(video.ctx, callback);
        worked++;
    }
    return worked;
}
void pu_video_client_shutdown(void)
{
    if (!video.ctx) return;
    stop_decoder();
    if (video.pid > 0) fprintf(stderr, "[video wallpaper] Helper termination remains unconfirmed at shutdown\n");
    if (video.ctx) JS_FreeValue(video.ctx, video.api);
    memset(&video, 0, sizeof(video));
    video.channel = -1;
}
