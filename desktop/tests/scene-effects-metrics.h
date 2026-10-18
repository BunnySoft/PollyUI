#pragma once
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <time.h>

struct stage_stamp {
    struct timespec wall, cpu;
    struct rusage usage;
};
struct stage_row {
    unsigned index, trial;
    const char *phase, *part;
    double wall_ms, cpu_ms;
    long voluntary, involuntary;
};
static bool stage_active;
static unsigned stage_index, stage_trial, stage_count;
static const char *stage_phase;
static struct stage_row stage_rows[512];

static struct stage_stamp stage_stamp(void)
{
    struct stage_stamp stamp = {0};
    if (stage_active &&
        (clock_gettime(CLOCK_MONOTONIC, &stamp.wall) ||
         clock_gettime(CLOCK_THREAD_CPUTIME_ID, &stamp.cpu) ||
         getrusage(RUSAGE_THREAD, &stamp.usage))) {
        perror("stage clocks/thread usage");
        exit(2);
    }
    return stamp;
}

static double stage_delta(struct timespec end, struct timespec start)
{
    return (end.tv_sec - start.tv_sec) * 1000.0 + (end.tv_nsec - start.tv_nsec) / 1000000.0;
}

static void stage_record(const char *part, struct stage_stamp begin)
{
    if (!stage_active) return;
    struct stage_stamp end = stage_stamp();
    if (stage_count == sizeof(stage_rows) / sizeof(stage_rows[0])) {
        fputs("FAIL: stage measurement capacity\n", stderr);
        exit(2);
    }
    stage_rows[stage_count++] = (struct stage_row){
        stage_index, stage_trial, stage_phase, part,
        stage_delta(end.wall, begin.wall), stage_delta(end.cpu, begin.cpu),
        end.usage.ru_nvcsw - begin.usage.ru_nvcsw,
        end.usage.ru_nivcsw - begin.usage.ru_nivcsw,
    };
}

static void stage_flush(void)
{
    for (unsigned i = 0; i < stage_count; i++) {
        const struct stage_row *row = &stage_rows[i];
        printf("GAUSSIAN_STAGE: case=%u trial=%u warmup=%u phase=%s part=%s wall_ms=%.9f thread_cpu_ms=%.9f voluntary=%ld involuntary=%ld\n",
            row->index, row->trial, row->trial == 0, row->phase, row->part,
            row->wall_ms, row->cpu_ms, row->voluntary, row->involuntary);
    }
}
