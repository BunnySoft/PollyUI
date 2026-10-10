#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif
#include <stdint.h>
#include <stdio.h>
#include <stddef.h>
#include <errno.h>
#include <string.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdlib.h>
#if defined(__linux__)
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <poll.h>
#endif
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#define EXPORT __declspec(dllexport)
#else
#include <time.h>
#include <pthread.h>
#define EXPORT __attribute__((visibility("default")))
#endif

EXPORT int8_t sr_echo_i8(int8_t value) { return value; }
EXPORT uint8_t sr_echo_u8(uint8_t value) { return value; }
EXPORT int16_t sr_echo_i16(int16_t value) { return value; }
EXPORT uint16_t sr_echo_u16(uint16_t value) { return value; }
EXPORT int32_t sr_echo_i32(int32_t value) { return value; }
EXPORT uint32_t sr_echo_u32(uint32_t value) { return value; }
EXPORT int64_t sr_echo_i64(int64_t value) { return value; }
EXPORT uint64_t sr_echo_u64(uint64_t value) { return value; }
EXPORT float sr_echo_float(float value) { return value; }
EXPORT double sr_echo_double(double value) { return value; }
EXPORT double sr_mixed(int8_t a, uint16_t b, int32_t c, double d) { return a + b + c + d; }
EXPORT void sr_fill(uint8_t *bytes, size_t count, uint8_t value)
{
    for (size_t i = 0; i < count; i++) bytes[i] = value;
}
EXPORT void *sr_echo_pointer(void *pointer) { return pointer; }
EXPORT const char *sr_tail(const char *text) { return text + 1; }
EXPORT const char *sr_static(void) { return "opaque"; }
static atomic_int owned_allocations;
EXPORT void *sr_allocate(size_t size)
{
    void *pointer = calloc(size ? size : 1, 1);
    if (pointer) atomic_fetch_add(&owned_allocations, 1);
    return pointer;
}
EXPORT void sr_release(void *pointer)
{
    if (pointer) { free(pointer); atomic_fetch_sub(&owned_allocations, 1); }
}
EXPORT int32_t sr_allocations(void) { return atomic_load(&owned_allocations); }
static void fixture_sleep(int32_t milliseconds)
{
#ifdef _WIN32
    Sleep((DWORD)milliseconds);
#else
    struct timespec delay = { milliseconds / 1000, (milliseconds % 1000) * 1000000 };
    while (nanosleep(&delay, &delay) && errno == EINTR) {}
#endif
}
EXPORT int32_t sr_async_delay(int32_t milliseconds, int32_t value)
{
    fixture_sleep(milliseconds); return value;
}
EXPORT uint64_t sr_thread_id(void)
{
#ifdef _WIN32
    return GetCurrentThreadId();
#else
    return (uint64_t)(uintptr_t)pthread_self();
#endif
}
static atomic_int gate_open;
EXPORT void sr_gate_reset(void) { atomic_store(&gate_open, 0); }
EXPORT void sr_gate_release(void) { atomic_store(&gate_open, 1); }
EXPORT int32_t sr_gate_wait(int32_t value)
{
    for (int i = 0; i < 1000 && !atomic_load(&gate_open); i++) fixture_sleep(1);
    return atomic_load(&gate_open) ? value : INT32_MIN;
}
EXPORT int32_t sr_gate_fill(uint8_t *bytes, size_t size, uint8_t value)
{
    if (sr_gate_wait(0) == INT32_MIN) return INT32_MIN;
    for (size_t i = 0; i < size; i++) bytes[i] = value;
    return (int32_t)size;
}
EXPORT int32_t sr_delay_fill(uint8_t *bytes, size_t size, uint8_t value, int32_t milliseconds)
{
    fixture_sleep(milliseconds);
    for (size_t i = 0; i < size; i++) bytes[i] = value;
    return (int32_t)size;
}
EXPORT int32_t sr_gate_pair(const uint8_t *first, const uint8_t *second)
{
    if (sr_gate_wait(0) == INT32_MIN) return INT32_MIN;
    return first[0] + second[0];
}
EXPORT int32_t sr_buffer_error(uint8_t *bytes)
{
    bytes[0] = 42;
    errno = 27;
#ifdef _WIN32
    SetLastError(27);
#endif
    return -1;
}
EXPORT int32_t sr_error(int32_t value)
{
    errno = value;
#ifdef _WIN32
    SetLastError((DWORD)value);
#endif
    return -1;
}

EXPORT int32_t sr_saved_error(void)
{
#ifdef _WIN32
    return (int32_t)GetLastError();
#else
    return errno;
#endif
}

static atomic_int callback_visits;
EXPORT int32_t sr_callback_visits(void) { return atomic_load(&callback_visits); }
EXPORT int32_t sr_callback_i32(int32_t (*callback)(int32_t), int32_t value, int32_t count)
{
    int32_t total = 0;
    atomic_store(&callback_visits, 0);
    for (int32_t i = 0; i < count; i++) {
        total += callback(value + i);
        atomic_fetch_add(&callback_visits, 1);
    }
    return total;
}
EXPORT int8_t sr_callback_i8(int8_t (*callback)(int8_t), int8_t value) { return callback(value); }
EXPORT int64_t sr_callback_i64(int64_t (*callback)(int64_t), int64_t value) { return callback(value); }
EXPORT double sr_callback_mixed(double (*callback)(int8_t, uint64_t, float, double))
{
    return callback(-7, UINT64_MAX, 0.5f, 1.25);
}
EXPORT void sr_callback_void(void (*callback)(int32_t), int32_t value) { callback(value); }
EXPORT int32_t sr_callback_error(int32_t (*callback)(int32_t))
{
    errno = 29;
#ifdef _WIN32
    SetLastError(29);
#endif
    return callback(3);
}
typedef struct CallbackThread { int32_t (*callback)(int32_t); } CallbackThread;
#ifdef _WIN32
static DWORD WINAPI callback_worker(void *user)
#else
static void *callback_worker(void *user)
#endif
{
    CallbackThread *call = user;
    call->callback(5);
    return 0;
}
EXPORT int32_t sr_callback_thread(int32_t (*callback)(int32_t))
{
    CallbackThread call = { callback };
#ifdef _WIN32
    HANDLE thread = CreateThread(NULL, 0, callback_worker, &call, 0, NULL);
    if (!thread) return -1;
    if (WaitForSingleObject(thread, INFINITE) != WAIT_OBJECT_0) abort();
    if (!CloseHandle(thread)) abort();
#else
    pthread_t thread;
    if (pthread_create(&thread, NULL, callback_worker, &call)) return -1;
    if (pthread_join(thread, NULL)) abort();
#endif
    return 777;
}

#if defined(_WIN32) || defined(__linux__)
EXPORT size_t sr_network_layout(int32_t index)
{
    const size_t values[] = {
        sizeof(struct sockaddr_in), offsetof(struct sockaddr_in, sin_family),
        offsetof(struct sockaddr_in, sin_port), offsetof(struct sockaddr_in, sin_addr),
        sizeof(struct sockaddr_in6), offsetof(struct sockaddr_in6, sin6_family),
        offsetof(struct sockaddr_in6, sin6_port), offsetof(struct sockaddr_in6, sin6_flowinfo),
        offsetof(struct sockaddr_in6, sin6_addr), offsetof(struct sockaddr_in6, sin6_scope_id),
#ifdef _WIN32
        sizeof(WSAPOLLFD), offsetof(WSAPOLLFD, fd), offsetof(WSAPOLLFD, events), offsetof(WSAPOLLFD, revents),
        sizeof(int), sizeof(SOCKET), sizeof(WSADATA),
#else
        sizeof(struct pollfd), offsetof(struct pollfd, fd), offsetof(struct pollfd, events), offsetof(struct pollfd, revents),
        sizeof(socklen_t), sizeof(int), 0,
#endif
    };
    return index >= 0 && (size_t)index < sizeof(values) / sizeof(*values) ? values[index] : SIZE_MAX;
}

EXPORT int64_t sr_network_constant(int32_t index)
{
    const int64_t values[] = {
        AF_INET, AF_INET6, SOCK_STREAM, SOCK_DGRAM, IPPROTO_TCP, IPPROTO_UDP,
#ifdef _WIN32
        SD_RECEIVE, SD_SEND, SD_BOTH,
#else
        SHUT_RD, SHUT_WR, SHUT_RDWR,
#endif
        SOL_SOCKET, SO_REUSEADDR, SO_ERROR, SO_TYPE, POLLIN, POLLOUT, POLLERR, POLLHUP, MSG_PEEK,
#ifdef _WIN32
        (int32_t)FIONBIO,
#else
        MSG_DONTWAIT, MSG_NOSIGNAL, F_GETFL, F_SETFL, O_NONBLOCK,
#endif
    };
    return index >= 0 && (size_t)index < sizeof(values) / sizeof(*values) ? values[index] : INT64_MIN;
}
#endif

EXPORT size_t sr_process_layout(int32_t index)
{
#ifdef _WIN32
    const size_t values[] = { sizeof(STARTUPINFOW), sizeof(PROCESS_INFORMATION),
        offsetof(PROCESS_INFORMATION, hProcess), offsetof(PROCESS_INFORMATION, hThread),
        offsetof(PROCESS_INFORMATION, dwProcessId), offsetof(PROCESS_INFORMATION, dwThreadId) };
#else
    const size_t values[] = { sizeof(int32_t) };
#endif
    return index >= 0 && (size_t)index < sizeof(values) / sizeof(*values) ? values[index] : SIZE_MAX;
}

EXPORT double sr_variadic(int32_t bias, int32_t count, ...)
{
    va_list args;
    va_start(args, count);
    double result = bias;
    for (int32_t i = 0; i < count; i++) {
        result += va_arg(args, int);
        result += va_arg(args, double);
    }
    va_end(args);
    return result;
}
EXPORT size_t sr_variadic_strings(int32_t count, ...)
{
    va_list args;
    va_start(args, count);
    size_t size = 0;
    for (int32_t i = 0; i < count; i++) size += strlen(va_arg(args, const char *));
    va_end(args);
    return size;
}

#if defined(__linux__)
EXPORT size_t sr_statx_offset(int32_t index)
{
    const size_t offsets[] = {
        offsetof(struct statx, stx_mask), offsetof(struct statx, stx_nlink),
        offsetof(struct statx, stx_uid), offsetof(struct statx, stx_gid),
        offsetof(struct statx, stx_mode), offsetof(struct statx, stx_ino),
        offsetof(struct statx, stx_size), offsetof(struct statx, stx_ctime.tv_sec),
        offsetof(struct statx, stx_ctime.tv_nsec), offsetof(struct statx, stx_mtime.tv_sec),
        offsetof(struct statx, stx_mtime.tv_nsec), offsetof(struct statx, stx_dev_major),
        offsetof(struct statx, stx_dev_minor), sizeof(struct statx),
        AT_FDCWD, AT_EMPTY_PATH, AT_SYMLINK_NOFOLLOW, AT_EACCESS, STATX_BASIC_STATS,
        O_RDONLY, O_RDWR, O_WRONLY, O_CREAT, O_EXCL, O_NONBLOCK, O_DIRECTORY,
        O_NOFOLLOW, O_CLOEXEC, O_PATH, RENAME_NOREPLACE, S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, LOCK_EX, LOCK_NB,
    };
    return index >= 0 && (size_t)index < sizeof(offsets) / sizeof(*offsets) ? offsets[index] : SIZE_MAX;
}
static char retiring_path[4096];
static char failing_close_path[4096];
EXPORT void sr_fail_close(const char *path)
{
    snprintf(failing_close_path, sizeof(failing_close_path), "%s", path);
}
EXPORT int32_t sr_checked_close(int32_t fd)
{
    if (*failing_close_path) {
        char descriptor[64], path[4096];
        snprintf(descriptor, sizeof(descriptor), "/proc/self/fd/%d", fd);
        ssize_t size = readlink(descriptor, path, sizeof(path) - 1);
        if (size >= 0) {
            path[size] = 0;
            if (!strcmp(path, failing_close_path)) {
                *failing_close_path = 0;
                if (close(fd)) return -1;
                errno = EIO; return -1;
            }
        }
    }
    return close(fd);
}
EXPORT void sr_retire_on_entries(const char *path)
{
    snprintf(retiring_path, sizeof(retiring_path), "%s", path);
}
#if defined(__GLIBC__)
EXPORT ssize_t sr_checked_getdents64(int fd, void *buffer, size_t size)
#else
EXPORT int sr_checked_getdents(int fd, void *buffer, size_t size)
#endif
{
    if (*retiring_path) {
        int result = rmdir(retiring_path);
        *retiring_path = 0;
        if (result) return -1;
    }
#if defined(__GLIBC__)
    return getdents64(fd, buffer, size);
#else
    return getdents(fd, buffer, size);
#endif
}
#endif

typedef struct SrRecord { int8_t tag; int64_t count; double ratio; } SrRecord;
EXPORT size_t sr_record_size(void) { return sizeof(SrRecord); }
EXPORT size_t sr_record_count_offset(void) { return offsetof(SrRecord, count); }
EXPORT size_t sr_record_ratio_offset(void) { return offsetof(SrRecord, ratio); }
EXPORT void sr_record_fill(SrRecord *record)
{
    record->tag = -7; record->count = INT64_MIN + 1; record->ratio = 1.25;
}
EXPORT int32_t sr_record_check(const SrRecord *record)
{
    return record->tag == 12 && record->count == INT64_MAX && record->ratio == 2.5;
}

EXPORT uint64_t sr_monotonic_ns(void)
{
#ifdef _WIN32
    LARGE_INTEGER counter, frequency;
    if (!QueryPerformanceCounter(&counter) || !QueryPerformanceFrequency(&frequency) ||
        counter.QuadPart < 0 || frequency.QuadPart <= 0) return UINT64_MAX;
    uint64_t value = (uint64_t)counter.QuadPart, rate = (uint64_t)frequency.QuadPart;
    if (rate > UINT64_MAX / UINT64_C(1000000000)) return UINT64_MAX;
    return (value / rate) * UINT64_C(1000000000) +
        (value % rate) * UINT64_C(1000000000) / rate;
#else
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value)) return UINT64_MAX;
    return (uint64_t)value.tv_sec * UINT64_C(1000000000) + (uint64_t)value.tv_nsec;
#endif
}

typedef struct SrTextRecord { uint8_t bytes[4]; char text[16]; } SrTextRecord;
EXPORT size_t sr_text_size(void) { return sizeof(SrTextRecord); }
EXPORT size_t sr_text_offset(void) { return offsetof(SrTextRecord, text); }
EXPORT void sr_text_fill(SrTextRecord *record)
{
    const uint8_t bytes[] = {1, 2, 3, 4};
    memcpy(record->bytes, bytes, sizeof(bytes));
    memset(record->text, 0, sizeof(record->text));
    memcpy(record->text, "A\xf0\x9f\x99\x82", 5);
}
EXPORT int32_t sr_text_check(const SrTextRecord *record)
{
    const uint8_t bytes[] = {9, 8, 7, 6};
    return !memcmp(record->bytes, bytes, sizeof(bytes)) && !strcmp(record->text, "B\xe4\xb8\xad");
}
