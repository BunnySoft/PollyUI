#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <grp.h>
#include <pwd.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define ACCOUNT_ROOT "/var/lib/polly-accounts"
#define PASSWORD_TOOL "/usr/bin/passwd.distrib"
#define ACCOUNT_TOOL "/usr/sbin/polly-accounts"

static void fail(const char *message) {
    fprintf(stderr, "polly-passwd: %s: %s\n", message, strerror(errno));
    exit(1);
}

static void trusted(const char *path, int directory) {
    struct stat st;
    if (lstat(path, &st) != 0)
        fail(path);
    if (st.st_uid != 0 || (st.st_mode & 0022) ||
        (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode))) {
        errno = EPERM;
        fail("unsafe account/tool path");
    }
}

static void bind_readonly(const char *source, const char *suffix, int recursive) {
    char target[256];
    int length = snprintf(target, sizeof(target), ACCOUNT_ROOT "/%s", suffix);
    if (length < 0 || (size_t)length >= sizeof(target)) {
        errno = EOVERFLOW;
        fail("mount path");
    }
    struct stat st;
    if (lstat(source, &st) != 0)
        fail(source);
    if (S_ISLNK(st.st_mode)) {
        char link[256];
        ssize_t size = readlink(source, link, sizeof(link) - 1);
        if (size < 0)
            fail(source);
        link[size] = '\0';
        if (symlink(link, target) != 0 && errno != EEXIST)
            fail(target);
        if (lstat(target, &st) != 0 || !S_ISLNK(st.st_mode))
            fail("invalid compatibility link");
        char existing[256];
        ssize_t count = readlink(target, existing, sizeof(existing) - 1);
        if (count < 0)
            fail(target);
        existing[count] = '\0';
        if (strcmp(link, existing) != 0) {
            errno = EPERM;
            fail("unexpected compatibility link");
        }
        return;
    }
    trusted(source, S_ISDIR(st.st_mode));
    if (S_ISDIR(st.st_mode)) {
        if (mkdir(target, 0755) != 0 && errno != EEXIST)
            fail(target);
    } else {
        int fd = open(target, O_WRONLY | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (fd < 0)
            fail(target);
        close(fd);
    }
    trusted(target, S_ISDIR(st.st_mode));
    if (mount(source, target, NULL, MS_BIND | (recursive ? MS_REC : 0), NULL) != 0 ||
        mount(NULL, target, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL) != 0)
        fail("private password-tool mount");
}

static void sync_file(const char *path, int directory) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (directory ? O_DIRECTORY : 0));
    if (fd < 0)
        fail(path);
    if (fsync(fd) != 0)
        fail("saving account state");
    close(fd);
}

static void check_storage(void) {
    struct stat st;
    if (lstat("/usr/lib/polly-storage/storage.py", &st) != 0) {
        if (errno != ENOENT)
            fail("checking storage policy");
        if (lstat("/etc/polly-storage.json", &st) != 0) {
            if (errno == ENOENT)
                return;
            fail("checking storage manifest");
        }
    }
    trusted("/usr", 1);
    trusted("/usr/sbin", 1);
    trusted(ACCOUNT_TOOL, 0);
    pid_t child = fork();
    if (child < 0)
        fail("starting account storage check");
    if (child == 0) {
        if (close_range(3, ~0U, 0) != 0)
            fail("isolating account storage check");
        execl(ACCOUNT_TOOL, ACCOUNT_TOOL, "check-storage", (char *)NULL);
        fail("starting account storage check");
    }
    int status;
    while (waitpid(child, &status, 0) < 0) {
        if (errno != EINTR)
            fail("waiting for account storage check");
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        errno = EPERM;
        fail("required account storage is not ready");
    }
}

int main(int argc, char **argv) {
    static const struct option options[] = {
        {"all", no_argument, NULL, 'a'}, {"delete", no_argument, NULL, 'd'},
        {"expire", no_argument, NULL, 'e'}, {"help", no_argument, NULL, 'h'},
        {"keep-tokens", no_argument, NULL, 'k'}, {"lock", no_argument, NULL, 'l'},
        {"unlock", no_argument, NULL, 'u'}, {"status", no_argument, NULL, 'S'},
        {"quiet", no_argument, NULL, 'q'}, {"mindays", required_argument, NULL, 'n'},
        {"maxdays", required_argument, NULL, 'x'}, {"warndays", required_argument, NULL, 'w'},
        {"inactive", required_argument, NULL, 'i'}, {NULL, 0, NULL, 0}
    };
    struct rlimit no_core = {0, 0};
    uid_t caller = getuid();
    if (geteuid() != 0) {
        errno = EPERM;
        fail("the installed setuid password entry is required");
    }
    if (setrlimit(RLIMIT_CORE, &no_core) != 0 || prctl(PR_SET_DUMPABLE, 0) != 0 ||
        clearenv() != 0 || setenv("PATH", "/usr/sbin:/usr/bin:/sbin:/bin", 1) != 0 ||
        setenv("LANG", "C.UTF-8", 1) != 0 || chdir("/") != 0)
        fail("isolating password entry");
    umask(077);
    trusted(PASSWORD_TOOL, 0);
    int option, all = 0, help = 0, aging = 0;
    opterr = 0;
    while ((option = getopt_long(argc, argv, "adelukhSqn:x:w:i:", options, NULL)) != -1) {
        if (option == '?') {
            fprintf(stderr, "polly-passwd: unsupported option; namespace overrides, stdin and password aging are not supported.\n");
            return 2;
        }
        all |= option == 'a';
        help |= option == 'h';
        aging |= strchr("eknxwi", option) != NULL;
    }
    if (argc - optind > 1) {
        fprintf(stderr, "polly-passwd: expected at most one account name.\n");
        return 2;
    }
    struct passwd *user = getpwuid(caller);
    if (user == NULL) {
        errno = EINVAL;
        fail("unknown caller");
    }
    const char *target = optind < argc ? argv[optind] : user->pw_name;
    int managed = strcmp(target, "root") == 0 || strcmp(target, "polly") == 0;
    if (managed && aging && !help) {
        fprintf(stderr, "polly-passwd: managed-account password aging/expiry is not implemented.\n");
        return 2;
    }
    if (caller != 0 && strcmp(target, user->pw_name) != 0) {
        fprintf(stderr, "polly-passwd: only root may change another account.\n");
        return 1;
    }
    if (!managed || all || help) {
        execv(PASSWORD_TOOL, argv);
        fail("starting distribution passwd");
    }
    check_storage();
    trusted("/var", 1);
    trusted("/var/lib", 1);
    trusted(ACCOUNT_ROOT, 1);
    trusted(ACCOUNT_ROOT "/etc", 1);
    trusted(ACCOUNT_ROOT "/etc/passwd", 0);
    trusted(ACCOUNT_ROOT "/etc/shadow", 0);
    struct group *shadow = getgrnam("shadow");
    struct stat st;
    if (shadow == NULL || stat(ACCOUNT_ROOT "/etc/shadow", &st) != 0 ||
        st.st_gid != shadow->gr_gid || (st.st_mode & 0007)) {
        errno = EPERM;
        fail("unsafe persistent shadow database");
    }
    if (caller != 0)
        trusted(ACCOUNT_ROOT "/setup-complete", 0);
    pid_t child = fork();
    if (child < 0)
        fail("starting password transaction");
    if (child == 0) {
        if (close_range(3, ~0U, 0) != 0 || unshare(CLONE_NEWNS) != 0 ||
            mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0)
            fail("isolating password namespace");
        bind_readonly("/usr", "usr", 0);
        bind_readonly("/lib", "lib", 0);
        bind_readonly("/lib64", "lib64", 0);
        bind_readonly("/bin", "bin", 0);
        bind_readonly("/sbin", "sbin", 0);
        bind_readonly("/dev", "dev", 1);
        bind_readonly("/etc/pam.d", "etc/pam.d", 0);
        bind_readonly("/etc/login.defs", "etc/login.defs", 0);
        if (chroot(ACCOUNT_ROOT) != 0 || chdir("/") != 0)
            fail("entering persistent password database");
        execv(PASSWORD_TOOL, argv);
        fail("starting distribution passwd");
    }
    int status;
    while (waitpid(child, &status, 0) < 0) {
        if (errno != EINTR)
            fail("waiting for password transaction");
    }
    if (!WIFEXITED(status))
        return 1;
    if (WEXITSTATUS(status) != 0)
        return WEXITSTATUS(status);
    sync_file(ACCOUNT_ROOT "/etc/shadow", 0);
    sync_file(ACCOUNT_ROOT "/etc", 1);
    return 0;
}
