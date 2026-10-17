#define _GNU_SOURCE
#include <dirent.h>
#include <drm_fourcc.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <linux/magic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <sys/sysmacros.h>
#include <time.h>
#include <unistd.h>
#include <wlr/render/allocator.h>
#include <wlr/render/drm_format_set.h>
#include <wlr/types/wlr_buffer.h>
#include <wlr/util/log.h>

/* The pinned internal SHM factory is exported, but its header is not installed. */
struct wlr_allocator *wlr_shm_allocator_create(void);

struct shm_fd_identity { int fd; dev_t device; ino_t inode; };
static bool require_global_restore;

struct snapshot {
    struct statvfs space;
    unsigned fds, shm_maps;
    struct shm_fd_identity *shm_fds;
    size_t shm_fd_count;
};

struct owner_capture {
    struct wl_listener destroy;
    bool enabled, destroyed, proof_ok;
    int fd;
    dev_t device;
    ino_t inode;
    uintptr_t address;
    size_t length, locks;
    bool accessing;
};
static struct owner_capture *owner_pending;

static void owner_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct owner_capture *owner = wl_container_of(listener, owner, destroy);
    owner->destroyed = true;
    wl_list_remove(&owner->destroy.link);
    wl_list_init(&owner->destroy.link);
}

static uint64_t owner_nanoseconds(void)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) { perror("owner clock"); exit(2); }
    return (uint64_t)now.tv_sec * 1000000000u + now.tv_nsec;
}

static void owner_proof(const char *phase, const struct statvfs *first)
{
    struct owner_capture *owner = owner_pending;
    if (!owner) return;
    owner_pending = NULL;
    uint64_t vfs_first_recorded = owner_nanoseconds();
    errno = 0;
    int fd_flags = fcntl(owner->fd, F_GETFD);
    int fd_error = errno;
    bool closed = fd_flags == -1 && fd_error == EBADF;
    struct stat current = {0};
    int identity_status = -2, identity_error = 0;
    bool same_inode = false;
    if (!closed) {
        errno = 0;
        identity_status = fstat(owner->fd, &current);
        identity_error = errno;
        same_inode = identity_status == 0 &&
            current.st_dev == owner->device && current.st_ino == owner->inode;
    }
    long page = sysconf(_SC_PAGESIZE);
    unsigned unmapped = 0, mapped = 0, other_error = 0;
    int first_error = 0;
    uintptr_t first_unexpected = 0;
    bool aligned = page > 0 && owner->length > 0 &&
        owner->address <= UINTPTR_MAX - owner->length && owner->address % (uintptr_t)page == 0;
    if (aligned) for (size_t offset = 0; offset < owner->length; offset += (size_t)page) {
        unsigned char vector = 0;
        errno = 0;
        size_t count = owner->length - offset < (size_t)page ? owner->length - offset : (size_t)page;
        int result = mincore((void *)(owner->address + offset), count, &vector);
        int error = errno;
        if (result == -1 && error == ENOMEM) {
            unmapped++;
        } else {
            if (!mapped && !other_error) { first_unexpected = owner->address + offset; first_error = error; }
            if (!result) mapped++;
            else other_error++;
        }
    }
    uint64_t proof_finished = owner_nanoseconds();
    struct statvfs after = {0};
    errno = 0;
    int after_status = statvfs("/dev/shm", &after), after_error = errno;
    uint64_t after_recorded = owner_nanoseconds();
    owner->proof_ok = owner->destroyed && closed && aligned && unmapped > 0 &&
        !mapped && !other_error && after_status == 0;
    printf("OWNER phase=%s fd=%d device=%ju inode=%ju start=0x%" PRIxPTR " length=%zu preDropLocks=%zu preDropAccess=%d destroyed=%d fdFlags=%d fdErrno=%d EBADF=%d currentIdentityStatus=%d currentIdentityErrno=%d currentDevice=%ju currentInode=%ju sameInode=%d page=%ld unmappedPages=%u mappedPages=%u otherPageErrors=%u firstUnexpected=0x%" PRIxPTR " firstPageErrno=%d proofOk=%d\n",
        phase, owner->fd, (uintmax_t)owner->device, (uintmax_t)owner->inode, owner->address,
        owner->length, owner->locks, owner->accessing, owner->destroyed, fd_flags, fd_error,
        closed, identity_status, identity_error, (uintmax_t)current.st_dev, (uintmax_t)current.st_ino,
        same_inode, page, unmapped, mapped, other_error, first_unexpected, first_error, owner->proof_ok);
    printf("OWNER_VFS phase=%s firstRecordedNs=%" PRIu64 " firstAvailable=%ju firstFreeInodes=%ju proofFinishedNs=%" PRIu64 " postStatus=%d postErrno=%d postRecordedNs=%" PRIu64 " postAvailable=%ju postFreeInodes=%ju originalComparisonStillUsesFirst=1\n",
        phase, vfs_first_recorded, (uintmax_t)first->f_bavail * first->f_frsize,
        (uintmax_t)first->f_ffree, proof_finished, after_status, after_error, after_recorded,
        (uintmax_t)after.f_bavail * after.f_frsize, (uintmax_t)after.f_ffree);
    if (!owner->proof_ok) fputs("FAIL: exact owner fd/mapping/destroy proof\n", stderr);
    if (after_status) fprintf(stderr, "FAIL: owner post-proof statvfs: %s\n", strerror(after_error));
}

static void snapshot_finish(struct snapshot *value)
{
    free(value->shm_fds);
    value->shm_fds = NULL;
    value->shm_fd_count = 0;
}

static bool snapshot(const char *phase, struct snapshot *result)
{
    memset(result, 0, sizeof(*result));
    if (statvfs("/dev/shm", &result->space)) {
        perror("statvfs /dev/shm");
        return false;
    }
    owner_proof(phase, &result->space);
    struct stat mount;
    if (stat("/dev/shm", &mount)) { perror("stat SHM mount"); return false; }
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) { perror("opendir own fds"); return false; }
    int read_error = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (!entry) { read_error = errno; break; }
        if (entry->d_name[0] == '.') continue;
        result->fds++;
        char *end = NULL;
        errno = 0;
        long number = strtol(entry->d_name, &end, 10);
        if (errno || !end || *end || number < 0 || number > INT_MAX) {
            read_error = EINVAL;
            break;
        }
        struct stat identity;
        if (fstat((int)number, &identity)) { read_error = errno; break; }
        if (identity.st_dev != mount.st_dev) continue;
        if (result->shm_fd_count == SIZE_MAX / sizeof(*result->shm_fds)) {
            read_error = EOVERFLOW;
            break;
        }
        size_t count = result->shm_fd_count + 1;
        struct shm_fd_identity *items = realloc(result->shm_fds, count * sizeof(*items));
        if (!items) { read_error = ENOMEM; break; }
        result->shm_fds = items;
        items[result->shm_fd_count++] = (struct shm_fd_identity){
            .fd = (int)number, .device = identity.st_dev, .inode = identity.st_ino,
        };
    }
    closedir(directory);
    if (read_error) {
        fprintf(stderr, "FAIL: reading own fd identities: %s\n", strerror(read_error));
        snapshot_finish(result);
        return false;
    }
    FILE *maps = fopen("/proc/self/maps", "r");
    if (!maps) { perror("open own maps"); snapshot_finish(result); return false; }
    char line[4096];
    bool parsed = true;
    while (fgets(line, sizeof(line), maps)) {
        unsigned long long start, end, offset, inode;
        unsigned device_major, device_minor;
        char permissions[5];
        if (sscanf(line, "%llx-%llx %4s %llx %x:%x %llu", &start, &end,
            permissions, &offset, &device_major, &device_minor, &inode) != 7) {
            fputs("FAIL: parsing own mapping identity\n", stderr);
            parsed = false;
            break;
        }
        if (device_major == major(mount.st_dev) && device_minor == minor(mount.st_dev) && inode)
            result->shm_maps++;
    }
    bool ok = parsed && !ferror(maps);
    fclose(maps);
    if (!ok) {
        fputs("FAIL: reading own maps\n", stderr);
        snapshot_finish(result);
        return false;
    }
    printf("SNAP phase=%s capacity=%ju free=%ju available=%ju freeInodes=%ju availableInodes=%ju fds=%u shmMaps=%u ownShmFds=%zu\n",
        phase, (uintmax_t)result->space.f_blocks * result->space.f_frsize,
        (uintmax_t)result->space.f_bfree * result->space.f_frsize,
        (uintmax_t)result->space.f_bavail * result->space.f_frsize,
        (uintmax_t)result->space.f_ffree, (uintmax_t)result->space.f_favail,
        result->fds, result->shm_maps, result->shm_fd_count);
    for (size_t i = 0; i < result->shm_fd_count; i++)
        printf("OWN_SHM_FD phase=%s fd=%d device=%ju inode=%ju\n", phase,
            result->shm_fds[i].fd, (uintmax_t)result->shm_fds[i].device,
            (uintmax_t)result->shm_fds[i].inode);
    return true;
}

static bool same_shm_fds(const struct snapshot *before, const struct snapshot *after)
{
    if (before->shm_fd_count != after->shm_fd_count) return false;
    for (size_t i = 0; i < before->shm_fd_count; i++) {
        bool found = false;
        for (size_t j = 0; j < after->shm_fd_count; j++)
            if (before->shm_fds[i].fd == after->shm_fds[j].fd &&
                before->shm_fds[i].device == after->shm_fds[j].device &&
                before->shm_fds[i].inode == after->shm_fds[j].inode) found = true;
        if (!found) return false;
    }
    return true;
}

static bool restored(const struct snapshot *before, const char *phase)
{
    struct snapshot after;
    if (!snapshot(phase, &after)) return false;
    bool own = before->fds == after.fds && before->shm_maps == 0 && after.shm_maps == 0 &&
        same_shm_fds(before, &after);
    bool global = before->space.f_bfree == after.space.f_bfree &&
        before->space.f_bavail == after.space.f_bavail &&
        before->space.f_ffree == after.space.f_ffree &&
        before->space.f_favail == after.space.f_favail;
    if (!own) fputs("FAIL: own SHM fd identity/mapping restoration\n", stderr);
    if (!global) fputs(require_global_restore ?
        "FAIL: private SHM space/inode restoration\n" :
        "DIAG: shared-mount SHM totals changed; exact owner assertions still required\n", stderr);
    snapshot_finish(&after);
    return own && (!require_global_restore || global);
}

static bool positive(struct wlr_allocator *allocator, const struct wlr_drm_format *format,
    int width, int height, const struct snapshot *initial)
{
    struct owner_capture owner = {0};
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
    if (ok && buffer) {
        owner.enabled = true;
        owner.fd = shm.fd; owner.device = backing.st_dev; owner.inode = backing.st_ino;
        owner.address = (uintptr_t)data; owner.length = length;
        owner.locks = buffer->n_locks; owner.accessing = buffer->accessing_data_ptr;
        owner.destroy.notify = owner_destroyed;
        wl_list_init(&owner.destroy.link);
        wl_signal_add(&buffer->events.destroy, &owner.destroy);
        owner_pending = &owner;
    }
    wlr_buffer_drop(buffer);
    bool global_restored = restored(initial, "after-positive-drop");
    owner_pending = NULL;
    if (owner.enabled && !owner.destroyed) wl_list_remove(&owner.destroy.link);
    return global_restored && ok && (!owner.enabled || owner.proof_ok);
}

int main(int argc, char **argv)
{
    bool quota = argc == 2 && !strcmp(argv[1], "--private-64k");
    require_global_restore = quota;
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
        snapshot_finish(&initial);
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
        snapshot_finish(&initial);
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
    snapshot_finish(&initial);
    return ok ? 0 : 1;
}
