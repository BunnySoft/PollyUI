#include "bridge/bridge.h"
#include "bridge/image_file.h"
#include "layout/layout.h"
#include "pollyui/window.h"
#include "render/canvas_c.h"
#include "render/render.h"
#include "script/script.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#endif

static int failed;
static void check(int ok, const char *message)
{
    if (!ok) {
        fprintf(stderr, "FAIL: %s\n", message);
        failed = 1;
    }
}
static JSValue evaluate(JSContext *ctx, const char *source)
{
    JSValue value = JS_Eval(ctx, source, strlen(source), "canvas-native", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(value)) {
        JSValue error = JS_GetException(ctx);
        const char *message = JS_ToCString(ctx, error);
        fprintf(stderr, "FAIL: %s\n", message ? message : "JS exception");
        JS_FreeCString(ctx, message);
        JS_FreeValue(ctx, error);
        failed = 1;
    }
    return value;
}
static JSValue collect(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    (void)argc;
    (void)argv;
    JS_RunGC(JS_GetRuntime(ctx));
    return JS_UNDEFINED;
}
static void pixel(PuSurface *surface, int x, int y, const uint8_t expected[4], const char *message)
{
    uint8_t actual[4];
    pu_surface_read_pixel(surface, x, y, actual);
    if (memcmp(actual, expected, 4)) {
        fprintf(stderr, "pixel %d,%d: %u,%u,%u,%u\n", x, y, actual[0], actual[1], actual[2],
                actual[3]);
        check(0, message);
    }
}
static int write_file(const char *path, const uint8_t *bytes, size_t length)
{
#ifdef _WIN32
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
    wchar_t *wide = count ? malloc((size_t)count * sizeof(*wide)) : NULL;
    if (!wide)
        return 0;
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, count);
    HANDLE file =
        CreateFileW(wide, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    free(wide);
    if (file == INVALID_HANDLE_VALUE)
        return 0;
    DWORD written = 0;
    int ok = length <= UINT32_MAX && WriteFile(file, bytes, (DWORD)length, &written, NULL) &&
             written == length;
    CloseHandle(file);
    return ok;
#else
    FILE *file = fopen(path, "wb");
    if (!file)
        return 0;
    int ok = fwrite(bytes, 1, length, file) == length;
    if (fclose(file))
        ok = 0;
    return ok;
#endif
}
static void remove_file(const char *path)
{
#ifdef _WIN32
    wchar_t wide[4096];
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, 4096))
        DeleteFileW(wide);
#else
    unlink(path);
#endif
}
static int prepare_orientations(const char *directory)
{
    PuCanvas *canvas = pu_canvas_create(48, 32);
    uint8_t *quadrants = malloc(48 * 32 * 4);
    if (!canvas || !quadrants) {
        free(quadrants);
        pu_canvas_destroy(canvas);
        return 0;
    }
    const uint8_t colors[4][4] = {
        {255, 0, 0, 255}, {0, 255, 0, 255}, {0, 0, 255, 255}, {255, 255, 0, 255}};
    for (int y = 0; y < 32; ++y)
        for (int x = 0; x < 48; ++x)
            memcpy(quadrants + ((size_t)y * 48 + x) * 4,
                   colors[(y >= 16 ? 2 : 0) + (x >= 24 ? 1 : 0)], 4);
    int ok = pu_canvas_write(canvas, 48, 32, quadrants, 0, 0, 0, 0, 48, 32);
    free(quadrants);
    uint8_t *jpeg = NULL;
    size_t jpeg_length = 0;
    ok = ok && pu_canvas_encode(canvas, 1, 1, &jpeg, &jpeg_length);
    pu_canvas_destroy(canvas);
    for (int origin = 1; ok && origin <= 8; ++origin) {
        uint8_t exif[] = {255,
                          225,
                          0,
                          34,
                          'E',
                          'x',
                          'i',
                          'f',
                          0,
                          0,
                          'I',
                          'I',
                          42,
                          0,
                          8,
                          0,
                          0,
                          0,
                          1,
                          0,
                          18,
                          1,
                          3,
                          0,
                          1,
                          0,
                          0,
                          0,
                          (uint8_t)origin,
                          0,
                          0,
                          0,
                          0,
                          0,
                          0,
                          0};
        uint8_t *oriented = malloc(jpeg_length + sizeof(exif));
        if (!oriented) {
            ok = 0;
            break;
        }
        memcpy(oriented, jpeg, 2);
        memcpy(oriented + 2, exif, sizeof(exif));
        memcpy(oriented + 2 + sizeof(exif), jpeg + 2, jpeg_length - 2);
        char path[4096];
        snprintf(path, sizeof(path), "%s/orientation-%d.jpg", directory, origin);
        ok = write_file(path, oriented, jpeg_length + sizeof(exif));
        free(oriented);
    }
    pu_canvas_bytes_free(jpeg);
    return ok;
}

static int prepare_files(JSContext *ctx, const char *source, char directory[4096],
                         char script_path[4096])
{
    char candidate[4096];
#ifdef _WIN32
    char temp[2048];
    if (!GetTempPathA(sizeof(temp), temp))
        return 0;
    snprintf(candidate, 4096, "%spolly-canvas-%lu-%llu", temp, GetCurrentProcessId(),
             (unsigned long long)GetTickCount64());
    if (!CreateDirectoryA(candidate, NULL))
        return 0;
#else
    snprintf(candidate, 4096, "/tmp/polly-canvas-XXXXXX");
    if (!mkdtemp(candidate))
        return 0;
#endif
    strcpy(directory, candidate);
    char path[4096];
    snprintf(script_path, 4096, "%s/cases.mjs", directory);
    FILE *file = fopen(source, "rb");
    if (!file || fseek(file, 0, SEEK_END)) {
        if (file)
            fclose(file);
        return 0;
    }
    long size = ftell(file);
    if (size <= 0 || fseek(file, 0, SEEK_SET)) {
        fclose(file);
        return 0;
    }
    uint8_t *script = malloc((size_t)size);
    if (!script) {
        fclose(file);
        return 0;
    }
    int ok = fread(script, 1, (size_t)size, file) == (size_t)size;
    fclose(file);
    if (ok)
        ok = write_file(script_path, script, (size_t)size);
    free(script);
    if (!ok)
        return 0;
    PuCanvas *canvas = pu_canvas_create(2, 2);
    uint8_t pixels[] = {255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255};
    if (!canvas || !pu_canvas_write(canvas, 2, 2, pixels, 0, 0, 0, 0, 2, 2)) {
        pu_canvas_destroy(canvas);
        return 0;
    }
    JSValue global = JS_GetGlobalObject(ctx);
    for (int jpeg = 0; jpeg < 2; ++jpeg) {
        uint8_t *bytes;
        size_t length;
        if (!pu_canvas_encode(canvas, jpeg, .92, &bytes, &length)) {
            ok = 0;
            break;
        }
        snprintf(path, sizeof(path), "%s/fixture.%s", directory, jpeg ? "jpg" : "png");
        ok = write_file(path, bytes, length);
        if (!jpeg && ok) {
            snprintf(path, sizeof(path), "%s/unicode-\xe4\xb8\xad\xe6\x96\x87 %%.png", directory);
            ok = write_file(path, bytes, length);
            JS_SetPropertyStr(ctx, global, "fixtureUnicodePath", JS_NewString(ctx, path));
        }
        pu_canvas_bytes_free(bytes);
        if (!ok)
            break;
    }
    pu_canvas_destroy(canvas);
    snprintf(path, sizeof(path), "%s/fixture.png", directory);
    ok = ok && prepare_orientations(directory);
    JS_SetPropertyStr(ctx, global, "fixturePath", JS_NewString(ctx, path));
#ifndef _WIN32
    snprintf(path, sizeof(path), "%s/fifo", directory);
    ok = ok && mkfifo(path, 0600) == 0;
    JS_SetPropertyStr(ctx, global, "fixtureFifo", JS_NewString(ctx, path));
    int socket_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    snprintf(address.sun_path, sizeof(address.sun_path), "%s/socket", directory);
    ok = ok && socket_fd >= 0 && bind(socket_fd, (struct sockaddr *)&address, sizeof(address)) == 0;
    if (socket_fd >= 0)
        close(socket_fd);
    JS_SetPropertyStr(ctx, global, "fixtureSocket", JS_NewString(ctx, address.sun_path));
#endif
    JS_FreeValue(ctx, global);
    return ok;
}
static void clean_files(const char *directory, const char *script_path)
{
    if (!*directory)
        return;
    char path[4096];
    remove_file(script_path);
    const char *names[] = {"fixture.png", "fixture.jpg", "unicode-\xe4\xb8\xad\xe6\x96\x87 %.png",
                           "fifo", "socket"};
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); ++i) {
        snprintf(path, sizeof(path), "%s/%s", directory, names[i]);
        remove_file(path);
    }
    for (int origin = 1; origin <= 8; ++origin) {
        snprintf(path, sizeof(path), "%s/orientation-%d.jpg", directory, origin);
        remove_file(path);
    }
#ifdef _WIN32
    RemoveDirectoryA(directory);
#else
    rmdir(directory);
#endif
}
int main(int argc, char **argv)
{
    if (argc != 2)
        return 2;
    PuScript *script = pu_script_create();
    check(script != NULL, "script creation");
    if (!script)
        return 1;
    JSContext *ctx = pu_script_jsctx(script);
    PuBridge *bridge = pu_bridge_install(ctx);
    check(bridge != NULL, "DOM/media installation");
    if (!bridge)
        return 1;
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "gc", JS_NewCFunction(ctx, collect, "gc", 0));
    JS_FreeValue(ctx, global);
    char directory[4096] = {0}, script_path[4096] = {0};
    int prepared = prepare_files(ctx, argv[1], directory, script_path);
    check(prepared, "owned relocated resource fixtures");
    if (!prepared) {
        pu_bridge_free(bridge);
        pu_script_destroy(script);
        clean_files(directory, script_path);
        return 1;
    }
    check(!pu_script_run_file(script, script_path), "Canvas API fixture evaluates");
    while (pu_script_pump(script) > 0) {
    }
    check(!pu_script_finish(script), "Canvas async assertions finish");
    JSValue value =
        evaluate(ctx, "if(!globalThis.canvasTestsDone)throw Error('Canvas tests did not finish');");
    JS_FreeValue(ctx, value);
    JS_RunGC(JS_GetRuntime(ctx));
    size_t backings = pu_canvas_live_backings(), resources = pu_canvas_live_resources();
    value = evaluate(
        ctx,
        "(()=>{for(let i=0;i<100;i++){const "
        "c=document.createElement('canvas');c.width=8;c.height=8;"
        "const x=c.getContext('2d');const "
        "g=x.createLinearGradient(0,0,8,8);g.addColorStop(0,'red');"
        "const style=c.style;c.addEventListener('click',()=>{style.width='8';x.fillRect(0,0,1,1)});"
        "g.addColorStop(1,'blue');x.fillStyle=g;x.fillRect(0,0,8,8);"
        "const p=new Path2D();p.roundRect(0,0,8,8,2);x.clip(p);"
        "const pattern=x.createPattern(c,'repeat');pattern.setTransform(new "
        "DOMMatrix());x.fillStyle=pattern;}})();");
    JS_FreeValue(ctx, value);
    JS_RunGC(JS_GetRuntime(ctx));
    check(pu_canvas_live_backings() == backings && pu_canvas_live_resources() == resources,
          "detached canvas/context/gradient/pattern/path cycles release under GC");
    value = evaluate(
        ctx,
        "(()=>{let c=document.createElement('canvas');const x=c.getContext('2d');x.fillStyle='red';"
        "globalThis.retainedCanvasStyle=c.style;c=null;gc();retainedCanvasStyle.width='8';})();"
        "retainedCanvasStyle=null;");
    JS_FreeValue(ctx, value);
    JS_RunGC(JS_GetRuntime(ctx));
    check(pu_canvas_live_backings() == backings,
          "style-only element ownership releases media safely");
    if (!failed) {
        value =
            evaluate(ctx, "document.body.style.alignItems='flex-start';"
                          "globalThis.composedImage=new Image();composedImage.src='fixture.png';"
                          "document.body.appendChild(composedImage);");
        JS_FreeValue(ctx, value);
        while (pu_script_pump(script) > 0) {
        }
        PuNode *body = pu_bridge_body(bridge);
        pu_layout_calculate(body, 100, 100);
        check(body->first_child && body->first_child->layout_w == 2 &&
                  body->first_child->layout_h == 2,
              "decoded img has intrinsic DOM dimensions");
        PuSurface *image_surface = pu_surface_create(150, 150);
        pu_render_tree(image_surface, body, 1.5f);
        pixel(image_surface, 1, 1, (uint8_t[]){255, 0, 0, 255}, "img is painted by DOM renderer");
        pu_surface_destroy(image_surface);
        value = evaluate(ctx, "composedImage.width=10;");
        JS_FreeValue(ctx, value);
        pu_layout_calculate(body, 100, 100);
        check(body->first_child->layout_w == 10 && body->first_child->layout_h == 10,
              "img dimension attrs invalidate layout and preserve ratio");
        value = evaluate(ctx, "composedImage.style.height='5';");
        JS_FreeValue(ctx, value);
        pu_layout_calculate(body, 100, 100);
        check(body->first_child->layout_w == 10 && body->first_child->layout_h == 5,
              "CSS size is independent of img natural size");
        value = evaluate(ctx, "check(composedImage.width===10&&composedImage.height===5,'img "
                              "dimensions reflect rendered CSS size');");
        JS_FreeValue(ctx, value);
        value = evaluate(
            ctx,
            "document.body.textContent='';"
            "const clipped=document.createElement('div');"
            "Object.assign(clipped.style,{width:'30',height:'20',overflow:'hidden',scrollLeft:'2'})"
            ";"
            "const composed=document.createElement('canvas');composed.width=4;composed.height=4;"
            "Object.assign(composed.style,{width:'40',height:'40'});"
            "composed.getContext('2d').fillStyle='red';composed.getContext('2d').fillRect(0,0,4,4);"
            "clipped.appendChild(composed);document.body.appendChild(clipped);");
        JS_FreeValue(ctx, value);
        pu_layout_calculate(body, 100, 100);
        PuSurface *surface = pu_surface_create(150, 150);
        check(surface != NULL, "DPI composition surface");
        pu_render_tree(surface, body, 1.5f);
        pixel(surface, 1, 1, (uint8_t[]){255, 0, 0, 255},
              "canvas participates in CSS scale / scroll / DPI composition");
        pixel(surface, 50, 1, (uint8_t[]){255, 255, 255, 255},
              "ancestor clip bounds canvas composition");
        value = evaluate(
            ctx,
            "document.body.textContent='';"
            "globalThis.roundedParent=document.createElement('div');"
            "Object.assign(roundedParent.style,{width:'30',height:'20',overflow:'hidden'});"
            "globalThis.roundedCanvas=document.createElement('canvas');"
            "roundedCanvas.width=4;roundedCanvas.height=4;"
            "Object.assign(roundedCanvas.style,{width:'20',height:'20',borderRadius:'8',overflow:'"
            "hidden'});"
            "roundedCanvas.getContext('2d').fillStyle='red';"
            "roundedCanvas.getContext('2d').fillRect(0,0,4,4);"
            "roundedParent.appendChild(roundedCanvas);document.body.appendChild(roundedParent);"
            "Object.assign(composedImage.style,{position:'absolute',left:'40',top:'0',width:'20',"
            "height:'20',"
            "borderRadius:'8',overflow:'hidden',opacity:'.5'});document.body.appendChild("
            "composedImage);");
        JS_FreeValue(ctx, value);
        const float scales[] = {1, 1.5f};
        for (size_t i = 0; i < sizeof(scales) / sizeof(scales[0]); ++i) {
            pu_layout_calculate(body, 100, 100);
            pu_render_tree(surface, body, scales[i]);
            pixel(surface, 0, 0, (uint8_t[]){255, 255, 255, 255},
                  "canvas media clips its own rounded corner at native/DPI scale");
            pixel(surface, (int)(10 * scales[i]), (int)(10 * scales[i]),
                  (uint8_t[]){255, 0, 0, 255}, "rounded canvas center remains opaque red");
            value = evaluate(
                ctx, "roundedParent.style.scrollLeft='2';roundedCanvas.style.opacity='.5';");
            JS_FreeValue(ctx, value);
            pu_layout_calculate(body, 100, 100);
            pu_render_tree(surface, body, scales[i]);
            pixel(surface, 0, 0, (uint8_t[]){255, 255, 255, 255},
                  "rounded media corner preserves ancestor scroll and opacity");
            uint8_t rgba[4];
            pu_surface_read_pixel(surface, (int)(10 * scales[i]), (int)(10 * scales[i]), rgba);
            uint8_t reference[4];
            pu_surface_read_pixel(surface, (int)(50 * scales[i]), (int)(10 * scales[i]), reference);
            check(!memcmp(rgba, reference, 4) && rgba[0] == 255 && rgba[1] > 0 && rgba[1] < 255 &&
                      rgba[1] == rgba[2] && rgba[3] == 255,
                  "rounded canvas opacity exactly matches existing img composition");
            pixel(surface, (int)(32 * scales[i]), (int)(10 * scales[i]),
                  (uint8_t[]){255, 255, 255, 255}, "ancestor overflow clip remains in effect");
            value = evaluate(ctx,
                             "roundedParent.style.scrollLeft='0';roundedCanvas.style.opacity='1';");
            JS_FreeValue(ctx, value);
        }
        pu_surface_destroy(surface);
        PuBridge *child = pu_bridge_new_document(bridge);
        check(child != NULL, "child document creation");
        global = JS_GetGlobalObject(ctx);
        JS_SetPropertyStr(ctx, global, "childDocument", pu_bridge_document(child));
        JS_FreeValue(ctx, global);
        value = evaluate(
            ctx,
            "globalThis.pendingChildImage=childDocument.createElement('img');"
            "pendingChildImage.src='fixture.png';globalThis.childDecodeResult='pending';"
            "pendingChildImage.decode().then(()=>childDecodeResult='resolved',e=>childDecodeResult="
            "e.name);"
            "childDocument.body.appendChild(pendingChildImage);"
            "pendingChildImage.onload=()=>{throw Error('late load after child close')};"
            "globalThis.detachedChildImage=childDocument.createElement('img');"
            "detachedChildImage.src='fixture.png';globalThis.detachedChildDecode='pending';"
            "detachedChildImage.decode().then(()=>detachedChildDecode='resolved',e=>"
            "detachedChildDecode=e.name);"
            "detachedChildImage.onload=()=>{throw Error('late detached load after child close')};"
            "globalThis.detached=childDocument.createElement('canvas');"
            "globalThis.detachedContext=detached.getContext('2d');"
            "detachedContext.fillStyle='blue';detachedContext.fillRect(0,0,2,2);"
            "childDocument.body.appendChild(detached);document.body.appendChild(detached);"
            "check(detachedContext===detached.getContext('2d'),'context survives document move');");
        JS_FreeValue(ctx, value);
        pu_bridge_release_document(child);
        while (pu_script_pump(script) > 0) {
        }
        JS_RunGC(JS_GetRuntime(ctx));
        value = evaluate(ctx, "check(detachedContext.getImageData(0,0,1,1).data[2]===255,'moved "
                              "canvas survives child close');");
        JS_FreeValue(ctx, value);
        value = evaluate(ctx, "check(childDecodeResult==='EncodingError','child-close cancels "
                              "pending decode without late event');");
        JS_FreeValue(ctx, value);
        value = evaluate(ctx, "check(detachedChildDecode==='EncodingError','child-close cancels "
                              "detached owning-document producers');");
        JS_FreeValue(ctx, value);
        value = evaluate(
            ctx, "globalThis.pendingShutdown=new Image();pendingShutdown.src='fixture.png';"
                 "globalThis.shutdownDecode='pending';pendingShutdown.decode().then(()=>"
                 "shutdownDecode='resolved',e=>shutdownDecode=e.name);"
                 "pendingShutdown.onload=()=>{throw Error('late load after VM scope close')};");
        JS_FreeValue(ctx, value);
    }
    pu_bridge_free(bridge);
    while (pu_script_pump(script) > 0) {
    }
    value = evaluate(
        ctx, "if(globalThis.detachedContext)rejects(()=>detachedContext.fillRect(0,0,1,1));");
    JS_FreeValue(ctx, value);
    if (!failed) {
        value = evaluate(ctx, "check(shutdownDecode==='EncodingError','shutdown rejects decode "
                              "without late delivery');");
        JS_FreeValue(ctx, value);
    }
    pu_script_destroy(script);
    check(pu_canvas_live_backings() == 0 && pu_canvas_live_resources() == 0,
          "VM shutdown releases all native canvas resources");
    pu_render_shutdown();
    clean_files(directory, script_path);
    if (!failed)
        puts("PASS: Canvas2D/Image API, pixels, CSS/DPI/clip composition, multi-document and "
             "shutdown");
    return failed;
}
