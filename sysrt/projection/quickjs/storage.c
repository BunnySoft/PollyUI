#include "sysrt/projection/quickjs/storage.h"
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <sys/stat.h>
#else
#include <unistd.h>
#endif

typedef struct Entry {
    char *key, *value;
    size_t key_length, value_length;
} Entry;
typedef struct Store {
    Entry *entries;
    size_t count;
} Store;

static Store g_store;
static char *g_path;

static char *copy_bytes(const char *value, size_t length)
{
    if (length == SIZE_MAX) return NULL;
    char *copy = malloc(length + 1);
    if (copy) { memcpy(copy, value, length); copy[length] = 0; }
    return copy;
}

static void free_store(Store *store)
{
    for (size_t i = 0; i < store->count; i++) {
        free(store->entries[i].key); free(store->entries[i].value);
    }
    free(store->entries);
    *store = (Store){0};
}

static size_t find_entry(const Store *store, const char *key, size_t length)
{
    for (size_t i = 0; i < store->count; i++)
        if (store->entries[i].key_length == length && !memcmp(store->entries[i].key, key, length)) return i;
    return store->count;
}

static int put_entry(Store *store, const char *key, size_t kl, const char *value, size_t vl)
{
    char *copy = copy_bytes(value, vl);
    if (!copy) return 0;
    size_t index = find_entry(store, key, kl);
    if (index == store->count) {
        char *key_copy = copy_bytes(key, kl);
        if (!key_copy || store->count >= SIZE_MAX / sizeof(Entry) - 1) { free(key_copy); free(copy); return 0; }
        Entry *entries = realloc(store->entries, (store->count + 1) * sizeof(Entry));
        if (!entries) { free(key_copy); free(copy); return 0; }
        store->entries = entries;
        entries[index] = (Entry){ .key = key_copy, .key_length = kl };
        store->count++;
    }
    free(store->entries[index].value);
    store->entries[index].value = copy;
    store->entries[index].value_length = vl;
    return 1;
}

static int clone_store(Store *copy)
{
    *copy = (Store){0};
    for (size_t i = 0; i < g_store.count; i++) {
        const Entry *entry = &g_store.entries[i];
        if (!put_entry(copy, entry->key, entry->key_length, entry->value, entry->value_length)) {
            free_store(copy); return 0;
        }
    }
    return 1;
}

static int read_length(FILE *file, size_t *length, int allow_eof)
{
    char line[32];
    if (!fgets(line, sizeof(line), file)) return allow_eof && feof(file) ? 0 : -1;
    if (line[0] < '0' || line[0] > '9') return -1;
    errno = 0;
    char *end;
    unsigned long long value = strtoull(line, &end, 10);
    if (errno || strcmp(end, "\n") || value >= SIZE_MAX) return -1;
    *length = (size_t)value;
    return 1;
}

static char *read_bytes(FILE *file, size_t length)
{
    char *value = malloc(length + 1);
    if (!value) { errno = ENOMEM; return NULL; }
    if (fread(value, 1, length, file) != length || fgetc(file) != '\n') {
        free(value); errno = EINVAL; return NULL;
    }
    value[length] = 0;
    return value;
}

static int load_store(void)
{
    FILE *file = fopen(g_path, "rb");
    if (!file) return errno == ENOENT;
    errno = 0;
    char magic[7];
    int ok = fgets(magic, sizeof(magic), file) && !strcmp(magic, "PUST1\n");
    while (ok) {
        size_t kl, vl;
        int result = read_length(file, &kl, 1);
        if (!result) break;
        if (result < 0) { ok = 0; break; }
        char *key = read_bytes(file, kl);
        char *value = NULL;
        if (key && read_length(file, &vl, 0) == 1) value = read_bytes(file, vl);
        ok = key && value && put_entry(&g_store, key, kl, value, vl);
        free(key); free(value);
    }
    if (ferror(file)) ok = 0;
    int error = errno;
    fclose(file);
    if (!ok) errno = error ? error : EINVAL;
    return ok;
}

static int write_store(FILE *file, const Store *store)
{
    if (fputs("PUST1\n", file) == EOF) return 0;
    for (size_t i = 0; i < store->count; i++) {
        const Entry *entry = &store->entries[i];
        if (fprintf(file, "%zu\n", entry->key_length) < 0 ||
            fwrite(entry->key, 1, entry->key_length, file) != entry->key_length ||
            fprintf(file, "\n%zu\n", entry->value_length) < 0 ||
            fwrite(entry->value, 1, entry->value_length, file) != entry->value_length ||
            fputc('\n', file) == EOF) return 0;
    }
    return 1;
}

static int save_store(const Store *store)
{
    size_t length = strlen(g_path) + sizeof(".tmp.XXXXXX");
    char *temporary = malloc(length);
    if (!temporary) { errno = ENOMEM; return 0; }
    snprintf(temporary, length, "%s.tmp.XXXXXX", g_path);
    int fd;
#ifdef _WIN32
    if (_mktemp_s(temporary, length) != 0) { free(temporary); return 0; }
    fd = _open(temporary, _O_CREAT | _O_EXCL | _O_WRONLY | _O_BINARY, _S_IREAD | _S_IWRITE);
    FILE *file = fd < 0 ? NULL : _fdopen(fd, "wb");
#else
    fd = mkstemp(temporary);
    FILE *file = fd < 0 ? NULL : fdopen(fd, "wb");
#endif
    int ok = file && write_store(file, store) && fflush(file) == 0;
    if (ok) {
#ifdef _WIN32
        ok = _commit(fd) == 0;
#else
        ok = fsync(fd) == 0;
#endif
    }
    int error = errno;
    if (file) { if (fclose(file) != 0) { ok = 0; error = errno; } }
    else if (fd >= 0) {
#ifdef _WIN32
        _close(fd);
#else
        close(fd);
#endif
    }
    if (ok) {
#ifdef _WIN32
        ok = MoveFileExA(temporary, g_path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
        if (!ok) error = EIO;
#else
        ok = rename(temporary, g_path) == 0;
        if (!ok) error = errno;
#endif
    }
    if (!ok && fd >= 0) remove(temporary);
    free(temporary);
    if (!ok) errno = error ? error : EIO;
    return ok;
}

static JSValue commit_store(JSContext *ctx, Store *next)
{
    if (!save_store(next)) {
        int error = errno;
        free_store(next);
        return JS_ThrowInternalError(ctx, "localStorage write failed: %s", strerror(error));
    }
    free_store(&g_store);
    g_store = *next;
    return JS_UNDEFINED;
}

static JSValue js_get(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!argc) return JS_ThrowTypeError(ctx, "getItem requires a key");
    size_t length;
    const char *key = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!key) return JS_EXCEPTION;
    size_t index = find_entry(&g_store, key, length);
    JS_FreeCString(ctx, key);
    return index == g_store.count ? JS_NULL :
        JS_NewStringLen(ctx, g_store.entries[index].value, g_store.entries[index].value_length);
}

static JSValue js_set(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (argc < 2) return JS_ThrowTypeError(ctx, "setItem requires a key and value");
    size_t kl, vl;
    const char *key = JS_ToCStringLen(ctx, &kl, argv[0]);
    if (!key) return JS_EXCEPTION;
    const char *value = JS_ToCStringLen(ctx, &vl, argv[1]);
    if (!value) { JS_FreeCString(ctx, key); return JS_EXCEPTION; }
    Store next;
    int ok = clone_store(&next) && put_entry(&next, key, kl, value, vl);
    JS_FreeCString(ctx, key); JS_FreeCString(ctx, value);
    if (!ok) { free_store(&next); return JS_ThrowOutOfMemory(ctx); }
    return commit_store(ctx, &next);
}

static JSValue js_remove(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!argc) return JS_ThrowTypeError(ctx, "removeItem requires a key");
    size_t length;
    const char *key = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!key) return JS_EXCEPTION;
    size_t index = find_entry(&g_store, key, length);
    JS_FreeCString(ctx, key);
    if (index == g_store.count) return JS_UNDEFINED;
    Store next;
    if (!clone_store(&next)) return JS_ThrowOutOfMemory(ctx);
    free(next.entries[index].key); free(next.entries[index].value);
    memmove(next.entries + index, next.entries + index + 1, (--next.count - index) * sizeof(Entry));
    return commit_store(ctx, &next);
}

static JSValue js_clear(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    Store next = {0};
    return commit_store(ctx, &next);
}

static JSValue js_key(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    int64_t index;
    if (!argc || JS_ToInt64(ctx, &index, argv[0]) < 0) return argc ? JS_EXCEPTION : JS_NULL;
    if (index < 0 || (uint64_t)index >= g_store.count) return JS_NULL;
    return JS_NewStringLen(ctx, g_store.entries[index].key, g_store.entries[index].key_length);
}

static JSValue js_length(JSContext *ctx, JSValueConst self)
{
    (void)self;
    return JS_NewInt64(ctx, (int64_t)g_store.count);
}

int pu_storage_install(JSContext *ctx, const char *path)
{
    pu_storage_shutdown();
    if (!path) { fprintf(stderr, "[storage] A storage path is required\n"); return 0; }
    g_path = copy_bytes(path, strlen(path));
    if (!g_path || !load_store()) {
        fprintf(stderr, "[storage] Cannot load localStorage: %s\n", strerror(errno));
        pu_storage_shutdown(); return 0;
    }
    JSValue store = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, store, "getItem", JS_NewCFunction(ctx, js_get, "getItem", 1));
    JS_SetPropertyStr(ctx, store, "setItem", JS_NewCFunction(ctx, js_set, "setItem", 2));
    JS_SetPropertyStr(ctx, store, "removeItem", JS_NewCFunction(ctx, js_remove, "removeItem", 1));
    JS_SetPropertyStr(ctx, store, "clear", JS_NewCFunction(ctx, js_clear, "clear", 0));
    JS_SetPropertyStr(ctx, store, "key", JS_NewCFunction(ctx, js_key, "key", 1));
    JSAtom atom = JS_NewAtom(ctx, "length");
    JSValue getter = JS_NewCFunction2(ctx, (JSCFunction *)js_length, "length", 0, JS_CFUNC_getter, 0);
    JS_DefinePropertyGetSet(ctx, store, atom, getter, JS_UNDEFINED, JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
    JS_FreeAtom(ctx, atom);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "localStorage", store);
    JS_FreeValue(ctx, global);
    return 1;
}

void pu_storage_shutdown(void)
{
    free_store(&g_store);
    free(g_path); g_path = NULL;
}
