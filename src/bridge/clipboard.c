#include "bridge/clipboard.h"
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#if defined(PU_CLIPBOARD_SDL)
#include <SDL3/SDL.h>
#elif defined(_WIN32)
#include <windows.h>
#endif

#define CLIPBOARD_LIMIT (16u * 1024u * 1024u)
#define CLIPBOARD_TYPES 16
static const char *text_type = "text/plain;charset=utf-8";
struct Item { char *type; uint8_t *data; size_t size; };
struct Payload { size_t count; struct Item items[CLIPBOARD_TYPES]; };
static struct Payload *memory_payload;
static char *memory_primary;
static int memory_mode;

static void free_payload(void *opaque)
{
    struct Payload *payload = opaque;
    if (!payload) return;
    for (size_t i = 0; i < payload->count; i++) { free(payload->items[i].type); free(payload->items[i].data); }
    free(payload);
}
static struct Item *find_item(struct Payload *payload, const char *type)
{
    if (payload) for (size_t i = 0; i < payload->count; i++)
        if (!strcmp(payload->items[i].type, type)) return &payload->items[i];
    return NULL;
}
static int ready(JSContext *ctx)
{
    if (memory_mode) return 1;
#if defined(PU_CLIPBOARD_SDL)
    if (!SDL_WasInit(SDL_INIT_VIDEO) || !SDL_GetKeyboardFocus()) {
        JS_ThrowTypeError(ctx, "Clipboard access requires a focused application window"); return 0;
    }
    return 1;
#elif defined(_WIN32)
    if (!GetActiveWindow()) { JS_ThrowTypeError(ctx, "Clipboard access requires an active application window"); return 0; }
    return 1;
#else
    JS_ThrowTypeError(ctx, "Clipboard is unavailable on this host"); return 0;
#endif
}
static const char *mime(JSContext *ctx, JSValueConst value)
{
    if (!JS_IsString(value)) { JS_ThrowTypeError(ctx, "A clipboard MIME type is required"); return NULL; }
    size_t length;
    const char *type = JS_ToCStringLen(ctx, &length, value);
    if (!type) return NULL;
    int valid = length > 0 && length <= 127;
    for (size_t i = 0; valid && i < length; i++)
        if ((unsigned char)type[i] < 32 || (unsigned char)type[i] > 126) valid = 0;
    if (!valid) {
        JS_FreeCString(ctx, type);
        JS_ThrowTypeError(ctx, "Invalid clipboard MIME type"); return NULL;
    }
    return type;
}

#if defined(PU_CLIPBOARD_SDL)
static const void *SDLCALL provide(void *opaque, const char *type, size_t *size)
{
    struct Item *item = find_item(opaque, type);
    *size = item ? item->size : 0;
    return item ? item->data : NULL;
}
static void SDLCALL release_payload(void *opaque) { free_payload(opaque); }
#endif

static JSValue offer(JSContext *ctx, struct Payload *payload)
{
    if (memory_mode) { free_payload(memory_payload); memory_payload = payload; return JS_UNDEFINED; }
#if defined(PU_CLIPBOARD_SDL)
    const char *types[CLIPBOARD_TYPES];
    for (size_t i = 0; i < payload->count; i++) types[i] = payload->items[i].type;
    if (!payload->count) {
        free_payload(payload);
        if (!SDL_ClearClipboardData()) return JS_ThrowInternalError(ctx, "Clipboard clear failed: %s", SDL_GetError());
        return JS_UNDEFINED;
    }
    /* SDL owns valid callback payloads even when the platform setter fails. */
    if (!SDL_SetClipboardData(provide, release_payload, payload, types, payload->count))
        return JS_ThrowInternalError(ctx, "Clipboard write failed: %s", SDL_GetError());
    return JS_UNDEFINED;
#elif defined(_WIN32)
    struct Item *item = find_item(payload, text_type);
    if (payload->count && (!item || payload->count != 1 || memchr(item->data, 0, item->size))) {
        free_payload(payload); return JS_ThrowTypeError(ctx, "The Win32 host supports UTF-8 clipboard text only");
    }
    int count = item && item->size ? MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
        (const char *)item->data, (int)item->size, NULL, 0) : 0;
    if (item && item->size && !count) { free_payload(payload); return JS_ThrowTypeError(ctx, "Invalid UTF-8 clipboard text"); }
    HGLOBAL handle = item ? GlobalAlloc(GMEM_MOVEABLE, ((size_t)count + 1) * sizeof(wchar_t)) : NULL;
    if (item && !handle) { free_payload(payload); return JS_ThrowOutOfMemory(ctx); }
    if (item) {
        wchar_t *wide = GlobalLock(handle);
        if (!wide) { GlobalFree(handle); free_payload(payload); return JS_ThrowInternalError(ctx, "Clipboard allocation failed"); }
        if (count) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)item->data, (int)item->size, wide, count);
        wide[count] = 0; GlobalUnlock(handle);
    }
    free_payload(payload);
    if (!OpenClipboard(GetActiveWindow())) { if (handle) GlobalFree(handle); return JS_ThrowInternalError(ctx, "Clipboard is busy"); }
    BOOL ok = EmptyClipboard();
    if (ok && handle) ok = SetClipboardData(CF_UNICODETEXT, handle) != NULL;
    CloseClipboard();
    if (!ok) { if (handle) GlobalFree(handle); return JS_ThrowInternalError(ctx, "Clipboard write failed"); }
    return JS_UNDEFINED;
#else
    free_payload(payload); return JS_ThrowTypeError(ctx, "Clipboard is unavailable");
#endif
}

static JSValue write_data(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!argc || !JS_IsArray(argv[0])) return JS_ThrowTypeError(ctx, "Clipboard data must be an array of {type,data}");
    if (!ready(ctx)) return JS_EXCEPTION;
    JSValue length = JS_GetPropertyStr(ctx, argv[0], "length");
    if (JS_IsException(length)) return length;
    uint32_t count;
    int ok = JS_ToUint32(ctx, &count, length);
    JS_FreeValue(ctx, length);
    if (ok < 0) return JS_EXCEPTION;
    if (count > CLIPBOARD_TYPES) return JS_ThrowRangeError(ctx, "Too many clipboard MIME types");
    struct Payload *payload = calloc(1, sizeof(*payload));
    if (!payload) return JS_ThrowOutOfMemory(ctx);
    size_t total = 0;
    for (uint32_t i = 0; i < count; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, argv[0], i);
        if (JS_IsException(item)) goto failed;
        if (!JS_IsObject(item)) { JS_FreeValue(ctx, item); JS_ThrowTypeError(ctx, "Invalid clipboard item"); goto failed; }
        JSValue type_value = JS_GetPropertyStr(ctx, item, "type");
        if (JS_IsException(type_value)) { JS_FreeValue(ctx, item); goto failed; }
        const char *type = mime(ctx, type_value);
        JS_FreeValue(ctx, type_value);
        if (!type) { JS_FreeValue(ctx, item); goto failed; }
        if (find_item(payload, type)) {
            JS_FreeCString(ctx, type); JS_FreeValue(ctx, item);
            JS_ThrowTypeError(ctx, "Duplicate clipboard MIME type"); goto failed;
        }
        JSValue data = JS_GetPropertyStr(ctx, item, "data");
        JS_FreeValue(ctx, item);
        if (JS_IsException(data)) { JS_FreeCString(ctx, type); goto failed; }
        size_t offset = 0, size = 0, storage_size = 0;
        bool direct = JS_IsArrayBuffer(data);
        JSValue buffer = direct ? JS_DupValue(ctx, data) : JS_GetTypedArrayBuffer(ctx, data, &offset, &size, NULL);
        JS_FreeValue(ctx, data);
        if (JS_IsException(buffer)) { JS_FreeCString(ctx, type); goto failed; }
        uint8_t *bytes = JS_GetArrayBuffer(ctx, &storage_size, buffer);
        if (direct) size = storage_size;
        if (!bytes) { JS_FreeValue(ctx, buffer); JS_FreeCString(ctx, type); goto failed; }
        if (offset > storage_size || size > storage_size - offset || size > CLIPBOARD_LIMIT - total) {
            JS_FreeValue(ctx, buffer); JS_FreeCString(ctx, type);
            JS_ThrowRangeError(ctx, "Clipboard payload exceeds 16 MiB"); goto failed;
        }
        struct Item *entry = &payload->items[payload->count++];
        entry->type = strdup(type); entry->data = malloc(size + 1); entry->size = size;
        if (entry->data) { memcpy(entry->data, bytes + offset, size); entry->data[size] = 0; }
        JS_FreeValue(ctx, buffer); JS_FreeCString(ctx, type);
        if (!entry->type || !entry->data) { JS_ThrowOutOfMemory(ctx); goto failed; }
        total += size;
    }
    return offer(ctx, payload);
failed:
    free_payload(payload); return JS_EXCEPTION;
}

static JSValue write_text(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int primary)
{
    (void)self;
    if (!argc || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "Clipboard text must be a string");
    if (!ready(ctx)) return JS_EXCEPTION;
    size_t length;
    const char *text = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!text) return JS_EXCEPTION;
    if (length > CLIPBOARD_LIMIT || memchr(text, 0, length)) {
        JS_FreeCString(ctx, text); return JS_ThrowRangeError(ctx, "Clipboard text exceeds 16 MiB or contains NUL");
    }
    if (primary) {
        JSValue result = JS_UNDEFINED;
        if (memory_mode) {
            char *copy = strdup(text);
            if (!copy) result = JS_ThrowOutOfMemory(ctx);
            else { free(memory_primary); memory_primary = copy; }
        }
#if defined(PU_CLIPBOARD_SDL) && defined(__linux__)
        else if (!SDL_SetPrimarySelectionText(text)) result = JS_ThrowInternalError(ctx, "Primary selection write failed: %s", SDL_GetError());
#else
        else result = JS_ThrowTypeError(ctx, "Primary selection is unavailable");
#endif
        JS_FreeCString(ctx, text); return result;
    }
    struct Payload *payload = calloc(1, sizeof(*payload));
    if (!payload) { JS_FreeCString(ctx, text); return JS_ThrowOutOfMemory(ctx); }
    payload->count = 1;
    payload->items[0].type = strdup(text_type);
    payload->items[0].data = malloc(length + 1);
    payload->items[0].size = length;
    if (payload->items[0].data) memcpy(payload->items[0].data, text, length + 1);
    JS_FreeCString(ctx, text);
    if (!payload->items[0].type || !payload->items[0].data) { free_payload(payload); return JS_ThrowOutOfMemory(ctx); }
    return offer(ctx, payload);
}

#if defined(_WIN32) && !defined(PU_CLIPBOARD_SDL)
static JSValue win32_text(JSContext *ctx, bool binary)
{
    if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return binary ? JS_NULL : JS_NewString(ctx, "");
    if (!OpenClipboard(GetActiveWindow())) return JS_ThrowInternalError(ctx, "Clipboard is busy");
    HANDLE handle = GetClipboardData(CF_UNICODETEXT);
    size_t size = handle ? GlobalSize(handle) : 0;
    const wchar_t *text = handle ? GlobalLock(handle) : NULL;
    JSValue result = JS_EXCEPTION;
    if (!text || !size || size > CLIPBOARD_LIMIT * 2) JS_ThrowInternalError(ctx, "Invalid or oversized clipboard text");
    else {
        size_t count = 0;
        while (count < size / sizeof(wchar_t) && text[count]) count++;
        if (count == size / sizeof(wchar_t)) JS_ThrowTypeError(ctx, "Clipboard text is not terminated");
        else {
            int length = count ? WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, (int)count, NULL, 0, NULL, NULL) : 0;
            char *bytes = length >= 0 && (size_t)length <= CLIPBOARD_LIMIT ? malloc((size_t)length + 1) : NULL;
            if (!bytes) JS_ThrowOutOfMemory(ctx);
            else if (count && !length) JS_ThrowTypeError(ctx, "Invalid Unicode clipboard text");
            else {
                if (length) WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, (int)count, bytes, length, NULL, NULL);
                result = binary ? JS_NewArrayBufferCopy(ctx, (uint8_t *)bytes, length) : JS_NewStringLen(ctx, bytes, length);
            }
            free(bytes);
        }
    }
    if (text) GlobalUnlock(handle);
    CloseClipboard();
    return result;
}
#endif

static JSValue read_data(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!argc) return JS_ThrowTypeError(ctx, "A MIME type is required");
    if (!ready(ctx)) return JS_EXCEPTION;
    const char *type = mime(ctx, argv[0]);
    if (!type) return JS_EXCEPTION;
    JSValue result = JS_NULL;
    if (memory_mode) {
        struct Item *item = find_item(memory_payload, type);
        if (item) result = JS_NewArrayBufferCopy(ctx, item->data, item->size);
    }
#if defined(PU_CLIPBOARD_SDL)
    else {
        SDL_ClearError();
        if (SDL_HasClipboardData(type)) {
            size_t size = 0;
            SDL_ClearError();
            void *bytes = SDL_GetClipboardData(type, &size);
            /* Wayland's successful zero-byte EOF has no allocation or SDL error. */
            if (*SDL_GetError() || (!bytes && size))
                result = JS_ThrowInternalError(ctx, "Clipboard read failed: %s", SDL_GetError());
            else if (size > CLIPBOARD_LIMIT) result = JS_ThrowRangeError(ctx, "Clipboard payload exceeds 16 MiB");
            else result = JS_NewArrayBufferCopy(ctx, bytes, size);
            SDL_free(bytes);
        } else if (*SDL_GetError()) result = JS_ThrowInternalError(ctx, "Clipboard query failed: %s", SDL_GetError());
    }
#elif defined(_WIN32)
    else if (!strcmp(type, text_type)) result = win32_text(ctx, true);
    else result = JS_ThrowTypeError(ctx, "The Win32 host supports UTF-8 clipboard text only");
#endif
    JS_FreeCString(ctx, type); return result;
}

static JSValue read_text(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int primary)
{
    (void)self; (void)argc; (void)argv;
    if (!ready(ctx)) return JS_EXCEPTION;
    if (memory_mode) {
        if (primary) return JS_NewString(ctx, memory_primary ? memory_primary : "");
        struct Item *item = find_item(memory_payload, text_type);
        if (!item) item = find_item(memory_payload, "text/plain");
        return JS_NewStringLen(ctx, item ? (const char *)item->data : "", item ? item->size : 0);
    }
#if defined(PU_CLIPBOARD_SDL)
    SDL_ClearError();
    if (primary) {
#if defined(__linux__)
        if (!SDL_HasPrimarySelectionText()) return *SDL_GetError() ?
            JS_ThrowInternalError(ctx, "Primary selection query failed: %s", SDL_GetError()) : JS_NewString(ctx, "");
        char *text = SDL_GetPrimarySelectionText();
        if (!text || *SDL_GetError()) {
            SDL_free(text);
            return JS_ThrowInternalError(ctx, "Primary selection read failed: %s", SDL_GetError());
        }
        JSValue result = strlen(text) > CLIPBOARD_LIMIT ? JS_ThrowRangeError(ctx, "Primary selection exceeds 16 MiB") : JS_NewString(ctx, text);
        SDL_free(text); return result;
#else
        return JS_ThrowTypeError(ctx, "Primary selection is unavailable");
#endif
    }
    const char *types[] = { "text/plain;charset=utf-8", "text/plain;charset=UTF-8", "text/plain", "UTF8_STRING" };
    for (size_t i = 0; i < sizeof(types) / sizeof(types[0]); i++) {
        if (!SDL_HasClipboardData(types[i])) continue;
        size_t size = 0;
        SDL_ClearError();
        void *bytes = SDL_GetClipboardData(types[i], &size);
        if (*SDL_GetError() || (!bytes && size)) {
            SDL_free(bytes);
            return JS_ThrowInternalError(ctx, "Clipboard text read failed: %s", SDL_GetError());
        }
        while (size && size <= CLIPBOARD_LIMIT && ((const char *)bytes)[size - 1] == '\0') size--;
        JSValue result = size > CLIPBOARD_LIMIT ? JS_ThrowRangeError(ctx, "Clipboard text exceeds 16 MiB") :
            JS_NewStringLen(ctx, bytes ? bytes : "", size);
        SDL_free(bytes); return result;
    }
    if (*SDL_GetError()) return JS_ThrowInternalError(ctx, "Clipboard text query failed: %s", SDL_GetError());
    return JS_NewString(ctx, "");
#elif defined(_WIN32)
    if (primary) return JS_ThrowTypeError(ctx, "Primary selection is unavailable");
    return win32_text(ctx, false);
#else
    return JS_ThrowTypeError(ctx, "Clipboard is unavailable");
#endif
}

static JSValue formats(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ready(ctx)) return JS_EXCEPTION;
    JSValue array = JS_NewArray(ctx);
    if (JS_IsException(array)) return array;
    if (memory_mode) {
        if (memory_payload) for (size_t i = 0; i < memory_payload->count; i++)
            if (JS_SetPropertyUint32(ctx, array, (uint32_t)i, JS_NewString(ctx, memory_payload->items[i].type)) < 0) {
                JS_FreeValue(ctx, array); return JS_EXCEPTION;
            }
    }
#if defined(PU_CLIPBOARD_SDL)
    else {
        size_t count = 0;
        char **types = SDL_GetClipboardMimeTypes(&count);
        if (!types || count > 256) {
            SDL_free(types); JS_FreeValue(ctx, array);
            return JS_ThrowInternalError(ctx, "Cannot enumerate clipboard MIME types");
        }
        for (size_t i = 0; i < count; i++)
            if (JS_SetPropertyUint32(ctx, array, (uint32_t)i, JS_NewString(ctx, types[i])) < 0) {
                SDL_free(types); JS_FreeValue(ctx, array); return JS_EXCEPTION;
            }
        SDL_free(types);
    }
#elif defined(_WIN32)
    else if (IsClipboardFormatAvailable(CF_UNICODETEXT)) JS_SetPropertyUint32(ctx, array, 0, JS_NewString(ctx, text_type));
#endif
    return array;
}

int pu_clipboard_install(JSContext *ctx, int memory_only)
{
    memory_mode = memory_only;
    JSValue object = JS_NewObject(ctx);
    if (JS_IsException(object)) return 0;
    int primary = memory_mode, data = memory_mode;
#if defined(PU_CLIPBOARD_SDL)
    data = 1;
#if defined(__linux__)
    primary = 1;
#endif
#endif
    int ok = JS_SetPropertyStr(ctx, object, "supportsPrimary", JS_NewBool(ctx, primary)) >= 0 &&
        JS_SetPropertyStr(ctx, object, "supportsFormats", JS_NewBool(ctx, data)) >= 0 &&
        JS_SetPropertyStr(ctx, object, "writeText", JS_NewCFunctionMagic(ctx, write_text, "writeText", 1, JS_CFUNC_generic_magic, 0)) >= 0 &&
        JS_SetPropertyStr(ctx, object, "readText", JS_NewCFunctionMagic(ctx, read_text, "readText", 0, JS_CFUNC_generic_magic, 0)) >= 0 &&
        JS_SetPropertyStr(ctx, object, "writePrimaryText", JS_NewCFunctionMagic(ctx, write_text, "writePrimaryText", 1, JS_CFUNC_generic_magic, 1)) >= 0 &&
        JS_SetPropertyStr(ctx, object, "readPrimaryText", JS_NewCFunctionMagic(ctx, read_text, "readPrimaryText", 0, JS_CFUNC_generic_magic, 1)) >= 0 &&
        JS_SetPropertyStr(ctx, object, "read", JS_NewCFunction(ctx, read_data, "read", 1)) >= 0 &&
        JS_SetPropertyStr(ctx, object, "write", JS_NewCFunction(ctx, write_data, "write", 1)) >= 0 &&
        JS_SetPropertyStr(ctx, object, "formats", JS_NewCFunction(ctx, formats, "formats", 0)) >= 0;
    JSValue global = JS_GetGlobalObject(ctx);
    if (ok) ok = JS_SetPropertyStr(ctx, global, "clipboard", object) >= 0;
    else JS_FreeValue(ctx, object);
    JS_FreeValue(ctx, global);
    return ok;
}

void pu_clipboard_shutdown(void)
{
    free_payload(memory_payload); memory_payload = NULL;
    free(memory_primary); memory_primary = NULL;
    memory_mode = 0;
}
