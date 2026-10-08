#define _GNU_SOURCE
#include "greeter-client.h"
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

static bool receive(int fd, void *data, size_t length)
{
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = recv(fd, (char *)data + offset, length - offset, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return false;
        offset += (size_t)count;
    }
    return true;
}

int main(int argc, char **argv)
{
    bool setup_mode = argc == 2 && !strcmp(argv[1], "--setup");
    struct rlimit core = {0, 0};
    if ((argc != 1 && !setup_mode) || getuid() != 991 || geteuid() != getuid() || setrlimit(RLIMIT_CORE, &core) ||
        access("/run/.containerenv", F_OK) || access("/run/polly-graphical-auth-fixture", F_OK)) return 2;
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    strcpy(address.sun_path, "/run/polly-graphical-auth-fixture/tokens.sock");
    struct timeval timeout = {.tv_sec = 20};
    if (fd < 0 || setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) ||
        connect(fd, (struct sockaddr *)&address, sizeof(address))) return 2;
    struct ucred peer;
    socklen_t size = sizeof(peer);
    uint32_t lengths[2];
    char first[1025] = {0}, second[1025] = {0};
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) || peer.uid ||
        !receive(fd, lengths, sizeof(lengths)) || !lengths[0] || !lengths[1] ||
        lengths[0] > 1024 || lengths[1] > 1024 ||
        !receive(fd, first, lengths[0]) || !receive(fd, second, lengths[1])) return 2;
    close(fd);
    JSRuntime *runtime = JS_NewRuntime();
    JSContext *ctx = runtime ? JS_NewContext(runtime) : NULL;
    if (!ctx || !pu_greeter_client_install(ctx)) return 2;
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "fixturePassword", JS_NewStringLen(ctx, first, lengths[0]));
    JS_SetPropertyStr(ctx, global, "fixtureRootPassword", JS_NewStringLen(ctx, second, lengths[1]));
    JS_SetPropertyStr(ctx, global, "fixtureSetup", JS_NewBool(ctx, setup_mode));
    explicit_bzero(first, sizeof(first)); explicit_bzero(second, sizeof(second));
    const char script[] =
        "globalThis.fixtureDone = false; globalThis.fixtureFailed = false;"
        "(async () => {"
        " let refused = false;"
        " try { graphicalAuth.login(fixturePassword, 'root'); } catch (_) { refused = true; }"
        " if (!refused) throw Error('Native API accepted a username override');"
        " refused = false;"
        " try { graphicalAuth.status('/bin/true'); } catch (_) { refused = true; }"
        " if (!refused) throw Error('Native API accepted a command');"
        " if (fixtureSetup) {"
        "   if (await graphicalAuth.status() !== 'setup') throw Error('Initial state not setup');"
        "   graphicalAuth.onProgress = phase => { if (phase === 'prepared') graphicalAuth.cancel(); };"
        "   if (await graphicalAuth.setup(fixturePassword, fixtureRootPassword) !== 'cancelled')"
        "     throw Error('Native cancellation did not settle');"
        "   if (await graphicalAuth.status() !== 'setup') throw Error('Cancellation initialized state');"
        "   graphicalAuth.onProgress = null;"
        "   if (await graphicalAuth.setup(fixturePassword, fixtureRootPassword) !== 'login')"
        "     throw Error('Native commit did not settle');"
        "   if (await graphicalAuth.status() !== 'login') throw Error('Committed state not login');"
        "   fixturePassword = fixtureRootPassword = ''; fixtureDone = true; return;"
        " }"
        " let handoffs = 0;"
        " graphicalAuth.onProgress = phase => { if (phase === 'handoff') handoffs++; };"
        " let denied = false;"
        " try { await graphicalAuth.login('synthetic-wrong-' + fixturePassword); }"
        " catch (error) { denied = error.code === 'denied'; }"
        " if (!denied || handoffs) throw Error('Wrong password entered a native session');"
        " const result = await graphicalAuth.login(fixturePassword);"
        " fixturePassword = '';"
        " if (result !== 'handoff' || handoffs !== 1) throw Error('Native handoff was not acknowledged');"
        " fixtureDone = true;"
        "})().catch(() => { fixtureFailed = true; fixtureDone = true; });";
    JSValue evaluated = JS_Eval(ctx, script, sizeof(script) - 1, "<fixed-native-greeter-fixture>", JS_EVAL_TYPE_GLOBAL);
    bool failed = JS_IsException(evaluated), done = false;
    JS_FreeValue(ctx, evaluated);
    struct timespec started, now, delay = {.tv_nsec = 1000000};
    clock_gettime(CLOCK_MONOTONIC, &started);
    while (!failed && !done) {
        pu_greeter_client_pump();
        for (int i = 0; i < 64; i++) {
            JSContext *job;
            int result = JS_ExecutePendingJob(runtime, &job);
            if (result < 0) { failed = true; break; }
            if (!result) break;
        }
        JSValue value = JS_GetPropertyStr(ctx, global, "fixtureDone");
        done = JS_ToBool(ctx, value) == 1; JS_FreeValue(ctx, value);
        value = JS_GetPropertyStr(ctx, global, "fixtureFailed");
        failed = failed || JS_ToBool(ctx, value) != 0; JS_FreeValue(ctx, value);
        clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec - started.tv_sec > 60) { failed = true; break; }
        nanosleep(&delay, NULL);
    }
    pu_greeter_client_shutdown();
    JS_FreeValue(ctx, global); JS_FreeContext(ctx); JS_FreeRuntime(runtime);
    if (failed || !done) {
        fprintf(stderr, "NATIVE GREETER CLIENT FIXTURE FAILED (credential details withheld)\n"); return 1;
    }
    puts(setup_mode ? "POLLY_NATIVE_SETUP_CLIENT_PASS actual-client-uid=991 cancel-uninitialized=1 commit=1 seat-tested=0" :
        "POLLY_GREETD_NATIVE_CLIENT_PASS wrong-denied=1 fixed-api=1 actual-client-uid=991 handoff-ack=1 gui-tested=0");
    return 0;
}
