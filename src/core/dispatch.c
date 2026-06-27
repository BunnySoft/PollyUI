#include "core/dispatch.h"
#include "core/thread.h"

#include <stdlib.h>

typedef struct Delivery {
    PuDeliverFn      fn;
    void            *ctx;
    struct Delivery *next;
} Delivery;

struct PuDispatch {
    PuMutex  *mutex;
    PuCond   *cond;
    Delivery *head, *tail;
    int       pending;          /* outstanding async refs */
    void    (*wake)(void *);
    void     *wake_ctx;
};

PuDispatch *pu_dispatch_new(void)
{
    PuDispatch *d = (PuDispatch *)calloc(1, sizeof(PuDispatch));
    if (!d) return NULL;
    d->mutex = pu_mutex_new();
    d->cond  = pu_cond_new();
    if (!d->mutex || !d->cond) { pu_dispatch_free(d); return NULL; }
    return d;
}

void pu_dispatch_free(PuDispatch *d)
{
    if (!d) return;
    Delivery *n = d->head;
    while (n) { Delivery *next = n->next; free(n); n = next; }
    pu_mutex_free(d->mutex);
    pu_cond_free(d->cond);
    free(d);
}

void pu_dispatch_set_waker(PuDispatch *d, void (*wake)(void *), void *wakectx)
{
    pu_mutex_lock(d->mutex);
    d->wake = wake;
    d->wake_ctx = wakectx;
    pu_mutex_unlock(d->mutex);
}

void pu_dispatch_post(PuDispatch *d, PuDeliverFn fn, void *ctx)
{
    Delivery *node = (Delivery *)malloc(sizeof(Delivery));
    if (!node) return;
    node->fn = fn;
    node->ctx = ctx;
    node->next = NULL;

    pu_mutex_lock(d->mutex);
    if (d->tail) d->tail->next = node; else d->head = node;
    d->tail = node;
    void (*wake)(void *) = d->wake;
    void *wctx = d->wake_ctx;
    pu_cond_signal(d->cond);
    pu_mutex_unlock(d->mutex);

    if (wake) wake(wctx); /* outside the lock */
}

int pu_dispatch_drain(PuDispatch *d)
{
    /* Detach the queue under the lock, then run deliveries unlocked so they may
     * post / ref without deadlocking. */
    pu_mutex_lock(d->mutex);
    Delivery *list = d->head;
    d->head = d->tail = NULL;
    pu_mutex_unlock(d->mutex);

    int count = 0;
    while (list) {
        Delivery *next = list->next;
        list->fn(list->ctx);
        free(list);
        list = next;
        count++;
    }
    return count;
}

void pu_dispatch_ref(PuDispatch *d)
{
    pu_mutex_lock(d->mutex);
    d->pending++;
    pu_mutex_unlock(d->mutex);
}

void pu_dispatch_unref(PuDispatch *d)
{
    pu_mutex_lock(d->mutex);
    if (d->pending > 0) d->pending--;
    pu_cond_signal(d->cond); /* loop may now be able to exit */
    pu_mutex_unlock(d->mutex);
}

int pu_dispatch_pending(PuDispatch *d)
{
    pu_mutex_lock(d->mutex);
    int p = d->pending;
    pu_mutex_unlock(d->mutex);
    return p;
}

void pu_dispatch_wait(PuDispatch *d, int ms)
{
    pu_mutex_lock(d->mutex);
    if (!d->head) pu_cond_wait_ms(d->cond, d->mutex, ms);
    pu_mutex_unlock(d->mutex);
}
