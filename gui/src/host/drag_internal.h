#ifndef PU_DRAG_INTERNAL_H
#define PU_DRAG_INTERNAL_H
#include "pollyui/drag.h"
#include <stdint.h>

typedef struct PuDragOwner PuDragOwner;
struct PuDragInput {
    unsigned references;
    PuDragOwner *owner;
    void *seat;
    uint32_t serial;
    int valid, used;
};
struct PuDragOwner {
    unsigned references;
    PuWindow *window;
    void *native, *backend;
    PuDragInput *input;
    int open;
};
struct PuDragSession {
    struct PuDragSession *next;
    PuDragOwner *owner;
    PuDragItem *items;
    size_t count;
    PuDragFn callback;
    void *user;
    unsigned references;
    int cancel_requested;
    PuDragStatus status;
    char reason[192];
    void *native;
};
PuDragOwner *pu_drag_owner_new(PuWindow *window);
void pu_drag_owner_close(PuDragOwner *owner);
void pu_drag_owner_unref(PuDragOwner *owner);
void pu_drag_invalidate(PuDragOwner *owner);
PuDragInput *pu_drag_input_new(PuDragOwner *owner, void *seat, uint32_t serial);
PuDragSession *pu_drag_copy(PuDragOwner *owner, PuDragInput *input,
    const PuDragItem *items, size_t count, PuDragFn callback, void *user);
void pu_drag_finish(PuDragSession *session, PuDragStatus status, const char *reason);
void pu_drag_deliver(PuDragSession *session);
int pu_drag_fail(const char *message);

#if defined(PU_DRAG_WAYLAND)
void pu_wayland_drag_attach(PuDragOwner *owner, void *display, void *surface);
int pu_wayland_drag_supported(PuDragOwner *owner);
PuDragSession *pu_wayland_drag_start(PuDragOwner *owner, PuDragInput *input,
    const PuDragItem *items, size_t count, PuDragFn callback, void *user);
void pu_wayland_drag_close(PuDragOwner *owner);
void pu_wayland_drag_suspend(PuDragOwner *owner);
void pu_wayland_drag_pump(void);
void pu_wayland_drag_shutdown(void);
#endif
#endif
