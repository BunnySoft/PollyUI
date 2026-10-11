#include "drag-wire.h"
#include "pollyui/context.h"
#include "quickjs.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

typedef struct Test
{
    int fd, failed, collect;
    JSContext *ctx;
    JSValue object;
    const char *mode;
} Test;
static Test test;
static JSValue receipt(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc != 1)
        return JS_ThrowTypeError(ctx, "test.report requires receipt");
    struct DragReceipt report = { 0 };
    const char *fields[] = { "down", "up", "copied", "cancelled", "error", "received", "clipboard", "heartbeat",
        "invalid", "held", "pending", "bytes", "closed" };
    int *values[] = { &report.down, &report.up, &report.copied, &report.cancelled, &report.error, &report.received,
        &report.clipboard, &report.heartbeat, &report.invalid, &report.held, &report.pending, &report.bytes,
        &report.closed };
    for (size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); i++)
    {
        JSValue value = JS_GetPropertyStr(ctx, argv[0], fields[i]);
        int32_t number;
        int ok = JS_ToInt32(ctx, &number, value) == 0;
        JS_FreeValue(ctx, value);
        if (!ok)
            return JS_EXCEPTION;
        *values[i] = number;
    }
    if (send(test.fd, &report, sizeof(report), MSG_NOSIGNAL) != sizeof(report))
        return JS_ThrowInternalError(ctx, "Native fixture receipt failed");
    return JS_UNDEFINED;
}
static JSValue gc(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)ctx;
    (void)self;
    (void)argc;
    (void)argv;
    test.collect = 1;
    return JS_UNDEFINED;
}
static JSValue bytes(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    uint32_t size;
    if (argc != 1 || JS_ToUint32(ctx, &size, argv[0]))
        return JS_EXCEPTION;
    unsigned char *data = malloc(size ? size : 1);
    if (!data)
        return JS_ThrowOutOfMemory(ctx);
    for (uint32_t i = 0; i < size; i++)
        data[i] = i >= 2 ? (unsigned char)((i - 2) % 251) : 0;
    JSValue result = JS_NewArrayBufferCopy(ctx, data, size);
    free(data);
    return result;
}
static int install(JSContext *ctx, PuDispatch *dispatch, int headless, void *data)
{
    (void)dispatch;
    (void)headless;
    (void)data;
    test.ctx = ctx;
    test.object = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, test.object, "report", JS_NewCFunction(ctx, receipt, "report", 1));
    JS_SetPropertyStr(ctx, test.object, "gc", JS_NewCFunction(ctx, gc, "gc", 0));
    JS_SetPropertyStr(ctx, test.object, "bytes", JS_NewCFunction(ctx, bytes, "bytes", 1));
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "test", JS_DupValue(ctx, test.object));
    JSValue app = JS_NewObject(ctx), args = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, args, 0, JS_NewString(ctx, test.mode));
    JS_SetPropertyStr(ctx, app, "arguments", args);
    JS_SetPropertyStr(ctx, global, "application", app);
    JS_FreeValue(ctx, global);
    return !JS_HasException(ctx);
}
static int pump(void *data)
{
    (void)data;
    if (test.collect)
    {
        test.collect = 0;
        JS_RunGC(JS_GetRuntime(test.ctx));
    }
    struct DragRequest request;
    if (recv(test.fd, &request, sizeof(request), MSG_DONTWAIT) == sizeof(request))
    {
        JSValue callback = JS_GetPropertyStr(test.ctx, test.object, "oncommand");
        JSValue args[] = { JS_NewInt32(test.ctx, request.command), JS_NewInt32(test.ctx, request.mode) };
        JSValue result = JS_Call(test.ctx, callback, test.object, 2, args);
        JS_FreeValue(test.ctx, callback);
        if (JS_IsException(result))
        {
            JSValue error = JS_GetException(test.ctx);
            const char *message = JS_ToCString(test.ctx, error);
            fprintf(stderr, "FAIL JS drag: %s\n", message ? message : "exception");
            JS_FreeCString(test.ctx, message);
            JS_FreeValue(test.ctx, error);
            test.failed = 1;
        }
        JS_FreeValue(test.ctx, result);
    }
    return test.failed ? -1 : 0;
}
static void dispose(void *data)
{
    (void)data;
    JS_FreeValue(test.ctx, test.object);
}
int main(int argc, char **argv)
{
    if (argc < 3)
        return 2;
    test.fd = atoi(argv[1]);
    setvbuf(stdout, NULL, _IOLBF, 0);
    int result;
    if (!strcmp(argv[2], "--receiver"))
        result = pu_test_drag_receiver(test.fd);
    else
    {
        if (argc != 4)
            return 2;
        test.mode = argv[3];
        PuGuiHooks hooks = { .install = install, .pump = pump, .dispose = dispose };
        PuGuiConfig config = { .script = argv[2], .hooks = &hooks };
        result = pu_gui_run(&config);
        pu_gui_shutdown();
    }
    close(test.fd);
    return result;
}
