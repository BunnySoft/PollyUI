#include "net/fetch.h"
#include "core/thread.h"

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static JSContext  *g_ctx;
static PuDispatch *g_disp;

static char *dup_str(const char *s)
{
    if (!s) return NULL;
    size_t n = strlen(s) + 1;
    char *p = (char *)malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}

/* One in-flight request: the inputs, the result, and the Promise to settle. */
typedef struct PuFetch {
    char   *url;
    char   *method;
    char   *body;        /* request body (optional) */
    int     status;
    int     ok;
    char   *resp_body;   /* owned */
    char   *error;       /* owned; non-NULL => reject */
    JSValue resolve;
    JSValue reject;
} PuFetch;

/* ---- the worker (background thread) ----------------------------------------*/

static char *read_local(const char *path, long *out_len)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    if (n < 0) { fclose(f); return NULL; }
    fseek(f, 0, SEEK_SET);
    char *buf = (char *)malloc((size_t)n + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t rd = fread(buf, 1, (size_t)n, f);
    fclose(f);
    buf[rd] = '\0';
    if (out_len) *out_len = (long)rd;
    return buf;
}

static void do_file(PuFetch *f)
{
    const char *path = f->url + 7;                       /* skip "file://" */
    if (path[0] == '/' && path[1] && path[2] == ':') path++; /* file:///C:/.. -> C:/.. */
    char *buf = read_local(path, NULL);
    if (buf) { f->status = 200; f->ok = 1; f->resp_body = buf; }
    else     { f->status = 404; f->error = dup_str("file not found"); }
}

#ifdef _WIN32
static void do_http(PuFetch *f)
{
    wchar_t wurl[2048];
    MultiByteToWideChar(CP_UTF8, 0, f->url, -1, wurl, 2048);

    URL_COMPONENTS uc;
    memset(&uc, 0, sizeof(uc));
    uc.dwStructSize = sizeof(uc);
    wchar_t host[256] = {0}, path[1536] = {0};
    uc.lpszHostName = host; uc.dwHostNameLength = 256;
    uc.lpszUrlPath  = path; uc.dwUrlPathLength  = 1536;
    if (!WinHttpCrackUrl(wurl, 0, 0, &uc)) { f->error = dup_str("invalid URL"); return; }

    int https = (uc.nScheme == INTERNET_SCHEME_HTTPS);
    wchar_t wmethod[16];
    MultiByteToWideChar(CP_UTF8, 0, f->method ? f->method : "GET", -1, wmethod, 16);

    HINTERNET sess = WinHttpOpen(L"PollyUI/1.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                 WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    HINTERNET conn = sess ? WinHttpConnect(sess, host, uc.nPort, 0) : NULL;
    HINTERNET req  = conn ? WinHttpOpenRequest(conn, wmethod, path, NULL, WINHTTP_NO_REFERER,
                                               WINHTTP_DEFAULT_ACCEPT_TYPES,
                                               https ? WINHTTP_FLAG_SECURE : 0) : NULL;
    if (!req) {
        f->error = dup_str("connection failed");
        if (conn) WinHttpCloseHandle(conn);
        if (sess) WinHttpCloseHandle(sess);
        return;
    }

    DWORD blen = f->body ? (DWORD)strlen(f->body) : 0;
    BOOL ok = WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                                 (LPVOID)f->body, blen, blen, 0)
              && WinHttpReceiveResponse(req, NULL);
    if (ok) {
        DWORD code = 0, sz = sizeof(code);
        WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &code, &sz, WINHTTP_NO_HEADER_INDEX);
        f->status = (int)code;
        f->ok = (code >= 200 && code < 400);

        size_t cap = 4096, len = 0;
        char *buf = (char *)malloc(cap);
        DWORD avail = 0;
        while (buf && WinHttpQueryDataAvailable(req, &avail) && avail > 0) {
            if (len + avail + 1 > cap) { cap = (len + avail + 1) * 2; buf = (char *)realloc(buf, cap); if (!buf) break; }
            DWORD got = 0;
            if (!WinHttpReadData(req, buf + len, avail, &got) || got == 0) break;
            len += got;
        }
        if (buf) { buf[len] = '\0'; f->resp_body = buf; }
    } else {
        f->error = dup_str("request failed");
    }
    WinHttpCloseHandle(req);
    WinHttpCloseHandle(conn);
    WinHttpCloseHandle(sess);
}
#else
/* No bundled native HTTP client on non-Windows yet (Windows uses WinHTTP).
 * file:// requests still work via do_file(); remote fetch rejects clearly. */
static void do_http(PuFetch *f)
{
    f->error = dup_str("network fetch not supported on this platform yet");
}
#endif

/* ---- UI-thread delivery (settles the Promise) ------------------------------*/

static JSValue make_resolved(JSContext *ctx, JSValue value)
{
    JSValue funcs[2];
    JSValue p = JS_NewPromiseCapability(ctx, funcs);
    JSValue r = JS_Call(ctx, funcs[0], JS_UNDEFINED, 1, &value);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, funcs[0]); JS_FreeValue(ctx, funcs[1]);
    JS_FreeValue(ctx, value);
    return p;
}

static JSValue make_rejected(JSContext *ctx, JSValue err)
{
    JSValue funcs[2];
    JSValue p = JS_NewPromiseCapability(ctx, funcs);
    JSValue r = JS_Call(ctx, funcs[1], JS_UNDEFINED, 1, &err);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, funcs[0]); JS_FreeValue(ctx, funcs[1]);
    JS_FreeValue(ctx, err);
    return p;
}

/* response.text() -> Promise<string> */
static JSValue js_response_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)argc; (void)argv;
    return make_resolved(ctx, JS_GetPropertyStr(ctx, this_val, "__body"));
}

/* response.json() -> Promise<value> */
static JSValue js_response_json(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)argc; (void)argv;
    JSValue body = JS_GetPropertyStr(ctx, this_val, "__body");
    const char *s = JS_ToCString(ctx, body);
    JS_FreeValue(ctx, body);
    JSValue parsed = JS_ParseJSON(ctx, s ? s : "null", s ? strlen(s) : 4, "<fetch json>");
    if (s) JS_FreeCString(ctx, s);
    if (JS_IsException(parsed)) return make_rejected(ctx, JS_GetException(ctx));
    return make_resolved(ctx, parsed);
}

static void deliver_fetch(void *ctx)
{
    PuFetch *f = (PuFetch *)ctx;
    JSContext *jc = g_ctx;

    if (f->error) {
        JSValue err = JS_NewError(jc);
        JS_SetPropertyStr(jc, err, "message", JS_NewString(jc, f->error));
        JSValue r = JS_Call(jc, f->reject, JS_UNDEFINED, 1, &err);
        JS_FreeValue(jc, r);
        JS_FreeValue(jc, err);
    } else {
        JSValue res = JS_NewObject(jc);
        JS_SetPropertyStr(jc, res, "status", JS_NewInt32(jc, f->status));
        JS_SetPropertyStr(jc, res, "ok", JS_NewBool(jc, f->ok));
        JS_SetPropertyStr(jc, res, "url", JS_NewString(jc, f->url));
        JS_SetPropertyStr(jc, res, "__body", JS_NewString(jc, f->resp_body ? f->resp_body : ""));
        JS_SetPropertyStr(jc, res, "text", JS_NewCFunction(jc, js_response_text, "text", 0));
        JS_SetPropertyStr(jc, res, "json", JS_NewCFunction(jc, js_response_json, "json", 0));
        JSValue r = JS_Call(jc, f->resolve, JS_UNDEFINED, 1, &res);
        JS_FreeValue(jc, r);
        JS_FreeValue(jc, res);
    }

    JS_FreeValue(jc, f->resolve);
    JS_FreeValue(jc, f->reject);
    free(f->url); free(f->method); free(f->body); free(f->resp_body); free(f->error);
    free(f);
    pu_dispatch_unref(g_disp);
}

static void fetch_thread(void *arg)
{
    PuFetch *f = (PuFetch *)arg;
    if (strncmp(f->url, "file://", 7) == 0) do_file(f);
    else                                    do_http(f);
    pu_dispatch_post(g_disp, deliver_fetch, f);
}

/* ---- fetch(url, options) ---------------------------------------------------*/

static JSValue js_fetch(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "fetch(url) requires a URL");

    PuFetch *f = (PuFetch *)calloc(1, sizeof(PuFetch));
    if (!f) return JS_ThrowOutOfMemory(ctx);

    const char *url = JS_ToCString(ctx, argv[0]);
    f->url = dup_str(url);
    if (url) JS_FreeCString(ctx, url);

    f->method = dup_str("GET");
    if (argc >= 2 && JS_IsObject(argv[1])) {
        JSValue m = JS_GetPropertyStr(ctx, argv[1], "method");
        if (JS_IsString(m)) { const char *ms = JS_ToCString(ctx, m); free(f->method); f->method = dup_str(ms); if (ms) JS_FreeCString(ctx, ms); }
        JS_FreeValue(ctx, m);
        JSValue b = JS_GetPropertyStr(ctx, argv[1], "body");
        if (JS_IsString(b)) { const char *bs = JS_ToCString(ctx, b); f->body = dup_str(bs); if (bs) JS_FreeCString(ctx, bs); }
        JS_FreeValue(ctx, b);
    }

    JSValue funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, funcs);
    f->resolve = funcs[0];
    f->reject  = funcs[1];

    pu_dispatch_ref(g_disp);
    PuThread *th = pu_thread_start(fetch_thread, f);
    pu_thread_detach(th);
    return promise;
}

void pu_fetch_install(JSContext *ctx, PuDispatch *dispatch)
{
    g_ctx = ctx;
    g_disp = dispatch;
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "fetch", JS_NewCFunction(ctx, js_fetch, "fetch", 2));
    JS_FreeValue(ctx, global);
}
