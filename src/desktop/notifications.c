#include "notifications.h"
#include "session-bus.h"
#include "windows.h"
#include "core/thread.h"
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SERVICE "org.freedesktop.Notifications"
#define OBJECT "/org/freedesktop/Notifications"
#define MAX_NOTICES 64
#define MAX_ACTIONS 8
struct Notice {
    uint32_t id, revision;
    char *owner, *application, *summary, *body;
    char *actions[MAX_ACTIONS * 2];
    unsigned action_count, urgency;
    bool resident;
    long long deadline;
    struct Notice *next;
};
static struct {
    JSContext *ctx;
    JSValue api;
    DBusConnection *bus;
    struct Notice *notices;
    uint32_t next_id, revision;
    bool changed, failed;
    char error[256];
} server;

static void fail(const char *message)
{
    if (!server.failed) {
        server.failed = server.changed = true;
        snprintf(server.error, sizeof(server.error), "%s", message);
        fprintf(stderr, "[notifications] %s\n", message);
    }
}
static void free_notice(struct Notice *notice)
{
    free(notice->owner); free(notice->application); free(notice->summary); free(notice->body);
    for (unsigned i = 0; i < notice->action_count * 2; i++) free(notice->actions[i]);
    free(notice);
}
static bool send_message(DBusMessage *message)
{
    if (!message) { fail("Cannot allocate D-Bus notification message"); return false; }
    if (dbus_connection_get_outgoing_size(server.bus) > 2 * 1024 * 1024) {
        dbus_message_unref(message); fail("Notification reply queue exceeds supported limits"); return false;
    }
    bool ok = dbus_connection_send(server.bus, message, NULL);
    dbus_message_unref(message);
    if (!ok) fail("Cannot queue D-Bus notification message");
    return ok;
}
static DBusHandlerResult reply_error(DBusMessage *request, const char *name, const char *message)
{
    return send_message(dbus_message_new_error(request, name, message)) ? DBUS_HANDLER_RESULT_HANDLED : DBUS_HANDLER_RESULT_NEED_MEMORY;
}
static struct Notice **find_notice(uint32_t id)
{
    struct Notice **at = &server.notices;
    while (*at && (*at)->id != id) at = &(*at)->next;
    return at;
}
static bool signal_notice(struct Notice *notice, const char *name, const char *action, uint32_t reason)
{
    DBusMessage *message = dbus_message_new_signal(OBJECT, SERVICE, name);
    if (!message) { fail("Cannot allocate notification signal"); return false; }
    bool ok = dbus_message_set_destination(message, notice->owner) &&
        dbus_message_append_args(message, DBUS_TYPE_UINT32, &notice->id, DBUS_TYPE_INVALID);
    if (ok) ok = action ? dbus_message_append_args(message, DBUS_TYPE_STRING, &action, DBUS_TYPE_INVALID) :
        dbus_message_append_args(message, DBUS_TYPE_UINT32, &reason, DBUS_TYPE_INVALID);
    if (!ok) { dbus_message_unref(message); fail("Cannot populate notification signal"); return false; }
    return send_message(message);
}
static bool close_notice(struct Notice **slot, uint32_t reason)
{
    struct Notice *notice = *slot;
    if (!signal_notice(notice, "NotificationClosed", NULL, reason)) return false;
    *slot = notice->next; free_notice(notice);
    server.changed = true;
    return true;
}
static const char *string_arg(DBusMessageIter *iter)
{
    const char *text;
    dbus_message_iter_get_basic(iter, &text);
    dbus_message_iter_next(iter);
    return text;
}
static DBusHandlerResult notify(DBusMessage *request)
{
    if (!dbus_message_has_signature(request, "susssasa{sv}i"))
        return reply_error(request, DBUS_ERROR_INVALID_ARGS, "Notify expects susssasa{sv}i");
    DBusMessageIter args, actions, hints;
    dbus_message_iter_init(request, &args);
    const char *application = string_arg(&args);
    uint32_t replacement;
    dbus_message_iter_get_basic(&args, &replacement); dbus_message_iter_next(&args);
    const char *icon = string_arg(&args), *summary = string_arg(&args), *body = string_arg(&args);
    const char *owner = dbus_message_get_sender(request);
    if (!owner || strlen(application) > 256 || strlen(icon) > 4096 || !*summary ||
        strlen(summary) > 1024 || strlen(body) > 8192)
        return reply_error(request, DBUS_ERROR_LIMITS_EXCEEDED, "Notification text exceeds supported limits");
    struct Notice **existing = find_notice(replacement);
    if (*existing && strcmp((*existing)->owner, owner))
        return reply_error(request, DBUS_ERROR_ACCESS_DENIED, "Cannot replace another sender's notification");
    size_t total = 0, own = 0;
    for (struct Notice *item = server.notices; item; item = item->next) {
        total++; if (!strcmp(item->owner, owner)) own++;
    }
    if (!*existing && (total >= MAX_NOTICES || own >= 16))
        return reply_error(request, DBUS_ERROR_LIMITS_EXCEEDED, "Notification queue is full");
    struct Notice *notice = calloc(1, sizeof(*notice));
    if (!notice) return DBUS_HANDLER_RESULT_NEED_MEMORY;
    notice->owner = strdup(owner); notice->application = strdup(application);
    notice->summary = strdup(summary); notice->body = strdup(body);
    if (!notice->owner || !notice->application || !notice->summary || !notice->body) goto memory;
    dbus_message_iter_recurse(&args, &actions);
    unsigned count = 0;
    const char *action_strings[MAX_ACTIONS * 2];
    while (dbus_message_iter_get_arg_type(&actions) != DBUS_TYPE_INVALID) {
        const char *text = string_arg(&actions);
        if (count == MAX_ACTIONS * 2 || !*text || strlen(text) > 256) goto invalid;
        action_strings[count++] = text;
    }
    if (count % 2) goto invalid;
    for (unsigned i = 0; i < count; i += 2) {
        for (unsigned j = 0; j < i; j += 2) if (!strcmp(action_strings[i], action_strings[j])) goto invalid;
        notice->action_count++;
        notice->actions[i] = strdup(action_strings[i]); notice->actions[i + 1] = strdup(action_strings[i + 1]);
        if (!notice->actions[i] || !notice->actions[i + 1]) goto memory;
    }
    dbus_message_iter_next(&args); dbus_message_iter_recurse(&args, &hints);
    notice->urgency = 1;
    unsigned hint_count = 0;
    while (dbus_message_iter_get_arg_type(&hints) != DBUS_TYPE_INVALID) {
        if (++hint_count > 32) goto invalid;
        DBusMessageIter entry, variant;
        dbus_message_iter_recurse(&hints, &entry);
        const char *name = string_arg(&entry);
        dbus_message_iter_recurse(&entry, &variant);
        if (!strcmp(name, "urgency")) {
            if (dbus_message_iter_get_arg_type(&variant) != DBUS_TYPE_BYTE) goto invalid;
            unsigned char urgency;
            dbus_message_iter_get_basic(&variant, &urgency);
            if (urgency > 2) goto invalid;
            notice->urgency = urgency;
        } else if (!strcmp(name, "resident")) {
            if (dbus_message_iter_get_arg_type(&variant) != DBUS_TYPE_BOOLEAN) goto invalid;
            dbus_bool_t resident;
            dbus_message_iter_get_basic(&variant, &resident); notice->resident = resident;
        }
        dbus_message_iter_next(&hints);
    }
    dbus_message_iter_next(&args);
    int32_t timeout;
    dbus_message_iter_get_basic(&args, &timeout);
    if (timeout < -1) goto invalid;
    if (timeout == -1) timeout = notice->urgency == 2 ? 0 : 5000;
    notice->deadline = timeout > 0 ? pu_now_ms() + timeout : 0;
    notice->revision = ++server.revision;
    if (!notice->revision) notice->revision = ++server.revision;
    if (*existing) notice->id = (*existing)->id;
    else {
        do { notice->id = ++server.next_id; } while (!notice->id || *find_notice(notice->id));
    }
    DBusMessage *reply = dbus_message_new_method_return(request);
    if (!reply || !dbus_message_append_args(reply, DBUS_TYPE_UINT32, &notice->id, DBUS_TYPE_INVALID)) {
        if (reply) dbus_message_unref(reply);
        goto memory;
    }
    if (!send_message(reply)) goto memory;
    if (*existing) {
        struct Notice *old = *existing; notice->next = old->next; *existing = notice; free_notice(old);
    } else { notice->next = server.notices; server.notices = notice; }
    server.changed = true;
    return DBUS_HANDLER_RESULT_HANDLED;
invalid:
    free_notice(notice);
    return reply_error(request, DBUS_ERROR_INVALID_ARGS, "Invalid notification actions, hints or timeout");
memory:
    free_notice(notice);
    return DBUS_HANDLER_RESULT_NEED_MEMORY;
}
static const char introspection[] =
    "<node><interface name='org.freedesktop.Notifications'>"
    "<method name='GetCapabilities'><arg direction='out' type='as'/></method>"
    "<method name='GetServerInformation'><arg direction='out' type='s'/><arg direction='out' type='s'/>"
    "<arg direction='out' type='s'/><arg direction='out' type='s'/></method>"
    "<method name='Notify'><arg direction='in' type='s'/><arg direction='in' type='u'/>"
    "<arg direction='in' type='s'/><arg direction='in' type='s'/><arg direction='in' type='s'/>"
    "<arg direction='in' type='as'/><arg direction='in' type='a{sv}'/><arg direction='in' type='i'/>"
    "<arg direction='out' type='u'/></method>"
    "<method name='CloseNotification'><arg direction='in' type='u'/></method>"
    "<signal name='NotificationClosed'><arg type='u'/><arg type='u'/></signal>"
    "<signal name='ActionInvoked'><arg type='u'/><arg type='s'/></signal>"
    "</interface><interface name='org.freedesktop.DBus.Introspectable'>"
    "<method name='Introspect'><arg direction='out' type='s'/></method></interface></node>";
static DBusHandlerResult message(DBusConnection *connection, DBusMessage *request, void *data)
{
    (void)connection; (void)data;
    if (dbus_message_get_type(request) != DBUS_MESSAGE_TYPE_METHOD_CALL) return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
    if (server.failed) return reply_error(request, DBUS_ERROR_FAILED, server.error);
    if (dbus_message_is_method_call(request, SERVICE, "Notify")) return notify(request);
    if (dbus_message_is_method_call(request, SERVICE, "CloseNotification")) {
        if (!dbus_message_has_signature(request, "u")) return reply_error(request, DBUS_ERROR_INVALID_ARGS, "Expected notification ID");
        uint32_t id;
        dbus_message_get_args(request, NULL, DBUS_TYPE_UINT32, &id, DBUS_TYPE_INVALID);
        struct Notice **slot = find_notice(id);
        if (*slot && strcmp((*slot)->owner, dbus_message_get_sender(request)))
            return reply_error(request, DBUS_ERROR_ACCESS_DENIED, "Cannot close another sender's notification");
        if (*slot && !close_notice(slot, 3)) return DBUS_HANDLER_RESULT_NEED_MEMORY;
        send_message(dbus_message_new_method_return(request));
        return DBUS_HANDLER_RESULT_HANDLED;
    }
    DBusMessage *reply = NULL;
    if (dbus_message_is_method_call(request, SERVICE, "GetCapabilities") && dbus_message_has_signature(request, "")) {
        reply = dbus_message_new_method_return(request);
        const char *capabilities[] = { "actions", "body" };
        const char **values = capabilities;
        if (reply && !dbus_message_append_args(reply, DBUS_TYPE_ARRAY, DBUS_TYPE_STRING, &values, 2, DBUS_TYPE_INVALID)) {
            dbus_message_unref(reply); reply = NULL;
        }
    } else if (dbus_message_is_method_call(request, SERVICE, "GetServerInformation") && dbus_message_has_signature(request, "")) {
        reply = dbus_message_new_method_return(request);
        const char *name = "PollyShell", *vendor = "PollyUI", *version = "0.1", *spec = "1.2";
        if (reply && !dbus_message_append_args(reply, DBUS_TYPE_STRING, &name, DBUS_TYPE_STRING, &vendor,
            DBUS_TYPE_STRING, &version, DBUS_TYPE_STRING, &spec, DBUS_TYPE_INVALID)) {
            dbus_message_unref(reply); reply = NULL;
        }
    } else if (dbus_message_is_method_call(request, DBUS_INTERFACE_INTROSPECTABLE, "Introspect") &&
        dbus_message_has_signature(request, "")) {
        reply = dbus_message_new_method_return(request);
        const char *xml = introspection;
        if (reply && !dbus_message_append_args(reply, DBUS_TYPE_STRING, &xml, DBUS_TYPE_INVALID)) {
            dbus_message_unref(reply); reply = NULL;
        }
    } else if (dbus_message_is_method_call(request, DBUS_INTERFACE_PEER, "Ping") && dbus_message_has_signature(request, ""))
        reply = dbus_message_new_method_return(request);
    else return reply_error(request, DBUS_ERROR_UNKNOWN_METHOD, "Unsupported notification method or signature");
    return send_message(reply) ? DBUS_HANDLER_RESULT_HANDLED : DBUS_HANDLER_RESULT_NEED_MEMORY;
}
static const DBusObjectPathVTable vtable = { .message_function = message };
static void stop(void)
{
    if (server.bus) {
        dbus_connection_unregister_object_path(server.bus, OBJECT);
        dbus_connection_close(server.bus); dbus_connection_unref(server.bus); server.bus = NULL;
    }
    while (server.notices) { struct Notice *next = server.notices->next; free_notice(server.notices); server.notices = next; }
    server.changed = false; server.failed = false; server.error[0] = 0;
}
static int ready(JSContext *ctx)
{
    if (!server.bus || server.failed) {
        JS_ThrowInternalError(ctx, "%s", server.failed ? server.error : "Notification server is not started"); return 0;
    }
    return 1;
}
static JSValue start(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!pu_desktop_windows_ready(ctx)) return JS_EXCEPTION;
    if (server.bus) return server.failed ? JS_ThrowInternalError(ctx, "%s", server.error) : JS_UNDEFINED;
    char error[256];
    server.bus = pu_session_bus_connect(error, sizeof(error));
    if (!server.bus) return JS_ThrowInternalError(ctx, "%s", error);
    if (!dbus_connection_register_object_path(server.bus, OBJECT, &vtable, NULL)) {
        stop(); return JS_ThrowOutOfMemory(ctx);
    }
    DBusError failure = DBUS_ERROR_INIT;
    int result = dbus_bus_request_name(server.bus, SERVICE, DBUS_NAME_FLAG_DO_NOT_QUEUE, &failure);
    if (result != DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER) {
        snprintf(error, sizeof(error), "%s", failure.message ? failure.message : "Another notification server owns the session name");
        dbus_error_free(&failure); stop(); return JS_ThrowInternalError(ctx, "%s", error);
    }
    server.changed = true;
    return JS_UNDEFINED;
}
static JSValue stop_server(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{ (void)ctx; (void)self; (void)argc; (void)argv; stop(); return JS_UNDEFINED; }
static JSValue snapshot(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ready(ctx)) return JS_EXCEPTION;
    JSValue array = JS_NewArray(ctx);
    if (JS_IsException(array)) return array;
    uint32_t index = 0;
    for (struct Notice *notice = server.notices; notice && !JS_HasException(ctx); notice = notice->next) {
        JSValue item = JS_NewObject(ctx), actions = JS_NewArray(ctx);
        if (JS_IsException(item) || JS_IsException(actions)) {
            JS_FreeValue(ctx, item); JS_FreeValue(ctx, actions); break;
        }
        JS_SetPropertyStr(ctx, item, "id", JS_NewUint32(ctx, notice->id));
        JS_SetPropertyStr(ctx, item, "revision", JS_NewUint32(ctx, notice->revision));
        JS_SetPropertyStr(ctx, item, "application", JS_NewString(ctx, notice->application));
        JS_SetPropertyStr(ctx, item, "summary", JS_NewString(ctx, notice->summary));
        JS_SetPropertyStr(ctx, item, "body", JS_NewString(ctx, notice->body));
        JS_SetPropertyStr(ctx, item, "urgency", JS_NewUint32(ctx, notice->urgency));
        JS_SetPropertyStr(ctx, item, "resident", JS_NewBool(ctx, notice->resident));
        for (unsigned i = 0; i < notice->action_count; i++) {
            JSValue action = JS_NewObject(ctx);
            if (JS_IsException(action)) break;
            JS_SetPropertyStr(ctx, action, "key", JS_NewString(ctx, notice->actions[i * 2]));
            JS_SetPropertyStr(ctx, action, "label", JS_NewString(ctx, notice->actions[i * 2 + 1]));
            JS_SetPropertyUint32(ctx, actions, i, action);
        }
        JS_SetPropertyStr(ctx, item, "actions", actions);
        JS_SetPropertyUint32(ctx, array, index++, item);
    }
    if (JS_HasException(ctx)) { JS_FreeValue(ctx, array); return JS_EXCEPTION; }
    return array;
}
static bool integer(JSContext *ctx, JSValueConst value, uint32_t *out)
{
    double number;
    if (!JS_IsNumber(value) || JS_ToFloat64(ctx, &number, value) < 0) return false;
    if (!isfinite(number) || number < 1 || number > UINT32_MAX || floor(number) != number) return false;
    *out = (uint32_t)number; return true;
}
static JSValue act(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int action)
{
    (void)self;
    if (!ready(ctx)) return JS_EXCEPTION;
    uint32_t id, revision;
    if (argc != (action ? 3 : 2) || !integer(ctx, argv[0], &id) || !integer(ctx, argv[1], &revision))
        return JS_ThrowTypeError(ctx, "Notification action requires current ID and revision");
    struct Notice **slot = find_notice(id);
    if (!*slot || (*slot)->revision != revision) return JS_ThrowTypeError(ctx, "Stale notification action");
    if (action) {
        if (!JS_IsString(argv[2])) return JS_ThrowTypeError(ctx, "Notification action key must be a string");
        size_t length;
        const char *key = JS_ToCStringLen(ctx, &length, argv[2]);
        if (!key) return JS_EXCEPTION;
        bool found = false;
        for (unsigned i = 0; i < (*slot)->action_count; i++)
            if (length == strlen((*slot)->actions[i * 2]) && !memcmp(key, (*slot)->actions[i * 2], length)) found = true;
        if (!found) { JS_FreeCString(ctx, key); return JS_ThrowTypeError(ctx, "Unknown notification action"); }
        bool sent = signal_notice(*slot, "ActionInvoked", key, 0);
        JS_FreeCString(ctx, key);
        if (!sent) return JS_ThrowInternalError(ctx, "%s", server.error);
        if ((*slot)->resident) return JS_UNDEFINED;
    }
    if (!close_notice(slot, 2)) return JS_ThrowInternalError(ctx, "%s", server.error);
    return JS_UNDEFINED;
}
int pu_notifications_install(JSContext *ctx, JSValueConst api)
{
    server.ctx = ctx; server.api = JS_DupValue(ctx, api);
    const char *bus = getenv("POLLY_SESSION_BUS_ADDRESS");
    return JS_SetPropertyStr(ctx, api, "notificationsAvailable", JS_NewBool(ctx, bus && *bus)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "startNotifications", JS_NewCFunction(ctx, start, "startNotifications", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "stopNotifications", JS_NewCFunction(ctx, stop_server, "stopNotifications", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "notifications", JS_NewCFunction(ctx, snapshot, "notifications", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "dismissNotification", JS_NewCFunctionMagic(ctx, act, "dismissNotification", 2, JS_CFUNC_generic_magic, 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "invokeNotificationAction", JS_NewCFunctionMagic(ctx, act, "invokeNotificationAction", 3, JS_CFUNC_generic_magic, 1)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "onNotificationsChanged", JS_NULL) >= 0;
}
int pu_notifications_pump(void)
{
    if (!server.bus) return 0;
    if (!server.failed) {
        if (!dbus_connection_read_write(server.bus, 0)) fail("Private notification bus disconnected");
        if (dbus_connection_get_dispatch_status(server.bus) == DBUS_DISPATCH_NEED_MEMORY)
            fail("Cannot allocate notification dispatch state");
        for (int i = 0; i < 64 && !server.failed && dbus_connection_get_dispatch_status(server.bus) == DBUS_DISPATCH_DATA_REMAINS; i++)
            if (dbus_connection_dispatch(server.bus) == DBUS_DISPATCH_NEED_MEMORY) fail("Cannot dispatch notification message");
        long long now = pu_now_ms();
        struct Notice **slot = &server.notices;
        while (*slot && !server.failed) {
            if ((*slot)->deadline && now >= (*slot)->deadline) close_notice(slot, 1);
            else slot = &(*slot)->next;
        }
    }
    if (!server.changed) return 0;
    server.changed = false;
    JSContext *ctx = server.ctx;
    JSValue callback = JS_GetPropertyStr(ctx, server.api, "onNotificationsChanged"), result = JS_UNDEFINED;
    if (JS_IsException(callback)) result = JS_EXCEPTION;
    else if (JS_IsFunction(ctx, callback)) result = JS_Call(ctx, callback, server.api, 0, NULL);
    else if (!JS_IsNull(callback) && !JS_IsUndefined(callback)) result = JS_ThrowTypeError(ctx, "Notification callback must be a function");
    JS_FreeValue(ctx, callback);
    if (JS_IsException(result)) {
        JSValue error = JS_GetException(ctx);
        const char *text = JS_ToCString(ctx, error);
        fprintf(stderr, "[notifications] Callback failed: %s\n", text ? text : "unknown error");
        JS_FreeCString(ctx, text); JS_FreeValue(ctx, error);
    } else JS_FreeValue(ctx, result);
    return 1;
}
void pu_notifications_shutdown(void)
{
    stop();
    if (server.ctx) JS_FreeValue(server.ctx, server.api);
    memset(&server, 0, sizeof(server));
}
