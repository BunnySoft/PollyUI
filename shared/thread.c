#include "shared/thread.h"

#include <stdlib.h>

#ifdef _WIN32
/* ===================== Windows (Win32) backend ============================ */
#include <windows.h>

struct PuMutex  { CRITICAL_SECTION cs; };
struct PuCond   { CONDITION_VARIABLE cv; };
struct PuThread { HANDLE h; };

PuMutex *pu_mutex_new(void)
{
    PuMutex *m = (PuMutex *)malloc(sizeof(PuMutex));
    if (m) InitializeCriticalSection(&m->cs);
    return m;
}
void pu_mutex_free(PuMutex *m)   { if (m) { DeleteCriticalSection(&m->cs); free(m); } }
void pu_mutex_lock(PuMutex *m)   { EnterCriticalSection(&m->cs); }
void pu_mutex_unlock(PuMutex *m) { LeaveCriticalSection(&m->cs); }

PuCond *pu_cond_new(void)
{
    PuCond *c = (PuCond *)malloc(sizeof(PuCond));
    if (c) InitializeConditionVariable(&c->cv);
    return c;
}
void pu_cond_free(PuCond *c)                 { free(c); }
void pu_cond_wait(PuCond *c, PuMutex *m)     { SleepConditionVariableCS(&c->cv, &m->cs, INFINITE); }
void pu_cond_wait_ms(PuCond *c, PuMutex *m, int ms)
{
    SleepConditionVariableCS(&c->cv, &m->cs, ms < 0 ? INFINITE : (DWORD)ms);
}
void pu_cond_signal(PuCond *c)               { WakeConditionVariable(&c->cv); }

typedef struct { void (*fn)(void *); void *arg; } TrampArg;

static DWORD WINAPI pu_thread_trampoline(LPVOID p)
{
    TrampArg *ta = (TrampArg *)p;
    void (*fn)(void *) = ta->fn;
    void *arg = ta->arg;
    free(ta);
    fn(arg);
    return 0;
}

PuThread *pu_thread_start(void (*fn)(void *), void *arg)
{
    TrampArg *ta = (TrampArg *)malloc(sizeof(TrampArg));
    if (!ta) return NULL;
    ta->fn = fn;
    ta->arg = arg;

    PuThread *t = (PuThread *)malloc(sizeof(PuThread));
    if (!t) { free(ta); return NULL; }
    t->h = CreateThread(NULL, 0, pu_thread_trampoline, ta, 0, NULL);
    if (!t->h) { free(ta); free(t); return NULL; }
    return t;
}
void pu_thread_join(PuThread *t)
{
    if (!t) return;
    WaitForSingleObject(t->h, INFINITE);
    CloseHandle(t->h);
    free(t);
}

long long pu_now_ms(void) { return (long long)GetTickCount64(); }

#else
/* ===================== POSIX (pthreads) backend =========================== */
#include <pthread.h>
#include <time.h>

struct PuMutex  { pthread_mutex_t m; };
struct PuCond   { pthread_cond_t  c; };
struct PuThread { pthread_t t; };

PuMutex *pu_mutex_new(void)
{
    PuMutex *m = (PuMutex *)malloc(sizeof(PuMutex));
    if (m) pthread_mutex_init(&m->m, NULL);
    return m;
}
void pu_mutex_free(PuMutex *m)   { if (m) { pthread_mutex_destroy(&m->m); free(m); } }
void pu_mutex_lock(PuMutex *m)   { pthread_mutex_lock(&m->m); }
void pu_mutex_unlock(PuMutex *m) { pthread_mutex_unlock(&m->m); }

PuCond *pu_cond_new(void)
{
    PuCond *c = (PuCond *)malloc(sizeof(PuCond));
    if (c) pthread_cond_init(&c->c, NULL);
    return c;
}
void pu_cond_free(PuCond *c)             { if (c) { pthread_cond_destroy(&c->c); free(c); } }
void pu_cond_wait(PuCond *c, PuMutex *m) { pthread_cond_wait(&c->c, &m->m); }
void pu_cond_wait_ms(PuCond *c, PuMutex *m, int ms)
{
    if (ms < 0) { pthread_cond_wait(&c->c, &m->m); return; }
    /* pthread_cond_timedwait takes an absolute CLOCK_REALTIME deadline. */
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec  += ms / 1000;
    ts.tv_nsec += (long)(ms % 1000) * 1000000L;
    if (ts.tv_nsec >= 1000000000L) { ts.tv_sec += 1; ts.tv_nsec -= 1000000000L; }
    pthread_cond_timedwait(&c->c, &m->m, &ts);
}
void pu_cond_signal(PuCond *c)    { pthread_cond_signal(&c->c); }

typedef struct { void (*fn)(void *); void *arg; } TrampArg;

static void *pu_thread_trampoline(void *p)
{
    TrampArg *ta = (TrampArg *)p;
    void (*fn)(void *) = ta->fn;
    void *arg = ta->arg;
    free(ta);
    fn(arg);
    return NULL;
}

PuThread *pu_thread_start(void (*fn)(void *), void *arg)
{
    TrampArg *ta = (TrampArg *)malloc(sizeof(TrampArg));
    if (!ta) return NULL;
    ta->fn = fn;
    ta->arg = arg;

    PuThread *t = (PuThread *)malloc(sizeof(PuThread));
    if (!t) { free(ta); return NULL; }
    if (pthread_create(&t->t, NULL, pu_thread_trampoline, ta) != 0) { free(ta); free(t); return NULL; }
    return t;
}
void pu_thread_join(PuThread *t)
{
    if (!t) return;
    pthread_join(t->t, NULL);
    free(t);
}

long long pu_now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

#endif /* _WIN32 */
