#include "core/thread.h"

#include <windows.h>
#include <stdlib.h>

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
void pu_cond_broadcast(PuCond *c)            { WakeAllConditionVariable(&c->cv); }

/* The trampoline owns its argument block, so detaching/freeing the PuThread
 * handle can never race the running thread reading fn/arg. */
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
void pu_thread_detach(PuThread *t)
{
    if (!t) return;
    CloseHandle(t->h);
    free(t);
}

long long pu_now_ms(void) { return (long long)GetTickCount64(); }
