#include "sysrt/ffi/ffi.h"
#include <ffi.h>
#include <errno.h>
#include <float.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

#define SR_MAX_ARGS 16
#define SR_MAX_BYTES (16u * 1024u * 1024u)
typedef enum {
    T_VOID, T_I8, T_U8, T_I16, T_U16, T_I32, T_U32, T_I64, T_U64,
    T_FLOAT, T_DOUBLE, T_POINTER, T_CSTRING
} Type;
typedef union {
    ffi_arg word;
    int8_t i8; uint8_t u8; int16_t i16; uint16_t u16;
    int32_t i32; uint32_t u32; int64_t i64; uint64_t u64;
    float f32; double f64; void *pointer;
} Value;
typedef struct Library {
    void *handle;
    unsigned refs;
    int closed, wrapped;
    JSClassID function_class, pointer_class;
} Library;
typedef struct Memory {
    uint8_t *bytes;
    size_t size;
    unsigned refs;
    int closed;
} Memory;
typedef struct Pointer {
    void *address;
    size_t length;
    Memory *memory;
    Library *library;
    int closed, owns;
} Pointer;
typedef struct Function {
    Library *library;
    void (*code)(void);
    ffi_cif cif;
    Type result, params[SR_MAX_ARGS];
    ffi_type *types[SR_MAX_ARGS];
    unsigned count;
    int closed;
    JSClassID pointer_class;
} Function;

typedef struct Classes { JSClassID library, function, pointer; } Classes;

static JSValue error(JSContext *ctx, const char *code, const char *message)
{
    JSValue value = JS_NewError(ctx);
    if (JS_IsException(value)) return value;
    if (JS_SetPropertyStr(ctx, value, "code", JS_NewString(ctx, code)) < 0 ||
        JS_SetPropertyStr(ctx, value, "message", JS_NewString(ctx, message)) < 0) {
        JS_FreeValue(ctx, value); return JS_EXCEPTION;
    }
    return JS_Throw(ctx, value);
}

static int unload(Library *library)
{
    if (!library->handle) return 1;
#ifdef _WIN32
    int ok = FreeLibrary((HMODULE)library->handle) != 0;
#else
    int ok = dlclose(library->handle) == 0;
#endif
    if (ok) library->handle = NULL;
    return ok;
}

static void release_library(Library *library)
{
    if (!library) return;
    unsigned refs = --library->refs;
    if ((!refs || (library->closed && library->wrapped && refs == 1)) && !unload(library))
        fprintf(stderr, "[ffi] Cannot unload native library\n");
    if (!refs) free(library);
}

static void release_memory(Memory *memory)
{
    if (memory && !--memory->refs) { free(memory->bytes); free(memory); }
}

static Memory *new_memory(size_t size)
{
    Memory *memory = calloc(1, sizeof(*memory));
    if (!memory) return NULL;
    memory->bytes = calloc(size ? size : 1, 1);
    if (!memory->bytes) { free(memory); return NULL; }
    memory->size = size; memory->refs = 1;
    return memory;
}

static void library_finalizer(JSRuntime *rt, JSValue value)
{
    (void)rt;
    Library *library = JS_GetOpaque(value, JS_GetClassID(value));
    if (library) { library->wrapped = 0; release_library(library); }
}

static void function_finalizer(JSRuntime *rt, JSValue value)
{
    (void)rt;
    Function *function = JS_GetOpaque(value, JS_GetClassID(value));
    if (function) { release_library(function->library); free(function); }
}

static void pointer_finalizer(JSRuntime *rt, JSValue value)
{
    (void)rt;
    Pointer *pointer = JS_GetOpaque(value, JS_GetClassID(value));
    if (pointer) {
        release_memory(pointer->memory); release_library(pointer->library); free(pointer);
    }
}

static int pointer_live(JSContext *ctx, Pointer *pointer)
{
    if (pointer->closed || (pointer->memory && pointer->memory->closed) ||
        (pointer->library && pointer->library->closed)) {
        error(ctx, "ERR_FFI_CLOSED", "Native pointer or its owner is closed"); return 0;
    }
    return 1;
}

static JSValue new_pointer(JSContext *ctx, JSClassID class_id, void *address, size_t length,
                           Memory *memory, Library *library, int owns)
{
    if (!address) return JS_NULL;
    Pointer *pointer = calloc(1, sizeof(*pointer));
    if (!pointer) return JS_ThrowOutOfMemory(ctx);
    JSValue value = JS_NewObjectClass(ctx, class_id);
    if (JS_IsException(value)) { free(pointer); return value; }
    pointer->address = address; pointer->length = length;
    pointer->memory = memory; pointer->library = library; pointer->owns = owns;
    if (memory) memory->refs++;
    if (library) library->refs++;
    JS_SetOpaque(value, pointer);
    return value;
}

static const char *text(JSContext *ctx, JSValueConst value, size_t maximum)
{
    if (!JS_IsString(value)) { JS_ThrowTypeError(ctx, "FFI requires an explicit string"); return NULL; }
    size_t length;
    const char *s = JS_ToCStringLen(ctx, &length, value);
    if (!s) return NULL;
    if (length > maximum || memchr(s, 0, length)) {
        JS_FreeCString(ctx, s);
        JS_ThrowRangeError(ctx, "FFI string exceeds its bound or contains NUL"); return NULL;
    }
    return s;
}

static int index_value(JSContext *ctx, JSValueConst value, size_t maximum, size_t *result)
{
    double number;
    if (!JS_IsNumber(value) || JS_ToFloat64(ctx, &number, value) < 0 ||
        !isfinite(number) || number < 0 || number > (double)maximum || floor(number) != number) {
        JS_ThrowRangeError(ctx, "Expected a bounded nonnegative integer"); return 0;
    }
    *result = (size_t)number; return 1;
}

static int type_value(JSContext *ctx, JSValueConst value, Type *result)
{
    const char *s = text(ctx, value, 16);
    if (!s) return 0;
    static const char *names[] = { "void", "i8", "u8", "i16", "u16", "i32", "u32",
        "i64", "u64", "float", "double", "pointer", "cstring" };
    int found = 0;
    for (unsigned i = 0; i < sizeof(names) / sizeof(*names); i++)
        if (!strcmp(s, names[i])) { *result = (Type)i; found = 1; break; }
    if (!strcmp(s, "size")) { *result = sizeof(size_t) == 8 ? T_U64 : T_U32; found = 1; }
    if (!strcmp(s, "ssize")) { *result = sizeof(size_t) == 8 ? T_I64 : T_I32; found = 1; }
    if (!strcmp(s, "long")) { *result = sizeof(long) == 8 ? T_I64 : T_I32; found = 1; }
    if (!strcmp(s, "ulong")) { *result = sizeof(long) == 8 ? T_U64 : T_U32; found = 1; }
    JS_FreeCString(ctx, s);
    if (!found) JS_ThrowTypeError(ctx, "Unsupported FFI type");
    return found;
}

static ffi_type *native_type(Type type)
{
    static ffi_type *types[] = { &ffi_type_void, &ffi_type_sint8, &ffi_type_uint8,
        &ffi_type_sint16, &ffi_type_uint16, &ffi_type_sint32, &ffi_type_uint32,
        &ffi_type_sint64, &ffi_type_uint64, &ffi_type_float, &ffi_type_double,
        &ffi_type_pointer, &ffi_type_pointer };
    return types[type];
}

static int integer64(JSContext *ctx, JSValueConst input, int sign, Value *value)
{
    if (JS_IsNumber(input)) {
        double number;
        if (JS_ToFloat64(ctx, &number, input) < 0 || !isfinite(number) ||
            fabs(number) > 9007199254740991.0 || floor(number) != number || (!sign && number < 0)) {
            JS_ThrowRangeError(ctx, "Use BigInt for exact 64-bit integers"); return 0;
        }
        if (sign) value->i64 = (int64_t)number; else value->u64 = (uint64_t)number;
        return 1;
    }
    if (!JS_IsBigInt(input)) { JS_ThrowTypeError(ctx, "64-bit FFI arguments require Number or BigInt"); return 0; }
    size_t length;
    const char *s = JS_ToCStringLen(ctx, &length, input);
    if (!s) return 0;
    if (length > 20) {
        JS_FreeCString(ctx, s); JS_ThrowRangeError(ctx, "FFI integer exceeds 64 bits"); return 0;
    }
    char *end;
    errno = 0;
    if (sign) value->i64 = strtoll(s, &end, 10); else value->u64 = strtoull(s, &end, 10);
    int valid = errno != ERANGE && *s && !*end && (sign || s[0] != '-');
    JS_FreeCString(ctx, s);
    if (!valid) JS_ThrowRangeError(ctx, "FFI integer is outside the declared 64-bit range");
    return valid;
}

static int convert(JSContext *ctx, Type type, JSValueConst input, Value *value,
                   Memory **temporary, JSClassID pointer_class)
{
    if (type == T_I64 || type == T_U64) return integer64(ctx, input, type == T_I64, value);
    if (type == T_POINTER) {
        if (JS_IsNull(input)) { value->pointer = NULL; return 1; }
        Pointer *pointer = JS_GetOpaque2(ctx, input, pointer_class);
        if (!pointer || !pointer_live(ctx, pointer)) return 0;
        value->pointer = pointer->address; return 1;
    }
    if (type == T_CSTRING) {
        const char *s = text(ctx, input, SR_MAX_BYTES - 1);
        if (!s) return 0;
        size_t size = strlen(s) + 1;
        *temporary = new_memory(size);
        if (*temporary) memcpy((*temporary)->bytes, s, size);
        JS_FreeCString(ctx, s);
        if (!*temporary) { JS_ThrowOutOfMemory(ctx); return 0; }
        value->pointer = (*temporary)->bytes; return 1;
    }
    double number;
    if (!JS_IsNumber(input) || JS_ToFloat64(ctx, &number, input) < 0) {
        JS_ThrowTypeError(ctx, "FFI numeric arguments must be explicit numbers"); return 0;
    }
    if (type == T_FLOAT) {
        if (isfinite(number) && fabs(number) > FLT_MAX) { JS_ThrowRangeError(ctx, "FFI float overflow"); return 0; }
        value->f32 = (float)number; return 1;
    }
    if (type == T_DOUBLE) { value->f64 = number; return 1; }
    double low = 0, high = 0;
    switch (type) {
    case T_I8: low = INT8_MIN; high = INT8_MAX; break;
    case T_U8: high = UINT8_MAX; break;
    case T_I16: low = INT16_MIN; high = INT16_MAX; break;
    case T_U16: high = UINT16_MAX; break;
    case T_I32: low = INT32_MIN; high = INT32_MAX; break;
    case T_U32: high = UINT32_MAX; break;
    default: JS_ThrowTypeError(ctx, "Invalid FFI argument type"); return 0;
    }
    if (!isfinite(number) || floor(number) != number || number < low || number > high) {
        JS_ThrowRangeError(ctx, "FFI integer is outside the declared range"); return 0;
    }
    switch (type) {
    case T_I8: value->i8 = (int8_t)number; break; case T_U8: value->u8 = (uint8_t)number; break;
    case T_I16: value->i16 = (int16_t)number; break; case T_U16: value->u16 = (uint16_t)number; break;
    case T_I32: value->i32 = (int32_t)number; break; case T_U32: value->u32 = (uint32_t)number; break;
    default: return 0;
    }
    return 1;
}

static JSValue scalar(JSContext *ctx, Type type, Value value, int promoted)
{
    switch (type) {
    case T_VOID: return JS_UNDEFINED;
    case T_I8: return JS_NewInt32(ctx, promoted ? (int8_t)value.word : value.i8);
    case T_U8: return JS_NewUint32(ctx, promoted ? (uint8_t)value.word : value.u8);
    case T_I16: return JS_NewInt32(ctx, promoted ? (int16_t)value.word : value.i16);
    case T_U16: return JS_NewUint32(ctx, promoted ? (uint16_t)value.word : value.u16);
    case T_I32: return JS_NewInt32(ctx, promoted ? (int32_t)value.word : value.i32);
    case T_U32: return JS_NewUint32(ctx, promoted ? (uint32_t)value.word : value.u32);
    case T_I64: return JS_NewBigInt64(ctx, value.i64);
    case T_U64: return JS_NewBigUint64(ctx, value.u64);
    case T_FLOAT: return JS_NewFloat64(ctx, value.f32);
    case T_DOUBLE: return JS_NewFloat64(ctx, value.f64);
    default: return JS_ThrowTypeError(ctx, "Invalid scalar result");
    }
}

static JSValue call(JSContext *ctx, JSValueConst object, JSValueConst self,
                    int argc, JSValueConst *argv, int flags)
{
    (void)self;
    Function *function = JS_GetOpaque(object, JS_GetClassID(object));
    if (!function) return JS_ThrowTypeError(ctx, "Native function has no binding");
    if (flags & JS_CALL_FLAG_CONSTRUCTOR) return JS_ThrowTypeError(ctx, "Native functions are not constructors");
    if (function->closed || function->library->closed)
        return error(ctx, "ERR_FFI_CLOSED", "Native function or library is closed");
    if (argc != (int)function->count) return JS_ThrowTypeError(ctx, "Wrong native argument count");
    Value values[SR_MAX_ARGS] = {0}, returned = {0};
    void *args[SR_MAX_ARGS] = {0};
    Memory *temporary[SR_MAX_ARGS] = {0};
    JSValue result = JS_EXCEPTION;
    for (unsigned i = 0; i < function->count; i++) {
        if (!convert(ctx, function->params[i], argv[i], &values[i], &temporary[i], function->pointer_class)) goto done;
        args[i] = &values[i];
    }
    errno = 0;
#ifdef _WIN32
    SetLastError(0);
#endif
    ffi_call(&function->cif, function->code, &returned, args);
    int native_errno = errno;
#ifdef _WIN32
    DWORD system_error = GetLastError();
#endif
    JSValue value;
    if (function->result == T_POINTER) {
        Memory *memory = NULL;
        size_t length = 0;
        uintptr_t address = (uintptr_t)returned.pointer;
        for (unsigned i = 0; returned.pointer && i < function->count; i++) {
            Pointer *pointer = function->params[i] == T_POINTER ? JS_GetOpaque(argv[i], function->pointer_class) : NULL;
            Memory *candidate = temporary[i] ? temporary[i] : pointer ? pointer->memory : NULL;
            uintptr_t base = temporary[i] ? (uintptr_t)temporary[i]->bytes :
                pointer ? (uintptr_t)pointer->address : 0;
            size_t bound = temporary[i] ? temporary[i]->size : pointer ? pointer->length : 0;
            if (candidate && address >= base && address - base <= bound) {
                memory = candidate;
                length = bound - (size_t)(address - base); break;
            }
        }
        value = new_pointer(ctx, function->pointer_class, returned.pointer, length, memory, function->library, 0);
    } else value = scalar(ctx, function->result, returned, 1);
    if (JS_IsException(value)) goto done;
    result = JS_NewObject(ctx);
    if (JS_IsException(result)) { JS_FreeValue(ctx, value); goto done; }
    int ok = JS_SetPropertyStr(ctx, result, "value", value) >= 0;
#ifdef _WIN32
    (void)native_errno;
    ok = ok && JS_SetPropertyStr(ctx, result, "errno", JS_NULL) >= 0 &&
        JS_SetPropertyStr(ctx, result, "systemError", JS_NewUint32(ctx, system_error)) >= 0;
#else
    ok = ok && JS_SetPropertyStr(ctx, result, "errno", JS_NewInt32(ctx, native_errno)) >= 0 &&
        JS_SetPropertyStr(ctx, result, "systemError", JS_NULL) >= 0;
#endif
    if (!ok) { JS_FreeValue(ctx, result); result = JS_EXCEPTION; }
done:
    for (unsigned i = 0; i < function->count; i++) release_memory(temporary[i]);
    return result;
}

static JSValue open_library(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, const Classes *classes)
{
    (void)self;
    if (argc != 1) return JS_ThrowTypeError(ctx, "open requires one native library path or name");
    const char *path = text(ctx, argv[0], 4095);
    if (!path) return JS_EXCEPTION;
    void *handle = NULL;
    JSValue result = JS_EXCEPTION;
#ifdef _WIN32
    int separated = strchr(path, '\\') || strchr(path, '/') || strchr(path, ':');
    int absolute = (strlen(path) > 2 && path[1] == ':' && (path[2] == '\\' || path[2] == '/')) ||
        (path[0] == '\\' && path[1] == '\\');
    if (separated && !absolute) { JS_ThrowTypeError(ctx, "Native library paths must be absolute"); goto done; }
    wchar_t wide[4096];
    if (!*path || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, 4096)) {
        JS_ThrowTypeError(ctx, "Invalid native library path"); goto done;
    }
    handle = (void *)LoadLibraryExW(wide, NULL, separated ?
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS : LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!handle) { error(ctx, "ERR_FFI_LIBRARY", "Cannot load native library"); goto done; }
#else
    if (!*path || (strchr(path, '/') && path[0] != '/')) {
        JS_ThrowTypeError(ctx, "Use an absolute native library path or a loader name"); goto done;
    }
    handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        const char *failure = dlerror();
        error(ctx, "ERR_FFI_LIBRARY", failure ? failure : "Cannot load native library"); goto done;
    }
#endif
    Library *library = calloc(1, sizeof(*library));
    if (!library) { JS_ThrowOutOfMemory(ctx); goto done; }
    library->handle = handle; library->refs = 1; library->wrapped = 1;
    library->function_class = classes->function; library->pointer_class = classes->pointer;
    result = JS_NewObjectClass(ctx, classes->library);
    if (JS_IsException(result)) { release_library(library); handle = NULL; goto done; }
    JS_SetOpaque(result, library); handle = NULL;
done:
    if (handle) {
        Library library = { .handle = handle };
        if (!unload(&library)) fprintf(stderr, "[ffi] Cannot unload unbound library\n");
    }
    JS_FreeCString(ctx, path);
    return result;
}

static JSValue bind(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, const Classes *classes)
{
    Library *library = JS_GetOpaque2(ctx, self, classes->library);
    if (!library) return JS_EXCEPTION;
    if (library->closed) return error(ctx, "ERR_FFI_CLOSED", "Native library is closed");
    if (argc != 2 || !JS_IsObject(argv[1])) return JS_ThrowTypeError(ctx, "bind requires a symbol and signature");
    const char *name = text(ctx, argv[0], 255);
    if (!name) return JS_EXCEPTION;
    Function *function = calloc(1, sizeof(*function));
    JSValue result = JS_EXCEPTION, params = JS_UNDEFINED;
    if (!function) { JS_ThrowOutOfMemory(ctx); goto done; }
    JSPropertyEnum *properties = NULL;
    uint32_t property_count = 0;
    if (JS_GetOwnPropertyNames(ctx, &properties, &property_count, argv[1], JS_GPN_STRING_MASK) < 0) goto done;
    int fields_ok = 1;
    for (uint32_t i = 0; i < property_count; i++) {
        const char *field = JS_AtomToCString(ctx, properties[i].atom);
        if (!field) { fields_ok = 0; break; }
        if (strcmp(field, "result") && strcmp(field, "parameters") && strcmp(field, "abi") &&
            strcmp(field, "variadic")) {
            JS_ThrowTypeError(ctx, "Unsupported signature field: %s", field);
            fields_ok = 0;
        }
        JS_FreeCString(ctx, field);
        if (!fields_ok) break;
    }
    JS_FreePropertyEnum(ctx, properties, property_count);
    if (!fields_ok) goto done;
    JSValue returns = JS_GetPropertyStr(ctx, argv[1], "result");
    int ok = !JS_IsException(returns) && type_value(ctx, returns, &function->result);
    JS_FreeValue(ctx, returns);
    if (!ok) goto done;
    if (function->result == T_CSTRING) { JS_ThrowTypeError(ctx, "Return pointer and decode with an explicit memory bound"); goto done; }
    params = JS_GetPropertyStr(ctx, argv[1], "parameters");
    if (JS_IsException(params)) goto done;
    if (!JS_IsArray(params)) { JS_ThrowTypeError(ctx, "Signature parameters must be an array"); goto done; }
    JSValue length = JS_GetPropertyStr(ctx, params, "length");
    size_t count = 0;
    ok = !JS_IsException(length) && index_value(ctx, length, SR_MAX_ARGS, &count);
    JS_FreeValue(ctx, length);
    if (!ok) goto done;
    function->count = (unsigned)count;
    for (unsigned i = 0; i < count; i++) {
        JSValue type = JS_GetPropertyUint32(ctx, params, i);
        ok = !JS_IsException(type) && type_value(ctx, type, &function->params[i]);
        JS_FreeValue(ctx, type);
        if (!ok) goto done;
        if (function->params[i] == T_VOID) { JS_ThrowTypeError(ctx, "void is not an argument type"); goto done; }
        function->types[i] = native_type(function->params[i]);
    }
    ffi_abi abi = FFI_DEFAULT_ABI;
    JSValue convention = JS_GetPropertyStr(ctx, argv[1], "abi");
    if (JS_IsException(convention)) goto done;
    if (!JS_IsUndefined(convention)) {
        const char *s = text(ctx, convention, 16);
        if (!s) { JS_FreeValue(ctx, convention); goto done; }
        ok = !strcmp(s, "default");
#if defined(_WIN32) && (defined(_M_IX86) || defined(__i386__))
        if (!strcmp(s, "stdcall")) { abi = FFI_STDCALL; ok = 1; }
#endif
        JS_FreeCString(ctx, s);
        if (!ok) JS_ThrowTypeError(ctx, "Unsupported native calling convention");
    }
    JS_FreeValue(ctx, convention);
    if (!ok) goto done;
    JSValue variadic = JS_GetPropertyStr(ctx, argv[1], "variadic");
    if (JS_IsException(variadic)) goto done;
    size_t fixed = 0;
    int variable = !JS_IsUndefined(variadic);
    if (variable) {
        ok = index_value(ctx, variadic, function->count, &fixed);
        if (ok && abi != FFI_DEFAULT_ABI) { JS_ThrowTypeError(ctx, "Variadic calls require the default C ABI"); ok = 0; }
        if (ok && !fixed) { JS_ThrowRangeError(ctx, "Variadic signatures require a fixed parameter"); ok = 0; }
        for (unsigned i = (unsigned)fixed; ok && i < function->count; i++) {
            Type type = function->params[i];
            if (type == T_FLOAT || type == T_I8 || type == T_U8 || type == T_I16 || type == T_U16) {
                JS_ThrowTypeError(ctx, "Variadic tails require explicit C promotions: i32 or double");
                ok = 0;
            }
        }
    }
    JS_FreeValue(ctx, variadic);
    if (!ok) goto done;
    ffi_status prepared = variable ?
        ffi_prep_cif_var(&function->cif, abi, (unsigned)fixed, function->count,
            native_type(function->result), function->types) :
        ffi_prep_cif(&function->cif, abi, function->count, native_type(function->result), function->types);
    if (prepared != FFI_OK) {
        error(ctx, "ERR_FFI_SIGNATURE", "Cannot prepare native signature"); goto done;
    }
    if (library->closed) { error(ctx, "ERR_FFI_CLOSED", "Native library closed during binding"); goto done; }
#ifdef _WIN32
    FARPROC code = GetProcAddress((HMODULE)library->handle, name);
    if (!code) { error(ctx, "ERR_FFI_SYMBOL", "Native symbol is not exported"); goto done; }
#else
    dlerror();
    void *code = dlsym(library->handle, name);
    const char *failure = dlerror();
    if (failure || !code) { error(ctx, "ERR_FFI_SYMBOL", failure ? failure : "Native symbol is null"); goto done; }
#endif
    _Static_assert(sizeof(code) == sizeof(function->code), "Unsupported function address representation");
    memcpy(&function->code, &code, sizeof(code));
    result = JS_NewObjectClass(ctx, library->function_class);
    if (JS_IsException(result)) goto done;
    function->library = library; library->refs++;
    function->pointer_class = library->pointer_class;
    JS_SetOpaque(result, function); function = NULL;
done:
    JS_FreeValue(ctx, params); free(function); JS_FreeCString(ctx, name);
    return result;
}

static JSValue close_library(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, const Classes *classes)
{
    (void)argc; (void)argv;
    Library *library = JS_GetOpaque2(ctx, self, classes->library);
    if (!library) return JS_EXCEPTION;
    library->closed = 1;
    if (library->refs == 1 && !unload(library))
        return error(ctx, "ERR_FFI_UNLOAD", "Cannot unload native library");
    return JS_UNDEFINED;
}

static JSValue close_function(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, const Classes *classes)
{
    (void)argc; (void)argv;
    Function *function = JS_GetOpaque2(ctx, self, classes->function);
    if (!function) return JS_EXCEPTION;
    if (!function->closed) {
        function->closed = 1; release_library(function->library); function->library = NULL;
    }
    return JS_UNDEFINED;
}

static JSValue close_pointer(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, const Classes *classes)
{
    (void)argc; (void)argv;
    Pointer *pointer = JS_GetOpaque2(ctx, self, classes->pointer);
    if (!pointer) return JS_EXCEPTION;
    if (!pointer->closed) {
        pointer->closed = 1;
        if (pointer->owns && pointer->memory) pointer->memory->closed = 1;
        release_memory(pointer->memory); release_library(pointer->library);
        pointer->memory = NULL; pointer->library = NULL; pointer->address = NULL;
    }
    return JS_UNDEFINED;
}

static JSValue alloc_buffer(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, const Classes *classes)
{
    (void)self;
    size_t size = 0;
    if (argc != 1) return JS_ThrowTypeError(ctx, "alloc requires a byte count");
    if (!index_value(ctx, argv[0], SR_MAX_BYTES, &size)) return JS_EXCEPTION;
    Memory *memory = new_memory(size);
    if (!memory) return JS_ThrowOutOfMemory(ctx);
    JSValue result = new_pointer(ctx, classes->pointer, memory->bytes, size, memory, NULL, 1);
    release_memory(memory); return result;
}

static Pointer *bounded(JSContext *ctx, JSValueConst self, int argc,
                        JSValueConst *argv, size_t *offset, size_t *length, JSClassID pointer_class)
{
    Pointer *pointer = JS_GetOpaque2(ctx, self, pointer_class);
    if (!pointer || !pointer_live(ctx, pointer)) return NULL;
    if (!pointer->memory) { error(ctx, "ERR_FFI_MEMORY", "Unbounded native pointer cannot be read or written"); return NULL; }
    *offset = 0;
    if (argc > 1 && !index_value(ctx, argv[1], pointer->length, offset)) return NULL;
    if (!index_value(ctx, argv[0], pointer->length - *offset, length)) return NULL;
    return pointer;
}

static JSValue read_buffer(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, const Classes *classes)
{
    if (argc < 1 || argc > 2) return JS_ThrowTypeError(ctx, "read requires length and optional offset");
    size_t offset, length;
    Pointer *pointer = bounded(ctx, self, argc, argv, &offset, &length, classes->pointer);
    if (!pointer) return JS_EXCEPTION;
    return JS_NewArrayBufferCopy(ctx, (const uint8_t *)pointer->address + offset, length);
}

static JSValue write_buffer(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, const Classes *classes)
{
    if (argc < 1 || argc > 2) return JS_ThrowTypeError(ctx, "write requires ArrayBuffer and optional offset");
    size_t size = 0;
    uint8_t *bytes = JS_GetArrayBuffer(ctx, &size, argv[0]);
    if (!bytes) {
        if (JS_HasException(ctx)) return JS_EXCEPTION;
        if (size) return JS_ThrowTypeError(ctx, "Invalid ArrayBuffer");
    }
    JSValue lengths[2] = { JS_NewFloat64(ctx, (double)size), argc > 1 ? argv[1] : JS_UNDEFINED };
    size_t offset, length;
    Pointer *pointer = bounded(ctx, self, argc, lengths, &offset, &length, classes->pointer);
    if (!pointer) return JS_EXCEPTION;
    if (length) memcpy((uint8_t *)pointer->address + offset, bytes, length);
    return JS_UNDEFINED;
}

static JSValue read_string(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, const Classes *classes)
{
    if (argc < 1 || argc > 2) return JS_ThrowTypeError(ctx, "readString requires a byte bound and optional offset");
    size_t offset, length;
    Pointer *pointer = bounded(ctx, self, argc, argv, &offset, &length, classes->pointer);
    if (!pointer) return JS_EXCEPTION;
    const char *s = (const char *)pointer->address + offset;
    const char *end = memchr(s, 0, length);
    if (!end) return JS_ThrowRangeError(ctx, "No C string terminator inside the requested bound");
    return JS_NewStringLen(ctx, s, (size_t)(end - s));
}

static JSValue pointer_slice(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, const Classes *classes)
{
    if (argc != 2) return JS_ThrowTypeError(ctx, "slice requires offset and length");
    JSValue bounds[2] = { argv[1], argv[0] };
    size_t offset, length;
    Pointer *pointer = bounded(ctx, self, 2, bounds, &offset, &length, classes->pointer);
    if (!pointer) return JS_EXCEPTION;
    return new_pointer(ctx, classes->pointer, (uint8_t *)pointer->address + offset, length,
        pointer->memory, pointer->library, 0);
}

typedef enum {
    M_OPEN, M_ALLOC, M_BIND, M_CLOSE_LIBRARY, M_CLOSE_FUNCTION, M_CLOSE_POINTER,
    M_READ, M_WRITE, M_READ_STRING, M_SLICE
} Method;

static JSValue dispatch(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv,
                        int magic, JSValueConst *data)
{
    Classes classes = { (JSClassID)JS_VALUE_GET_INT(data[0]),
        (JSClassID)JS_VALUE_GET_INT(data[1]), (JSClassID)JS_VALUE_GET_INT(data[2]) };
    switch ((Method)magic) {
    case M_OPEN: return open_library(ctx, self, argc, argv, &classes);
    case M_ALLOC: return alloc_buffer(ctx, self, argc, argv, &classes);
    case M_BIND: return bind(ctx, self, argc, argv, &classes);
    case M_CLOSE_LIBRARY: return close_library(ctx, self, argc, argv, &classes);
    case M_CLOSE_FUNCTION: return close_function(ctx, self, argc, argv, &classes);
    case M_CLOSE_POINTER: return close_pointer(ctx, self, argc, argv, &classes);
    case M_READ: return read_buffer(ctx, self, argc, argv, &classes);
    case M_WRITE: return write_buffer(ctx, self, argc, argv, &classes);
    case M_READ_STRING: return read_string(ctx, self, argc, argv, &classes);
    case M_SLICE: return pointer_slice(ctx, self, argc, argv, &classes);
    }
    return JS_ThrowInternalError(ctx, "Invalid FFI method");
}

typedef struct MethodInfo { const char *name; int length; Method method; } MethodInfo;
static const MethodInfo library_methods[] = { { "bind", 2, M_BIND }, { "close", 0, M_CLOSE_LIBRARY } };
static const MethodInfo function_methods[] = { { "close", 0, M_CLOSE_FUNCTION } };
static const MethodInfo pointer_methods[] = {
    { "close", 0, M_CLOSE_POINTER }, { "read", 1, M_READ }, { "write", 1, M_WRITE },
    { "readString", 1, M_READ_STRING }, { "slice", 2, M_SLICE },
};
#if defined(_WIN32)
#define SR_PLATFORM "windows"
#define SR_LIBC "ucrt"
#elif defined(__APPLE__)
#define SR_PLATFORM "macos"
#define SR_LIBC "libsystem"
#elif defined(__linux__)
#define SR_PLATFORM "linux"
#if defined(__GLIBC__)
#define SR_LIBC "glibc"
#else
#define SR_LIBC "musl"
#endif
#else
#define SR_PLATFORM "unsupported"
#define SR_LIBC "unknown"
#endif
static const JSCFunctionListEntry exports[] = {
    JS_PROP_STRING_DEF("platform", SR_PLATFORM, 0), JS_PROP_STRING_DEF("libc", SR_LIBC, 0),
    JS_PROP_INT32_DEF("pointerSize", sizeof(void *), 0),
    JS_PROP_INT32_DEF("longSize", sizeof(long), 0),
    JS_PROP_INT32_DEF("maxBytes", SR_MAX_BYTES, 0),
};

static int module_init(JSContext *ctx, JSModuleDef *module)
{
    JSValue private = JS_GetModulePrivateValue(ctx, module), data[3];
    for (unsigned i = 0; i < 3; i++) data[i] = JS_GetPropertyUint32(ctx, private, i);
    JS_FreeValue(ctx, private);
    int ok = 1;
    for (unsigned i = 0; i < 3; i++)
        if (JS_VALUE_GET_TAG(data[i]) != JS_TAG_INT) ok = 0;
    if (!ok && !JS_HasException(ctx)) JS_ThrowInternalError(ctx, "Invalid FFI module class state");
    if (ok) {
        JSValue open = JS_NewCFunctionData(ctx, dispatch, 1, M_OPEN, 3, data);
        if (JS_IsException(open) || JS_SetModuleExport(ctx, module, "open", open) < 0) ok = 0;
        if (ok) {
            JSValue alloc = JS_NewCFunctionData(ctx, dispatch, 1, M_ALLOC, 3, data);
            if (JS_IsException(alloc) || JS_SetModuleExport(ctx, module, "alloc", alloc) < 0) ok = 0;
        }
    }
    for (unsigned i = 0; i < 3; i++) JS_FreeValue(ctx, data[i]);
    if (!ok) return -1;
    if (JS_SetModuleExportList(ctx, module, exports, sizeof(exports) / sizeof(*exports)) < 0 ||
        JS_SetModuleExport(ctx, module, "callbacks", JS_NewBool(ctx, 0)) < 0 ||
        JS_SetModuleExport(ctx, module, "async", JS_NewBool(ctx, 0)) < 0 ||
        JS_SetModuleExport(ctx, module, "variadics", JS_NewBool(ctx, 1)) < 0) return -1;
    return 0;
}

int sr_ffi_register(JSContext *ctx)
{
    JSRuntime *runtime = JS_GetRuntime(ctx);
    Classes classes = {0};
    JSClassID *ids[] = { &classes.library, &classes.function, &classes.pointer };
    const JSClassDef definitions[] = {
        { "NativeLibrary", .finalizer = library_finalizer },
        { "NativeFunction", .finalizer = function_finalizer, .call = call },
        { "NativePointer", .finalizer = pointer_finalizer },
    };
    const MethodInfo *methods[] = { library_methods, function_methods, pointer_methods };
    const int counts[] = { sizeof(library_methods) / sizeof(*library_methods),
        sizeof(function_methods) / sizeof(*function_methods), sizeof(pointer_methods) / sizeof(*pointer_methods) };
    for (unsigned i = 0; i < 3; i++) {
        do {
            *ids[i] = 0;
            JS_NewClassID(runtime, ids[i]);
        } while (JS_IsRegisteredClass(runtime, *ids[i]));
        if (JS_NewClass(runtime, *ids[i], &definitions[i]) < 0) return 0;
    }
    JSValue data[] = { JS_NewInt32(ctx, (int32_t)classes.library),
        JS_NewInt32(ctx, (int32_t)classes.function), JS_NewInt32(ctx, (int32_t)classes.pointer) };
    for (unsigned i = 0; i < 3; i++) {
        JSValue proto = JS_NewObject(ctx);
        if (JS_IsException(proto)) return 0;
        for (int j = 0; j < counts[i]; j++) {
            const MethodInfo *method = &methods[i][j];
            JSValue function = JS_NewCFunctionData(ctx, dispatch, method->length, method->method, 3, data);
            if (JS_IsException(function) || JS_DefinePropertyValueStr(ctx, proto, method->name, function,
                JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE) < 0) {
                JS_FreeValue(ctx, proto); return 0;
            }
        }
        JS_SetClassProto(ctx, *ids[i], proto);
    }
    JSModuleDef *module = JS_NewCModule(ctx, "sysrt:ffi", module_init);
    if (!module) return 0;
    JSValue private = JS_NewArray(ctx);
    if (JS_IsException(private)) return 0;
    for (unsigned i = 0; i < 3; i++) {
        if (JS_DefinePropertyValueUint32(ctx, private, i, data[i],
            JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE) < 0) {
            JS_FreeValue(ctx, private); return 0;
        }
    }
    if (JS_SetModulePrivateValue(ctx, module, private) < 0) return 0;
    return JS_AddModuleExportList(ctx, module, exports, sizeof(exports) / sizeof(*exports)) >= 0 &&
        JS_AddModuleExport(ctx, module, "open") >= 0 && JS_AddModuleExport(ctx, module, "alloc") >= 0 &&
        JS_AddModuleExport(ctx, module, "callbacks") >= 0 && JS_AddModuleExport(ctx, module, "async") >= 0 &&
        JS_AddModuleExport(ctx, module, "variadics") >= 0;
}
