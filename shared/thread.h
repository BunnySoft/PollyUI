#ifndef POLLYUI_CORE_THREAD_H
#define POLLYUI_CORE_THREAD_H

/* Win32/POSIX threading primitives for workers and asynchronous tasks. */

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

/* Start a thread running fn(arg). Join waits and releases the handle. */
PuThread *pu_thread_start(void (*fn)(void *), void *arg);
void      pu_thread_join(PuThread *t);

/* Monotonic milliseconds (for timed waits). */
long long pu_now_ms(void);

#endif /* POLLYUI_CORE_THREAD_H */
