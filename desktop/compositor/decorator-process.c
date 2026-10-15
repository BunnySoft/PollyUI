#include "decorator-process.h"
#include "decoration.h"
#include "private-process.h"
#include "server.h"
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <wlr/util/log.h>

struct PuDecoratorProcess {
    struct PuDesktop *desktop;
    struct wl_client *client;
    struct wl_listener destroy;
    struct wl_event_source *exit, *restart, *terminate, *startup;
    char **command;
    pid_t pid;
    unsigned attempts;
    uint32_t status;
    bool terminating, stopping;
    char message[192];
};

static void status(struct PuDecoratorProcess *service, uint32_t value, const char *message)
{
    service->status = value;
    snprintf(service->message, sizeof(service->message), "%s", message);
    pu_decorations_service_changed(service->desktop);
}
bool pu_decorator_allowed(const struct PuDesktop *desktop, const struct wl_client *client)
{ return desktop->decorator && desktop->decorator->client && desktop->decorator->client == client; }
bool pu_decorator_configured(const struct PuDesktop *desktop) { return desktop->decorator != NULL; }
pid_t pu_decorator_pid(const struct PuDesktop *desktop)
{ return desktop->decorator ? desktop->decorator->pid : 0; }
uint32_t pu_decorator_status(const struct PuDesktop *desktop, const char **message)
{
    if (message) *message = desktop->decorator ? desktop->decorator->message : "Decorator is not configured";
    return desktop->decorator ? desktop->decorator->status : 0;
}
void pu_decorator_ready(struct PuDesktop *desktop)
{
    if (desktop->decorator && !desktop->decorator->terminating) {
        wl_event_source_timer_update(desktop->decorator->startup, 0);
        status(desktop->decorator, 2, "");
    }
}
static int startup_timeout(void *data)
{
    struct PuDecoratorProcess *service = data;
    pu_decorator_fail(service->desktop, "Decorator did not initialize before its startup deadline");
    return 0;
}
static int force_exit(void *data)
{
    struct PuDecoratorProcess *service = data;
    if (service->pid && kill(service->pid, SIGKILL) < 0 && errno != ESRCH)
        wlr_log_errno(WLR_ERROR, "Cannot kill unresponsive decorator");
    return 0;
}
void pu_decorator_fail(struct PuDesktop *desktop, const char *message)
{
    struct PuDecoratorProcess *service = desktop->decorator;
    if (!service || desktop->stopping || service->stopping || service->terminating) return;
    status(service, 3, message);
    service->terminating = true;
    wl_event_source_timer_update(service->startup, 0);
    wlr_log(WLR_ERROR, "Decorator failed: %s", message);
    if (service->pid && kill(service->pid, SIGTERM) < 0 && errno != ESRCH)
        wlr_log_errno(WLR_ERROR, "Cannot terminate failed decorator");
    if (service->pid && wl_event_source_timer_update(service->terminate, 1000) < 0)
        force_exit(service);
}
static void disconnected(struct wl_listener *listener, void *data)
{
    (void)data;
    struct PuDecoratorProcess *service = wl_container_of(listener, service, destroy);
    service->client = NULL;
    wl_list_remove(&listener->link); wl_list_init(&listener->link);
    pu_decorator_fail(service->desktop, "Private decorator connection disconnected");
}
static bool spawn(struct PuDecoratorProcess *service)
{
    service->terminating = false;
    service->destroy.notify = disconnected;
    status(service, 1, "Decorator is starting");
    if (!pu_spawn_private(service->desktop, service->command, "decorator",
        &service->client, &service->pid, &service->destroy)) return false;
    if (wl_event_source_timer_update(service->startup, 5000) < 0)
        pu_decorator_fail(service->desktop, "Cannot monitor decorator initialization");
    return true;
}
static void schedule(struct PuDecoratorProcess *service)
{
    if (service->desktop->stopping || service->stopping) return;
    if (service->attempts >= 3) {
        status(service, 3, "Decorator restart budget exhausted");
        wlr_log(WLR_ERROR, "Decorator restart budget exhausted; applications remain running");
        return;
    }
    status(service, 1, "Decorator is recovering");
    if (wl_event_source_timer_update(service->restart, 100 << service->attempts) < 0)
        status(service, 3, "Cannot schedule decorator restart");
}
static bool reap(struct PuDecoratorProcess *service, int options)
{
    if (!service->pid) return true;
    int result_status;
    pid_t result;
    do { result = waitpid(service->pid, &result_status, options); } while (result < 0 && errno == EINTR);
    if (!result) return false;
    if (result < 0 && errno != ECHILD) {
        wlr_log_errno(WLR_ERROR, "Cannot reap decorator"); return false;
    }
    if (result > 0 && WIFEXITED(result_status))
        wlr_log(WEXITSTATUS(result_status) ? WLR_ERROR : WLR_INFO, "Decorator exited with status %d",
            WEXITSTATUS(result_status));
    service->pid = 0;
    service->terminating = true;
    wl_event_source_timer_update(service->terminate, 0);
    wl_event_source_timer_update(service->startup, 0);
    if (service->client) wl_client_destroy(service->client);
    schedule(service);
    return true;
}
static int exited(int signal_number, void *data)
{ (void)signal_number; reap(data, WNOHANG); return 0; }
static int restart(void *data)
{
    struct PuDecoratorProcess *service = data;
    if (service->desktop->stopping || service->pid || service->attempts >= 3) return 0;
    service->attempts++;
    if (!spawn(service)) schedule(service);
    return 0;
}
bool pu_decorator_spawn(struct PuDesktop *desktop, char *const argv[])
{
    if (!argv || !argv[0] || desktop->decorator || desktop->stopping) return false;
    struct PuDecoratorProcess *service = calloc(1, sizeof(*service));
    if (!service) return false;
    service->desktop = desktop;
    desktop->decorator = service;
    size_t count = 0;
    while (argv[count]) count++;
    service->command = calloc(count + 1, sizeof(*service->command));
    if (!service->command) return false;
    for (size_t i = 0; i < count; i++)
        if (!(service->command[i] = strdup(argv[i]))) return false;
    struct wl_event_loop *loop = wl_display_get_event_loop(desktop->display);
    service->exit = wl_event_loop_add_signal(loop, SIGCHLD, exited, service);
    service->restart = wl_event_loop_add_timer(loop, restart, service);
    service->terminate = wl_event_loop_add_timer(loop, force_exit, service);
    service->startup = wl_event_loop_add_timer(loop, startup_timeout, service);
    return service->exit && service->restart && service->terminate && service->startup && spawn(service);
}
void pu_decorator_stop(struct PuDesktop *desktop)
{
    struct PuDecoratorProcess *service = desktop->decorator;
    if (!service) return;
    service->stopping = true;
    if (service->restart) wl_event_source_remove(service->restart);
    service->restart = NULL;
    service->terminating = true;
    if (service->pid && !reap(service, WNOHANG)) {
        if (kill(service->pid, SIGTERM) < 0 && errno != ESRCH)
            wlr_log_errno(WLR_ERROR, "Cannot stop decorator");
        for (int i = 0; i < 100 && !reap(service, WNOHANG); i++) {
            struct timespec delay = {.tv_nsec = 10000000};
            nanosleep(&delay, NULL);
        }
        if (service->pid) { force_exit(service); reap(service, 0); }
    }
    if (service->client) wl_client_destroy(service->client);
    if (service->exit) wl_event_source_remove(service->exit);
    if (service->terminate) wl_event_source_remove(service->terminate);
    if (service->startup) wl_event_source_remove(service->startup);
    if (service->command) {
        for (size_t i = 0; service->command[i]; i++) free(service->command[i]);
        free(service->command);
    }
    free(service); desktop->decorator = NULL;
}
