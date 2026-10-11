#ifndef PU_WINDOW_CLOSE_H
#define PU_WINDOW_CLOSE_H

/* Included after each Host's private PuWindow and live registry declarations. */

static PuWindow *live_child(PuWindow *parent)
{
    for (PuWindow *w = g_windows; w; w = w->next)
        if (w->parent == parent && w->running) return w;
    return NULL;
}

static void release_close_borrow(PuWindow *w)
{
    if (!--w->borrows && w->destroy_requested && !w->children)
        pu_window_destroy(w);
}

static void discard_window_creation(PuWindow *w)
{
    w->borrows--;
    pu_window_destroy(w);
}

static PuWindow **borrow_window_snapshot(size_t *count)
{
    *count = 0;
    for (PuWindow *w = g_windows; w; w = w->next) (*count)++;
    PuWindow **windows = *count ? calloc(*count, sizeof(*windows)) : NULL;
    if (*count && !windows) {
        fprintf(stderr, "[window] Cannot allocate callback lifetime snapshot\n");
        for (PuWindow *w = g_windows; w; w = w->next) { w->exit_code = 1; w->running = 0; }
        *count = 0;
        return NULL;
    }
    size_t index = 0;
    for (PuWindow *w = g_windows; w; w = w->next) { w->borrows++; windows[index++] = w; }
    return windows;
}

static void release_window_snapshot(PuWindow **windows, size_t count)
{
    for (size_t i = 0; i < count; i++) release_close_borrow(windows[i]);
    free(windows);
}

static int coordinate_close(PuWindow *w, int external)
{
    if (!w || !w->running) return PU_CLOSE_ACCEPTED;
    if (w->close_pending) return PU_CLOSE_PENDING;
    if (w->closing) {
        /* Preserve explicit self-close inside an unowned window's request hook. */
        if (!external && !w->children) { w->running = 0; return PU_CLOSE_ACCEPTED; }
        fprintf(stderr, "[window] Close coordination is already in progress\n");
        return PU_CLOSE_DECLINED;
    }
    w->borrows++;
    w->closing = 1;
    w->close_external = external;
    int result = PU_CLOSE_ACCEPTED;
    while (w->running) {
        PuWindow *child = live_child(w);
        if (!child) break;
        result = coordinate_close(child, 1);
        if (result != PU_CLOSE_ACCEPTED) break;
    }
    if (result == PU_CLOSE_ACCEPTED && w->running && w->children) result = PU_CLOSE_PENDING;
    if (result == PU_CLOSE_ACCEPTED && external && w->running &&
        !w->close_hook_done && !w->popup && w->close_request_fn) {
        w->request_active = 1;
        int accepted = w->close_request_fn(w, w->close_request_user) != 0;
        w->request_active = 0;
        w->close_hook_done = 1;
        if (!accepted && w->running) result = PU_CLOSE_DECLINED;
        else if (w->running && w->children) result = PU_CLOSE_PENDING;
    }
    if (!w->running) result = PU_CLOSE_ACCEPTED; /* Explicit quit/self-close inside a hook. */
    if (result == PU_CLOSE_PENDING) w->close_pending = 1;
    else {
        w->close_hook_done = 0;
        if (result == PU_CLOSE_ACCEPTED) w->running = 0;
        else {
            fprintf(stderr, "[window] Close declined; the window and waiting owners remain open\n");
            for (PuWindow *parent = w->parent; parent; parent = parent->parent) {
                parent->close_pending = 0;
                parent->close_hook_done = 0;
            }
        }
    }
    w->closing = 0;
    pu_window_wake(NULL);
    release_close_borrow(w);
    return result;
}

static void progress_pending_closes(void)
{
    for (;;) {
        PuWindow *w;
        for (w = g_windows; w; w = w->next) {
            if (!w->running || !w->close_pending || w->closing || w->borrows) continue;
            PuWindow *child = live_child(w);
            if (!w->children || (child && !child->close_pending)) break;
        }
        if (!w) return;
        int external = w->close_external;
        w->close_pending = 0;
        coordinate_close(w, external);
    }
}

static void notify_dependent_failure(PuWindow *w)
{
    for (PuWindow *parent = w->parent; parent; parent = parent->parent) {
        if (parent->close_pending)
            fprintf(stderr, "[window] Child Host failed; pending owner closure cancelled\n");
        parent->close_pending = 0;
        parent->close_hook_done = 0;
    }
}

#if defined(PU_CLOSE_EXTERNAL_ALL)
static int g_close_all_running;
static int coordinate_close_all(int external)
{
    if (g_close_all_running) {
        fprintf(stderr, "[window] Application close coordination is already in progress\n");
        return 0;
    }
    size_t count = 0;
    for (PuWindow *w = g_windows; w; w = w->next) if (!w->parent) count++;
    PuWindow **roots = count ? calloc(count, sizeof(*roots)) : NULL;
    if (count && !roots) { fprintf(stderr, "[window] Cannot allocate application close snapshot\n"); return 0; }
    size_t index = 0;
    for (PuWindow *w = g_windows; w; w = w->next)
        if (!w->parent) { w->borrows++; roots[index++] = w; }
    g_close_all_running = 1;
    int result = PU_CLOSE_ACCEPTED;
    for (index = 0; index < count; index++) {
        int closed = coordinate_close(roots[index], external);
        if (closed == PU_CLOSE_DECLINED) result = PU_CLOSE_DECLINED;
        else if (closed == PU_CLOSE_PENDING && result != PU_CLOSE_DECLINED) result = PU_CLOSE_PENDING;
    }
    for (index = 0; index < count; index++) release_close_borrow(roots[index]);
    free(roots);
    g_close_all_running = 0;
    return result;
}
#endif

int pu_window_close(PuWindow *w) { return coordinate_close(w, 0); }
int pu_window_request_close(PuWindow *w) { return coordinate_close(w, 1); }
int pu_window_close_all(void)
{
    for (PuWindow *w = g_windows; w; w = w->next) {
        w->running = 0; w->close_pending = 0; w->close_hook_done = 0;
    }
    pu_window_wake(NULL);
    return PU_CLOSE_ACCEPTED;
}

#endif
