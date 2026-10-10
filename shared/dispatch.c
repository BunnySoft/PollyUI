#include "shared/dispatch.h"
#include "shared/thread.h"

#include <stdlib.h>
#include <stdio.h>

struct PuDelivery {
    PuDeliverFn      fn;
    void            *ctx;
    struct PuDelivery *next;
};

struct PuDispatch {
    PuMutex  *mutex;
    PuCond   *cond;
    PuDelivery *head, *tail;
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
    if (!d) return;
    PuDelivery *n = d->head;
    while (n) { PuDelivery *next = n->next; free(n); n = next; }
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

PuDelivery *pu_dispatch_prepare(PuDeliverFn fn, void *ctx)
{
    PuDelivery *node = malloc(sizeof(*node));
    if (!node) { fprintf(stderr, "[dispatch] Cannot allocate callback delivery\n"); return NULL; }
    node->fn = fn;
    node->ctx = ctx;
    node->next = NULL;
    return node;
}

void pu_dispatch_submit(PuDispatch *d, PuDelivery *node)
{
    pu_mutex_lock(d->mutex);
    if (d->tail) d->tail->next = node; else d->head = node;
    d->tail = node;
    void (*wake)(void *) = d->wake;
    void *wctx = d->wake_ctx;
    pu_cond_signal(d->cond);
    pu_mutex_unlock(d->mutex);

    if (wake) wake(wctx); /* outside the lock */
}

void pu_dispatch_discard(PuDelivery *delivery) { free(delivery); }

int pu_dispatch_post(PuDispatch *d, PuDeliverFn fn, void *ctx)
{
    PuDelivery *node = pu_dispatch_prepare(fn, ctx);
    if (!node) return 0;
    pu_dispatch_submit(d, node);
    return 1;
}

int pu_dispatch_remove(PuDispatch *d, PuDeliverFn fn, void *ctx)
{
    pu_mutex_lock(d->mutex);
    PuDelivery *previous = NULL, *node = d->head;
    while (node && (node->fn != fn || node->ctx != ctx)) { previous = node; node = node->next; }
    if (node) {
        if (previous) previous->next = node->next; else d->head = node->next;
        if (d->tail == node) d->tail = previous;
    }
    pu_mutex_unlock(d->mutex);
    int removed = node != NULL;
    free(node);
    return removed;
}

int pu_dispatch_drain(PuDispatch *d)
{
    /* Detach the queue under the lock, then run deliveries unlocked so they may
     * post / ref without deadlocking. */
    pu_mutex_lock(d->mutex);
    PuDelivery *list = d->head;
    d->head = d->tail = NULL;
    pu_mutex_unlock(d->mutex);

    int count = 0;
    while (list) {
        PuDelivery *next = list->next;
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
