#include "script/storage.h"
#include "model/node.h"   /* reuse PuStyle as the string key/value map */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Single process-wide store (one localStorage per app, like the web). */
static PuStyle g_store;
static char   *g_path;

/* ---- file format: "PUST1\n" then, per entry, <len>\n<bytes>\n for key+value */

static void storage_load(void)
{
    if (!g_path) return;
    FILE *f = fopen(g_path, "rb");
    if (!f) return;
    char magic[8] = { 0 };
    if (!fgets(magic, sizeof(magic), f) || strncmp(magic, "PUST1", 5) != 0) { fclose(f); return; }
    for (;;) {
        long kl = 0, vl = 0;
        if (fscanf(f, "%ld", &kl) != 1 || kl < 0) break;
        fgetc(f);                                  /* '\n' after the length */
        char *k = (char *)malloc((size_t)kl + 1);
        if (!k || fread(k, 1, (size_t)kl, f) != (size_t)kl) { free(k); break; }
        k[kl] = 0; fgetc(f);
        if (fscanf(f, "%ld", &vl) != 1 || vl < 0) { free(k); break; }
        fgetc(f);
        char *v = (char *)malloc((size_t)vl + 1);
        if (!v || fread(v, 1, (size_t)vl, f) != (size_t)vl) { free(k); free(v); break; }
        v[vl] = 0; fgetc(f);
        pu_style_set(&g_store, k, v);
        free(k); free(v);
    }
    fclose(f);
}

static void storage_save(void)
{
    if (!g_path) return;
    FILE *f = fopen(g_path, "wb");
    if (!f) return;
    fputs("PUST1\n", f);
    for (int i = 0; i < g_store.count; i++) {
        const char *k = g_store.props[i].name, *v = g_store.props[i].value;
        fprintf(f, "%zu\n", strlen(k)); fwrite(k, 1, strlen(k), f); fputc('\n', f);
        fprintf(f, "%zu\n", strlen(v)); fwrite(v, 1, strlen(v), f); fputc('\n', f);
    }
    fclose(f);
}

/* ---- JS methods ------------------------------------------------------------*/

static JSValue js_ls_getItem(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    if (argc < 1) return JS_NULL;
    const char *k = JS_ToCString(ctx, argv[0]);
    const char *v = k ? pu_style_get(&g_store, k) : NULL;
    JSValue r = v ? JS_NewString(ctx, v) : JS_NULL;
    if (k) JS_FreeCString(ctx, k);
    return r;
}

static JSValue js_ls_setItem(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    if (argc < 2) return JS_UNDEFINED;
    const char *k = JS_ToCString(ctx, argv[0]);
    const char *v = JS_ToCString(ctx, argv[1]);
    if (k) { pu_style_set(&g_store, k, v ? v : ""); storage_save(); }
    if (k) JS_FreeCString(ctx, k);
    if (v) JS_FreeCString(ctx, v);
    return JS_UNDEFINED;
}

static JSValue js_ls_removeItem(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    if (argc < 1) return JS_UNDEFINED;
    const char *k = JS_ToCString(ctx, argv[0]);
    if (k) { pu_style_remove(&g_store, k); storage_save(); JS_FreeCString(ctx, k); }
    return JS_UNDEFINED;
}

static JSValue js_ls_clear(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    pu_style_clear(&g_store);
    storage_save();
    return JS_UNDEFINED;
}

static JSValue js_ls_key(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    int32_t i = -1;
    if (argc >= 1) JS_ToInt32(ctx, &i, argv[0]);
    if (i < 0 || i >= g_store.count) return JS_NULL;
    return JS_NewString(ctx, g_store.props[i].name);
}

static JSValue js_ls_get_length(JSContext *ctx, JSValueConst t)
{
    return JS_NewInt32(ctx, g_store.count);
}

void pu_storage_install(JSContext *ctx, const char *path)
{
    free(g_path);
    g_path = path ? _strdup(path) : NULL;
    pu_style_clear(&g_store);
    storage_load();

    JSValue ls = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, ls, "getItem",    JS_NewCFunction(ctx, js_ls_getItem,    "getItem",    1));
    JS_SetPropertyStr(ctx, ls, "setItem",    JS_NewCFunction(ctx, js_ls_setItem,    "setItem",    2));
    JS_SetPropertyStr(ctx, ls, "removeItem", JS_NewCFunction(ctx, js_ls_removeItem, "removeItem", 1));
    JS_SetPropertyStr(ctx, ls, "clear",      JS_NewCFunction(ctx, js_ls_clear,      "clear",      0));
    JS_SetPropertyStr(ctx, ls, "key",        JS_NewCFunction(ctx, js_ls_key,        "key",        1));

    JSAtom len = JS_NewAtom(ctx, "length");
    JSValue getter = JS_NewCFunction2(ctx, (JSCFunction *)js_ls_get_length, "length", 0, JS_CFUNC_getter, 0);
    JS_DefinePropertyGetSet(ctx, ls, len, getter, JS_UNDEFINED, JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
    JS_FreeAtom(ctx, len);

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "localStorage", ls);
    JS_FreeValue(ctx, global);
}

void pu_storage_shutdown(void)
{
    pu_style_clear(&g_store);
    free(g_store.props);
    g_store.props = NULL; g_store.cap = 0;
    free(g_path);
    g_path = NULL;
}
