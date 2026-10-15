#include "bridge/bridge.h"
#include "render/canvas_c.h"
#include "render/gpu_canvas.h"
#include "render/render.h"
#include "layout/layout.h"
#include "script/script.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures;
static void check(int ok, const char* message)
{
    if (!ok) {
        fprintf(stderr, "FAIL: %s\n", message);
        failures = 1;
    }
}
static void evaluate(JSContext* ctx, const char* source)
{
    JSValue value = JS_Eval(ctx, source, strlen(source), "gpu-native", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(value)) {
        JSValue exception = JS_GetException(ctx);
        const char* text = JS_ToCString(ctx, exception);
        fprintf(stderr, "FAIL: %s\n", text ? text : "JS exception");
        JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, exception);
        failures = 1;
    }
    JS_FreeValue(ctx, value);
}
static JSValue collect(JSContext* ctx, JSValueConst self, int argc, JSValueConst* argv)
{
    (void)self;
    (void)argc;
    (void)argv;
    JS_RunGC(JS_GetRuntime(ctx));
    return JS_UNDEFINED;
}
static JSValue set_policy(JSContext* ctx, JSValueConst self, int argc, JSValueConst* argv)
{
    (void)self;
    if (argc != 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "test policy requires one string");
    const char* policy = JS_ToCString(ctx, argv[0]);
    if (!policy)
        return JS_EXCEPTION;
#ifdef _WIN32
    int failed = _putenv_s("PU_WEBGL2_DEVICE", policy);
#else
    int failed = setenv("PU_WEBGL2_DEVICE", policy, 1);
#endif
    JSValue result = failed
        ? JS_ThrowInternalError(ctx, "Cannot set process-local test provider policy")
        : JS_UNDEFINED;
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "gpuRequestedPolicy", JS_NewString(ctx, policy));
    JS_FreeValue(ctx, global);
    JS_FreeCString(ctx, policy);
    return result;
}
static void native_suite(JSContext* ctx, PuBridge* bridge)
{
    JS_RunGC(JS_GetRuntime(ctx));
    size_t contexts = pu_gpu_canvas_live_contexts(), backings = pu_canvas_live_backings();
    evaluate(ctx,
        "(()=>{for(let i=0;i<12;i++){const c=document.createElement('canvas');c.width=4;c.height=4;"
        "const gl=c.getContext('webgl2');const "
        "b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);"
        "gl.bufferData(gl.ARRAY_BUFFER,64,gl.STATIC_DRAW);const style=c.style;"
        "c.addEventListener('click',()=>{style.width='4';gl.clear(gl.COLOR_BUFFER_BIT)});}})();gc()"
        ";");
    check(pu_gpu_canvas_live_contexts() == contexts && pu_canvas_live_backings() == backings,
        "detached GPU canvas/context/bound-resource/style/listener cycles collect");
    PuBridge* child = pu_bridge_new_document(bridge);
    check(child != NULL, "GPU child document creation");
    if (!child)
        return;
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "gpuChild", pu_bridge_document(child));
    JS_FreeValue(ctx, global);
    evaluate(ctx,
        "globalThis.gpuMoved=gpuChild.createElement('canvas');gpuMoved.width=4;gpuMoved.height=4;"
        "globalThis.gpuMovedContext=gpuMoved.getContext('webgl2',{alpha:false,"
        "preserveDrawingBuffer:true});"
        "gpuMovedContext.clearColor(0,0,1,1);gpuMovedContext.clear(gpuMovedContext.COLOR_BUFFER_"
        "BIT);"
        "gpuChild.body.appendChild(gpuMoved);document.body.appendChild(gpuMoved);"
        "globalThis.gpuClosed=gpuChild.createElement('canvas');globalThis.gpuClosedContext="
        "gpuClosed.getContext('webgl2');"
        "gpuChild.body.appendChild(gpuClosed);"
        "globalThis.gpuDetached=gpuChild.createElement('canvas');globalThis.gpuDetachedContext="
        "gpuDetached.getContext('webgl2');"
        "globalThis.gpuLateBlob=false;gpuDetached.toBlob(()=>gpuLateBlob=true);");
#ifdef _WIN32
    evaluate(ctx,
        "globalThis.gpuSavedPolicy=gpuRequestedPolicy;gpuSetPolicyForTest('software');"
        "globalThis.gpuLateCreation=false;globalThis.gpuFailedCreation=gpuChild.createElement('canvas');"
        "gpuFailedCreation.addEventListener('webglcontextcreationerror',()=>gpuLateCreation=true);"
        "if(gpuFailedCreation.getContext('webgl2',{failIfMajorPerformanceCaveat:true})!==null)"
        "throw Error('CPU strict creation did not fail');gpuSetPolicyForTest(gpuSavedPolicy);");
#endif
    pu_bridge_release_document(child);
    pu_script_pump(JS_GetContextOpaque(ctx));
#ifdef _WIN32
    evaluate(ctx, "if(gpuLateCreation)throw Error('late failed-creation event after document close');");
#endif
    evaluate(ctx,
        "(()=>{const pixel=new "
        "Uint8Array(4);gpuMovedContext.readPixels(0,0,1,1,gpuMovedContext.RGBA,"
        "gpuMovedContext.UNSIGNED_BYTE,pixel);if(pixel[2]!==255||pixel[3]!==255)throw Error('moved "
        "context lost pixels');"
        "if(gpuMoved.getContext('webgl2')!==gpuMovedContext)throw Error('moved context identity');"
        "if(gpuLateBlob)throw Error('late GPU export callback after document close');"
        "for(const gl of [gpuClosedContext,gpuDetachedContext]){let "
        "threw=false;try{gl.clear(0);}catch(e){threw=e instanceof TypeError;}"
        "if(!threw)throw Error('closed document still permits GPU operations');}})();");
    evaluate(ctx,
        "document.body.textContent='';Object.assign(document.body.style,{backgroundColor:'white',"
        "alignItems:'flex-start'});"
        "globalThis.gpuClip=document.createElement('view');"
        "Object.assign(gpuClip.style,{position:'absolute',left:'10',top:'10',width:'30',height:'20'"
        ",overflow:'hidden',scrollLeft:'2'});"
        "globalThis.gpuComposed=document.createElement('canvas');gpuComposed.width=8;gpuComposed."
        "height=8;"
        "Object.assign(gpuComposed.style,{width:'40',height:'40',borderRadius:'8',translateX:'2',"
        "opacity:'.5'});"
        "globalThis.gpuComposedContext=gpuComposed.getContext('webgl2',{alpha:false});"
        "gpuComposedContext.clearColor(1,0,0,1);gpuComposedContext.clear(gpuComposedContext.COLOR_"
        "BUFFER_BIT);"
        "gpuClip.appendChild(gpuComposed);document.body.appendChild(gpuClip);"
        "globalThis.gpuControl=document.createElement('canvas');gpuControl.width=8;gpuControl."
        "height=8;"
        "Object.assign(gpuControl.style,{position:'absolute',left:'60',top:'10',width:'40',height:'"
        "40',borderRadius:'8',opacity:'.5'});"
        "const "
        "control=gpuControl.getContext('2d');control.fillStyle='red';control.fillRect(0,0,8,8);"
        "document.body.appendChild(gpuControl);");
    PuSurface* surface = pu_surface_create(150, 150);
    check(surface != NULL, "GPU DOM composition surface");
    if (surface) {
        const float scales[] = { 1, 1.5f };
        for (size_t i = 0; i < 2; ++i) {
            evaluate(ctx,
                "gpuComposedContext.clearColor(1,0,0,1);gpuComposedContext.clear("
                "gpuComposedContext.COLOR_BUFFER_BIT);");
            pu_layout_calculate(pu_bridge_body(bridge), 100, 100);
            pu_render_tree(surface, pu_bridge_body(bridge), scales[i]);
            uint8_t gpu[4], raster[4], outside[4], corner[4];
            pu_surface_read_pixel(surface, (int)(20 * scales[i]), (int)(20 * scales[i]), gpu);
            pu_surface_read_pixel(surface, (int)(70 * scales[i]), (int)(20 * scales[i]), raster);
            pu_surface_read_pixel(surface, (int)(45 * scales[i]), (int)(20 * scales[i]), outside);
            pu_surface_read_pixel(surface, (int)(10 * scales[i]), (int)(10 * scales[i]), corner);
            check(!memcmp(gpu, raster, 4) && gpu[0] == 255 && gpu[1] > 0 && gpu[1] < 255
                    && gpu[3] == 255,
                "GPU CSS/DPI/opacity/transform snapshot matches existing 2D pixels exactly");
            check(!memcmp(outside, (uint8_t[]) { 255, 255, 255, 255 }, 4)
                    && !memcmp(corner, (uint8_t[]) { 255, 255, 255, 255 }, 4),
                "GPU ancestor scroll/clip and own rounded clip");
            evaluate(ctx,
                "(()=>{const pixel=new Uint8Array(4);gpuComposedContext.readPixels(0,0,1,1,"
                "gpuComposedContext.RGBA,gpuComposedContext.UNSIGNED_BYTE,pixel);"
                "if(pixel[0]!==0||pixel[1]!==0||pixel[2]!==0||pixel[3]!==255)throw Error('drawing "
                "buffer was not discarded after presentation');"
                "if(gpuComposed.width!==8||gpuComposed.height!==8)throw Error('DPI resized GPU "
                "backing');})()");
            pu_render_tree(surface, pu_bridge_body(bridge), scales[i]);
            uint8_t retained[4];
            pu_surface_read_pixel(surface, (int)(20 * scales[i]), (int)(20 * scales[i]), retained);
            check(!memcmp(gpu, retained, 4),
                "retained DOM frame survives standard non-preserved buffer discard");
        }
        pu_surface_destroy(surface);
    }
}

int main(int argc, char** argv)
{
    if (argc != 2 && argc != 3) {
        fprintf(stderr, "usage: gpu-test module.mjs\n");
        return 2;
    }
    PuScript* script = pu_script_create();
    JSContext* ctx = pu_script_jsctx(script);
    PuBridge* bridge = pu_bridge_install(ctx);
    if (!bridge) {
        fprintf(stderr, "FAIL: bridge install\n");
        return 1;
    }
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "gc", JS_NewCFunction(ctx, collect, "gc", 0));
    JS_SetPropertyStr(ctx, global, "gpuSetPolicyForTest",
        JS_NewCFunction(ctx, set_policy, "gpuSetPolicyForTest", 1));
#if defined(_WIN32) || defined(__APPLE__)
    const char* policy = getenv("PU_WEBGL2_DEVICE");
    JS_SetPropertyStr(ctx, global, "gpuRequestedPolicy",
        JS_NewString(ctx, policy && *policy ? policy : "hardware"));
#else
    JS_SetPropertyStr(ctx, global, "gpuRequestedPolicy", JS_NewString(ctx, "system-gles"));
#endif
    JS_FreeValue(ctx, global);
    evaluate(ctx,
        "globalThis.gpuMethodCalls={};if(typeof WebGL2RenderingContext!=='undefined')for(const "
        "name of "
        "Object.getOwnPropertyNames(WebGL2RenderingContext.prototype)){"
        "const descriptor=Object.getOwnPropertyDescriptor(WebGL2RenderingContext.prototype,name);"
        "if(name==='constructor'||typeof descriptor.value!=='function')continue;"
        "const original=descriptor.value;const "
        "counted=function(...args){gpuMethodCalls[name]=(gpuMethodCalls[name]||0)+1;"
        "return "
        "original.apply(this,args);};Object.defineProperty(counted,'length',{value:original.length}"
        ");"
        "Object.defineProperty(WebGL2RenderingContext.prototype,name,{...descriptor,value:counted})"
        ";}");
    int failed = pu_script_run_file(script, argv[1]);
    pu_script_run_loop(script);
    failed |= pu_script_finish(script);
    JSValue value
        = JS_Eval(ctx, "if(!globalThis.gpuTestsDone)throw Error('GPU fixture did not finish');",
            strlen("if(!globalThis.gpuTestsDone)throw Error('GPU fixture did not finish');"),
            "gpu-driver", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(value)) {
        JSValue exception = JS_GetException(ctx);
        const char* text = JS_ToCString(ctx, exception);
        fprintf(stderr, "FAIL: %s\n", text ? text : "JS exception");
        JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, exception);
        failed = 1;
    }
    JS_FreeValue(ctx, value);
    if (!failed && argc == 2)
        native_suite(ctx, bridge);
    evaluate(ctx, "console.log('GPU_METHOD_CALLS '+JSON.stringify(gpuMethodCalls));");
    failed |= failures;
    pu_bridge_free(bridge);
    pu_script_destroy(script);
    if (pu_gpu_canvas_live_contexts() || pu_canvas_live_backings() || pu_canvas_live_resources()) {
        fprintf(stderr, "FAIL: native graphics resources survive shutdown\n");
        failed = 1;
    }
    pu_render_shutdown();
    if (!failed)
        puts(argc == 3 ? "PASS: unavailable GPU backend returns null/error and preserves Canvas2D"
                       : "PASS: real offscreen GPU runtime fixture");
    return failed;
}
