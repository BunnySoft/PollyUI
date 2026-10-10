#include "bridge/bridge.h"
#include "render/skia_c.h"
#include "quickjs.h"
#include <stdio.h>
#include <string.h>

static int failed;
static void check(int valid, const char *message)
{
    if (!valid) { fprintf(stderr, "FAIL: %s\n", message); failed = 1; }
}
static void evaluate(JSContext *ctx, const char *source)
{
    JSValue value = JS_Eval(ctx, source, strlen(source), "bitmap-fixture", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(value)) {
        JSValue error = JS_GetException(ctx);
        const char *message = JS_ToCString(ctx, error);
        fprintf(stderr, "FAIL: %s\n", message ? message : "JS exception");
        JS_FreeCString(ctx, message); JS_FreeValue(ctx, error);
        failed = 1;
    }
    JS_FreeValue(ctx, value);
}
static void key(JSContext *ctx, const char *property, char result[64])
{
    JSValue global = JS_GetGlobalObject(ctx), value = JS_GetPropertyStr(ctx, global, property);
    const char *text = JS_ToCString(ctx, value);
    check(text && strlen(text) < 64, "bitmap key is bounded");
    snprintf(result, 64, "%s", text ? text : "");
    JS_FreeCString(ctx, text); JS_FreeValue(ctx, value); JS_FreeValue(ctx, global);
}
static int visible(PuSurface *surface, const char *key)
{
    return pu_surface_draw_image(surface, key, 0, 0, 2, 2, 0);
}
int main(void)
{
    PuSurface *surface = pu_surface_create(2, 2);
    check(surface != NULL, "GUI raster fixture surface");
    JSRuntime *rt = JS_NewRuntime(), *other_rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt), *other = JS_NewContext(other_rt);
    PuBridge *bridge = pu_bridge_install(ctx), *other_bridge = pu_bridge_install(other);
    check(bridge && other_bridge, "two independent GUI realms");
    const char *setup =
        "function check(v,m){if(!v)throw Error(m)}"
        "function rejects(f){let ok=false;try{f()}catch(e){ok=true}check(ok,'expected rejection')}"
        "const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,"
        "0,0,0,2,0,0,0,2,8,6,0,0,0,114,182,13,36,0,0,0,17,73,68,65,84,"
        "120,156,99,248,207,192,240,31,132,25,96,12,0,71,202,7,249,103,89,110,183,"
        "0,0,0,0,73,69,78,68,174,66,96,130]);"
        "const storage = new Uint8Array(png.length+10);storage.set(png,5);"
        "globalThis.a=createBitmap(storage.subarray(5,5+png.length),4);"
        "globalThis.savedKey=a.key;"
        "check(a.width===2&&a.height===2&&!a.closed,'dimensions and live state');"
        "rejects(()=>createBitmap(png,3));rejects(()=>createBitmap(png,0));"
        "rejects(()=>createBitmap(png,4.5));rejects(()=>createBitmap(png,'4'));"
        "rejects(()=>createBitmap(new Uint16Array(png.buffer),4));"
        "rejects(()=>createBitmap(storage,4));rejects(()=>createBitmap(png.subarray(0,40),4));"
        "rejects(()=>createBitmap(new Uint8Array(),4));rejects(()=>createBitmap({},4));"
        "rejects(()=>createBitmap(png));"
        "const padded = new Uint8Array(4*1024*1024+png.length);padded.set(png);"
        "const paddedBitmap=createBitmap(padded,4);paddedBitmap.close();"
        "const wide=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,"
        "0,0,16,1,0,0,0,1,8,6,0,0,0,177,227,0,66,0,0,0,39,73,68,65,84,"
        "120,156,237,193,49,1,0,0,0,194,160,245,79,109,13,15,160,0,0,0,0,0,0,0,"
        "0,0,0,0,0,0,0,0,128,11,3,64,5,0,1,93,17,189,164,0,0,0,0,73,69,78,68,174,66,96,130]);"
        "const wideBitmap=createBitmap(wide,4097);"
        "check(wideBitmap.width===4097,'GUI has no desktop dimension policy');wideBitmap.close();"
        "globalThis.b=createBitmap(png.buffer,4);globalThis.secondKey=b.key;"
        "check(a.key!==b.key,'unique keys');"
        "check(!Reflect.set(a,'key',b.key)&&!Reflect.set(a,'width',100),'immutable metadata');"
        "storage.fill(0);";
    evaluate(ctx, setup); evaluate(other, setup);
    JSValue detached = JS_NewArrayBufferCopy(ctx, (const uint8_t *)"not an image", 12);
    JS_DetachArrayBuffer(ctx, detached);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "detached", detached);
    JS_FreeValue(ctx, global);
    evaluate(ctx, "rejects(()=>createBitmap(detached,4));");
    char a[64], b[64], other_key[64];
    key(ctx, "savedKey", a); key(ctx, "secondKey", b); key(other, "savedKey", other_key);
    check(strcmp(a, other_key) && visible(surface, a) && visible(surface, b) && visible(surface, other_key),
        "byte-offset input copied and keys unique across realms");
    PuBridge *child = pu_bridge_new_document(bridge);
    check(child != NULL, "shared-realm child document");
    pu_bridge_release_document(child);
    JS_RunGC(rt);
    check(visible(surface, a), "child document release leaves shared bitmap live");
    evaluate(ctx, "a.close();a.close();check(a.closed,'idempotent close');check(!b.closed,'other handle live');");
    check(!visible(surface, a) && visible(surface, b), "explicit close releases only its image");
    evaluate(ctx, "b=null;");
    JS_RunGC(rt);
    check(!visible(surface, b) && visible(surface, other_key), "GC releases only the owned realm image");
    evaluate(ctx, "globalThis.retained=createBitmap(png,4);globalThis.retainedKey=retained.key;");
    char retained[64]; key(ctx, "retainedKey", retained);
    pu_bridge_free(bridge);
    check(!visible(surface, retained) && visible(surface, other_key), "bridge teardown cleans retained images only once");
    evaluate(ctx, "check(retained.closed,'retained handle observes teardown');retained.close();"
        "rejects(()=>createBitmap(png,4));");
    JS_FreeContext(ctx); JS_FreeRuntime(rt);
    check(visible(surface, other_key), "destroyed VM cannot remove another VM bitmap");
    pu_bridge_free(other_bridge);
    check(!visible(surface, other_key), "second realm teardown cleans its retained handle");
    JS_FreeContext(other); JS_FreeRuntime(other_rt);
    pu_surface_destroy(surface);
    pu_render_shutdown();
    if (!failed) puts("PASS: GUI bitmap byte input, ownership, GC, shared documents and teardown");
    return failed;
}
