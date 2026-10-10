#include "sysrt/projection/quickjs/fetch.h"
#include "shared/thread.h"

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#elif defined(__linux__)
#include <curl/curl.h>
#endif
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static JSContext  *g_ctx;
static PuDispatch *g_disp;
static PuMutex *g_mutex;

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
    size_t  body_len;
    int     status;
    int     ok;
    char   *resp_body;   /* owned */
    size_t  resp_len, resp_cap;
    char   *final_url;
    char  **headers;
    size_t  header_count;
    char    error[256];
    PuThread *thread;
    int cancelled;
    struct PuFetch *next, *previous;
    JSValue resolve;
    JSValue reject;
} PuFetch;

static PuFetch *g_requests;

static int has_scheme(const char *url, const char *prefix)
{
    while (*prefix) {
        unsigned char c = (unsigned char)*url++;
        if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
        if (c != (unsigned char)*prefix++) return 0;
    }
    return 1;
}

static int token(const char *value, size_t length)
{
    if (!length) return 0;
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char)value[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') || (c && strchr("!#$%&'*+-.^_`|~", c)))) return 0;
    }
    return 1;
}

static void set_error(PuFetch *f, const char *message) { snprintf(f->error, sizeof(f->error), "%s", message); }
static int cancelled(PuFetch *f)
{
    pu_mutex_lock(g_mutex);
    int result = f->cancelled;
    pu_mutex_unlock(g_mutex);
    return result;
}

static int append_body(PuFetch *f, const char *data, size_t length)
{
    if (length > SIZE_MAX - f->resp_len - 1) { set_error(f, "response size overflow"); return 0; }
    size_t needed = f->resp_len + length + 1;
    if (needed > f->resp_cap) {
        size_t capacity = needed < SIZE_MAX / 2 ? needed * 2 : needed;
        char *buffer = realloc(f->resp_body, capacity);
        if (!buffer) { set_error(f, "out of memory reading response"); return 0; }
        f->resp_body = buffer; f->resp_cap = capacity;
    }
    memcpy(f->resp_body + f->resp_len, data, length);
    f->resp_len += length;
    f->resp_body[f->resp_len] = 0;
    return 1;
}

static void free_fetch(PuFetch *f)
{
    JS_FreeValue(g_ctx, f->resolve);
    JS_FreeValue(g_ctx, f->reject);
    for (size_t i = 0; i < f->header_count; i++) free(f->headers[i]);
    free(f->headers);
    free(f->url); free(f->method); free(f->body); free(f->resp_body); free(f->final_url);
    free(f);
}

static void unlink_fetch(PuFetch *f)
{
    if (f->previous) f->previous->next = f->next; else g_requests = f->next;
    if (f->next) f->next->previous = f->previous;
}

/* ---- the worker (background thread) ----------------------------------------*/

static void do_file(PuFetch *f)
{
    const char *path = f->url + 7;                       /* skip "file://" */
    if (path[0] == '/' && path[1] && path[2] == ':') path++; /* file:///C:/.. -> C:/.. */
    FILE *file = fopen(path, "rb");
    if (!file) { set_error(f, "cannot open local file"); return; }
    char buffer[16384];
    size_t length;
    while (!cancelled(f) && (length = fread(buffer, 1, sizeof(buffer), file)) != 0)
        if (!append_body(f, buffer, length)) break;
    if (ferror(file)) set_error(f, "failed to read local file");
    if (cancelled(f)) set_error(f, "request cancelled");
    fclose(file);
    if (!f->error[0]) { f->status = 200; f->ok = 1; }
}

#ifdef _WIN32
static void do_http(PuFetch *f)
{
    wchar_t wurl[2048];
    if (!MultiByteToWideChar(CP_UTF8, 0, f->url, -1, wurl, 2048)) {
        set_error(f, "URL exceeds WinHTTP conversion buffer"); return;
    }

    URL_COMPONENTS uc;
    memset(&uc, 0, sizeof(uc));
    uc.dwStructSize = sizeof(uc);
    wchar_t host[256] = {0}, path[1536] = {0};
    uc.lpszHostName = host; uc.dwHostNameLength = 256;
    uc.lpszUrlPath  = path; uc.dwUrlPathLength  = 1536;
    if (!WinHttpCrackUrl(wurl, 0, 0, &uc)) { set_error(f, "invalid URL"); return; }

    int https = (uc.nScheme == INTERNET_SCHEME_HTTPS);
    wchar_t wmethod[16];
    if (!MultiByteToWideChar(CP_UTF8, 0, f->method, -1, wmethod, 16)) {
        set_error(f, "HTTP method exceeds WinHTTP conversion buffer"); return;
    }

    HINTERNET sess = WinHttpOpen(L"PollyUI/1.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                 WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (sess && !WinHttpSetTimeouts(sess, 10000, 10000, 10000, 10000)) {
        set_error(f, "cannot configure HTTP timeouts"); WinHttpCloseHandle(sess); return;
    }
    HINTERNET conn = sess ? WinHttpConnect(sess, host, uc.nPort, 0) : NULL;
    HINTERNET req  = conn ? WinHttpOpenRequest(conn, wmethod, path, NULL, WINHTTP_NO_REFERER,
                                               WINHTTP_DEFAULT_ACCEPT_TYPES,
                                               https ? WINHTTP_FLAG_SECURE : 0) : NULL;
    if (!req) {
        set_error(f, "connection failed");
        if (conn) WinHttpCloseHandle(conn);
        if (sess) WinHttpCloseHandle(sess);
        return;
    }
    {
        DWORD policy = f->header_count ? WINHTTP_OPTION_REDIRECT_POLICY_NEVER :
                                        WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP;
        DWORD limit = 10;
        if (!WinHttpSetOption(req, WINHTTP_OPTION_REDIRECT_POLICY, &policy, sizeof(policy)) ||
            !WinHttpSetOption(req, WINHTTP_OPTION_MAX_HTTP_AUTOMATIC_REDIRECTS, &limit, sizeof(limit))) {
            set_error(f, "cannot configure HTTP redirect policy");
            WinHttpCloseHandle(req); WinHttpCloseHandle(conn); WinHttpCloseHandle(sess);
            return;
        }
    }
    for (size_t i = 0; i < f->header_count; i++) {
        int length = MultiByteToWideChar(CP_UTF8, 0, f->headers[i], -1, NULL, 0);
        wchar_t *header = length ? malloc((size_t)length * sizeof(wchar_t)) : NULL;
        size_t bytes = strlen(f->headers[i]);
        DWORD flags = bytes >= 2 && !strcmp(f->headers[i] + bytes - 2, ": ") ?
            WINHTTP_ADDREQ_FLAG_ADD_IF_NEW : WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE;
        int added = header && MultiByteToWideChar(CP_UTF8, 0, f->headers[i], -1, header, length) &&
            WinHttpAddRequestHeaders(req, header, (DWORD)-1, flags);
        free(header);
        if (!added) {
            set_error(f, "cannot configure HTTP headers");
            WinHttpCloseHandle(req); WinHttpCloseHandle(conn); WinHttpCloseHandle(sess);
            return;
        }
    }

    if (f->body_len > MAXDWORD) {
        set_error(f, "request body exceeds WinHTTP limit");
        WinHttpCloseHandle(req); WinHttpCloseHandle(conn); WinHttpCloseHandle(sess);
        return;
    }
    DWORD blen = (DWORD)f->body_len;
    BOOL ok = WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                                 (LPVOID)f->body, blen, blen, 0)
              && WinHttpReceiveResponse(req, NULL);
    if (ok) {
        DWORD code = 0, sz = sizeof(code);
        if (!WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                 WINHTTP_HEADER_NAME_BY_INDEX, &code, &sz, WINHTTP_NO_HEADER_INDEX))
            set_error(f, "cannot read HTTP status");
        f->status = (int)code;
        f->ok = (code >= 200 && code < 300);
        char buffer[16384];
        while (!cancelled(f)) {
            DWORD got = 0;
            if (!WinHttpReadData(req, buffer, sizeof(buffer), &got)) { set_error(f, "failed to read HTTP response"); break; }
            if (!got || !append_body(f, buffer, got)) break;
        }
        DWORD bytes = 0;
        WinHttpQueryOption(req, WINHTTP_OPTION_URL, NULL, &bytes);
        wchar_t *final_url = bytes ? malloc(bytes) : NULL;
        if (!final_url || !WinHttpQueryOption(req, WINHTTP_OPTION_URL, final_url, &bytes)) {
            set_error(f, "cannot read final response URL");
        } else {
            int length = WideCharToMultiByte(CP_UTF8, 0, final_url, -1, NULL, 0, NULL, NULL);
            f->final_url = length > 0 ? malloc((size_t)length) : NULL;
            if (!f->final_url ||
                !WideCharToMultiByte(CP_UTF8, 0, final_url, -1, f->final_url, length, NULL, NULL))
                set_error(f, "cannot encode final response URL");
        }
        free(final_url);
    } else {
        set_error(f, "request failed");
    }
    WinHttpCloseHandle(req);
    WinHttpCloseHandle(conn);
    WinHttpCloseHandle(sess);
}
#elif defined(__linux__)
static size_t curl_write(char *data, size_t size, size_t count, void *user)
{
    PuFetch *f = user;
    if (size && count > SIZE_MAX / size) { set_error(f, "response size overflow"); return 0; }
    size_t length = size * count;
    return !cancelled(f) && append_body(f, data, length) ? length : 0;
}

static int curl_progress(void *user, curl_off_t total, curl_off_t now, curl_off_t sent_total, curl_off_t sent)
{
    (void)total; (void)now; (void)sent_total; (void)sent;
    return cancelled(user);
}

static void do_http(PuFetch *f)
{
    CURL *curl = curl_easy_init();
    if (!curl) { set_error(f, "cannot create HTTP client"); return; }
    CURLcode result = CURLE_OK;
    struct curl_slist *headers = NULL;
#define SET_OPTION(option, value) do { \
    result = curl_easy_setopt(curl, option, value); \
    if (result != CURLE_OK) goto complete; \
} while (0)
    SET_OPTION(CURLOPT_URL, f->url);
    SET_OPTION(CURLOPT_PROTOCOLS_STR, "http,https");
    SET_OPTION(CURLOPT_REDIR_PROTOCOLS_STR, !strncmp(f->url, "https://", 8) ? "https" : "http,https");
    /* Never forward caller-supplied headers to an unexpected redirect target. */
    SET_OPTION(CURLOPT_FOLLOWLOCATION, f->header_count ? 0L : 1L);
    SET_OPTION(CURLOPT_MAXREDIRS, 10L);
    SET_OPTION(CURLOPT_CONNECTTIMEOUT_MS, 10000L);
    SET_OPTION(CURLOPT_TIMEOUT_MS, 30000L);
    SET_OPTION(CURLOPT_NOSIGNAL, 1L);
    SET_OPTION(CURLOPT_SSL_VERIFYPEER, 1L);
    SET_OPTION(CURLOPT_SSL_VERIFYHOST, 2L);
    const char *ca = getenv("PU_CA_BUNDLE");
    if (ca && *ca) SET_OPTION(CURLOPT_CAINFO, ca);
    SET_OPTION(CURLOPT_WRITEFUNCTION, curl_write);
    SET_OPTION(CURLOPT_WRITEDATA, f);
    SET_OPTION(CURLOPT_NOPROGRESS, 0L);
    SET_OPTION(CURLOPT_XFERINFOFUNCTION, curl_progress);
    SET_OPTION(CURLOPT_XFERINFODATA, f);
    SET_OPTION(CURLOPT_ACCEPT_ENCODING, "");
    for (size_t i = 0; i < f->header_count; i++) {
        char *header = dup_str(f->headers[i]);
        if (!header) { set_error(f, "out of memory preparing headers"); goto complete; }
        size_t length = strlen(header);
        if (length >= 2 && !strcmp(header + length - 2, ": ")) {
            header[length - 2] = ';'; header[length - 1] = 0;
        }
        struct curl_slist *next = curl_slist_append(headers, header);
        free(header);
        if (!next) { set_error(f, "out of memory preparing headers"); goto complete; }
        headers = next;
    }
    if (headers) SET_OPTION(CURLOPT_HTTPHEADER, headers);
    if (f->body) {
        SET_OPTION(CURLOPT_POSTFIELDS, f->body);
        SET_OPTION(CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)f->body_len);
    }
    if (!strcmp(f->method, "HEAD")) SET_OPTION(CURLOPT_NOBODY, 1L);
    SET_OPTION(CURLOPT_CUSTOMREQUEST, f->method);
    result = curl_easy_perform(curl);
    if (result == CURLE_OK) {
        long status = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
        f->status = (int)status; f->ok = status >= 200 && status < 300;
        char *url = NULL;
        curl_easy_getinfo(curl, CURLINFO_EFFECTIVE_URL, &url);
        f->final_url = dup_str(url ? url : f->url);
        if (!f->final_url) set_error(f, "out of memory storing response URL");
    }
complete:
    if (result != CURLE_OK && !f->error[0]) set_error(f, curl_easy_strerror(result));
    curl_easy_cleanup(curl);
    curl_slist_free_all(headers);
#undef SET_OPTION
}
#else
/* No bundled native HTTP client on non-Windows yet (Windows uses WinHTTP).
 * file:// requests still work via do_file(); remote fetch rejects clearly. */
static void do_http(PuFetch *f)
{
    set_error(f, "network fetch not supported on this platform yet");
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
    size_t length = 0;
    const char *s = JS_ToCStringLen(ctx, &length, body);
    JS_FreeValue(ctx, body);
    if (!s) return make_rejected(ctx, JS_GetException(ctx));
    JSValue parsed = JS_ParseJSON(ctx, s, length, "<fetch json>");
    if (s) JS_FreeCString(ctx, s);
    if (JS_IsException(parsed)) return make_rejected(ctx, JS_GetException(ctx));
    return make_resolved(ctx, parsed);
}

static void deliver_fetch(void *ctx)
{
    PuFetch *f = (PuFetch *)ctx;
    JSContext *jc = g_ctx;
    pu_thread_join(f->thread);
    unlink_fetch(f);

    if (f->error[0]) {
        JSValue err = JS_NewError(jc);
        JS_SetPropertyStr(jc, err, "message", JS_NewString(jc, f->error));
        JSValue r = JS_Call(jc, f->reject, JS_UNDEFINED, 1, &err);
        JS_FreeValue(jc, r);
        JS_FreeValue(jc, err);
    } else {
        JSValue res = JS_NewObject(jc);
        JS_SetPropertyStr(jc, res, "status", JS_NewInt32(jc, f->status));
        JS_SetPropertyStr(jc, res, "ok", JS_NewBool(jc, f->ok));
        JS_SetPropertyStr(jc, res, "url", JS_NewString(jc, f->final_url ? f->final_url : f->url));
        JS_SetPropertyStr(jc, res, "__body", JS_NewStringLen(jc, f->resp_body ? f->resp_body : "", f->resp_len));
        JS_SetPropertyStr(jc, res, "text", JS_NewCFunction(jc, js_response_text, "text", 0));
        JS_SetPropertyStr(jc, res, "json", JS_NewCFunction(jc, js_response_json, "json", 0));
        JSValue r = JS_Call(jc, f->resolve, JS_UNDEFINED, 1, &res);
        JS_FreeValue(jc, r);
        JS_FreeValue(jc, res);
    }

    free_fetch(f);
    pu_dispatch_unref(g_disp);
}

static void fetch_thread(void *arg)
{
    PuFetch *f = (PuFetch *)arg;
    if (cancelled(f)) set_error(f, "request cancelled");
    else if (strncmp(f->url, "file://", 7) == 0) do_file(f);
    else                                    do_http(f);
    if (cancelled(f)) set_error(f, "request cancelled");
    if (!pu_dispatch_post(g_disp, deliver_fetch, f)) {
        fprintf(stderr, "[fetch] Fatal: unable to schedule HTTP completion\n");
        abort();
    }
}

/* ---- fetch(url, options) ---------------------------------------------------*/

static int parse_headers(JSContext *ctx, JSValueConst object, PuFetch *f)
{
    if (!JS_IsObject(object) || JS_IsArray(object)) {
        JS_ThrowTypeError(ctx, "headers must be an object of header names and values"); return 0;
    }
    JSPropertyEnum *properties;
    uint32_t count;
    if (JS_GetOwnPropertyNames(ctx, &properties, &count, object, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) return 0;
    int ok = 1;
    for (uint32_t i = 0; i < count && ok; i++) {
        JSValue name_value = JS_AtomToString(ctx, properties[i].atom);
        if (JS_IsException(name_value)) { ok = 0; break; }
        size_t nl = 0, vl = 0;
        const char *name = JS_ToCStringLen(ctx, &nl, name_value);
        JS_FreeValue(ctx, name_value);
        if (!name) { ok = 0; break; }
        JSValue value = JS_GetProperty(ctx, object, properties[i].atom);
        const char *text = JS_IsException(value) ? NULL : JS_ToCStringLen(ctx, &vl, value);
        JS_FreeValue(ctx, value);
        if (!name || !text) ok = 0;
        else {
            int valid = token(name, nl);
            for (size_t j = 0; j < vl; j++)
                if (((unsigned char)text[j] < 32 && text[j] != '\t') || text[j] == 127) valid = 0;
            if (!valid) { JS_ThrowTypeError(ctx, "invalid HTTP header"); ok = 0; }
            else {
                char *header = malloc(nl + vl + 3);
                char **list = realloc(f->headers, (f->header_count + 1) * sizeof(char *));
                if (list) f->headers = list;
                if (!header || !list) { free(header); JS_ThrowOutOfMemory(ctx); ok = 0; }
                else {
                    memcpy(header, name, nl);
                    for (size_t j = 0; j < nl; j++)
                        if (header[j] >= 'A' && header[j] <= 'Z') header[j] += 'a' - 'A';
                    header[nl] = 0;
                    if (!strcmp(header, "host") || !strcmp(header, "content-length") ||
                        !strcmp(header, "transfer-encoding") || !strcmp(header, "connection") ||
                        !strcmp(header, "proxy-connection") || !strcmp(header, "upgrade")) {
                        free(header); JS_ThrowTypeError(ctx, "transport-managed header cannot be overridden"); ok = 0;
                    } else {
                        header[nl] = ':'; header[nl + 1] = ' ';
                        memcpy(header + nl + 2, text, vl); header[nl + vl + 2] = 0;
                        size_t position = f->header_count;
                        for (size_t j = 0; j < f->header_count; j++)
                            if (!strncmp(f->headers[j], header, nl + 1)) { position = j; break; }
                        if (position == f->header_count) f->header_count++;
                        else free(f->headers[position]);
                        f->headers[position] = header;
                    }
                }
            }
        }
        if (name) JS_FreeCString(ctx, name);
        if (text) JS_FreeCString(ctx, text);
    }
    for (uint32_t i = 0; i < count; i++) JS_FreeAtom(ctx, properties[i].atom);
    js_free(ctx, properties);
    return ok;
}

static JSValue js_fetch(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (ctx != g_ctx || !g_disp) return JS_ThrowInternalError(ctx, "fetch service is not running");
    if (argc < 1) return JS_ThrowTypeError(ctx, "fetch(url) requires a URL");

    PuFetch *f = (PuFetch *)calloc(1, sizeof(PuFetch));
    if (!f) return JS_ThrowOutOfMemory(ctx);
    f->resolve = f->reject = JS_UNDEFINED;

    size_t url_length = 0;
    const char *url = JS_ToCStringLen(ctx, &url_length, argv[0]);
    if (!url) { free_fetch(f); return JS_EXCEPTION; }
    if (strlen(url) != url_length || (!has_scheme(url, "http://") &&
        !has_scheme(url, "https://") && !has_scheme(url, "file://"))) {
        JS_FreeCString(ctx, url); free_fetch(f);
        return JS_ThrowTypeError(ctx, "fetch URL must use http://, https:// or file:// and contain no NUL");
    }
    f->url = dup_str(url);
    if (f->url) for (char *p = f->url; *p && *p != ':'; p++)
        if (*p >= 'A' && *p <= 'Z') *p += 'a' - 'A';
    if (url) JS_FreeCString(ctx, url);

    f->method = dup_str("GET");
    if (argc >= 2 && JS_IsObject(argv[1])) {
        const char *unsupported[] = { "signal", "redirect", "credentials", "mode", "cache" };
        for (size_t i = 0; i < sizeof(unsupported) / sizeof(unsupported[0]); i++) {
            JSValue option = JS_GetPropertyStr(ctx, argv[1], unsupported[i]);
            if (JS_IsException(option)) { free_fetch(f); return JS_EXCEPTION; }
            int present = !JS_IsUndefined(option) && !JS_IsNull(option);
            JS_FreeValue(ctx, option);
            if (present) {
                free_fetch(f);
                return JS_ThrowTypeError(ctx, "fetch option '%s' is not implemented", unsupported[i]);
            }
        }
        JSValue m = JS_GetPropertyStr(ctx, argv[1], "method");
        if (JS_IsException(m)) { free_fetch(f); return JS_EXCEPTION; }
        if (!JS_IsUndefined(m)) {
            if (!JS_IsString(m)) { JS_FreeValue(ctx, m); free_fetch(f); return JS_ThrowTypeError(ctx, "fetch method must be a string"); }
            size_t length;
            const char *ms = JS_ToCStringLen(ctx, &length, m);
            if (!ms) { JS_FreeValue(ctx, m); free_fetch(f); return JS_EXCEPTION; }
            if (strlen(ms) != length) {
                JS_FreeCString(ctx, ms); JS_FreeValue(ctx, m); free_fetch(f);
                return JS_ThrowTypeError(ctx, "HTTP method contains NUL");
            }
            free(f->method); f->method = dup_str(ms); JS_FreeCString(ctx, ms);
        }
        JS_FreeValue(ctx, m);
        JSValue b = JS_GetPropertyStr(ctx, argv[1], "body");
        if (JS_IsException(b)) { free_fetch(f); return JS_EXCEPTION; }
        if (!JS_IsUndefined(b)) {
            if (!JS_IsString(b)) { JS_FreeValue(ctx, b); free_fetch(f); return JS_ThrowTypeError(ctx, "fetch body must be a string"); }
            const char *bs = JS_ToCStringLen(ctx, &f->body_len, b);
            if (!bs) { JS_FreeValue(ctx, b); free_fetch(f); return JS_EXCEPTION; }
            f->body = malloc(f->body_len + 1);
            if (f->body) memcpy(f->body, bs, f->body_len + 1);
            JS_FreeCString(ctx, bs);
            if (!f->body) { JS_FreeValue(ctx, b); free_fetch(f); return JS_ThrowOutOfMemory(ctx); }
        }
        JS_FreeValue(ctx, b);
        JSValue headers = JS_GetPropertyStr(ctx, argv[1], "headers");
        int parsed = !JS_IsException(headers) &&
            (JS_IsUndefined(headers) || JS_IsNull(headers) || parse_headers(ctx, headers, f));
        JS_FreeValue(ctx, headers);
        if (!parsed) { free_fetch(f); return JS_EXCEPTION; }
    }
    if (!f->url || !f->method) { free_fetch(f); return JS_ThrowOutOfMemory(ctx); }
    if (!token(f->method, strlen(f->method))) { free_fetch(f); return JS_ThrowTypeError(ctx, "invalid HTTP method"); }

    JSValue funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, funcs);
    if (JS_IsException(promise)) { free_fetch(f); return promise; }
    f->resolve = funcs[0];
    f->reject  = funcs[1];

    pu_dispatch_ref(g_disp);
    f->next = g_requests;
    if (g_requests) g_requests->previous = f;
    g_requests = f;
    f->thread = pu_thread_start(fetch_thread, f);
    if (!f->thread) {
        set_error(f, "cannot start request thread");
        deliver_fetch(f);
    }
    return promise;
}

int pu_fetch_install(JSContext *ctx, PuDispatch *dispatch)
{
    if (g_ctx || !dispatch) { fprintf(stderr, "[fetch] Invalid runtime installation\n"); return 0; }
    g_mutex = pu_mutex_new();
    if (!g_mutex) { fprintf(stderr, "[fetch] Cannot create request mutex\n"); return 0; }
#if defined(__linux__)
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) {
        pu_mutex_free(g_mutex); g_mutex = NULL;
        fprintf(stderr, "[fetch] Cannot initialize libcurl\n"); return 0;
    }
#endif
    g_ctx = ctx;
    g_disp = dispatch;
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "fetch", JS_NewCFunction(ctx, js_fetch, "fetch", 2));
    JS_FreeValue(ctx, global);
    return 1;
}

void pu_fetch_shutdown(void)
{
    if (!g_ctx) return;
    pu_mutex_lock(g_mutex);
    for (PuFetch *f = g_requests; f; f = f->next) f->cancelled = 1;
    pu_mutex_unlock(g_mutex);
    while (g_requests) {
        PuFetch *f = g_requests;
        pu_thread_join(f->thread);
        pu_dispatch_remove(g_disp, deliver_fetch, f);
        unlink_fetch(f);
        free_fetch(f);
        pu_dispatch_unref(g_disp);
    }
    pu_mutex_free(g_mutex); g_mutex = NULL;
    g_ctx = NULL; g_disp = NULL;
#if defined(__linux__)
    curl_global_cleanup();
#endif
}
