#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#include <stdint.h>
#include <stddef.h>
#include <errno.h>
#ifdef _WIN32
#include <windows.h>
#define EXPORT __declspec(dllexport)
#else
#include <time.h>
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
EXPORT int32_t sr_error(int32_t value)
{
    errno = value;
#ifdef _WIN32
    SetLastError((DWORD)value);
#endif
    return -1;
}

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
