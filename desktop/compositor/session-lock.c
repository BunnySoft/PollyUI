#include "session-lock.h"
#include "server.h"
#include "private-process.h"
#include "output-control.h"
#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <wlr/types/wlr_cursor.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_session_lock_v1.h>
#include <wlr/util/log.h>

struct LockOutput {
    struct PuSessionLock *lock;
    struct wlr_output *output;
    struct wlr_scene_rect *black;
    struct wl_list link;
    struct wl_listener destroy, present;
    bool presented, pending;
    uint32_t sequence;
};
struct LockSurface {
    struct PuSessionLock *lock;
    struct wlr_session_lock_surface_v1 *surface;
    struct wlr_scene_tree *tree;
    struct wl_list link;
    struct wl_listener map, unmap, destroy, tree_destroy;
    struct LockOutput *output;
    int width, height;
};
struct PuSessionLock {
    struct PuDesktop *desktop;
    struct wlr_session_lock_manager_v1 *manager;
    struct wlr_session_lock_v1 *session;
    struct wlr_scene_tree *tree;
    struct wl_client *client;
    pid_t pid;
    struct wl_event_source *exit;
    struct wl_list outputs, surfaces;
    struct wl_listener new_lock, new_surface, unlock, destroy, client_destroy;
    bool active, acknowledged, unlocking, client_succeeded;
};
static void unlisten(struct wl_listener *listener)
{
    if (!listener->link.next) return;
    wl_list_remove(&listener->link); wl_list_init(&listener->link);
}
static void listen(struct wl_signal *signal, struct wl_listener *listener, wl_notify_func_t notify)
{ listener->notify = notify; wl_signal_add(signal, listener); }
bool pu_session_lock_active(struct PuDesktop *desktop)
{ return desktop->session_lock && desktop->session_lock->active; }
pid_t pu_session_lock_pid(struct PuDesktop *desktop)
{ return desktop->session_lock ? desktop->session_lock->pid : 0; }
bool pu_session_lock_client_succeeded(struct PuDesktop *desktop)
{ return desktop->session_lock && desktop->session_lock->client_succeeded; }
bool pu_session_lock_allowed(const struct PuDesktop *desktop, const struct wl_client *client)
{ return desktop->session_lock && desktop->session_lock->client == client; }
static void acknowledge(struct PuSessionLock *lock)
{
    if (!lock->active || !lock->session || lock->acknowledged) return;
    struct LockOutput *output;
    wl_list_for_each(output, &lock->outputs, link)
        if (output->output->enabled && !output->presented) return;
    lock->acknowledged = true;
    wlr_session_lock_v1_send_locked(lock->session);
}
void pu_session_lock_prepare_frame(struct PuDesktop *desktop, struct wlr_output *output)
{
    struct PuSessionLock *lock = desktop->session_lock;
    if (!lock || !lock->active) return;
    struct LockOutput *entry;
    wl_list_for_each(entry, &lock->outputs, link) if (entry->output == output) {
        entry->sequence = output->commit_seq + 1;
        entry->pending = true;
    }
}
static void frame_presented(struct wl_listener *listener, void *data)
{
    struct LockOutput *output = wl_container_of(listener, output, present);
    struct wlr_output_event_present *event = data;
    if (!output->lock->active || !output->pending || !event->presented || event->commit_seq != output->sequence) return;
    output->pending = false; output->presented = true;
    acknowledge(output->lock);
}
static struct LockOutput *find_output(struct PuSessionLock *lock, struct wlr_output *output)
{
    struct LockOutput *entry;
    wl_list_for_each(entry, &lock->outputs, link) if (entry->output == output) return entry;
    return NULL;
}
bool pu_session_lock_surface(struct PuDesktop *desktop, struct wlr_surface *surface)
{
    struct PuSessionLock *lock = desktop->session_lock;
    if (!lock || !lock->active) return false;
    struct LockSurface *entry;
    wl_list_for_each(entry, &lock->surfaces, link)
        if (entry->output && entry->surface->surface == surface) return true;
    return false;
}
void pu_session_lock_focus(struct PuDesktop *desktop)
{
    struct PuSessionLock *lock = desktop->session_lock;
    if (!lock || !lock->active) return;
    struct wlr_surface *surface = NULL;
    struct LockSurface *entry;
    wl_list_for_each(entry, &lock->surfaces, link) {
        if (!entry->output || !entry->output->output->enabled || !entry->surface->surface->mapped) continue;
        if (desktop->seat->keyboard_state.focused_surface == entry->surface->surface) return;
        if (!surface) surface = entry->surface->surface;
    }
    struct wlr_keyboard *keyboard = wlr_seat_get_keyboard(desktop->seat);
    if (surface && keyboard) wlr_seat_keyboard_notify_enter(desktop->seat, surface, NULL, 0, &keyboard->modifiers);
    else wlr_seat_keyboard_notify_clear_focus(desktop->seat);
}
void pu_session_lock_motion(struct PuDesktop *desktop, uint32_t time)
{
    struct PuSessionLock *lock = desktop->session_lock;
    if (!lock || !lock->active) return;
    double sx, sy;
    struct wlr_scene_node *node = wlr_scene_node_at(&lock->tree->node, desktop->cursor->x, desktop->cursor->y, &sx, &sy);
    struct wlr_scene_surface *scene = node && node->type == WLR_SCENE_NODE_BUFFER ?
        wlr_scene_surface_try_from_buffer(wlr_scene_buffer_from_node(node)) : NULL;
    if (scene && pu_session_lock_surface(desktop, scene->surface)) {
        wlr_seat_pointer_notify_enter(desktop->seat, scene->surface, sx, sy);
        wlr_seat_pointer_notify_motion(desktop->seat, time, sx, sy);
        struct wlr_keyboard *keyboard = wlr_seat_get_keyboard(desktop->seat);
        if (keyboard && desktop->seat->keyboard_state.focused_surface != scene->surface)
            wlr_seat_keyboard_notify_enter(desktop->seat, scene->surface, NULL, 0, &keyboard->modifiers);
    } else wlr_seat_pointer_notify_clear_focus(desktop->seat);
}
void pu_session_lock_arrange(struct PuDesktop *desktop)
{
    struct PuSessionLock *lock = desktop->session_lock;
    if (!lock) return;
    struct LockOutput *output;
    wl_list_for_each(output, &lock->outputs, link) {
        struct wlr_box box;
        wlr_output_layout_get_box(desktop->layout, output->output, &box);
        wlr_scene_rect_set_size(output->black, box.width, box.height);
        wlr_scene_node_set_position(&output->black->node, box.x, box.y);
        wlr_scene_node_set_enabled(&output->black->node, output->output->enabled);
        struct LockSurface *surface;
        wl_list_for_each(surface, &lock->surfaces, link) {
            if (surface->output != output) continue;
            if (!surface->tree) continue;
            wlr_scene_node_set_position(&surface->tree->node, box.x, box.y);
            wlr_scene_node_set_enabled(&surface->tree->node, output->output->enabled);
            if (box.width > 0 && box.height > 0 &&
                (surface->width != box.width || surface->height != box.height)) {
                surface->width = box.width; surface->height = box.height;
                wlr_session_lock_surface_v1_configure(surface->surface, (uint32_t)box.width, (uint32_t)box.height);
            }
        }
    }
    if (lock->active) {
        wlr_scene_node_raise_to_top(&lock->tree->node);
        pu_session_lock_focus(desktop);
        acknowledge(lock);
    }
}
static void output_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct LockOutput *output = wl_container_of(listener, output, destroy);
    struct LockSurface *surface;
    wl_list_for_each(surface, &output->lock->surfaces, link) {
        if (surface->output != output) continue;
        surface->output = NULL;
        if (surface->tree) wlr_scene_node_set_enabled(&surface->tree->node, false);
    }
    struct PuSessionLock *lock = output->lock;
    unlisten(&output->destroy); unlisten(&output->present); wl_list_remove(&output->link);
    wlr_scene_node_destroy(&output->black->node); free(output);
    if (!lock->desktop->stopping) { acknowledge(lock); pu_session_lock_focus(lock->desktop); }
}
bool pu_session_lock_output(struct PuDesktop *desktop, struct wlr_output *output)
{
    struct PuSessionLock *lock = desktop->session_lock;
    struct LockOutput *entry = calloc(1, sizeof(*entry));
    if (!entry) return false;
    entry->black = wlr_scene_rect_create(lock->tree, 1, 1, (float[4]){0, 0, 0, 1});
    if (!entry->black) { free(entry); return false; }
    entry->lock = lock; entry->output = output;
    wl_list_insert(&lock->outputs, &entry->link);
    listen(&output->events.destroy, &entry->destroy, output_destroyed);
    listen(&output->events.present, &entry->present, frame_presented);
    wlr_scene_node_lower_to_bottom(&entry->black->node);
    pu_session_lock_arrange(desktop);
    return true;
}
static void surface_mapped(struct wl_listener *listener, void *data)
{
    (void)data;
    struct LockSurface *surface = wl_container_of(listener, surface, map);
    pu_session_lock_focus(surface->lock->desktop);
}
static void surface_unmapped(struct wl_listener *listener, void *data)
{
    (void)data;
    struct LockSurface *surface = wl_container_of(listener, surface, unmap);
    pu_session_lock_focus(surface->lock->desktop);
}
static void surface_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct LockSurface *surface = wl_container_of(listener, surface, destroy);
    struct PuSessionLock *lock = surface->lock;
    unlisten(&surface->map); unlisten(&surface->unmap); unlisten(&surface->destroy);
    wl_list_remove(&surface->link);
    if (surface->tree) wlr_scene_node_destroy(&surface->tree->node);
    unlisten(&surface->tree_destroy);
    free(surface);
    if (!lock->desktop->stopping) pu_session_lock_focus(lock->desktop);
}
static void surface_tree_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct LockSurface *surface = wl_container_of(listener, surface, tree_destroy);
    surface->tree = NULL;
    unlisten(listener);
}
static void new_surface(struct wl_listener *listener, void *data)
{
    struct PuSessionLock *lock = wl_container_of(listener, lock, new_surface);
    struct wlr_session_lock_surface_v1 *surface = data;
    struct LockOutput *output = find_output(lock, surface->output);
    if (!output) {
        wl_resource_post_error(surface->resource, 0, "Lock surface output is unavailable"); return;
    }
    struct LockSurface *entry = calloc(1, sizeof(*entry));
    if (!entry) { wl_resource_post_no_memory(surface->resource); return; }
    entry->tree = wlr_scene_subsurface_tree_create(lock->tree, surface->surface);
    if (!entry->tree) { free(entry); wl_resource_post_no_memory(surface->resource); return; }
    entry->lock = lock; entry->surface = surface; entry->output = output;
    wl_list_insert(&lock->surfaces, &entry->link);
    listen(&surface->surface->events.map, &entry->map, surface_mapped);
    listen(&surface->surface->events.unmap, &entry->unmap, surface_unmapped);
    listen(&surface->events.destroy, &entry->destroy, surface_destroyed);
    listen(&entry->tree->node.events.destroy, &entry->tree_destroy, surface_tree_destroyed);
    pu_session_lock_arrange(lock->desktop);
}
static void unlocked(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuSessionLock *lock = wl_container_of(listener, lock, unlock);
    if (!lock->acknowledged || wl_resource_get_client(lock->session->resource) != lock->client) return;
    lock->unlocking = true; lock->active = false;
    wlr_scene_node_set_enabled(&lock->tree->node, false);
    pu_desktop_isolate_input(lock->desktop);
    pu_desktop_restore_input(lock->desktop);
}
static void destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuSessionLock *lock = wl_container_of(listener, lock, destroy);
    unlisten(&lock->new_surface); unlisten(&lock->unlock); unlisten(&lock->destroy);
    lock->session = NULL;
    if (lock->active && !lock->desktop->stopping)
        wlr_log(WLR_ERROR, "Lock client was lost; desktop remains hidden and input blocked");
    pu_session_lock_focus(lock->desktop);
}
static void new_lock(struct wl_listener *listener, void *data)
{
    struct PuSessionLock *lock = wl_container_of(listener, lock, new_lock);
    struct wlr_session_lock_v1 *session = data;
    if (!lock->active || lock->session || wl_resource_get_client(session->resource) != lock->client) {
        wlr_session_lock_v1_destroy(session); return;
    }
    lock->session = session; lock->acknowledged = false; lock->unlocking = false;
    listen(&session->events.new_surface, &lock->new_surface, new_surface);
    listen(&session->events.unlock, &lock->unlock, unlocked);
    listen(&session->events.destroy, &lock->destroy, destroyed);
    acknowledge(lock);
}
static void client_destroyed(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuSessionLock *lock = wl_container_of(listener, lock, client_destroy);
    lock->client = NULL; unlisten(listener);
}
static bool reap(struct PuSessionLock *lock, int options)
{
    if (!lock->pid) return true;
    int status;
    pid_t pid;
    do { pid = waitpid(lock->pid, &status, options); } while (pid < 0 && errno == EINTR);
    if (!pid) return false;
    if (pid < 0 && errno != ECHILD) { wlr_log_errno(WLR_ERROR, "Cannot reap lock process"); return false; }
    if (pid < 0) wlr_log_errno(WLR_ERROR, "Lock process no longer exists");
    lock->client_succeeded = pid > 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0;
    lock->pid = 0;
    if (lock->client) wl_client_destroy(lock->client);
    return true;
}
static int exited(int signal, void *data) { (void)signal; reap(data, WNOHANG); return 0; }
bool pu_session_lock_spawn(struct PuDesktop *desktop, char *const argv[])
{
    struct PuSessionLock *lock = desktop->session_lock;
    if (!lock || desktop->stopping || lock->client || lock->pid || lock->session) return false;
    if (!lock->exit) lock->exit = wl_event_loop_add_signal(wl_display_get_event_loop(desktop->display), SIGCHLD, exited, lock);
    if (!lock->exit) { wlr_log_errno(WLR_ERROR, "Cannot watch lock process"); return false; }
    pu_output_control_locking(desktop);
    lock->client_destroy.notify = client_destroyed;
    if (!pu_spawn_private(desktop, argv, "session lock", &lock->client, &lock->pid, &lock->client_destroy)) return false;
    bool recovering = lock->active;
    lock->client_succeeded = false;
    lock->active = true; lock->acknowledged = false; lock->unlocking = false;
    struct LockOutput *output;
    wl_list_for_each(output, &lock->outputs, link) if (!recovering) {
        output->presented = output->pending = false;
        wlr_output_schedule_frame(output->output);
    }
    pu_desktop_isolate_input(desktop);
    wlr_scene_node_set_enabled(&lock->tree->node, true);
    pu_session_lock_arrange(desktop);
    return true;
}
bool pu_session_lock_init(struct PuDesktop *desktop)
{
    struct PuSessionLock *lock = calloc(1, sizeof(*lock));
    if (!lock) return false;
    desktop->session_lock = lock; lock->desktop = desktop;
    wl_list_init(&lock->outputs); wl_list_init(&lock->surfaces);
    lock->tree = wlr_scene_tree_create(&desktop->scene->tree);
    lock->manager = wlr_session_lock_manager_v1_create(desktop->display);
    if (!lock->tree || !lock->manager) return false;
    wlr_scene_node_set_enabled(&lock->tree->node, false);
    listen(&lock->manager->events.new_lock, &lock->new_lock, new_lock);
    return true;
}
void pu_session_lock_finish(struct PuDesktop *desktop)
{
    struct PuSessionLock *lock = desktop->session_lock;
    if (!lock) return;
    if (lock->client) wl_client_destroy(lock->client);
    if (!reap(lock, WNOHANG)) {
        if (kill(lock->pid, SIGTERM) < 0 && errno != ESRCH) wlr_log_errno(WLR_ERROR, "Cannot stop lock process");
        for (int i = 0; i < 100 && !reap(lock, WNOHANG); i++) {
            struct timespec delay = {.tv_nsec = 10000000}; nanosleep(&delay, NULL);
        }
        if (lock->pid) {
            if (kill(lock->pid, SIGKILL) < 0 && errno != ESRCH) wlr_log_errno(WLR_ERROR, "Cannot kill lock process");
            else reap(lock, 0);
        }
    }
    if (lock->exit) wl_event_source_remove(lock->exit);
    if (lock->session) wlr_session_lock_v1_destroy(lock->session);
    struct LockSurface *surface, *next_surface;
    wl_list_for_each_safe(surface, next_surface, &lock->surfaces, link) surface_destroyed(&surface->destroy, NULL);
    struct LockOutput *output, *next;
    wl_list_for_each_safe(output, next, &lock->outputs, link) output_destroyed(&output->destroy, NULL);
    unlisten(&lock->new_lock);
    if (lock->tree) wlr_scene_node_destroy(&lock->tree->node);
    free(lock); desktop->session_lock = NULL;
}
