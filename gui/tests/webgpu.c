#include "bridge/webgpu.h"
#include "bridge/bridge.h"
#include "render/skia_c.h"
#include "render/render.h"
#include "layout/layout.h"
#include "script/script.h"
#include <stdio.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <time.h>
#endif

static JSValue collect(JSContext* context, JSValueConst self, int count, JSValueConst* arguments)
{
    (void)self;
    (void)count;
    (void)arguments;
    JS_RunGC(JS_GetRuntime(context));
    return JS_UNDEFINED;
}
static JSValue close_gpu(JSContext *context, JSValueConst self, int count, JSValueConst *arguments)
{
    (void)self;(void)count;(void)arguments;
    pu_webgpu_shutdown(context);
    return JS_UNDEFINED;
}
static JSValue readback_count(JSContext *context,JSValueConst self,int count,JSValueConst *arguments)
{
    (void)self;(void)count;(void)arguments;
    return JS_NewInt64(context,(int64_t)pu_webgpu_live_readbacks());
}
static JSValue present_gpu(JSContext *context, JSValueConst self, int count, JSValueConst *arguments)
{
    (void)self;
    double scale=1;
    if(count&&JS_ToFloat64(context,&scale,arguments[0]))return JS_EXCEPTION;
    PuBridge *bridge=JS_GetRuntimeOpaque(JS_GetRuntime(context));
    PuSurface *surface=pu_surface_create(24,24);
    if(!surface)return JS_ThrowOutOfMemory(context);
    PuNode *root=pu_bridge_body(bridge);
    pu_layout_calculate(root,16,16);pu_render_tree(surface,root,(float)scale);
    uint8_t pixel[4];pu_surface_read_pixel(surface,(int)scale,(int)scale,pixel);
    pu_surface_destroy(surface);
    return JS_NewArrayBufferCopy(context,pixel,4);
}
int main(int argc, char** argv)
{
    if (argc != 2 && !(argc == 3 && !strcmp(argv[2],"--frames"))) {
        fputs("usage: webgpu-test fixture.mjs [--frames]\n", stderr);
        return 2;
    }
    PuScript* script = pu_script_create();
    if (!script)
        return 1;
    JSContext* context = pu_script_jsctx(script);
    PuBridge* bridge = pu_bridge_install(context);
    if (!bridge) {
        JSValue error = JS_GetException(context);
        const char* message = JS_ToCString(context, error);
        fprintf(stderr, "FAIL: bridge install: %s\n", message ? message : "unknown");
        JS_FreeCString(context, message);
        JS_FreeValue(context, error);
        pu_script_destroy(script);
        return 1;
    }
    JSValue global = JS_GetGlobalObject(context);
    JS_SetPropertyStr(context, global, "gc", JS_NewCFunction(context, collect, "gc", 0));
    JS_SetPropertyStr(context, global, "closeGpuForTest", JS_NewCFunction(context, close_gpu, "closeGpuForTest", 0));
    JS_SetPropertyStr(context, global, "presentGpuForTest", JS_NewCFunction(context, present_gpu, "presentGpuForTest", 1));
    JS_SetPropertyStr(context,global,"nativeReadbacksForTest",JS_NewCFunction(context,readback_count,"nativeReadbacksForTest",0));
    JSValue performance=JS_GetPropertyStr(context,global,"performance");
    JSValue clock=JS_GetPropertyStr(context,performance,"now");
    JS_FreeValue(context, global);
    int failed = pu_script_run_file(script, argv[1]);
    if(argc==3) {
        for(unsigned frame=0;frame<3600&&!pu_script_failed(script);++frame) {
            pu_script_pump(script);
            JSValue root=JS_GetGlobalObject(context),done=JS_GetPropertyStr(context,root,"webgpuTestsDone");
            int complete=JS_ToBool(context,done);JS_FreeValue(context,done);JS_FreeValue(context,root);
            if(complete)break;
            JSValue stamp=JS_Call(context,clock,performance,0,NULL);double timestamp=0;
            if(JS_IsException(stamp)||JS_ToFloat64(context,&timestamp,stamp)){failed=1;JS_FreeValue(context,stamp);break;}
            JS_FreeValue(context,stamp);
            pu_script_flush_raf(script,timestamp);
#ifdef _WIN32
            Sleep(16);
#else
            struct timespec delay={0,16000000};nanosleep(&delay,NULL);
#endif
        }
        pu_script_pump(script);
    } else pu_script_run_loop(script);
    JS_FreeValue(context,clock);JS_FreeValue(context,performance);
    failed |= pu_script_finish(script);
    const char* assertion
        = "if(!globalThis.webgpuTestsDone)throw Error('WebGPU fixture did not complete');";
    JSValue value
        = JS_Eval(context, assertion, strlen(assertion), "webgpu-driver", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(value)) {
        JSValue error = JS_GetException(context);
        const char* message = JS_ToCString(context, error);
        fprintf(stderr, "FAIL: %s\n", message ? message : "unknown");
        JS_FreeCString(context, message);
        JS_FreeValue(context, error);
        failed = 1;
    }
    JS_FreeValue(context, value);
    pu_webgpu_shutdown(context);
    pu_bridge_free(bridge);
    pu_script_destroy(script);
    if(pu_webgpu_live_resources()) {fprintf(stderr,"FAIL: WebGPU resources survived VM shutdown\n");failed=1;}
    pu_render_shutdown();
    if (!failed)
        puts("PASS: real QuickJS/native WebGPU fixture");
    return failed;
}
