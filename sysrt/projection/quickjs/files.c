#include "sysrt/projection/quickjs/files.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *error_code(int error)
{
    switch (error) {
    case EACCES: return "EACCES"; case EPERM: return "EPERM"; case ENOENT: return "ENOENT";
    case EEXIST: return "EEXIST"; case ESTALE: return "ESTALE"; case EINVAL: return "EINVAL";
    case EFBIG: return "EFBIG"; case ELOOP: return "ELOOP"; case ENOTDIR: return "ENOTDIR";
    case ENAMETOOLONG: return "ENAMETOOLONG"; case EILSEQ: return "EILSEQ";
    case ENOSPC: return "ENOSPC"; case EROFS: return "EROFS"; case ENOMEM: return "ENOMEM";
    default: return "EIO";
    }
}

static JSValue failure(JSContext *ctx, const char *operation)
{
    int error = errno;
    JSValue value = JS_NewError(ctx);
    if (JS_IsException(value)) return value;
    JS_SetPropertyStr(ctx, value, "message", JS_NewString(ctx, strerror(error)));
    JS_SetPropertyStr(ctx, value, "code", JS_NewString(ctx, error_code(error)));
    JS_SetPropertyStr(ctx, value, "operation", JS_NewString(ctx, operation));
    return JS_Throw(ctx, value);
}

static int property(JSContext *ctx, JSValueConst object, const char *name, JSValue value)
{
    return !JS_IsException(value) && JS_SetPropertyStr(ctx, object, name, value) >= 0;
}

static const char *string(JSContext *ctx, JSValueConst value, size_t limit)
{
    if (!JS_IsString(value)) { JS_ThrowTypeError(ctx, "File API requires explicit string arguments"); return NULL; }
    size_t length;
    const char *text = JS_ToCStringLen(ctx, &length, value);
    if (!text) return NULL;
    if (length > limit || memchr(text, 0, length)) {
        JS_FreeCString(ctx, text);
        JS_ThrowRangeError(ctx, "File API string exceeds its bound or contains NUL");
        return NULL;
    }
    return text;
}

static JSValue entry_value(JSContext *ctx, const PuFileEntry *entry)
{
    JSValue value = JS_NewObject(ctx);
    if (JS_IsException(value)) return value;
#define SET(key, expression) do { if (!property(ctx, value, key, expression)) goto failed; } while (0)
    SET("name", JS_NewString(ctx, entry->name)); SET("path", JS_NewString(ctx, entry->path));
    SET("identity", JS_NewString(ctx, entry->identity)); SET("type", JS_NewString(ctx, entry->type));
    SET("permissions", JS_NewString(ctx, entry->permissions)); SET("bytes", JS_NewFloat64(ctx, (double)entry->bytes));
    SET("mtimeMs", JS_NewFloat64(ctx, entry->mtime_ms));
    SET("uid", JS_NewUint32(ctx, entry->uid)); SET("gid", JS_NewUint32(ctx, entry->gid));
    SET("readable", JS_NewBool(ctx, entry->readable)); SET("writable", JS_NewBool(ctx, entry->writable));
    SET("linkTarget", JS_NewString(ctx, entry->link_target));
    SET("targetType", JS_NewString(ctx, entry->target_type));
    SET("targetIdentity", JS_NewString(ctx, entry->target_identity));
    SET("contentIdentity", JS_NewString(ctx, entry->content_identity));
    SET("targetError", entry->target_error ? JS_NewString(ctx, error_code(entry->target_error)) : JS_NULL);
#undef SET
    return value;
failed:
    JS_FreeValue(ctx, value); return JS_EXCEPTION;
}

enum { LIST, STAT, READ, WRITE, MKDIR, RENAME, REPLACE, OBSERVE };
static JSValue request(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int operation)
{
    (void)self;
    const int counts[] = { 2, 2, 2, 4, 3, 4, 4, 1 };
    if (argc != counts[operation]) return JS_ThrowTypeError(ctx, "Wrong file API argument count");
    const char *args[4] = { NULL };
    for (int i = 0; i < argc; i++) {
        if (operation == STAT && i == 1) {
            if (!JS_IsBool(argv[i])) { JS_ThrowTypeError(ctx, "stat followLinks must be boolean"); goto failed; }
            continue;
        }
        if (operation == LIST && i == 1 && JS_IsNull(argv[i])) continue;
        size_t limit = ((operation == WRITE && i == 2) || (operation == REPLACE && i == 1)) ?
            PU_FILES_TEXT : PU_FILES_PATH - 1;
        args[i] = string(ctx, argv[i], limit);
        if (!args[i]) goto failed;
    }
    PuFileEntry entry;
    JSValue value;
    int result;
    if (operation == LIST) {
        PuFileDirectory snapshot;
        result = pu_files_list(args[0], args[1], &snapshot);
        if (result) value = failure(ctx, "listDirectory");
        else {
            value = JS_NewObject(ctx);
            JSValue entries = JS_NewArray(ctx);
            if (!JS_IsException(value) && !JS_IsException(entries)) {
                int ok = 1;
                for (size_t i = 0; i < snapshot.count && ok; i++) {
                    JSValue item = entry_value(ctx, &snapshot.entries[i]);
                    ok = !JS_IsException(item) && JS_SetPropertyUint32(ctx, entries, (uint32_t)i, item) >= 0;
                }
                ok = ok && property(ctx, value, "version", JS_NewInt32(ctx, 1)) &&
                    property(ctx, value, "path", JS_NewString(ctx, snapshot.path)) &&
                    property(ctx, value, "identity", JS_NewString(ctx, snapshot.identity)) &&
                    property(ctx, value, "complete", JS_NewBool(ctx, snapshot.complete));
                if (ok) ok = property(ctx, value, "entries", JS_DupValue(ctx, entries));
                JS_FreeValue(ctx, entries);
                if (!ok) { JS_FreeValue(ctx, value); value = JS_EXCEPTION; }
            } else { JS_FreeValue(ctx, entries); JS_FreeValue(ctx, value); value = JS_EXCEPTION; }
            pu_files_list_free(&snapshot);
        }
    } else if (operation == READ) {
        char *text; size_t length;
        result = pu_files_read(args[0], args[1], &text, &length, &entry);
        value = result ? failure(ctx, "readText") : entry_value(ctx, &entry);
        if (!result) {
            if (!JS_IsException(value) && !property(ctx, value, "text", JS_NewStringLen(ctx, text, length))) {
                JS_FreeValue(ctx, value); value = JS_EXCEPTION;
            }
            if (!JS_IsException(value) && !strncmp(args[1], "sha256:", 7) &&
                (!property(ctx, value, "metadataIdentity", JS_NewString(ctx, entry.identity)) ||
                 !property(ctx, value, "identity", JS_NewString(ctx, entry.content_identity)))) {
                JS_FreeValue(ctx, value); value = JS_EXCEPTION;
            }
            free(text);
        }
    } else {
        switch (operation) {
        case STAT: result = pu_files_stat(args[0], JS_ToBool(ctx, argv[1]), &entry); break;
        case WRITE: result = pu_files_write(args[0], args[1], args[2], strlen(args[2]), args[3], &entry); break;
        case MKDIR: result = pu_files_mkdir(args[0], args[1], args[2], &entry); break;
        case REPLACE: result = pu_files_replace(args[0], args[1], strlen(args[1]), args[2], args[3], &entry); break;
        case OBSERVE: result = pu_files_observe_text(args[0], &entry); break;
        default: result = pu_files_rename(args[0], args[1], args[2], args[3], &entry); break;
        }
        value = result ? failure(ctx, operation == STAT ? "stat" : operation == WRITE ? "writeText" :
            operation == MKDIR ? "createDirectory" : operation == REPLACE ? "replaceText" :
            operation == OBSERVE ? "observeText" : "rename") : entry_value(ctx, &entry);
        if (!result && operation == OBSERVE && !JS_IsException(value) &&
            (!property(ctx, value, "metadataIdentity", JS_NewString(ctx, entry.identity)) ||
             !property(ctx, value, "identity", JS_NewString(ctx, entry.content_identity)))) {
            JS_FreeValue(ctx, value); value = JS_EXCEPTION;
        }
    }
    for (int i = 0; i < argc; i++) JS_FreeCString(ctx, args[i]);
    return value;
failed:
    for (int i = 0; i < argc; i++) JS_FreeCString(ctx, args[i]);
    return JS_EXCEPTION;
}

static JSValue locations(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    PuFileLocations locations;
    if (pu_files_locations(&locations)) return failure(ctx, "locations");
    JSValue value = JS_NewObject(ctx);
    if (JS_IsException(value)) return value;
    const char *keys[] = { "home", "documents", "downloads", "desktop" };
    const char *paths[] = { locations.home, locations.documents, locations.downloads, locations.desktop };
    for (size_t i = 0; i < 4; i++) {
        if (!property(ctx, value, keys[i], JS_NewString(ctx, paths[i]))) {
            JS_FreeValue(ctx, value); return JS_EXCEPTION;
        }
    }
    return value;
}

int pu_files_install(JSContext *ctx, JSValueConst api)
{
    JSValue value = JS_NewObject(ctx);
    if (JS_IsException(value)) return 0;
    const char *names[] = { "listDirectory", "stat", "readText", "writeText", "createDirectory", "rename", "replaceText", "observeText" };
    const int counts[] = { 2, 2, 2, 4, 3, 4, 4, 1 };
    for (int i = 0; i < 8; i++)
        if (JS_SetPropertyStr(ctx, value, names[i], JS_NewCFunctionMagic(ctx, request, names[i], counts[i], JS_CFUNC_generic_magic, i)) < 0)
            goto failed;
    if (JS_SetPropertyStr(ctx, value, "version", JS_NewInt32(ctx, 1)) < 0 ||
        JS_SetPropertyStr(ctx, value, "implementation", JS_NewString(ctx, "posix-ordinary-v1")) < 0 ||
        JS_SetPropertyStr(ctx, value, "maxEntries", JS_NewInt32(ctx, PU_FILES_COUNT)) < 0 ||
        JS_SetPropertyStr(ctx, value, "maxTextBytes", JS_NewInt32(ctx, PU_FILES_TEXT)) < 0 ||
        JS_SetPropertyStr(ctx, value, "overwrite", JS_TRUE) < 0 ||
        JS_SetPropertyStr(ctx, value, "textObservation", JS_NewString(ctx, "sha256-v1")) < 0 ||
        JS_SetPropertyStr(ctx, value, "locations", JS_NewCFunction(ctx, locations, "locations", 0)) < 0) goto failed;
    return JS_SetPropertyStr(ctx, api, "fileSystem", value) >= 0;
failed:
    JS_FreeValue(ctx, value); return 0;
}
