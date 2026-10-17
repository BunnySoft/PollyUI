#include <dirent.h>
#include <drm_fourcc.h>
#include <errno.h>
#include <inttypes.h>
#include <linux/magic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <unistd.h>
#include <wlr/render/allocator.h>
#include <wlr/render/drm_format_set.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/util/log.h>

/* The pinned internal SHM factory is exported, but its header is not installed. */
struct wlr_allocator *wlr_shm_allocator_create(void);

struct snapshot {
    struct statvfs space;
    unsigned fds, shm_maps;
};

static bool snapshot(const char *phase, struct snapshot *result)
{
    memset(result, 0, sizeof(*result));
    if (statvfs("/dev/shm", &result->space)) {
        perror("statvfs /dev/shm");
        return false;
    }
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) {
        perror("opendir own fds");
        return false;
    }
    struct dirent *entry;
    errno = 0;
    while ((entry = readdir(directory))) {
        if (entry->d_name[0] != '.') result->fds++;
    }
    int read_error = errno;
    closedir(directory);
    if (read_error) {
        fprintf(stderr, "FAIL: reading own fds: %s\n", strerror(read_error));
        return false;
    }
    FILE *maps = fopen("/proc/self/maps", "r");
    if (!maps) {
        perror("open own maps");
        return false;
    }
    char line[4096];
    while (fgets(line, sizeof(line), maps)) {
        if (strstr(line, "/dev/shm/wlroots-")) result->shm_maps++;
    }
    bool ok = !ferror(maps);
    fclose(maps);
    if (!ok) {
        fputs("FAIL: reading own maps\n", stderr);
        return false;
    }
    printf("SNAP phase=%s capacity=%ju free=%ju available=%ju freeInodes=%ju availableInodes=%ju fds=%u shmMaps=%u\n",
        phase, (uintmax_t)result->space.f_blocks * result->space.f_frsize,
        (uintmax_t)result->space.f_bfree * result->space.f_frsize,
        (uintmax_t)result->space.f_bavail * result->space.f_frsize,
        (uintmax_t)result->space.f_ffree, (uintmax_t)result->space.f_favail,
        result->fds, result->shm_maps);
    return true;
}

static bool restored(const struct snapshot *before, const char *phase)
{
    struct snapshot after;
    if (!snapshot(phase, &after)) return false;
    bool ok = before->space.f_bfree == after.space.f_bfree &&
        before->space.f_bavail == after.space.f_bavail &&
        before->space.f_ffree == after.space.f_ffree &&
        before->space.f_favail == after.space.f_favail &&
        before->fds == after.fds && before->shm_maps == after.shm_maps;
    if (!ok) fputs("FAIL: SHM space/inode/fd/mapping leak\n", stderr);
    return ok;
}

static bool positive(struct wlr_allocator *allocator, const struct wlr_drm_format *format,
    int width, int height, const struct snapshot *initial)
{
    bool ok = false, access = false;
    size_t length = (size_t)width * 4 * height;
    struct wlr_buffer *buffer = wlr_allocator_create_buffer(allocator, width, height, format);
    printf("ALLOC width=%d height=%d bytes=%zu nonnull=%d\n", width, height, length, buffer != NULL);
    if (!buffer) {
        fputs("FAIL: adequately provisioned SHM allocation rejected\n", stderr);
        goto cleanup;
    }
    struct wlr_shm_attributes shm;
    struct stat backing, mount;
    if (!wlr_buffer_get_shm(buffer, &shm) || fstat(shm.fd, &backing) || stat("/dev/shm", &mount)) {
        fputs("FAIL: missing real SHM fd metadata\n", stderr);
        goto cleanup;
    }
    printf("BACKING beforeAccess size=%jd blocks512=%jd links=%ju stride=%d offset=%jd\n",
        (intmax_t)backing.st_size, (intmax_t)backing.st_blocks, (uintmax_t)backing.st_nlink,
        shm.stride, (intmax_t)shm.offset);
    if (buffer->width != width || buffer->height != height ||
        shm.width != width || shm.height != height || shm.stride != width * 4 ||
        shm.format != DRM_FORMAT_ARGB8888 || shm.offset != 0 ||
        backing.st_size != (off_t)length || backing.st_blocks < (blkcnt_t)(length / 512) ||
        backing.st_nlink != 0 || backing.st_dev != mount.st_dev) {
        fputs("FAIL: returned SHM buffer is not fully backed before access (not touched)\n", stderr);
        goto cleanup;
    }
    void *data = NULL;
    uint32_t pixel_format = 0;
    size_t stride = 0;
    access = wlr_buffer_begin_data_ptr_access(buffer,
        WLR_BUFFER_DATA_PTR_ACCESS_READ | WLR_BUFFER_DATA_PTR_ACCESS_WRITE,
        &data, &pixel_format, &stride);
    if (!access || !data || stride != (size_t)width * 4 || pixel_format != DRM_FORMAT_ARGB8888) {
        fputs("FAIL: real SHM data pointer access\n", stderr);
        goto cleanup;
    }
    volatile unsigned char *pixels = data;
    for (size_t i = 0; i < length; i++) pixels[i] = (unsigned char)(i ^ 0xa5);
    for (size_t i = 0; i < length; i++) {
        if (pixels[i] != (unsigned char)(i ^ 0xa5)) {
            fputs("FAIL: full SHM read/write mismatch\n", stderr);
            goto cleanup;
        }
    }
    if (fstat(shm.fd, &backing)) {
        perror("fstat after full read/write");
        goto cleanup;
    }
    printf("BACKING afterFullReadWrite bytes=%zu blocks512=%jd\n", length, (intmax_t)backing.st_blocks);
    ok = true;
cleanup:
    if (access) wlr_buffer_end_data_ptr_access(buffer);
    wlr_buffer_drop(buffer);
    return restored(initial, "after-positive-drop") && ok;
}

int main(int argc, char **argv)
{
    bool quota = argc == 2 && !strcmp(argv[1], "--private-64k");
    if (argc != 1 && !quota) {
        fputs("Usage: pollywm-shm-allocator-test [--private-64k]\n", stderr);
        return 2;
    }
    setvbuf(stdout, NULL, _IOLBF, 0);
    wlr_log_init(WLR_INFO, NULL);
    struct snapshot initial;
    struct statfs filesystem;
    if (!snapshot("initial", &initial)) return 1;
    if (statfs("/dev/shm", &filesystem)) {
        perror("statfs /dev/shm");
        return 1;
    }
    uintmax_t capacity = (uintmax_t)initial.space.f_blocks * initial.space.f_frsize;
    uintmax_t available = (uintmax_t)initial.space.f_bavail * initial.space.f_frsize;
    const char *private_test = getenv("POLLY_SHM_PRIVATE_TEST");
    if (filesystem.f_type != TMPFS_MAGIC || initial.shm_maps ||
        (quota ? (!private_test || strcmp(private_test, "1") ||
            capacity != 65536 || available != capacity ||
            initial.space.f_bfree != initial.space.f_blocks) : available < 1024 * 1024)) {
        fputs("UNAVAILABLE: requires tmpfs SHM; normal mode needs 1MiB free; quota mode needs "
            "an empty dedicated 64KiB container mount and POLLY_SHM_PRIVATE_TEST=1\n", stderr);
        return 77;
    }
    struct wlr_drm_format_set formats = {0};
    struct wlr_allocator *allocator = NULL;
    bool ok = false;
    if (!wlr_drm_format_set_add(&formats, DRM_FORMAT_ARGB8888, DRM_FORMAT_MOD_LINEAR)) {
        fputs("FAIL: real DRM format builder\n", stderr);
        goto cleanup;
    }
    const struct wlr_drm_format *format = wlr_drm_format_set_get(&formats, DRM_FORMAT_ARGB8888);
    allocator = wlr_shm_allocator_create();
    if (!format || !allocator) {
        fputs("FAIL: real SHM allocator factory\n", stderr);
        goto cleanup;
    }
    if (!positive(allocator, format, 32, 32, &initial)) goto cleanup;
    if (quota) {
        for (unsigned i = 0; i < 3; i++) {
            struct wlr_buffer *buffer = wlr_allocator_create_buffer(allocator, 128, 256, format);
            printf("OVERQUOTA attempt=%u bytes=131072 capacity=%ju nonnull=%d\n", i + 1, capacity, buffer != NULL);
            bool rejected = buffer == NULL;
            wlr_buffer_drop(buffer);
            if (!restored(&initial, "after-rejection") || !rejected) {
                fputs("FAIL: over-quota request must return NULL before publication (never touched)\n", stderr);
                goto cleanup;
            }
        }
    } else if (!positive(allocator, format, 128, 256, &initial)) {
        goto cleanup;
    }
    ok = positive(allocator, format, 32, 32, &initial);
cleanup:
    wlr_allocator_destroy(allocator);
    wlr_drm_format_set_finish(&formats);
    ok = restored(&initial, "final-after-destroy") && ok;
    if (ok) puts(quota ?
        "PASS: private 64KiB real SHM positive, three explicit pre-publication refusals, recovery and positive reuse; no child/fault" :
        "PASS: real SHM 4096/131072-byte backing before access, full read/write, cleanup and reuse");
    return ok ? 0 : 1;
}
