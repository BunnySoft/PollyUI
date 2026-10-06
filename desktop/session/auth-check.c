#define _GNU_SOURCE
#include "auth-protocol.h"
#include <security/pam_appl.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pwd.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static long long now_ms(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int receive(void *buffer, size_t length)
{
    long long deadline = now_ms() + 5000;
    size_t offset = 0;
    while (offset < length) {
        long long remaining = deadline - now_ms();
        if (remaining <= 0) return 0;
        struct pollfd descriptor = {.fd = 3, .events = POLLIN};
        int ready = poll(&descriptor, 1, (int)remaining);
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0) return 0;
        ssize_t count = recv(3, (char *)buffer + offset, length - offset, 0);
        if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        if (count <= 0) return 0;
        offset += (size_t)count;
    }
    return 1;
}

struct Credentials { const char *password; int supplied; };

static int converse(int count, const struct pam_message **messages, struct pam_response **response, void *data)
{
    struct Credentials *credentials = data;
    if (count < 1 || count > 8) return PAM_CONV_ERR;
    struct pam_response *answers = calloc((size_t)count, sizeof(*answers));
    if (!answers) return PAM_BUF_ERR;
    for (int i = 0; i < count; i++) {
        if (messages[i]->msg_style == PAM_PROMPT_ECHO_OFF && !credentials->supplied) {
            answers[i].resp = strdup(credentials->password);
            credentials->supplied = 1;
        }
        else if (messages[i]->msg_style != PAM_ERROR_MSG && messages[i]->msg_style != PAM_TEXT_INFO) {
            for (int j = 0; j < i; j++) {
                if (answers[j].resp) explicit_bzero(answers[j].resp, strlen(answers[j].resp));
                free(answers[j].resp);
            }
            free(answers); return PAM_CONV_ERR;
        }
        if (messages[i]->msg_style == PAM_PROMPT_ECHO_OFF && !answers[i].resp) {
            for (int j = 0; j < i; j++) {
                if (answers[j].resp) explicit_bzero(answers[j].resp, strlen(answers[j].resp));
                free(answers[j].resp);
            }
            free(answers); return PAM_BUF_ERR;
        }
    }
    *response = answers;
    return PAM_SUCCESS;
}

static int isolate(void)
{
    struct rlimit no_core = {0, 0};
    if (setrlimit(RLIMIT_CORE, &no_core) || prctl(PR_SET_DUMPABLE, 0)) return 0;
    pid_t parent = getppid();
    if (prctl(PR_SET_PDEATHSIG, SIGTERM) || getppid() != parent) return 0;
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) return 0;
    for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
        char *end;
        long fd = strtol(entry->d_name, &end, 10);
        if (!*end && fd > 3 && fd != dirfd(directory)) close((int)fd);
    }
    closedir(directory);
    int null = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (null < 0) return 0;
    for (int i = 0; i < 3; i++) if (dup2(null, i) < 0) { close(null); return 0; }
    if (null > 3) close(null);
    return fcntl(3, F_SETFD, FD_CLOEXEC) == 0;
}

int main(int argc, char **argv)
{
    (void)argv;
    if (argc != 1 || getuid() == 0 || geteuid() != getuid()) return 2;
    struct ucred peer;
    socklen_t size = sizeof(peer);
    int type;
    socklen_t type_size = sizeof(type);
    if (getsockopt(3, SOL_SOCKET, SO_PEERCRED, &peer, &size) || peer.uid != getuid() ||
        getsockopt(3, SOL_SOCKET, SO_TYPE, &type, &type_size) || type != SOCK_STREAM || !isolate()) return 2;
    struct sigaction timeout = {.sa_handler = SIG_DFL};
    sigemptyset(&timeout.sa_mask);
    if (sigaction(SIGALRM, &timeout, NULL)) return 2;
    sigset_t signals;
    sigemptyset(&signals);
    sigaddset(&signals, SIGALRM);
    if (sigprocmask(SIG_UNBLOCK, &signals, NULL)) return 2;
    alarm(30);
    if (clearenv() || setenv("PATH", "/usr/sbin:/usr/bin:/sbin:/bin", 1)) return 2;
    struct PuAuthRequest request;
    if (!receive(&request, sizeof(request)) || request.magic != PU_AUTH_MAGIC || !request.serial ||
        !request.length || request.length > PU_AUTH_PASSWORD_LIMIT) return 2;
    char *password = calloc((size_t)request.length + 1, 1);
    if (!password) return 2;
    if (!receive(password, request.length) || memchr(password, 0, request.length)) {
        explicit_bzero(password, request.length); free(password); return 2;
    }
    struct PuAuthReply reply = {PU_AUTH_MAGIC, request.serial, PU_AUTH_UNAVAILABLE, PAM_SERVICE_ERR};
    struct stat policy;
    struct passwd *user = getpwuid(getuid());
    if (user && lstat("/etc/pam.d/polly-lock", &policy) == 0 && S_ISREG(policy.st_mode) &&
        policy.st_uid == 0 && !(policy.st_mode & 022)) {
        struct Credentials credentials = {password, 0};
        struct pam_conv conversation = {converse, &credentials};
        pam_handle_t *handle = NULL;
        int status = pam_start("polly-lock", user->pw_name, &conversation, &handle);
        reply.pam_status = (uint32_t)status;
        if (status == PAM_SUCCESS) {
            status = pam_authenticate(handle, PAM_DISALLOW_NULL_AUTHTOK);
            if (status == PAM_SUCCESS) status = pam_acct_mgmt(handle, 0);
            reply.pam_status = (uint32_t)status;
            reply.result = status == PAM_SUCCESS ? PU_AUTH_ACCEPTED :
                status == PAM_AUTH_ERR || status == PAM_USER_UNKNOWN || status == PAM_MAXTRIES ?
                PU_AUTH_DENIED : PU_AUTH_UNAVAILABLE;
            pam_end(handle, status);
        }
    }
    explicit_bzero(password, request.length); free(password);
    size_t offset = 0;
    while (offset < sizeof(reply)) {
        ssize_t count = send(3, (char *)&reply + offset, sizeof(reply) - offset, MSG_NOSIGNAL);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 2;
        offset += (size_t)count;
    }
    close(3);
    alarm(0);
    return 0;
}
