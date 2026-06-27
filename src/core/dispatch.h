#ifndef POLLYUI_CORE_DISPATCH_H
#define POLLYUI_CORE_DISPATCH_H

/* UI-thread dispatcher — the marshal-to-UI mechanism (cf. Control.BeginInvoke /
 * Dispatcher.BeginInvoke). Worker threads and async tasks `post` a delivery
 * (a C function + context) that is run later on the UI thread by `drain`.
 *
 * A reference count keeps the event loop alive while async work is outstanding
 * (cf. libuv handle refs): the loop keeps running while pending() > 0. */

typedef struct PuDispatch PuDispatch;
typedef void (*PuDeliverFn)(void *ctx);

PuDispatch *pu_dispatch_new(void);
void        pu_dispatch_free(PuDispatch *d);

/* Post a delivery from any thread; runs on the UI thread at the next drain. */
void pu_dispatch_post(PuDispatch *d, PuDeliverFn fn, void *ctx);

/* UI thread: run all queued deliveries now. Returns how many ran. */
int  pu_dispatch_drain(PuDispatch *d);

/* Outstanding-async refcount (keeps the loop alive). */
void pu_dispatch_ref(PuDispatch *d);
void pu_dispatch_unref(PuDispatch *d);
int  pu_dispatch_pending(PuDispatch *d);

/* UI thread: block up to `ms` waiting for a post (or wake). */
void pu_dispatch_wait(PuDispatch *d, int ms);

/* Optional waker invoked on every post (e.g. PostMessage a window so its
 * message loop wakes and drains). Runs on the posting thread. */
void pu_dispatch_set_waker(PuDispatch *d, void (*wake)(void *), void *wakectx);

#endif /* POLLYUI_CORE_DISPATCH_H */
