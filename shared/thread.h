#ifndef POLLYUI_CORE_THREAD_H
#define POLLYUI_CORE_THREAD_H

/* Minimal threading primitives (Win32-backed; windows.h stays in thread.c).
 * Used by the concurrency layer (workers + async tasks). Cross-platform later
 * swaps the implementation for pthreads/C11 threads. */

typedef struct PuMutex  PuMutex;
typedef struct PuCond   PuCond;
typedef struct PuThread PuThread;

PuMutex *pu_mutex_new(void);
void     pu_mutex_free(PuMutex *m);
void     pu_mutex_lock(PuMutex *m);
void     pu_mutex_unlock(PuMutex *m);

PuCond *pu_cond_new(void);
void    pu_cond_free(PuCond *c);
void    pu_cond_wait(PuCond *c, PuMutex *m);          /* wait (unlocks m while waiting) */
void    pu_cond_wait_ms(PuCond *c, PuMutex *m, int ms);
void    pu_cond_signal(PuCond *c);
void    pu_cond_broadcast(PuCond *c);

/* Start a thread running fn(arg). Join (waits + frees) or detach (frees handle). */
PuThread *pu_thread_start(void (*fn)(void *), void *arg);
void      pu_thread_join(PuThread *t);
void      pu_thread_detach(PuThread *t);

/* Monotonic milliseconds (for timed waits). */
long long pu_now_ms(void);

#endif /* POLLYUI_CORE_THREAD_H */
