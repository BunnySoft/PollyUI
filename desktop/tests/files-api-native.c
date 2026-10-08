#define _GNU_SOURCE
#include "files.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    assert(argc == 2 && getuid() == 1000 && geteuid() == 1000);
    char root[] = "/tmp/polly-files-api-XXXXXX";
    assert(mkdtemp(root));
    assert(!setenv("HOME", root, 1));
    FILE *file = fopen(argv[1], "rb");
    assert(file && !fseek(file, 0, SEEK_END));
    long length = ftell(file);
    assert(length > 0 && length < 65536 && !fseek(file, 0, SEEK_SET));
    char *source = malloc((size_t)length + 1);
    assert(source && fread(source, 1, (size_t)length, file) == (size_t)length);
    source[length] = 0; fclose(file);
    JSRuntime *runtime = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(runtime);
    JSValue api = JS_NewObject(ctx), global = JS_GetGlobalObject(ctx);
    assert(pu_files_install(ctx, api));
    assert(JS_SetPropertyStr(ctx, global, "desktop", api) >= 0);
    JS_FreeValue(ctx, global);
    JSValue result = JS_Eval(ctx, source, (size_t)length, argv[1], JS_EVAL_TYPE_GLOBAL);
    free(source);
    int status = JS_IsException(result);
    if (status) {
        JSValue exception = JS_GetException(ctx);
        const char *message = JS_ToCString(ctx, exception);
        fprintf(stderr, "FAIL native JS file API: %s\n", message ? message : "exception");
        JS_FreeCString(ctx, message); JS_FreeValue(ctx, exception);
    } else printf("PASS: actual QuickJS fileSystem v1 native API; private fixture %s\n", root);
    JS_FreeValue(ctx, result); JS_FreeContext(ctx); JS_FreeRuntime(runtime);
    return status;
}
