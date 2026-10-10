#include "power.h"
#include "session-bus.h"
#include "windows.h"
#include "shared/thread.h"
#include <dbus/dbus.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define LOGIN "org.freedesktop.login1"
#define MANAGER "/org/freedesktop/login1"
enum Step { MATCH, OWNER, UID, SESSION, PROPERTIES, CAN_OFF, CAN_REBOOT, ACTION };
static struct {
    JSContext *ctx;
    JSValue api;
    DBusConnection *bus;
    DBusPendingCall *pending;
    enum Step step;
    long long deadline, refresh;
    uint32_t revision;
    bool ready, active, remote, local_user, changed, failed, trusted, sent;
    char owner[256], session[256], can_off[16], can_reboot[16], operation[16], error[256];
    char outcome[16];
} power;

static bool ordinary_identity(uid_t real, uid_t effective)
{
    return real != 0 && real == effective;
}
static void changed(void)
{
    if (!++power.revision) ++power.revision;
    power.changed = true;
}
static void error(const char *message)
{
    if (message != power.error) snprintf(power.error, sizeof(power.error), "%s", message);
    changed();
    fprintf(stderr, "[power] %s\n", power.error);
}
static void drop_pending(void)
{
    if (!power.pending) return;
    dbus_pending_call_cancel(power.pending);
    dbus_pending_call_unref(power.pending);
    power.pending = NULL;
}
static void request_failed(bool uncertain, const char *message)
{
    power.operation[0] = 0;
    strcpy(power.outcome, uncertain ? "uncertain" : "failed");
    power.sent = uncertain;
    error(message);
}
static bool send(enum Step step, DBusMessage *message)
{
    if (!message) {
        power.failed = true; power.ready = false; power.operation[0] = 0;
        request_failed(false, "Cannot allocate power request; no power action was sent"); return false;
    }
    if (power.pending || !dbus_connection_send_with_reply(power.bus, message, &power.pending, 3000) || !power.pending) {
        dbus_message_unref(message);
        power.failed = true; power.ready = false; power.operation[0] = 0;
        request_failed(step == ACTION, step == ACTION ?
            "Power request could not be tracked; it may already have been sent. Do not repeat it." :
            "Cannot send power state request; no power action was sent"); return false;
    }
    dbus_message_unref(message);
    power.step = step; power.deadline = pu_now_ms() + 3000;
    if (step == ACTION) power.sent = true;
    return true;
}
static DBusMessage *method(const char *path, const char *interface, const char *member)
{ return dbus_message_new_method_call(power.owner, path, interface, member); }
static void discover(void)
{
    DBusMessage *message = dbus_message_new_method_call(DBUS_SERVICE_DBUS, DBUS_PATH_DBUS, DBUS_INTERFACE_DBUS, "GetNameOwner");
    const char *name = LOGIN;
    if (message && !dbus_message_append_args(message, DBUS_TYPE_STRING, &name, DBUS_TYPE_INVALID)) {
        dbus_message_unref(message); message = NULL;
    }
    send(OWNER, message);
}
static void reset(void)
{
    drop_pending();
    if (power.sent && strcmp(power.outcome, "accepted")) {
        strcpy(power.outcome, "uncertain");
        snprintf(power.error, sizeof(power.error), "%s",
            "Power service disconnected after the request was sent; shutdown/restart may already be underway. Do not repeat it.");
    } else if (*power.operation && !power.sent) {
        strcpy(power.outcome, "failed");
        snprintf(power.error, sizeof(power.error), "%s", "Power verification was interrupted; no power action was sent.");
    }
    power.ready = power.active = power.local_user = power.trusted = false;
    power.owner[0] = power.session[0] = power.operation[0] = 0;
    strcpy(power.can_off, "unknown"); strcpy(power.can_reboot, "unknown");
    changed();
}
static bool properties(DBusMessage *message)
{
    if (!dbus_message_has_signature(message, "a{sv}")) return false;
    DBusMessageIter root, array;
    dbus_message_iter_init(message, &root); dbus_message_iter_recurse(&root, &array);
    bool active = false, remote = true, own = false, seat = false;
    unsigned count = 0, fields = 0;
    while (dbus_message_iter_get_arg_type(&array) != DBUS_TYPE_INVALID) {
        if (++count > 128) return false;
        DBusMessageIter entry, value;
        const char *name;
        dbus_message_iter_recurse(&array, &entry); dbus_message_iter_get_basic(&entry, &name);
        dbus_message_iter_next(&entry); dbus_message_iter_recurse(&entry, &value);
        if (!strcmp(name, "Active") || !strcmp(name, "Remote")) {
            if (dbus_message_iter_get_arg_type(&value) != DBUS_TYPE_BOOLEAN) return false;
            dbus_bool_t boolean;
            dbus_message_iter_get_basic(&value, &boolean);
            if (!strcmp(name, "Active")) { active = boolean; fields |= 1; }
            else { remote = boolean; fields |= 2; }
        } else if (!strcmp(name, "User") || !strcmp(name, "Seat")) {
            if (dbus_message_iter_get_arg_type(&value) != DBUS_TYPE_STRUCT) return false;
            DBusMessageIter tuple;
            dbus_message_iter_recurse(&value, &tuple);
            if (!strcmp(name, "User")) {
                uint32_t uid;
                if (dbus_message_iter_get_arg_type(&tuple) != DBUS_TYPE_UINT32) return false;
                dbus_message_iter_get_basic(&tuple, &uid); own = uid == getuid(); fields |= 4;
            } else {
                const char *id;
                if (dbus_message_iter_get_arg_type(&tuple) != DBUS_TYPE_STRING) return false;
                dbus_message_iter_get_basic(&tuple, &id); seat = *id != 0; fields |= 8;
            }
        }
        dbus_message_iter_next(&array);
    }
    if (fields != 15) return false;
    power.active = active && seat; power.remote = remote; power.local_user = own;
    return true;
}
static void read_session(void)
{
    DBusMessage *message = method(MANAGER, LOGIN ".Manager", "GetSessionByPID");
    uint32_t pid = (uint32_t)getpid();
    if (message && !dbus_message_append_args(message, DBUS_TYPE_UINT32, &pid, DBUS_TYPE_INVALID)) {
        dbus_message_unref(message); message = NULL;
    }
    send(SESSION, message);
}
static bool capability(DBusMessage *message, char *destination)
{
    const char *value;
    if (!dbus_message_get_args(message, NULL, DBUS_TYPE_STRING, &value, DBUS_TYPE_INVALID) ||
        (strcmp(value, "yes") && strcmp(value, "no") && strcmp(value, "na") && strcmp(value, "challenge"))) return false;
    strcpy(destination, value);
    return true;
}
static void complete(enum Step step, DBusMessage *reply)
{
    bool valid = reply && dbus_message_get_type(reply) == DBUS_MESSAGE_TYPE_METHOD_RETURN;
    if (valid && step != MATCH && step != OWNER && step != UID)
        valid = dbus_message_get_sender(reply) && !strcmp(dbus_message_get_sender(reply), power.owner);
    if (!valid) {
        if (step == MATCH) power.failed = true;
        char message[256];
        bool rejected = step == ACTION && reply && dbus_message_get_type(reply) == DBUS_MESSAGE_TYPE_ERROR &&
            dbus_message_get_sender(reply) && !strcmp(dbus_message_get_sender(reply), power.owner) &&
            (dbus_message_is_error(reply, DBUS_ERROR_ACCESS_DENIED) ||
                dbus_message_is_error(reply, DBUS_ERROR_AUTH_FAILED) ||
                dbus_message_is_error(reply, DBUS_ERROR_UNKNOWN_METHOD) ||
                dbus_message_is_error(reply, DBUS_ERROR_NOT_SUPPORTED) ||
                dbus_message_is_error(reply, "org.freedesktop.DBus.Error.InteractiveAuthorizationRequired"));
        bool uncertain = step == ACTION && !rejected;
        snprintf(message, sizeof(message), "%s: %s",
            uncertain ? "Power result is unknown after sending; do not repeat the request" :
            rejected ? "The login service rejected the power action" : "Power verification failed; no power action was sent",
            reply && dbus_message_get_error_name(reply) ? dbus_message_get_error_name(reply) : "timeout or invalid service reply");
        power.ready = false;
        request_failed(uncertain, message);
        if (rejected) strcpy(power.outcome, "rejected");
        power.refresh = pu_now_ms() + 5000;
        return;
    }
    if (step == MATCH) {
        if (!dbus_message_has_signature(reply, "")) goto invalid;
        discover();
    } else if (step == OWNER) {
        const char *owner;
        if (!dbus_message_get_args(reply, NULL, DBUS_TYPE_STRING, &owner, DBUS_TYPE_INVALID) ||
            *owner != ':' || strlen(owner) >= sizeof(power.owner)) goto invalid;
        strcpy(power.owner, owner);
        DBusMessage *message = dbus_message_new_method_call(DBUS_SERVICE_DBUS, DBUS_PATH_DBUS, DBUS_INTERFACE_DBUS, "GetConnectionUnixUser");
        if (message && !dbus_message_append_args(message, DBUS_TYPE_STRING, &owner, DBUS_TYPE_INVALID)) {
            dbus_message_unref(message); message = NULL;
        }
        send(UID, message);
    } else if (step == UID) {
        uint32_t uid;
        if (!dbus_message_get_args(reply, NULL, DBUS_TYPE_UINT32, &uid, DBUS_TYPE_INVALID) || uid != 0) {
            reset(); power.failed = true; error("Power management requires the root-owned login service"); return;
        }
        power.trusted = true;
        read_session();
    } else if (step == SESSION) {
        const char *session;
        if (!dbus_message_get_args(reply, NULL, DBUS_TYPE_OBJECT_PATH, &session, DBUS_TYPE_INVALID) ||
            strncmp(session, MANAGER "/session/", sizeof(MANAGER "/session/") - 1) ||
            strlen(session) >= sizeof(power.session)) goto invalid;
        strcpy(power.session, session);
        DBusMessage *message = method(session, DBUS_INTERFACE_PROPERTIES, "GetAll");
        const char *interface = LOGIN ".Session";
        if (message && !dbus_message_append_args(message, DBUS_TYPE_STRING, &interface, DBUS_TYPE_INVALID)) {
            dbus_message_unref(message); message = NULL;
        }
        send(PROPERTIES, message);
    } else if (step == PROPERTIES) {
        if (!properties(reply)) goto invalid;
        send(CAN_OFF, method(MANAGER, LOGIN ".Manager", "CanPowerOff"));
    } else if (step == CAN_OFF) {
        if (!capability(reply, power.can_off)) goto invalid;
        send(CAN_REBOOT, method(MANAGER, LOGIN ".Manager", "CanReboot"));
    } else if (step == CAN_REBOOT) {
        if (!capability(reply, power.can_reboot)) goto invalid;
        power.ready = true; power.refresh = pu_now_ms() + 5000;
        if (!power.sent && (!*power.outcome || !strcmp(power.outcome, "checking"))) power.error[0] = 0;
        changed();
        if (*power.operation) {
            const char *allowed = !strcmp(power.operation, "poweroff") ? power.can_off : power.can_reboot;
            if (!power.active || power.remote || !power.local_user || strcmp(allowed, "yes")) {
                request_failed(false, "The current local session is not authorized for this power action; no action was sent"); return;
            }
            DBusMessage *message = method(MANAGER, LOGIN ".Manager", !strcmp(power.operation, "poweroff") ? "PowerOff" : "Reboot");
            dbus_bool_t interactive = false;
            if (message && !dbus_message_append_args(message, DBUS_TYPE_BOOLEAN, &interactive, DBUS_TYPE_INVALID)) {
                dbus_message_unref(message); message = NULL;
            }
            if (!send(ACTION, message)) power.operation[0] = 0;
        }
    } else {
        if (!dbus_message_has_signature(reply, "")) goto invalid;
        power.operation[0] = 0; strcpy(power.outcome, "accepted"); power.error[0] = 0; changed();
    }
    return;
invalid:
    if (step == MATCH) power.failed = true;
    power.ready = false;
    power.refresh = pu_now_ms() + 5000;
    request_failed(step == ACTION, step == ACTION ?
        "Invalid power acknowledgment after sending; shutdown/restart may already be underway. Do not repeat it." :
        "Invalid power service state; no power action was sent");
}
static DBusHandlerResult filter(DBusConnection *bus, DBusMessage *message, void *data)
{
    (void)bus; (void)data;
    if (dbus_message_is_signal(message, DBUS_INTERFACE_DBUS, "NameOwnerChanged") &&
        dbus_message_get_sender(message) && !strcmp(dbus_message_get_sender(message), DBUS_SERVICE_DBUS)) {
        const char *name, *old, *next;
        if (dbus_message_get_args(message, NULL, DBUS_TYPE_STRING, &name, DBUS_TYPE_STRING, &old,
            DBUS_TYPE_STRING, &next, DBUS_TYPE_INVALID) && !strcmp(name, LOGIN)) {
            reset(); power.failed = false; power.refresh = pu_now_ms() + 50;
            error(power.sent ? *power.error ? power.error :
                "The login service accepted the power request; it cannot be repeated here." :
                "Login service changed; verifying the new owner");
        }
    }
    return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
}
static void stop(void)
{
    reset();
    if (power.bus) {
        dbus_connection_remove_filter(power.bus, filter, NULL);
        dbus_connection_close(power.bus); dbus_connection_unref(power.bus); power.bus = NULL;
    }
    power.failed = false;
}
static JSValue start(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!pu_desktop_windows_ready(ctx)) return JS_EXCEPTION;
    if (!ordinary_identity(getuid(), geteuid()))
        return JS_ThrowTypeError(ctx, "Power controls require an ordinary non-setid desktop user");
    if (power.sent) return JS_UNDEFINED;
    if (power.bus && !power.failed && dbus_connection_get_is_connected(power.bus)) return JS_UNDEFINED;
    stop();
    if (!power.sent) power.error[0] = 0;
    char message[256];
    power.bus = pu_system_bus_connect(message, sizeof(message));
    if (!power.bus) return JS_ThrowInternalError(ctx, "%s", message);
    dbus_connection_set_max_message_size(power.bus, 65536);
    dbus_connection_set_max_received_size(power.bus, 256 * 1024);
    if (!dbus_connection_add_filter(power.bus, filter, NULL, NULL)) {
        stop(); return JS_ThrowInternalError(ctx, "Cannot monitor login service ownership");
    }
    power.refresh = pu_now_ms();
    DBusMessage *subscription = dbus_message_new_method_call(DBUS_SERVICE_DBUS, DBUS_PATH_DBUS, DBUS_INTERFACE_DBUS, "AddMatch");
    const char *match = "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.freedesktop.login1'";
    if (subscription && !dbus_message_append_args(subscription, DBUS_TYPE_STRING, &match, DBUS_TYPE_INVALID)) {
        dbus_message_unref(subscription); subscription = NULL;
    }
    if (!send(MATCH, subscription)) {
        stop(); return JS_ThrowInternalError(ctx, "Cannot subscribe to login service ownership");
    }
    return JS_UNDEFINED;
}
static JSValue stop_service(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!pu_desktop_windows_ready(ctx)) return JS_EXCEPTION;
    stop(); return JS_UNDEFINED;
}
static JSValue snapshot(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!pu_desktop_windows_ready(ctx)) return JS_EXCEPTION;
    JSValue result = JS_NewObject(ctx);
    if (JS_IsException(result)) return result;
#define PUT(name, value) if (JS_SetPropertyStr(ctx, result, name, value) < 0) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    PUT("version", JS_NewUint32(ctx, 1));
    PUT("ready", JS_NewBool(ctx, power.ready && !power.failed));
    PUT("active", JS_NewBool(ctx, power.active && !power.remote && power.local_user));
    PUT("revision", JS_NewUint32(ctx, power.revision));
    PUT("poweroff", JS_NewString(ctx, power.can_off));
    PUT("reboot", JS_NewString(ctx, power.can_reboot));
    PUT("operation", JS_NewString(ctx, power.operation));
    PUT("error", JS_NewString(ctx, power.error));
    PUT("session", JS_NewString(ctx, power.session));
    PUT("outcome", JS_NewString(ctx, power.outcome));
    PUT("sent", JS_NewBool(ctx, power.sent));
    PUT("busy", JS_NewBool(ctx, power.pending != NULL));
    PUT("cancellable", JS_NewBool(ctx, *power.operation && !power.sent));
#undef PUT
    return result;
}
static JSValue action(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!pu_desktop_windows_ready(ctx)) return JS_EXCEPTION;
    double revision;
    if (argc != 2 || !JS_IsNumber(argv[0]) || JS_ToFloat64(ctx, &revision, argv[0]) < 0 ||
        !isfinite(revision) || revision != power.revision || !JS_IsString(argv[1]) ||
        !power.ready || power.failed || !power.active || power.remote || !power.local_user || power.pending || power.sent ||
        !ordinary_identity(getuid(), geteuid()))
        return JS_ThrowTypeError(ctx, "Power operation requires current authorized session state");
    size_t length;
    const char *name = JS_ToCStringLen(ctx, &length, argv[1]);
    if (!name) return JS_EXCEPTION;
    bool off = length == 8 && !memcmp(name, "poweroff", 8), reboot = length == 6 && !memcmp(name, "reboot", 6);
    JS_FreeCString(ctx, name);
    if ((!off && !reboot) || strcmp(off ? power.can_off : power.can_reboot, "yes"))
        return JS_ThrowTypeError(ctx, "Power action is not available without additional authorization");
    strcpy(power.operation, off ? "poweroff" : "reboot");
    strcpy(power.outcome, "checking");
    power.error[0] = 0; changed();
    read_session();
    return JS_UNDEFINED;
}
static JSValue cancel_action(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!pu_desktop_windows_ready(ctx)) return JS_EXCEPTION;
    if (power.sent) return JS_ThrowTypeError(ctx, "The final power action was sent and cannot be cancelled here");
    if (!*power.operation) return JS_UNDEFINED;
    drop_pending();
    power.operation[0] = 0; strcpy(power.outcome, "cancelled"); power.error[0] = 0;
    power.refresh = pu_now_ms(); changed();
    return JS_UNDEFINED;
}
int pu_power_install(JSContext *ctx, JSValueConst api)
{
    power.ctx = ctx; power.api = JS_DupValue(ctx, api);
    return JS_SetPropertyStr(ctx, api, "startPower", JS_NewCFunction(ctx, start, "startPower", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "stopPower", JS_NewCFunction(ctx, stop_service, "stopPower", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "powerState", JS_NewCFunction(ctx, snapshot, "powerState", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "requestPower", JS_NewCFunction(ctx, action, "requestPower", 2)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "cancelPower", JS_NewCFunction(ctx, cancel_action, "cancelPower", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "onPowerChanged", JS_NULL) >= 0;
}
int pu_power_pump(void)
{
    if (!power.ctx || !power.bus) return 0;
    if (!power.failed) {
        if (!dbus_connection_read_write(power.bus, 0) || !dbus_connection_get_is_connected(power.bus)) {
            reset(); power.failed = true;
            error(power.sent ? *power.error ? power.error : "The login service accepted the power request and disconnected." :
                "System power bus disconnected; no power action was sent");
        } else {
            for (unsigned i = 0; i < 16 && dbus_connection_get_dispatch_status(power.bus) == DBUS_DISPATCH_DATA_REMAINS; i++)
                if (dbus_connection_dispatch(power.bus) == DBUS_DISPATCH_NEED_MEMORY) {
                    drop_pending(); power.failed = true; power.ready = false;
                    if (power.sent && !strcmp(power.outcome, "accepted"))
                        error("The accepted power request cannot be repeated; further service status is unavailable.");
                    else request_failed(power.sent, power.sent ?
                            "Power acknowledgment could not be processed after sending; do not repeat the request." :
                            "Cannot inspect the power service; no power action was sent");
                    break;
                }
            if (power.pending && (dbus_pending_call_get_completed(power.pending) || pu_now_ms() >= power.deadline)) {
                DBusMessage *reply = dbus_pending_call_get_completed(power.pending) ? dbus_pending_call_steal_reply(power.pending) : NULL;
                enum Step step = power.step;
                drop_pending(); complete(step, reply);
                if (reply) dbus_message_unref(reply);
            }
            if (!power.failed && !power.pending && !power.sent && pu_now_ms() >= power.refresh) {
                power.refresh = pu_now_ms() + 5000;
                if (power.trusted) read_session(); else discover();
            }
        }
    }
    if (!power.changed) return 0;
    power.changed = false;
    JSValue callback = JS_GetPropertyStr(power.ctx, power.api, "onPowerChanged"), result = JS_UNDEFINED;
    if (JS_IsException(callback)) result = JS_EXCEPTION;
    else if (JS_IsFunction(power.ctx, callback)) result = JS_Call(power.ctx, callback, power.api, 0, NULL);
    else if (!JS_IsNull(callback) && !JS_IsUndefined(callback))
        result = JS_ThrowTypeError(power.ctx, "Power callback must be a function");
    if (JS_IsException(result)) {
        JSValue exception = JS_GetException(power.ctx);
        const char *message = JS_ToCString(power.ctx, exception);
        fprintf(stderr, "[power] Callback failed: %s\n", message ? message : "unknown");
        JS_FreeCString(power.ctx, message); JS_FreeValue(power.ctx, exception);
    } else JS_FreeValue(power.ctx, result);
    JS_FreeValue(power.ctx, callback);
    return 1;
}
void pu_power_shutdown(void)
{
    stop();
    if (power.ctx) JS_FreeValue(power.ctx, power.api);
    memset(&power, 0, sizeof(power));
}
