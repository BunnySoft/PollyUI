#define _POSIX_C_SOURCE 200809L
#include "server.h"
#include "input-method.h"
#include "decorator-process.h"
#include "session-lock.h"
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include <wlr/util/log.h>

#define CHECK(value) do { if (!(value)) { \
    fprintf(stderr, "FAIL private process line %d: %s\n", __LINE__, #value); return false; \
} } while (0)

struct Child {
    pid_t pid;
    int control[2], connection;
    struct wl_client *client;
    struct wl_listener destroy;
    unsigned revoked;
    bool (*on_revoke)(void);
};
static struct PuDesktop desktop;
static struct Child shell = {.connection = -1}, ime = {.connection = -1};
static struct Child decorator = {.connection = -1}, locker = {.connection = -1};
static struct Child *starting;
static unsigned drained;
static bool hooks_passed = true, block_ime_term;
static const char *program;
static pid_t ordinary_pid;
static void close_child(struct Child *child);

static void revoked(struct wl_listener *listener, void *data)
{
    (void)data;
    struct Child *child = wl_container_of(listener, child, destroy);
    child->client = NULL;
    child->revoked++;
    wl_list_remove(&listener->link);
    wl_list_init(&listener->link);
    if (child->on_revoke) {
        bool (*hook)(void) = child->on_revoke;
        child->on_revoke = NULL;
        if (!hook()) hooks_passed = false;
    }
}
static void created(struct wl_listener *listener, void *data)
{
    (void)listener;
    if (!starting) return;
    starting->client = data;
}
static int child_main(int fd, bool block_term)
{
    if (block_term) {
        sigset_t mask;
        sigemptyset(&mask);
        sigaddset(&mask, SIGTERM);
        if (sigprocmask(SIG_BLOCK, &mask, NULL) < 0) return 119;
    }
    pid_t pid = getpid();
    struct iovec iov = {.iov_base = &pid, .iov_len = sizeof(pid)};
    union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
    struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1,
        .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET;
    header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int));
    int connection = 3;
    /* Keep the private socket open in the parent so HUP cannot replace SIGCHLD. */
    memcpy(CMSG_DATA(header), &connection, sizeof(connection));
    if (sendmsg(fd, &message, MSG_NOSIGNAL) != sizeof(pid)) return 120;
    unsigned char code;
    if (read(fd, &code, 1) != 1) return 121;
    return code;
}
static bool ready(struct Child *child)
{
    struct iovec iov = {.iov_base = &child->pid, .iov_len = sizeof(child->pid)};
    union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
    struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1,
        .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
    CHECK(recvmsg(child->control[0], &message, 0) == sizeof(child->pid));
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    CHECK(header && header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS &&
        header->cmsg_len == CMSG_LEN(sizeof(int)) && !(message.msg_flags & MSG_CTRUNC));
    memcpy(&child->connection, CMSG_DATA(header), sizeof(child->connection));
    child->destroy.notify = revoked;
    wl_client_add_destroy_listener(child->client, &child->destroy);
    return true;
}
static bool start(struct Child *child, const char *self, enum PuPrivateProcess owner)
{
    CHECK(socketpair(AF_UNIX, SOCK_SEQPACKET, 0, child->control) == 0);
    char fd[32];
    snprintf(fd, sizeof(fd), "%d", child->control[1]);
    char *args[] = {(char *)self,
        owner == PU_PRIVATE_INPUT_METHOD && block_ime_term ? "--child-block-term" : "--child", fd, NULL};
    starting = child;
    bool spawned = false;
    switch (owner) {
    case PU_PRIVATE_SHELL: spawned = pu_desktop_spawn_shell(&desktop, args); break;
    case PU_PRIVATE_DECORATOR: spawned = pu_decorator_spawn(&desktop, args); break;
    case PU_PRIVATE_INPUT_METHOD: spawned = pu_input_method_spawn(&desktop, args); break;
    case PU_PRIVATE_SESSION_LOCK: spawned = pu_session_lock_spawn(&desktop, args); break;
    case PU_PRIVATE_PROCESS_COUNT: break;
    }
    starting = NULL;
    CHECK(spawned && ready(child));
    CHECK(owner != PU_PRIVATE_INPUT_METHOD || pu_input_method_allowed(&desktop, child->client));
    CHECK(owner != PU_PRIVATE_SHELL || desktop.shell_pid == child->pid);
    return true;
}
static bool release(struct Child *child, unsigned char code)
{
    CHECK(write(child->control[0], &code, 1) == 1);
    siginfo_t info = {0};
    int result;
    do { result = waitid(P_PID, (id_t)child->pid, &info, WEXITED | WNOWAIT); }
    while (result < 0 && errno == EINTR);
    CHECK(result == 0 && info.si_pid == child->pid && info.si_code == CLD_EXITED && info.si_status == code);
    return true;
}
static bool live(struct Child *child)
{
    siginfo_t info = {0};
    CHECK(waitid(P_PID, (id_t)child->pid, &info, WEXITED | WNOWAIT | WNOHANG) == 0);
    CHECK(!info.si_pid && child->client);
    return true;
}
static int drain(int fd, uint32_t mask, void *data)
{
    (void)mask; (void)data;
    uint64_t value;
    if (read(fd, &value, sizeof(value)) != sizeof(value)) return -1;
    drained++;
    return 0;
}
static bool batch_suite(const char *self)
{
    CHECK(start(&shell, self, PU_PRIVATE_SHELL));
    CHECK(start(&ime, self, PU_PRIVATE_INPUT_METHOD));
    struct wl_event_loop *loop = wl_display_get_event_loop(desktop.display);
    /* Adversarial boundary of pinned Wayland 1.23.1's 32-event dispatch batch,
     * not a product limit. Queue these before SIGCHLD to split the old sources. */
    int fds[31];
    struct wl_event_source *sources[31];
    for (unsigned i = 0; i < 31; i++) {
        CHECK((fds[i] = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK)) >= 0);
        CHECK((sources[i] = wl_event_loop_add_fd(loop, fds[i], WL_EVENT_READABLE, drain, NULL)));
    }
    for (unsigned i = 0; i < 31; i++) {
        uint64_t value = 1;
        CHECK(write(fds[i], &value, sizeof(value)) == sizeof(value));
    }
    CHECK(release(&shell, 37));
    for (int i = 0; i < 3; i++) CHECK(wl_event_loop_dispatch(loop, 25) == 0);
    for (unsigned i = 0; i < 31; i++) {
        wl_event_source_remove(sources[i]);
        close(fds[i]);
    }
    fprintf(stderr, "batch: drained=%u shell_pid=%ld exited=%d revoked=%u live_ime=%ld revoked=%u\n",
        drained, (long)desktop.shell_pid, desktop.shell_exited, shell.revoked, (long)ime.pid, ime.revoked);
    CHECK(drained == 31);
    CHECK(!desktop.shell_pid && desktop.shell_exited && WIFEXITED(desktop.shell_status) &&
        WEXITSTATUS(desktop.shell_status) == 37 && shell.revoked == 1);
    CHECK(live(&ime) && !ime.revoked);
    int status;
    CHECK(waitpid(shell.pid, &status, WNOHANG) == -1 && errno == ECHILD);
    for (int i = 0; i < 3; i++) CHECK(wl_event_loop_dispatch(loop, 0) == 0);
    CHECK(shell.revoked == 1 && WEXITSTATUS(desktop.shell_status) == 37);
    puts("PASS: production Shell exit reaped once across ready batch; live input method untouched");
    return true;
}
static bool dispatch(void)
{
    CHECK(wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 0) == 0);
    CHECK(hooks_passed && !desktop.failed);
    return true;
}
static bool consumed(struct Child *child, unsigned count)
{
    int status;
    CHECK(!child->client && child->revoked == count);
    CHECK(waitpid(child->pid, &status, WNOHANG) == -1 && errno == ECHILD);
    return true;
}
static bool stop_decorator(void)
{
    pu_decorator_stop(&desktop);
    CHECK(!desktop.decorator);
    return true;
}
static bool simultaneous_suite(const char *self)
{
    CHECK(start(&shell, self, PU_PRIVATE_SHELL));
    struct wl_event_source *shared = desktop.private_process_exit;
    CHECK(start(&decorator, self, PU_PRIVATE_DECORATOR));
    CHECK(start(&ime, self, PU_PRIVATE_INPUT_METHOD));
    CHECK(start(&locker, self, PU_PRIVATE_SESSION_LOCK));
    CHECK(shared && desktop.private_process_exit == shared);
    for (unsigned i = 0; i < PU_PRIVATE_PROCESS_COUNT; i++) CHECK(desktop.private_processes[i].check);
    uint32_t epoch = pu_input_method_epoch(&desktop);
    int ordinary_pipe[2];
    CHECK(pipe(ordinary_pipe) == 0);
    ordinary_pid = fork();
    CHECK(ordinary_pid >= 0);
    if (!ordinary_pid) {
        unsigned char code;
        _exit(read(ordinary_pipe[0], &code, 1) == 1 ? code : 122);
    }
    unsigned char code = 71;
    CHECK(write(ordinary_pipe[1], &code, 1) == 1);
    siginfo_t info = {0};
    CHECK(waitid(P_PID, (id_t)ordinary_pid, &info, WEXITED | WNOWAIT) == 0 && info.si_status == 71);
    CHECK(release(&shell, 38) && release(&decorator, 39) && release(&ime, 40) && release(&locker, 0));
    CHECK(dispatch());
    CHECK(!desktop.shell_pid && desktop.shell_exited && WEXITSTATUS(desktop.shell_status) == 38);
    CHECK(!pu_decorator_pid(&desktop) && pu_decorator_status(&desktop, NULL) == 1);
    CHECK(!pu_session_lock_pid(&desktop) && pu_session_lock_client_succeeded(&desktop));
    CHECK(pu_session_lock_active(&desktop));
    CHECK(pu_input_method_epoch(&desktop) == epoch + 1);
    CHECK(consumed(&shell, 1) && consumed(&decorator, 1) && consumed(&ime, 1) && consumed(&locker, 1));
    int status;
    CHECK(waitpid(ordinary_pid, &status, 0) == ordinary_pid && WIFEXITED(status) && WEXITSTATUS(status) == 71);
    ordinary_pid = 0;
    close(ordinary_pipe[0]); close(ordinary_pipe[1]);
    CHECK(dispatch() && pu_input_method_epoch(&desktop) == epoch + 1);
    puts("PASS: one notification checks four exact PIDs once; lock stays private; ordinary child status remains owned");

    pid_t previous = decorator.pid;
    close(decorator.connection); decorator.connection = -1;
    starting = &decorator;
    for (int i = 0; i < 1000 && !pu_decorator_pid(&desktop); i++)
        CHECK(wl_event_loop_dispatch(wl_display_get_event_loop(desktop.display), 5) == 0);
    starting = NULL;
    CHECK(pu_decorator_pid(&desktop) && pu_decorator_pid(&desktop) != previous);
    CHECK(ready(&decorator) && live(&decorator));
    decorator.on_revoke = stop_decorator;
    CHECK(release(&decorator, 0) && dispatch() && consumed(&decorator, 2));
    CHECK(!desktop.decorator && dispatch());
    puts("PASS: existing decorator backoff restarts a new exact PID; unregister cancels the next restart");
    return true;
}
static int release_ime(int fd, uint32_t mask, void *data)
{
    (void)data;
    if (drain(fd, mask, NULL) < 0 || !release(&ime, 0)) hooks_passed = false;
    return 0;
}
static bool replace_during_exit(void)
{
    CHECK(desktop.private_process_dispatching);
    pu_desktop_stop_shell(&desktop);
    close_child(&shell);
    CHECK(start(&shell, program, PU_PRIVATE_SHELL));
    struct wl_event_loop *loop = wl_display_get_event_loop(desktop.display);
    int fd = eventfd(1, EFD_CLOEXEC | EFD_NONBLOCK);
    CHECK(fd >= 0);
    struct wl_event_source *source = wl_event_loop_add_fd(loop, fd, WL_EVENT_READABLE, release_ime, NULL);
    CHECK(source);
    CHECK(release(&shell, 43));
    pu_decorator_stop(&desktop);
    pu_input_method_stop(&desktop);
    wl_event_source_remove(source); close(fd);
    CHECK(desktop.private_process_pending && desktop.shell_pid == shell.pid);
    CHECK(!desktop.decorator && consumed(&ime, 1));
    return true;
}
static bool reentrant_suite(const char *self)
{
    program = self;
    block_ime_term = true;
    CHECK(start(&shell, self, PU_PRIVATE_SHELL));
    CHECK(start(&decorator, self, PU_PRIVATE_DECORATOR));
    CHECK(start(&ime, self, PU_PRIVATE_INPUT_METHOD));
    CHECK(start(&locker, self, PU_PRIVATE_SESSION_LOCK));
    shell.on_revoke = replace_during_exit;
    CHECK(release(&shell, 42) && release(&locker, 0));
    CHECK(dispatch());
    CHECK(!desktop.shell_pid && WEXITSTATUS(desktop.shell_status) == 43 && consumed(&shell, 2));
    CHECK(!pu_session_lock_pid(&desktop) && pu_session_lock_client_succeeded(&desktop) && consumed(&locker, 1));
    CHECK(pu_session_lock_active(&desktop) && decorator.revoked == 1);
    CHECK(dispatch() && shell.revoked == 2 && locker.revoked == 1);
    puts("PASS: real revoke hook replaces Shell, frees later decorator, nests IME stop/dispatch; new Shell and later lock are reaped without stale callbacks");
    return true;
}
static bool rollback_suite(const char *self)
{
    char *missing[] = {"/pollywm-test/no-private-process", NULL};
    CHECK(!pu_desktop_spawn_shell(&desktop, missing) && !desktop.private_process_exit);
    CHECK(!pu_decorator_spawn(&desktop, missing) && !desktop.decorator && !desktop.private_process_exit);
    CHECK(!pu_input_method_spawn(&desktop, missing) && !desktop.private_process_exit);
    CHECK(!pu_session_lock_spawn(&desktop, missing) && !desktop.private_process_exit);
    struct PuDesktop failed;
    CHECK(!pu_desktop_init(&failed, "private-process-test") && !failed.private_process_exit);
    pu_desktop_finish(&failed);
    CHECK(start(&ime, self, PU_PRIVATE_INPUT_METHOD));
    struct wl_event_source *shared = desktop.private_process_exit;
    CHECK(!pu_desktop_spawn_shell(&desktop, missing) && desktop.private_process_exit == shared);
    CHECK(!pu_decorator_spawn(&desktop, missing) && !desktop.decorator && desktop.private_process_exit == shared);
    CHECK(!pu_session_lock_spawn(&desktop, missing) && desktop.private_process_exit == shared);
    CHECK(live(&ime));
    CHECK(release(&ime, 0));
    pu_input_method_stop(&desktop);
    CHECK(!desktop.private_process_exit && consumed(&ime, 1));
    CHECK(dispatch());
    puts("PASS: four spawn failures roll back registration and the last shared source");
    return true;
}
static bool stop_all(void)
{
    pu_input_method_stop(&desktop);
    pu_input_method_stop(&desktop);
    pu_session_lock_finish(&desktop);
    pu_session_lock_finish(&desktop);
    pu_desktop_stop_shell(&desktop);
    pu_desktop_stop_shell(&desktop);
    pu_decorator_stop(&desktop);
    pu_decorator_stop(&desktop);
    CHECK(!desktop.private_process_exit);
    for (unsigned i = 0; i < PU_PRIVATE_PROCESS_COUNT; i++) CHECK(!desktop.private_processes[i].check);
    CHECK(dispatch() && dispatch());
    return true;
}
static void close_child(struct Child *child)
{
    if (child->connection >= 0) close(child->connection);
    if (child->control[0] > 0) close(child->control[0]);
    if (child->control[1] > 0) close(child->control[1]);
}
int main(int argc, char **argv)
{
    if (argc == 3 && (!strcmp(argv[1], "--child") || !strcmp(argv[1], "--child-block-term")))
        return child_main(atoi(argv[2]), !strcmp(argv[1], "--child-block-term"));
    if (argc != 1) return 2;
    char runtime[] = "/tmp/polly-private-process-XXXXXX";
    if (!mkdtemp(runtime) || setenv("XDG_RUNTIME_DIR", runtime, 1) < 0) {
        perror("private process runtime");
        return 1;
    }
    wlr_log_init(WLR_INFO, NULL);
    bool (*suites[])(const char *) = {batch_suite, simultaneous_suite, reentrant_suite, rollback_suite};
    for (unsigned i = 0; i < sizeof(suites) / sizeof(suites[0]); i++) {
        bool initialized = pu_desktop_init(&desktop, "private-process-test");
        struct wl_listener listener = {.notify = created};
        if (initialized) wl_display_add_client_created_listener(desktop.display, &listener);
        bool passed = initialized && suites[i](argv[0]) && stop_all();
        if (initialized) wl_list_remove(&listener.link);
        pu_desktop_finish(&desktop);
        if (ordinary_pid > 0) {
            int status;
            if (kill(ordinary_pid, SIGKILL) < 0 && errno != ESRCH) perror("kill ordinary fixture");
            while (waitpid(ordinary_pid, &status, 0) < 0 && errno == EINTR) {}
            ordinary_pid = 0;
        }
        close_child(&shell); close_child(&ime); close_child(&decorator); close_child(&locker);
        shell = ime = decorator = locker = (struct Child){.connection = -1};
        if (!passed) { rmdir(runtime); return 1; }
    }
    if (rmdir(runtime) < 0) { perror("remove private process runtime"); return 1; }
    puts("PASS: repeated stop and display finish leave no registered owners or stale source");
    return 0;
}
