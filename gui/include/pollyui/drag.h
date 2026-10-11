#ifndef POLLYUI_DRAG_H
#define POLLYUI_DRAG_H
#include <stddef.h>

typedef struct PuWindow PuWindow;
typedef struct PuDragInput PuDragInput;
typedef struct PuDragSession PuDragSession;

typedef struct PuDragItem {
    const char *type;
    const void *data;
    size_t size;
} PuDragItem;

typedef enum PuDragStatus {
    PU_DRAG_PENDING, PU_DRAG_COPIED, PU_DRAG_CANCELLED, PU_DRAG_ERROR
} PuDragStatus;
typedef struct PuDragResult {
    PuDragStatus status;
    const char *reason; /* Borrowed during callback; NULL on successful COPY. */
} PuDragResult;
typedef void (*PuDragFn)(const PuDragResult *result, void *user);

/* UI thread only. Capability is per ordinary window and current native seat.
 * A source uses COPY, no icon and no filesystem access. Items are deep-copied.
 * The opaque input is borrowed from a native pointer event; retain explicitly
 * to use during the same held press. Synthetic input cannot authorize a drag. */
int pu_window_drag_supported(PuWindow *window);
PuDragSession *pu_window_start_drag(PuWindow *window, PuDragInput *input,
    const PuDragItem *items, size_t count, PuDragFn callback, void *user);
const char *pu_drag_error(void);
void pu_drag_input_ref(PuDragInput *input);
void pu_drag_input_unref(PuDragInput *input);
void pu_drag_cancel(PuDragSession *session);
/* Releasing the caller's reference cancels a pending operation. Completion is
 * delivered once on the owning UI loop, never from a protocol/worker callback.
 * Clear the callback before destroying its user/VM; native cleanup still runs. */
void pu_drag_set_callback(PuDragSession *session, PuDragFn callback, void *user);
void pu_drag_release(PuDragSession *session);

#endif
