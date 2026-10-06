#include "desktop/output-client.h"
#include "desktop/windows.h"
#include "output-management-client.h"
#include "polly-output-guard-client.h"

#include <SDL3/SDL.h>
#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>

struct ModeInfo { int width, height, refresh, preferred; };
struct Mode {
    struct Mode *next;
    struct zwlr_output_mode_v1 *proxy;
    struct ModeInfo current, pending;
    int ready, removed;
};
struct Geometry { int enabled, x, y, width, height, refresh, transform, adaptive; double scale; };
struct Head {
    struct Head *next;
    struct zwlr_output_head_v1 *proxy;
    struct Mode *modes, *pending_mode;
    struct Geometry current, pending;
    char *name, *description, *pending_name, *pending_description;
    char *identity[3], *pending_identity[3];
    uint32_t id;
    int ready, removed;
};
static struct {
    JSContext *ctx;
    JSValue api;
    struct wl_display *display;
    struct zwlr_output_manager_v1 *manager;
    struct polly_output_guard_v1 *guard;
    struct Head *heads;
    uint32_t next_head, serial, token, outcome;
    uint32_t startup_serial, startup_reply, startup_accepted;
    Uint64 deadline;
    char *message;
    int ready, changed, failed;
} output;

static void copy_string(char **target, const char *text)
{
    char *copy = strdup(text);
    if (!copy) { output.failed = output.changed = 1; return; }
    free(*target); *target = copy;
}
static void mode_size(void *data, struct zwlr_output_mode_v1 *mode, int32_t width, int32_t height)
{ (void)mode; struct Mode *item = data; item->pending.width = width; item->pending.height = height; }
static void mode_refresh(void *data, struct zwlr_output_mode_v1 *mode, int32_t refresh)
{ (void)mode; ((struct Mode *)data)->pending.refresh = refresh; }
static void mode_preferred(void *data, struct zwlr_output_mode_v1 *mode)
{ (void)mode; ((struct Mode *)data)->pending.preferred = 1; }
static void mode_finished(void *data, struct zwlr_output_mode_v1 *mode)
{ (void)mode; ((struct Mode *)data)->removed = 1; }
static const struct zwlr_output_mode_v1_listener mode_listener = {
    .size = mode_size, .refresh = mode_refresh, .preferred = mode_preferred, .finished = mode_finished,
};
static void head_name(void *data, struct zwlr_output_head_v1 *head, const char *name)
{ (void)head; copy_string(&((struct Head *)data)->pending_name, name); }
static void head_description(void *data, struct zwlr_output_head_v1 *head, const char *description)
{ (void)head; copy_string(&((struct Head *)data)->pending_description, description); }
static void physical_size(void *data, struct zwlr_output_head_v1 *head, int32_t width, int32_t height)
{ (void)data; (void)head; (void)width; (void)height; }
static void make(void *data, struct zwlr_output_head_v1 *head, const char *value)
{ (void)head; copy_string(&((struct Head *)data)->pending_identity[0], value); }
static void model(void *data, struct zwlr_output_head_v1 *head, const char *value)
{ (void)head; copy_string(&((struct Head *)data)->pending_identity[1], value); }
static void serial_number(void *data, struct zwlr_output_head_v1 *head, const char *value)
{ (void)head; copy_string(&((struct Head *)data)->pending_identity[2], value); }
static void new_mode(void *data, struct zwlr_output_head_v1 *head, struct zwlr_output_mode_v1 *proxy)
{
    (void)head;
    struct Head *item = data;
    struct Mode *mode = calloc(1, sizeof(*mode));
    if (!mode) { zwlr_output_mode_v1_release(proxy); output.failed = output.changed = 1; return; }
    mode->proxy = proxy; mode->next = item->modes; item->modes = mode;
    if (zwlr_output_mode_v1_add_listener(proxy, &mode_listener, mode) < 0) output.failed = output.changed = 1;
}
static void enabled(void *data, struct zwlr_output_head_v1 *head, int32_t value)
{ (void)head; ((struct Head *)data)->pending.enabled = value != 0; }
static void current_mode(void *data, struct zwlr_output_head_v1 *head, struct zwlr_output_mode_v1 *mode)
{
    (void)head;
    if (!mode) { output.failed = output.changed = 1; return; }
    ((struct Head *)data)->pending_mode = zwlr_output_mode_v1_get_user_data(mode);
}
static void position(void *data, struct zwlr_output_head_v1 *head, int32_t x, int32_t y)
{ (void)head; struct Head *item = data; item->pending.x = x; item->pending.y = y; }
static void transform(void *data, struct zwlr_output_head_v1 *head, int32_t value)
{ (void)head; ((struct Head *)data)->pending.transform = value; }
static void scale(void *data, struct zwlr_output_head_v1 *head, wl_fixed_t value)
{ (void)head; ((struct Head *)data)->pending.scale = wl_fixed_to_double(value); }
static void adaptive(void *data, struct zwlr_output_head_v1 *head, uint32_t value)
{ (void)head; ((struct Head *)data)->pending.adaptive = value != 0; }
static void head_finished(void *data, struct zwlr_output_head_v1 *head)
{ (void)head; ((struct Head *)data)->removed = 1; }
static const struct zwlr_output_head_v1_listener head_listener = {
    .name = head_name, .description = head_description, .physical_size = physical_size, .mode = new_mode,
    .enabled = enabled, .current_mode = current_mode, .position = position, .transform = transform,
    .scale = scale, .finished = head_finished, .make = make, .model = model,
    .serial_number = serial_number, .adaptive_sync = adaptive,
};
static void new_head(void *data, struct zwlr_output_manager_v1 *manager, struct zwlr_output_head_v1 *proxy)
{
    (void)data; (void)manager;
    struct Head *head = calloc(1, sizeof(*head));
    if (!head || output.next_head == UINT32_MAX) {
        free(head); zwlr_output_head_v1_release(proxy);
        output.failed = output.changed = 1; return;
    }
    head->proxy = proxy; head->id = ++output.next_head;
    head->pending.scale = head->current.scale = 1;
    head->next = output.heads; output.heads = head;
    if (zwlr_output_head_v1_add_listener(proxy, &head_listener, head) < 0) output.failed = output.changed = 1;
}
static void free_mode(struct Mode *mode) { zwlr_output_mode_v1_release(mode->proxy); free(mode); }
static void free_head(struct Head *head)
{
    while (head->modes) { struct Mode *next = head->modes->next; free_mode(head->modes); head->modes = next; }
    zwlr_output_head_v1_release(head->proxy);
    for (unsigned i = 0; i < 3; i++) { free(head->identity[i]); free(head->pending_identity[i]); }
    free(head->name); free(head->description); free(head->pending_name); free(head->pending_description); free(head);
}
static void done(void *data, struct zwlr_output_manager_v1 *manager, uint32_t serial)
{
    (void)data; (void)manager;
    struct Head **link = &output.heads;
    while (*link) {
        struct Head *head = *link;
        if (head->removed) { *link = head->next; free_head(head); continue; }
        if (head->pending_name) { free(head->name); head->name = head->pending_name; head->pending_name = NULL; }
        if (head->pending_description) {
            free(head->description); head->description = head->pending_description; head->pending_description = NULL;
        }
        for (unsigned i = 0; i < 3; i++) if (head->pending_identity[i]) {
            free(head->identity[i]); head->identity[i] = head->pending_identity[i]; head->pending_identity[i] = NULL;
        }
        struct Mode **mode_link = &head->modes;
        while (*mode_link) {
            struct Mode *mode = *mode_link;
            if (mode->removed) {
                if (head->pending_mode == mode) head->pending_mode = NULL;
                *mode_link = mode->next; free_mode(mode); continue;
            }
            mode->current = mode->pending; mode->ready = 1; mode_link = &mode->next;
        }
        struct Mode *mode = head->pending_mode;
        if (!mode && !head->pending.width) {
            mode = head->modes;
            for (struct Mode *item = head->modes; item; item = item->next)
                if (item->current.preferred) { mode = item; break; }
        }
        if (mode) {
            head->pending.width = mode->current.width; head->pending.height = mode->current.height;
            head->pending.refresh = mode->current.refresh;
        }
        head->current = head->pending; head->ready = 1; link = &head->next;
    }
    output.serial = serial; output.ready = output.changed = 1;
}
static void finished(void *data, struct zwlr_output_manager_v1 *manager)
{
    (void)data;
    zwlr_output_manager_v1_destroy(manager); output.manager = NULL;
    output.failed = output.changed = 1;
}
static const struct zwlr_output_manager_v1_listener manager_listener = { .head = new_head, .done = done, .finished = finished };
static void guard_state(void *data, struct polly_output_guard_v1 *guard, uint32_t token, uint32_t remaining, uint32_t outcome, const char *message)
{
    (void)data; (void)guard;
    output.token = token; output.deadline = SDL_GetTicks() + remaining;
    output.outcome = outcome;
    copy_string(&output.message, message);
    output.changed = 1;
}
static void startup_claimed(void *data, struct polly_output_guard_v1 *guard, uint32_t serial, uint32_t accepted)
{
    (void)data; (void)guard;
    if (serial != output.startup_serial) return;
    output.startup_reply = serial;
    output.startup_accepted = accepted;
}
static const struct polly_output_guard_v1_listener guard_listener = {
    .state = guard_state, .startup_claimed = startup_claimed,
};

int pu_output_client_bind(struct wl_display *display, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version)
{
    if (!strcmp(interface, "zwlr_output_manager_v1")) {
        if (output.manager) return 1;
        if (version < 4) { output.failed = output.changed = 1; return 1; }
        output.display = display;
        output.manager = wl_registry_bind(registry, name, &zwlr_output_manager_v1_interface, 4);
        if (!output.manager || zwlr_output_manager_v1_add_listener(output.manager, &manager_listener, NULL) < 0)
            output.failed = output.changed = 1;
        return 1;
    }
    if (!strcmp(interface, "polly_output_guard_v1")) {
        if (output.guard) return 1;
        output.display = display;
        output.guard = wl_registry_bind(registry, name, &polly_output_guard_v1_interface, version < 2 ? version : 2);
        if (!output.guard || polly_output_guard_v1_add_listener(output.guard, &guard_listener, NULL) < 0)
            output.failed = output.changed = 1;
        return 1;
    }
    return 0;
}
static int ensure(JSContext *ctx)
{
    if (!pu_desktop_windows_ready(ctx)) return 0;
    if (!output.manager || !output.guard) { JS_ThrowTypeError(ctx, "Display configuration requires the trusted PollyWM connection"); return 0; }
    if (!output.ready || output.failed) { JS_ThrowInternalError(ctx, "Display configuration is unavailable"); return 0; }
    return 1;
}
static int property(JSContext *ctx, JSValueConst object, const char *name, JSValue value)
{ return !JS_IsException(value) && JS_SetPropertyStr(ctx, object, name, value) >= 0; }
static JSValue configuration(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ensure(ctx)) return JS_EXCEPTION;
    JSValue result = JS_NewObject(ctx), heads = JS_NewArray(ctx);
    if (JS_IsException(result) || JS_IsException(heads)) goto failed;
    Uint64 now = SDL_GetTicks();
    if (!property(ctx, result, "serial", JS_NewUint32(ctx, output.serial)) ||
        !property(ctx, result, "pendingToken", JS_NewUint32(ctx, output.token)) ||
        !property(ctx, result, "outcome", JS_NewUint32(ctx, output.outcome)) ||
        !property(ctx, result, "remainingMs", JS_NewFloat64(ctx, output.token && output.deadline > now ? output.deadline - now : 0)) ||
        !property(ctx, result, "message", JS_NewString(ctx, output.message ? output.message : ""))) goto failed;
    uint32_t index = 0;
    for (struct Head *head = output.heads; head; head = head->next) {
        if (!head->ready) continue;
        JSValue item = JS_NewObject(ctx), modes = JS_NewArray(ctx);
        if (JS_IsException(item) || JS_IsException(modes)) { JS_FreeValue(ctx, item); JS_FreeValue(ctx, modes); goto failed; }
        struct Geometry *g = &head->current;
        int ok = property(ctx, item, "id", JS_NewUint32(ctx, head->id)) &&
            property(ctx, item, "name", JS_NewString(ctx, head->name ? head->name : "")) &&
            property(ctx, item, "description", JS_NewString(ctx, head->description ? head->description : "")) &&
            property(ctx, item, "make", JS_NewString(ctx, head->identity[0] ? head->identity[0] : "")) &&
            property(ctx, item, "model", JS_NewString(ctx, head->identity[1] ? head->identity[1] : "")) &&
            property(ctx, item, "serialNumber", JS_NewString(ctx, head->identity[2] ? head->identity[2] : "")) &&
            property(ctx, item, "enabled", JS_NewBool(ctx, g->enabled)) &&
            property(ctx, item, "width", JS_NewInt32(ctx, g->width)) &&
            property(ctx, item, "height", JS_NewInt32(ctx, g->height)) &&
            property(ctx, item, "refresh", JS_NewInt32(ctx, g->refresh)) &&
            property(ctx, item, "x", JS_NewInt32(ctx, g->x)) && property(ctx, item, "y", JS_NewInt32(ctx, g->y)) &&
            property(ctx, item, "scale", JS_NewFloat64(ctx, g->scale)) &&
            property(ctx, item, "transform", JS_NewInt32(ctx, g->transform)) &&
            property(ctx, item, "adaptiveSync", JS_NewBool(ctx, g->adaptive));
        uint32_t mi = 0;
        for (struct Mode *mode = head->modes; mode && ok; mode = mode->next) {
            if (!mode->ready) continue;
            JSValue entry = JS_NewObject(ctx);
            if (JS_IsException(entry)) { ok = 0; break; }
            ok = property(ctx, entry, "width", JS_NewInt32(ctx, mode->current.width)) &&
                property(ctx, entry, "height", JS_NewInt32(ctx, mode->current.height)) &&
                property(ctx, entry, "refresh", JS_NewInt32(ctx, mode->current.refresh)) &&
                property(ctx, entry, "preferred", JS_NewBool(ctx, mode->current.preferred));
            if (!ok) JS_FreeValue(ctx, entry);
            else ok = JS_SetPropertyUint32(ctx, modes, mi++, entry) >= 0;
        }
        if (!ok) { JS_FreeValue(ctx, item); JS_FreeValue(ctx, modes); goto failed; }
        if (!property(ctx, item, "modes", modes)) { JS_FreeValue(ctx, item); goto failed; }
        if (JS_SetPropertyUint32(ctx, heads, index++, item) < 0) goto failed;
    }
    if (!property(ctx, result, "heads", heads)) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    return result;
failed:
    JS_FreeValue(ctx, heads); JS_FreeValue(ctx, result); return JS_EXCEPTION;
}

static bool number(JSContext *ctx, JSValueConst object, const char *name, double minimum, double maximum, bool integer, double *result)
{
    JSValue value = JS_GetPropertyStr(ctx, object, name);
    if (JS_IsException(value)) return false;
    int ok = JS_IsNumber(value) ? JS_ToFloat64(ctx, result, value) : -1;
    JS_FreeValue(ctx, value);
    if (ok < 0 || !isfinite(*result) || *result < minimum || *result > maximum || (integer && floor(*result) != *result)) {
        JS_ThrowTypeError(ctx, "Invalid display field: %s", name); return false;
    }
    return true;
}
static void succeeded(void *data, struct zwlr_output_configuration_v1 *config)
{ (void)config; *(int *)data = 1; }
static void rejected(void *data, struct zwlr_output_configuration_v1 *config)
{ (void)config; *(int *)data = -1; }
static void cancelled(void *data, struct zwlr_output_configuration_v1 *config)
{ (void)config; *(int *)data = -2; }
static const struct zwlr_output_configuration_v1_listener config_listener = { .succeeded = succeeded, .failed = rejected, .cancelled = cancelled };

static JSValue apply(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int test_only)
{
    (void)self;
    if (!argc || !JS_IsObject(argv[0])) return JS_ThrowTypeError(ctx, "A complete output configuration is required");
    if (!ensure(ctx)) return JS_EXCEPTION;
    if (output.token) return JS_ThrowTypeError(ctx, "A display change is awaiting confirmation");
    double serial = 0;
    if (!number(ctx, argv[0], "serial", 0, UINT32_MAX, true, &serial)) return JS_EXCEPTION;
    if ((uint32_t)serial != output.serial) return JS_ThrowTypeError(ctx, "Display configuration is stale; refresh it");
    JSValue heads = JS_GetPropertyStr(ctx, argv[0], "heads");
    if (JS_IsException(heads)) return heads;
    if (!JS_IsArray(heads)) { JS_FreeValue(ctx, heads); return JS_ThrowTypeError(ctx, "Display heads must be an array"); }
    JSValue length = JS_GetPropertyStr(ctx, heads, "length");
    uint32_t count = 0, actual = 0;
    int length_ok = !JS_IsException(length) && JS_ToUint32(ctx, &count, length) >= 0;
    JS_FreeValue(ctx, length);
    if (!length_ok) { JS_FreeValue(ctx, heads); return JS_EXCEPTION; }
    for (struct Head *head = output.heads; head; head = head->next) if (head->ready && !head->removed) actual++;
    if (!count || count != actual) { JS_FreeValue(ctx, heads); return JS_ThrowTypeError(ctx, "Include every current display exactly once"); }
    struct Head **seen = calloc(count, sizeof(*seen));
    if (!seen) { JS_FreeValue(ctx, heads); return JS_ThrowOutOfMemory(ctx); }
    struct zwlr_output_configuration_v1 *config = zwlr_output_manager_v1_create_configuration(output.manager, output.serial);
    int status = 0, enabled_count = 0;
    JSValue result = JS_EXCEPTION;
    if (!config || zwlr_output_configuration_v1_add_listener(config, &config_listener, &status) < 0) {
        JS_ThrowOutOfMemory(ctx); goto cleanup;
    }
    for (uint32_t i = 0; i < count; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, heads, i);
        if (JS_IsException(item)) goto cleanup;
        if (!JS_IsObject(item)) { JS_FreeValue(ctx, item); JS_ThrowTypeError(ctx, "Invalid display head"); goto cleanup; }
        double id = 0;
        if (!number(ctx, item, "id", 1, UINT32_MAX, true, &id)) { JS_FreeValue(ctx, item); goto cleanup; }
        struct Head *head = output.heads;
        while (head && (head->id != (uint32_t)id || !head->ready || head->removed)) head = head->next;
        bool duplicate = false;
        for (uint32_t j = 0; j < i; j++) if (seen[j] == head) duplicate = true;
        if (!head || duplicate) { JS_FreeValue(ctx, item); JS_ThrowTypeError(ctx, "Unknown or duplicate display"); goto cleanup; }
        seen[i] = head;
        JSValue enabled_value = JS_GetPropertyStr(ctx, item, "enabled");
        if (JS_IsException(enabled_value)) { JS_FreeValue(ctx, item); goto cleanup; }
        if (!JS_IsBool(enabled_value)) {
            JS_FreeValue(ctx, enabled_value); JS_FreeValue(ctx, item); JS_ThrowTypeError(ctx, "Display enabled must be boolean"); goto cleanup;
        }
        int is_enabled = JS_ToBool(ctx, enabled_value);
        JS_FreeValue(ctx, enabled_value);
        if (!is_enabled) { zwlr_output_configuration_v1_disable_head(config, head->proxy); JS_FreeValue(ctx, item); continue; }
        enabled_count++;
        double width = 0, height = 0, refresh = 0, x = 0, y = 0, factor = 0, rotation = 0;
        bool ok = number(ctx, item, "width", 1, 16384, true, &width) &&
            number(ctx, item, "height", 1, 16384, true, &height) &&
            number(ctx, item, "refresh", 0, 1000000, true, &refresh) &&
            number(ctx, item, "x", -32768, 32768, true, &x) && number(ctx, item, "y", -32768, 32768, true, &y) &&
            number(ctx, item, "scale", 0.25, 4, false, &factor) && number(ctx, item, "transform", 0, 7, true, &rotation);
        JSValue adaptive_value = ok ? JS_GetPropertyStr(ctx, item, "adaptiveSync") : JS_UNDEFINED;
        int adaptive_state = head->current.adaptive;
        if (JS_IsException(adaptive_value)) ok = false;
        else if (!JS_IsUndefined(adaptive_value)) {
            if (!JS_IsBool(adaptive_value)) { JS_ThrowTypeError(ctx, "adaptiveSync must be boolean"); ok = false; }
            else adaptive_state = JS_ToBool(ctx, adaptive_value);
        }
        JS_FreeValue(ctx, adaptive_value); JS_FreeValue(ctx, item);
        if (!ok) goto cleanup;
        if (width * height > 32 * 1024 * 1024 || width / factor > 32700 || height / factor > 32700) {
            JS_ThrowRangeError(ctx, "Display dimensions exceed supported rendering bounds"); goto cleanup;
        }
        struct zwlr_output_configuration_head_v1 *configured = zwlr_output_configuration_v1_enable_head(config, head->proxy);
        if (!configured) { JS_ThrowOutOfMemory(ctx); goto cleanup; }
        struct Mode *mode = head->modes;
        while (mode && (!mode->ready || mode->removed || mode->current.width != width ||
            mode->current.height != height || mode->current.refresh != refresh)) mode = mode->next;
        if (mode) zwlr_output_configuration_head_v1_set_mode(configured, mode->proxy);
        else zwlr_output_configuration_head_v1_set_custom_mode(configured, (int)width, (int)height, (int)refresh);
        zwlr_output_configuration_head_v1_set_position(configured, (int)x, (int)y);
        zwlr_output_configuration_head_v1_set_scale(configured, wl_fixed_from_double(factor));
        zwlr_output_configuration_head_v1_set_transform(configured, (int)rotation);
        zwlr_output_configuration_head_v1_set_adaptive_sync(configured, adaptive_state ?
            ZWLR_OUTPUT_HEAD_V1_ADAPTIVE_SYNC_STATE_ENABLED : ZWLR_OUTPUT_HEAD_V1_ADAPTIVE_SYNC_STATE_DISABLED);
        zwlr_output_configuration_head_v1_destroy(configured);
    }
    if (!enabled_count) { JS_ThrowTypeError(ctx, "At least one display must remain enabled"); goto cleanup; }
    if (test_only) zwlr_output_configuration_v1_test(config);
    else zwlr_output_configuration_v1_apply(config);
    if (!pu_desktop_windows_roundtrip() || !status) { JS_ThrowInternalError(ctx, "Display configuration was not acknowledged"); goto cleanup; }
    if (test_only) result = JS_NewBool(ctx, status == 1);
    else if (status != 1) JS_ThrowInternalError(ctx, status == -2 ? "Display configuration became stale" : "Display configuration was rejected");
    else if (!output.token) JS_ThrowInternalError(ctx, "Display configuration has no confirmation token");
    else result = JS_NewUint32(ctx, output.token);
cleanup:
    if (config) zwlr_output_configuration_v1_destroy(config);
    free(seen); JS_FreeValue(ctx, heads); return result;
}

static JSValue confirm(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int revert)
{
    (void)self;
    if (!argc || !JS_IsNumber(argv[0])) return JS_ThrowTypeError(ctx, "A pending display token is required");
    if (!ensure(ctx)) return JS_EXCEPTION;
    double token;
    if (JS_ToFloat64(ctx, &token, argv[0]) < 0) return JS_EXCEPTION;
    if (!output.token || token != output.token) return JS_ThrowTypeError(ctx, "Display confirmation is stale");
    if (revert) polly_output_guard_v1_revert(output.guard, output.token);
    else polly_output_guard_v1_confirm(output.guard, output.token);
    if (!pu_desktop_windows_roundtrip()) return JS_ThrowInternalError(ctx, "Display confirmation was not acknowledged");
    if (output.token || output.outcome == 3 || (!revert && output.outcome != 1))
        return JS_ThrowInternalError(ctx, "Display configuration was not kept");
    return JS_UNDEFINED;
}

static JSValue claim_profile_startup(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ensure(ctx)) return JS_EXCEPTION;
    if (polly_output_guard_v1_get_version(output.guard) < 2)
        return JS_ThrowTypeError(ctx, "Startup display profiles require output guard version 2");
    if (!++output.startup_serial) ++output.startup_serial;
    output.startup_reply = 0;
    polly_output_guard_v1_claim_startup(output.guard, output.startup_serial);
    if (!pu_desktop_windows_roundtrip() || output.startup_reply != output.startup_serial ||
        output.startup_accepted > 1)
        return JS_ThrowInternalError(ctx, "Display startup claim was not acknowledged");
    return JS_NewBool(ctx, output.startup_accepted == 1);
}

int pu_output_client_install(JSContext *ctx, JSValueConst api)
{
    output.ctx = ctx; output.api = JS_DupValue(ctx, api);
    return property(ctx, api, "outputConfiguration", JS_NewCFunction(ctx, configuration, "outputConfiguration", 0)) &&
        property(ctx, api, "claimOutputStartup", JS_NewCFunction(ctx, claim_profile_startup, "claimOutputStartup", 0)) &&
        property(ctx, api, "applyOutputConfiguration", JS_NewCFunctionMagic(ctx, apply, "applyOutputConfiguration", 1, JS_CFUNC_generic_magic, 0)) &&
        property(ctx, api, "testOutputConfiguration", JS_NewCFunctionMagic(ctx, apply, "testOutputConfiguration", 1, JS_CFUNC_generic_magic, 1)) &&
        property(ctx, api, "confirmOutputConfiguration", JS_NewCFunctionMagic(ctx, confirm, "confirmOutputConfiguration", 1, JS_CFUNC_generic_magic, 0)) &&
        property(ctx, api, "revertOutputConfiguration", JS_NewCFunctionMagic(ctx, confirm, "revertOutputConfiguration", 1, JS_CFUNC_generic_magic, 1)) &&
        property(ctx, api, "onOutputsChanged", JS_NULL);
}
int pu_output_client_pump(void)
{
    if (!output.ctx || !output.changed) return 0;
    output.changed = 0;
    JSValue callback = JS_GetPropertyStr(output.ctx, output.api, "onOutputsChanged"), result = JS_UNDEFINED;
    if (JS_IsException(callback)) result = JS_EXCEPTION;
    else if (JS_IsFunction(output.ctx, callback)) result = JS_Call(output.ctx, callback, output.api, 0, NULL);
    if (JS_IsException(result)) {
        JSValue error = JS_GetException(output.ctx);
        const char *text = JS_ToCString(output.ctx, error);
        SDL_Log("Display callback failed: %s", text ? text : "error");
        JS_FreeCString(output.ctx, text); JS_FreeValue(output.ctx, error);
    }
    JS_FreeValue(output.ctx, result); JS_FreeValue(output.ctx, callback);
    return 1;
}
void pu_output_client_shutdown(void)
{
    if (output.guard && output.token) polly_output_guard_v1_revert(output.guard, output.token);
    while (output.heads) { struct Head *next = output.heads->next; free_head(output.heads); output.heads = next; }
    if (output.manager) { zwlr_output_manager_v1_stop(output.manager); zwlr_output_manager_v1_destroy(output.manager); }
    if (output.guard) polly_output_guard_v1_destroy(output.guard);
    free(output.message);
    if (output.ctx) JS_FreeValue(output.ctx, output.api);
    memset(&output, 0, sizeof(output));
}
