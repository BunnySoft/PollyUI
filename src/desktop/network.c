#include "network.h"
#include "session-bus.h"
#include "windows.h"
#include "core/thread.h"
#include <math.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define IWD "net.connman.iwd"
#define IWD_ROOT "/net/connman/iwd"
#define AGENT_PATH "/org/pollyui/NetworkAgent"
#define OBJECT_MANAGER "org.freedesktop.DBus.ObjectManager"
#define MAX_DEVICES 16
#define MAX_NETWORKS 256
#define PATH_BYTES 513
struct Device {
    char path[PATH_BYTES], name[65], address[65], state[32], connected[PATH_BYTES], mode[32];
    bool powered, scanning, station;
};
struct Network {
    char path[PATH_BYTES], device[PATH_BYTES], known[PATH_BYTES], name[129], type[32];
    bool connected;
    int signal, order;
};
struct Model {
    struct Device devices[MAX_DEVICES];
    struct Network networks[MAX_NETWORKS];
    unsigned device_count, network_count;
};
enum PendingType { GET_OWNER, GET_UID, REGISTER_AGENT, GET_MODEL, GET_NETWORKS, OPERATION, GET_INFO };
struct Pending {
    enum PendingType type;
    DBusPendingCall *call;
    uint32_t epoch, revision;
    long long deadline;
    char path[PATH_BYTES];
    struct Pending *next;
};
static struct {
    JSContext *ctx;
    JSValue api;
    DBusConnection *bus;
    struct Pending *pending;
    struct Model model;
    uint32_t epoch, revision, prompt_id;
    bool trusted, registered, ready, changed, refreshing, dirty, fatal;
    bool canceled;
    int network_config;
    char owner[256], error[256], operation[32], target[PATH_BYTES], device[PATH_BYTES];
    DBusMessage *authentication;
    long long authentication_deadline;
    char auth_kind[32], auth_user[257];
} network;

static uint32_t advance(uint32_t *value) { if (!++*value) ++*value; return *value; }
static void set_error(const char *message)
{
    snprintf(network.error, sizeof(network.error), "%s", message);
    network.changed = true;
    fprintf(stderr, "[network] %s\n", message);
}
static void drop_pending(struct Pending *pending)
{
    dbus_pending_call_cancel(pending->call); dbus_pending_call_unref(pending->call); free(pending);
}
static bool send(DBusMessage *message)
{
    if (!message) { set_error("Cannot allocate network response"); return false; }
    bool ok = dbus_connection_get_outgoing_size(network.bus) < 2 * 1024 * 1024 &&
        dbus_connection_send(network.bus, message, NULL);
    dbus_message_unref(message);
    if (!ok) set_error("Cannot send network response");
    return ok;
}
static void cancel_auth(void)
{
    if (network.authentication) {
        send(dbus_message_new_error(network.authentication, IWD ".Agent.Error.Canceled", "Authentication canceled"));
        dbus_message_unref(network.authentication); network.authentication = NULL;
    }
    advance(&network.prompt_id);
    network.auth_kind[0] = network.auth_user[0] = 0;
    network.changed = true;
}
static void reset_service(void)
{
    cancel_auth();
    while (network.pending) { struct Pending *next = network.pending->next; drop_pending(network.pending); network.pending = next; }
    memset(&network.model, 0, sizeof(network.model));
    network.trusted = network.registered = network.ready = network.refreshing = network.dirty = false;
    network.owner[0] = network.operation[0] = network.target[0] = network.device[0] = 0;
    network.network_config = -1;
    advance(&network.epoch); advance(&network.revision); network.changed = true;
}
static struct Pending *queue(enum PendingType type, DBusMessage *message, const char *path, int timeout)
{
    if (!message) { set_error("Cannot allocate network request"); return NULL; }
    unsigned count = 0;
    for (struct Pending *pending = network.pending; pending; pending = pending->next) count++;
    if (count >= 32) { dbus_message_unref(message); set_error("Network request queue is full"); return NULL; }
    struct Pending *pending = calloc(1, sizeof(*pending));
    if (!pending || !dbus_connection_send_with_reply(network.bus, message, pending ? &pending->call : NULL, timeout) || !pending->call) {
        free(pending); dbus_message_unref(message); set_error("Cannot send network request"); return NULL;
    }
    dbus_message_unref(message);
    pending->type = type; pending->epoch = network.epoch; pending->revision = network.revision;
    pending->deadline = pu_now_ms() + timeout;
    if (path) snprintf(pending->path, sizeof(pending->path), "%s", path);
    pending->next = network.pending; network.pending = pending;
    return pending;
}
static DBusMessage *method(const char *path, const char *interface, const char *member)
{ return dbus_message_new_method_call(network.owner, path, interface, member); }
static void discover(void)
{
    DBusMessage *message = dbus_message_new_method_call(DBUS_SERVICE_DBUS, DBUS_PATH_DBUS, DBUS_INTERFACE_DBUS, "GetNameOwner");
    const char *name = IWD;
    if (message && !dbus_message_append_args(message, DBUS_TYPE_STRING, &name, DBUS_TYPE_INVALID)) {
        dbus_message_unref(message); message = NULL;
    }
    queue(GET_OWNER, message, NULL, 3000);
}
static void refresh(void)
{
    if (!network.trusted) return;
    if (network.refreshing) { network.dirty = true; return; }
    if (queue(GET_MODEL, method("/", OBJECT_MANAGER, "GetManagedObjects"), NULL, 5000)) {
        network.refreshing = true; network.dirty = false;
    }
}
static bool text(DBusMessageIter *value, char *out, size_t size, int type)
{
    if (dbus_message_iter_get_arg_type(value) != type) return false;
    const char *string;
    dbus_message_iter_get_basic(value, &string);
    if (strlen(string) >= size) return false;
    strcpy(out, string); return true;
}
static bool boolean(DBusMessageIter *value, bool *out)
{
    if (dbus_message_iter_get_arg_type(value) != DBUS_TYPE_BOOLEAN) return false;
    dbus_bool_t result; dbus_message_iter_get_basic(value, &result); *out = result; return true;
}
static struct Device *device(struct Model *model, const char *path, bool create)
{
    for (unsigned i = 0; i < model->device_count; i++)
        if (!strcmp(model->devices[i].path, path)) return &model->devices[i];
    if (!create || model->device_count >= MAX_DEVICES) return NULL;
    struct Device *result = &model->devices[model->device_count++];
    strcpy(result->path, path); return result;
}
static struct Network *find_network(const char *path)
{
    for (unsigned i = 0; i < network.model.network_count; i++)
        if (!strcmp(network.model.networks[i].path, path)) return &network.model.networks[i];
    return NULL;
}
static bool parse_interface(struct Model *model, const char *path, const char *interface, DBusMessageIter *properties)
{
    struct Device *dev = NULL;
    struct Network *entry = NULL;
    bool station = !strcmp(interface, IWD ".Station"), physical = !strcmp(interface, IWD ".Device");
    if (station || physical) {
        dev = device(model, path, true);
        if (!dev) return false;
        if (station) dev->station = true;
    } else if (!strcmp(interface, IWD ".Network")) {
        if (model->network_count >= MAX_NETWORKS) return false;
        entry = &model->networks[model->network_count++];
        strcpy(entry->path, path); entry->signal = INT_MIN; entry->order = INT_MAX;
    } else return true;
    unsigned count = 0;
    while (dbus_message_iter_get_arg_type(properties) != DBUS_TYPE_INVALID) {
        if (++count > 64) return false;
        DBusMessageIter pair, value;
        dbus_message_iter_recurse(properties, &pair);
        const char *name; dbus_message_iter_get_basic(&pair, &name); dbus_message_iter_next(&pair);
        dbus_message_iter_recurse(&pair, &value);
        bool ok = true;
        if (physical) {
            if (!strcmp(name, "Name")) ok = text(&value, dev->name, sizeof(dev->name), DBUS_TYPE_STRING);
            else if (!strcmp(name, "Address")) ok = text(&value, dev->address, sizeof(dev->address), DBUS_TYPE_STRING);
            else if (!strcmp(name, "Powered")) ok = boolean(&value, &dev->powered);
            else if (!strcmp(name, "Mode")) ok = text(&value, dev->mode, sizeof(dev->mode), DBUS_TYPE_STRING);
        } else if (station) {
            if (!strcmp(name, "State")) ok = text(&value, dev->state, sizeof(dev->state), DBUS_TYPE_STRING);
            else if (!strcmp(name, "Scanning")) ok = boolean(&value, &dev->scanning);
            else if (!strcmp(name, "ConnectedNetwork")) ok = text(&value, dev->connected, sizeof(dev->connected), DBUS_TYPE_OBJECT_PATH);
        } else if (entry) {
            if (!strcmp(name, "Name")) ok = text(&value, entry->name, sizeof(entry->name), DBUS_TYPE_STRING);
            else if (!strcmp(name, "Type")) ok = text(&value, entry->type, sizeof(entry->type), DBUS_TYPE_STRING);
            else if (!strcmp(name, "Device")) ok = text(&value, entry->device, sizeof(entry->device), DBUS_TYPE_OBJECT_PATH);
            else if (!strcmp(name, "KnownNetwork")) ok = text(&value, entry->known, sizeof(entry->known), DBUS_TYPE_OBJECT_PATH);
            else if (!strcmp(name, "Connected")) ok = boolean(&value, &entry->connected);
        }
        if (!ok) return false;
        dbus_message_iter_next(properties);
    }
    return true;
}
static bool parse_model(DBusMessage *reply)
{
    if (!dbus_message_has_signature(reply, "a{oa{sa{sv}}}")) return false;
    struct Model *next = calloc(1, sizeof(*next));
    if (!next) return false;
    DBusMessageIter root, objects;
    dbus_message_iter_init(reply, &root); dbus_message_iter_recurse(&root, &objects);
    bool ok = true; unsigned count = 0;
    while (ok && dbus_message_iter_get_arg_type(&objects) != DBUS_TYPE_INVALID) {
        if (++count > 1024) { ok = false; break; }
        DBusMessageIter pair, interfaces;
        dbus_message_iter_recurse(&objects, &pair);
        const char *path; dbus_message_iter_get_basic(&pair, &path);
        if (strlen(path) >= PATH_BYTES || strncmp(path, IWD_ROOT, sizeof(IWD_ROOT) - 1) ||
            (path[sizeof(IWD_ROOT) - 1] && path[sizeof(IWD_ROOT) - 1] != '/')) { ok = false; break; }
        dbus_message_iter_next(&pair); dbus_message_iter_recurse(&pair, &interfaces);
        unsigned interface_count = 0;
        while (ok && dbus_message_iter_get_arg_type(&interfaces) != DBUS_TYPE_INVALID) {
            if (++interface_count > 16) { ok = false; break; }
            DBusMessageIter item, properties;
            dbus_message_iter_recurse(&interfaces, &item);
            const char *interface; dbus_message_iter_get_basic(&item, &interface);
            dbus_message_iter_next(&item); dbus_message_iter_recurse(&item, &properties);
            ok = parse_interface(next, path, interface, &properties);
            dbus_message_iter_next(&interfaces);
        }
        dbus_message_iter_next(&objects);
    }
    for (unsigned i = 0; ok && i < next->network_count; i++) {
        struct Network *entry = &next->networks[i];
        if (!entry->name[0] || !entry->device[0] || !entry->type[0] || !device(next, entry->device, false)) ok = false;
        for (unsigned j = 0; ok && j < i; j++) if (!strcmp(entry->path, next->networks[j].path)) ok = false;
    }
    if (ok) {
        network.model = *next; advance(&network.revision); network.ready = true; network.changed = true;
        if (!strcmp(network.operation, "connect") &&
            (!find_network(network.target) || !device(&network.model, network.device, false))) {
            cancel_auth();
            struct Pending **operation = &network.pending;
            while (*operation) {
                if ((*operation)->type == OPERATION) {
                    struct Pending *old = *operation; *operation = old->next; drop_pending(old);
                } else operation = &(*operation)->next;
            }
            network.operation[0] = network.target[0] = network.device[0] = 0;
            set_error("Wi-Fi connection target disappeared");
        }
        struct Pending **slot = &network.pending;
        while (*slot) {
            if ((*slot)->type == GET_NETWORKS) {
                struct Pending *old = *slot; *slot = old->next; drop_pending(old);
            } else slot = &(*slot)->next;
        }
        for (unsigned i = 0; i < next->device_count; i++) {
            struct Device *dev = &next->devices[i];
            if (dev->station) queue(GET_NETWORKS, method(dev->path, IWD ".Station", "GetOrderedNetworks"), dev->path, 5000);
        }
    }
    free(next); return ok;
}
static bool parse_order(DBusMessage *reply, const char *path)
{
    if (!dbus_message_has_signature(reply, "a(on)")) return false;
    DBusMessageIter root, entries;
    dbus_message_iter_init(reply, &root); dbus_message_iter_recurse(&root, &entries);
    unsigned order = 0;
    int signals[MAX_NETWORKS], orders[MAX_NETWORKS];
    bool seen[MAX_NETWORKS] = {0};
    for (unsigned i = 0; i < network.model.network_count; i++) {
        signals[i] = network.model.networks[i].signal; orders[i] = network.model.networks[i].order;
    }
    while (dbus_message_iter_get_arg_type(&entries) != DBUS_TYPE_INVALID) {
        if (order >= MAX_NETWORKS) return false;
        DBusMessageIter entry;
        dbus_message_iter_recurse(&entries, &entry);
        const char *name; int16_t signal;
        dbus_message_iter_get_basic(&entry, &name); dbus_message_iter_next(&entry);
        dbus_message_iter_get_basic(&entry, &signal);
        if (signal < -10000 || signal > 0) return false;
        struct Network *item = find_network(name);
        if (item) {
            size_t index = (size_t)(item - network.model.networks);
            if (strcmp(item->device, path) || seen[index]) return false;
            seen[index] = true; signals[index] = signal; orders[index] = (int)order;
        }
        order++; dbus_message_iter_next(&entries);
    }
    for (unsigned i = 0; i < network.model.network_count; i++) {
        network.model.networks[i].signal = signals[i]; network.model.networks[i].order = orders[i];
    }
    network.changed = true; return true;
}
static void failure_reply(const char *operation, DBusMessage *reply)
{
    const char *name = reply ? dbus_message_get_error_name(reply) : NULL;
    char message[256];
    /* Do not log remote error bodies: they may contain a credential or SSID. */
    snprintf(message, sizeof(message), "%s failed: %s", operation, name ? name : "timeout or invalid reply");
    set_error(message);
}
static void completed(struct Pending *pending, DBusMessage *reply)
{
    if (pending->epoch != network.epoch) return;
    bool ok = reply && dbus_message_get_type(reply) == DBUS_MESSAGE_TYPE_METHOD_RETURN;
    if (pending->type == GET_OWNER) {
        const char *owner;
        if (!ok || !dbus_message_get_args(reply, NULL, DBUS_TYPE_STRING, &owner, DBUS_TYPE_INVALID) ||
            strlen(owner) >= sizeof(network.owner) || owner[0] != ':') { failure_reply("iwd discovery", reply); return; }
        strcpy(network.owner, owner);
        DBusMessage *message = dbus_message_new_method_call(DBUS_SERVICE_DBUS, DBUS_PATH_DBUS, DBUS_INTERFACE_DBUS, "GetConnectionUnixUser");
        if (message && !dbus_message_append_args(message, DBUS_TYPE_STRING, &owner, DBUS_TYPE_INVALID)) {
            dbus_message_unref(message); message = NULL;
        }
        queue(GET_UID, message, NULL, 3000);
    } else if (pending->type == GET_UID) {
        uint32_t uid;
        if (!ok || !dbus_message_get_args(reply, NULL, DBUS_TYPE_UINT32, &uid, DBUS_TYPE_INVALID) || uid != 0) {
            network.owner[0] = 0; set_error("iwd must be owned by the root system service"); return;
        }
        network.trusted = true;
        network.error[0] = 0;
        const char *path = AGENT_PATH;
        DBusMessage *message = method(IWD_ROOT, IWD ".AgentManager", "RegisterAgent");
        if (message && !dbus_message_append_args(message, DBUS_TYPE_OBJECT_PATH, &path, DBUS_TYPE_INVALID)) {
            dbus_message_unref(message); message = NULL;
        }
        queue(REGISTER_AGENT, message, NULL, 5000);
        queue(GET_INFO, method(IWD_ROOT, IWD ".Daemon", "GetInfo"), NULL, 5000);
        refresh();
    } else if (pending->type == REGISTER_AGENT) {
        network.registered = ok && dbus_message_has_signature(reply, "");
        if (!network.registered) failure_reply("Network authentication registration", reply);
        network.changed = true;
    } else if (pending->type == GET_INFO) {
        if (ok && dbus_message_has_signature(reply, "a{sv}")) {
            DBusMessageIter root, entries;
            dbus_message_iter_init(reply, &root); dbus_message_iter_recurse(&root, &entries);
            while (dbus_message_iter_get_arg_type(&entries) != DBUS_TYPE_INVALID) {
                DBusMessageIter entry, value; const char *name;
                dbus_message_iter_recurse(&entries, &entry); dbus_message_iter_get_basic(&entry, &name);
                dbus_message_iter_next(&entry); dbus_message_iter_recurse(&entry, &value);
                if (!strcmp(name, "NetworkConfigurationEnabled")) {
                    bool enabled;
                    if (!boolean(&value, &enabled)) { set_error("iwd returned invalid network configuration status"); return; }
                    network.network_config = enabled;
                }
                dbus_message_iter_next(&entries);
            }
            network.changed = true;
        } else if (!reply || (!dbus_message_is_error(reply, DBUS_ERROR_UNKNOWN_METHOD) &&
            !dbus_message_is_error(reply, DBUS_ERROR_UNKNOWN_INTERFACE)))
            failure_reply("iwd configuration query", reply);
    } else if (pending->type == GET_MODEL) {
        network.refreshing = false;
        if (!ok || !parse_model(reply)) { network.ready = false; failure_reply("Wi-Fi discovery", reply); }
        if (network.dirty) refresh();
    } else if (pending->type == GET_NETWORKS) {
        if (pending->revision != network.revision) return;
        if (!ok || !parse_order(reply, pending->path)) failure_reply("Wi-Fi network ordering", reply);
    } else {
        network.operation[0] = network.target[0] = network.device[0] = 0;
        cancel_auth();
        if ((!ok || !dbus_message_has_signature(reply, "")) && !network.canceled) failure_reply("Wi-Fi operation", reply);
        network.canceled = false;
        refresh(); network.changed = true;
    }
}

static DBusHandlerResult agent(DBusConnection *connection, DBusMessage *message, void *data)
{
    (void)connection; (void)data;
    if (dbus_message_get_type(message) != DBUS_MESSAGE_TYPE_METHOD_CALL) return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
    if (!network.trusted || !dbus_message_has_sender(message, network.owner)) {
        send(dbus_message_new_error(message, DBUS_ERROR_ACCESS_DENIED, "Only the authenticated iwd service may call this agent"));
        return DBUS_HANDLER_RESULT_HANDLED;
    }
    if (!dbus_message_has_interface(message, IWD ".Agent")) {
        send(dbus_message_new_error(message, DBUS_ERROR_UNKNOWN_INTERFACE, "Unknown agent interface"));
        return DBUS_HANDLER_RESULT_HANDLED;
    }
    const char *member = dbus_message_get_member(message);
    if (!strcmp(member, "Release") || !strcmp(member, "Cancel")) {
        const char *reason;
        bool valid = !strcmp(member, "Release") ? dbus_message_has_signature(message, "") :
            dbus_message_get_args(message, NULL, DBUS_TYPE_STRING, &reason, DBUS_TYPE_INVALID);
        if (!valid) send(dbus_message_new_error(message, DBUS_ERROR_INVALID_ARGS, "Invalid agent cancellation"));
        else {
            if (network.authentication) { dbus_message_unref(network.authentication); network.authentication = NULL; }
            advance(&network.prompt_id); network.auth_kind[0] = network.auth_user[0] = 0;
            if (!strcmp(member, "Release")) { network.registered = false; set_error("iwd released the authentication agent"); }
            network.changed = true;
            if (!dbus_message_get_no_reply(message)) send(dbus_message_new_method_return(message));
        }
        return DBUS_HANDLER_RESULT_HANDLED;
    }
    const char *kind = !strcmp(member, "RequestPassphrase") ? "passphrase" :
        !strcmp(member, "RequestPrivateKeyPassphrase") ? "private-key" :
        !strcmp(member, "RequestUserNameAndPassword") ? "username-password" :
        !strcmp(member, "RequestUserPassword") ? "password" : NULL;
    const char *path = NULL, *user = "";
    bool valid = kind && (!strcmp(kind, "password") ?
        dbus_message_get_args(message, NULL, DBUS_TYPE_OBJECT_PATH, &path, DBUS_TYPE_STRING, &user, DBUS_TYPE_INVALID) :
        dbus_message_get_args(message, NULL, DBUS_TYPE_OBJECT_PATH, &path, DBUS_TYPE_INVALID));
    if (!valid || network.authentication || strcmp(network.operation, "connect") ||
        !path || strcmp(path, network.target) || strlen(user) > 256) {
        send(dbus_message_new_error(message, IWD ".Agent.Error.Canceled", "No matching interactive connection request"));
        return DBUS_HANDLER_RESULT_HANDLED;
    }
    network.authentication = dbus_message_ref(message);
    strcpy(network.auth_kind, kind); strcpy(network.auth_user, user);
    network.authentication_deadline = pu_now_ms() + 120000;
    advance(&network.prompt_id); network.changed = true;
    return DBUS_HANDLER_RESULT_HANDLED;
}
static const DBusObjectPathVTable agent_vtable = { .message_function = agent };
static DBusHandlerResult filter(DBusConnection *connection, DBusMessage *message, void *data)
{
    (void)connection; (void)data;
    if (dbus_message_is_signal(message, DBUS_INTERFACE_DBUS, "NameOwnerChanged") &&
        dbus_message_has_sender(message, DBUS_SERVICE_DBUS)) {
        const char *name, *old, *owner;
        if (dbus_message_get_args(message, NULL, DBUS_TYPE_STRING, &name, DBUS_TYPE_STRING, &old,
            DBUS_TYPE_STRING, &owner, DBUS_TYPE_INVALID) && !strcmp(name, IWD) && strcmp(old, owner)) {
            reset_service();
            if (*owner) discover();
            else set_error("iwd service is unavailable");
        }
    } else if (network.trusted && dbus_message_has_sender(message, network.owner) &&
        (dbus_message_is_signal(message, OBJECT_MANAGER, "InterfacesAdded") ||
         dbus_message_is_signal(message, OBJECT_MANAGER, "InterfacesRemoved") ||
         dbus_message_is_signal(message, DBUS_INTERFACE_PROPERTIES, "PropertiesChanged"))) refresh();
    return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
}
static void stop(void)
{
    if (network.bus) {
        if (network.registered && network.trusted) {
            const char *path = AGENT_PATH;
            DBusMessage *message = method(IWD_ROOT, IWD ".AgentManager", "UnregisterAgent");
            if (message && dbus_message_append_args(message, DBUS_TYPE_OBJECT_PATH, &path, DBUS_TYPE_INVALID)) {
                dbus_message_set_no_reply(message, true); send(message);
            } else if (message) dbus_message_unref(message);
        }
        reset_service();
        dbus_connection_remove_filter(network.bus, filter, NULL);
        dbus_connection_unregister_object_path(network.bus, AGENT_PATH);
        dbus_connection_close(network.bus); dbus_connection_unref(network.bus); network.bus = NULL;
    }
    network.fatal = false;
}
static JSValue start(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!pu_desktop_windows_ready(ctx)) return JS_EXCEPTION;
    if (network.bus && !network.fatal && network.trusted && network.registered && network.ready) return JS_UNDEFINED;
    stop(); network.error[0] = 0;
    char error[256];
    network.bus = pu_system_bus_connect(error, sizeof(error));
    if (!network.bus) return JS_ThrowInternalError(ctx, "%s", error);
    if (!dbus_connection_register_object_path(network.bus, AGENT_PATH, &agent_vtable, NULL) ||
        !dbus_connection_add_filter(network.bus, filter, NULL, NULL)) {
        stop(); return JS_ThrowOutOfMemory(ctx);
    }
    const char *rules[] = {
        "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='net.connman.iwd'",
        "type='signal',sender='net.connman.iwd',interface='org.freedesktop.DBus.ObjectManager'",
        "type='signal',sender='net.connman.iwd',interface='org.freedesktop.DBus.Properties'",
    };
    DBusError failure = DBUS_ERROR_INIT;
    for (size_t i = 0; i < sizeof(rules) / sizeof(rules[0]); i++) {
        dbus_bus_add_match(network.bus, rules[i], &failure);
        if (dbus_error_is_set(&failure)) {
            snprintf(error, sizeof(error), "Cannot watch iwd: %s", failure.name);
            dbus_error_free(&failure); stop(); return JS_ThrowInternalError(ctx, "%s", error);
        }
    }
    discover();
    return JS_UNDEFINED;
}
static JSValue stop_network(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{ (void)ctx; (void)self; (void)argc; (void)argv; stop(); return JS_UNDEFINED; }
static JSValue refresh_network(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!network.trusted) return JS_ThrowTypeError(ctx, "iwd is not ready");
    network.error[0] = 0;
    refresh(); return JS_UNDEFINED;
}
static JSValue snapshot(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    JSValue result = JS_NewObject(ctx), devices = JS_NewArray(ctx), networks = JS_NewArray(ctx);
    if (JS_IsException(result) || JS_IsException(devices) || JS_IsException(networks)) {
        JS_FreeValue(ctx, result); JS_FreeValue(ctx, devices); JS_FreeValue(ctx, networks); return JS_EXCEPTION;
    }
    JS_SetPropertyStr(ctx, result, "ready", JS_NewBool(ctx, network.ready && network.trusted && !network.fatal));
    JS_SetPropertyStr(ctx, result, "registered", JS_NewBool(ctx, network.registered));
    JS_SetPropertyStr(ctx, result, "refreshing", JS_NewBool(ctx, network.refreshing));
    JS_SetPropertyStr(ctx, result, "revision", JS_NewUint32(ctx, network.revision));
    JS_SetPropertyStr(ctx, result, "error", JS_NewString(ctx, network.error));
    JS_SetPropertyStr(ctx, result, "operation", JS_NewString(ctx, network.operation));
    JS_SetPropertyStr(ctx, result, "target", JS_NewString(ctx, network.target));
    JS_SetPropertyStr(ctx, result, "networkConfiguration", network.network_config < 0 ? JS_NULL : JS_NewBool(ctx, network.network_config));
    for (unsigned i = 0; !JS_HasException(ctx) && i < network.model.device_count; i++) {
        struct Device *dev = &network.model.devices[i];
        JSValue item = JS_NewObject(ctx);
        if (JS_IsException(item)) break;
        JS_SetPropertyStr(ctx, item, "id", JS_NewString(ctx, dev->path));
        JS_SetPropertyStr(ctx, item, "name", JS_NewString(ctx, dev->name));
        JS_SetPropertyStr(ctx, item, "address", JS_NewString(ctx, dev->address));
        JS_SetPropertyStr(ctx, item, "state", JS_NewString(ctx, dev->state));
        JS_SetPropertyStr(ctx, item, "mode", JS_NewString(ctx, dev->mode));
        JS_SetPropertyStr(ctx, item, "powered", JS_NewBool(ctx, dev->powered));
        JS_SetPropertyStr(ctx, item, "scanning", JS_NewBool(ctx, dev->scanning));
        JS_SetPropertyStr(ctx, item, "station", JS_NewBool(ctx, dev->station));
        JS_SetPropertyStr(ctx, item, "connectedNetwork", JS_NewString(ctx, dev->connected));
        JS_SetPropertyUint32(ctx, devices, i, item);
    }
    for (unsigned i = 0; !JS_HasException(ctx) && i < network.model.network_count; i++) {
        struct Network *entry = &network.model.networks[i];
        JSValue item = JS_NewObject(ctx);
        if (JS_IsException(item)) break;
        JS_SetPropertyStr(ctx, item, "id", JS_NewString(ctx, entry->path));
        JS_SetPropertyStr(ctx, item, "device", JS_NewString(ctx, entry->device));
        JS_SetPropertyStr(ctx, item, "name", JS_NewString(ctx, entry->name));
        JS_SetPropertyStr(ctx, item, "type", JS_NewString(ctx, entry->type));
        JS_SetPropertyStr(ctx, item, "known", JS_NewBool(ctx, *entry->known));
        JS_SetPropertyStr(ctx, item, "connected", JS_NewBool(ctx, entry->connected));
        JS_SetPropertyStr(ctx, item, "signal", entry->signal == INT_MIN ? JS_NULL : JS_NewFloat64(ctx, entry->signal / 100.0));
        JS_SetPropertyStr(ctx, item, "order", JS_NewInt32(ctx, entry->order));
        JS_SetPropertyUint32(ctx, networks, i, item);
    }
    JS_SetPropertyStr(ctx, result, "devices", devices); JS_SetPropertyStr(ctx, result, "networks", networks);
    JSValue auth = JS_NULL;
    if (network.authentication) {
        auth = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, auth, "id", JS_NewUint32(ctx, network.prompt_id));
        JS_SetPropertyStr(ctx, auth, "kind", JS_NewString(ctx, network.auth_kind));
        JS_SetPropertyStr(ctx, auth, "network", JS_NewString(ctx, network.target));
        JS_SetPropertyStr(ctx, auth, "username", JS_NewString(ctx, network.auth_user));
    }
    JS_SetPropertyStr(ctx, result, "authentication", auth);
    if (JS_HasException(ctx)) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    return result;
}
static bool integer(JSContext *ctx, JSValueConst input, uint32_t *value)
{
    double number;
    if (!JS_IsNumber(input) || JS_ToFloat64(ctx, &number, input) < 0 ||
        !isfinite(number) || number < 1 || number > UINT32_MAX || floor(number) != number) return false;
    *value = (uint32_t)number; return true;
}
static JSValue act(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!network.bus || !network.trusted || !network.ready || network.fatal)
        return JS_ThrowTypeError(ctx, "iwd is not ready");
    if (*network.operation) return JS_ThrowTypeError(ctx, "A Wi-Fi operation is already in progress");
    uint32_t revision;
    if (argc != 3 || !integer(ctx, argv[0], &revision) || revision != network.revision ||
        !JS_IsString(argv[1]) || !JS_IsString(argv[2])) return JS_ThrowTypeError(ctx, "Network action requires a current revision, target and action");
    size_t path_length, action_length;
    const char *path = JS_ToCStringLen(ctx, &path_length, argv[1]);
    if (!path) return JS_EXCEPTION;
    const char *action = JS_ToCStringLen(ctx, &action_length, argv[2]);
    if (!action) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
    bool strings = !memchr(path, 0, path_length) && !memchr(action, 0, action_length) && path_length < PATH_BYTES;
    struct Network *entry = strings ? find_network(path) : NULL;
    struct Device *dev = strings ? device(&network.model, path, false) : NULL;
    struct Device *station = entry ? device(&network.model, entry->device, false) : NULL;
    const char *interface = NULL, *member = NULL, *target = path;
    int timeout = 15000;
    bool power = false;
    if (strings && entry && !strcmp(action, "connect") && network.registered && station && station->powered && station->station &&
        (!strcmp(entry->type, "open") || !strcmp(entry->type, "psk") ||
         (!strcmp(entry->type, "8021x") && *entry->known))) {
        interface = IWD ".Network"; member = "Connect"; timeout = 120000;
    } else if (strings && entry && !strcmp(action, "forget") && *entry->known) {
        interface = IWD ".KnownNetwork"; member = "Forget"; target = entry->known;
    } else if (strings && dev && dev->station && !strcmp(action, "scan")) {
        interface = IWD ".Station"; member = "Scan";
    } else if (strings && dev && dev->station && !strcmp(action, "disconnect")) {
        interface = IWD ".Station"; member = "Disconnect";
    } else if (strings && dev && (!strcmp(action, "power-on") || !strcmp(action, "power-off"))) {
        interface = DBUS_INTERFACE_PROPERTIES; member = "Set"; power = true;
    }
    JSValue result = JS_EXCEPTION;
    if (!member) { JS_ThrowTypeError(ctx, "Unsupported or unavailable Wi-Fi action"); goto done; }
    DBusMessage *message = method(target, interface, member);
    if (power && message) {
        const char *device_interface = IWD ".Device", *property = "Powered";
        dbus_bool_t value = !strcmp(action, "power-on");
        DBusMessageIter args, variant;
        dbus_message_iter_init_append(message, &args);
        if (!dbus_message_iter_append_basic(&args, DBUS_TYPE_STRING, &device_interface) ||
            !dbus_message_iter_append_basic(&args, DBUS_TYPE_STRING, &property) ||
            !dbus_message_iter_open_container(&args, DBUS_TYPE_VARIANT, "b", &variant) ||
            !dbus_message_iter_append_basic(&variant, DBUS_TYPE_BOOLEAN, &value) ||
            !dbus_message_iter_close_container(&args, &variant)) {
            dbus_message_unref(message); message = NULL;
        }
    }
    if (!queue(OPERATION, message, path, timeout)) { JS_ThrowInternalError(ctx, "%s", network.error); goto done; }
    strcpy(network.operation, action); strcpy(network.target, path);
    strcpy(network.device, entry ? entry->device : dev ? dev->path : "");
    network.error[0] = 0; network.canceled = false; network.changed = true;
    result = JS_UNDEFINED;
done:
    JS_FreeCString(ctx, path); JS_FreeCString(ctx, action); return result;
}
static JSValue cancel_connection(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!network.trusted || strcmp(network.operation, "connect") || !*network.device)
        return JS_ThrowTypeError(ctx, "No interactive Wi-Fi connection is in progress");
    char device[PATH_BYTES];
    strcpy(device, network.device);
    cancel_auth();
    struct Pending **slot = &network.pending;
    while (*slot) {
        if ((*slot)->type == OPERATION) {
            struct Pending *old = *slot; *slot = old->next; drop_pending(old);
        } else slot = &(*slot)->next;
    }
    network.operation[0] = network.target[0] = 0;
    if (!queue(OPERATION, method(device, IWD ".Station", "Disconnect"), device, 15000))
        return JS_ThrowInternalError(ctx, "%s", network.error);
    strcpy(network.operation, "disconnect"); strcpy(network.target, device);
    network.canceled = false; network.changed = true;
    return JS_UNDEFINED;
}
static JSValue reply_auth(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    uint32_t token;
    if (argc != 3 || !integer(ctx, argv[0], &token) || !network.authentication ||
        token != network.prompt_id || !network.trusted)
        return JS_ThrowTypeError(ctx, "Stale network authentication prompt");
    if (JS_IsNull(argv[1]) && JS_IsNull(argv[2])) {
        network.canceled = true; cancel_auth(); return JS_UNDEFINED;
    }
    if (!JS_IsString(argv[1]) || !JS_IsString(argv[2])) return JS_ThrowTypeError(ctx, "Authentication requires username and password strings");
    size_t user_length, password_length;
    const char *user = JS_ToCStringLen(ctx, &user_length, argv[1]);
    if (!user) return JS_EXCEPTION;
    const char *password = JS_ToCStringLen(ctx, &password_length, argv[2]);
    if (!password) { JS_FreeCString(ctx, user); return JS_EXCEPTION; }
    bool valid = user_length <= 256 && password_length > 0 && password_length <= 1024 &&
        !memchr(user, 0, user_length) && !memchr(password, 0, password_length);
    if (!strcmp(network.auth_kind, "passphrase")) {
        valid = valid && ((password_length >= 8 && password_length <= 63) ||
            (password_length == 64 && strspn(password, "0123456789abcdefABCDEF") == 64));
    }
    bool both = !strcmp(network.auth_kind, "username-password");
    if (both && !user_length) valid = false;
    JSValue result = JS_EXCEPTION;
    if (!valid) { JS_ThrowTypeError(ctx, "Invalid authentication field length or format"); goto done; }
    DBusMessage *reply = dbus_message_new_method_return(network.authentication);
    if (!reply) { JS_ThrowOutOfMemory(ctx); goto done; }
    bool appended = both ? dbus_message_append_args(reply, DBUS_TYPE_STRING, &user, DBUS_TYPE_STRING, &password, DBUS_TYPE_INVALID) :
        dbus_message_append_args(reply, DBUS_TYPE_STRING, &password, DBUS_TYPE_INVALID);
    if (!appended) { dbus_message_unref(reply); JS_ThrowOutOfMemory(ctx); goto done; }
    if (!send(reply)) { JS_ThrowInternalError(ctx, "%s", network.error); goto done; }
    dbus_message_unref(network.authentication); network.authentication = NULL;
    advance(&network.prompt_id); network.auth_kind[0] = network.auth_user[0] = 0; network.changed = true;
    result = JS_UNDEFINED;
done:
    JS_FreeCString(ctx, user); JS_FreeCString(ctx, password);
    return result;
}
int pu_network_install(JSContext *ctx, JSValueConst api)
{
    network.ctx = ctx; network.api = JS_DupValue(ctx, api); network.network_config = -1;
    advance(&network.epoch); advance(&network.revision);
    return JS_SetPropertyStr(ctx, api, "startNetwork", JS_NewCFunction(ctx, start, "startNetwork", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "stopNetwork", JS_NewCFunction(ctx, stop_network, "stopNetwork", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "networkState", JS_NewCFunction(ctx, snapshot, "networkState", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "refreshNetworks", JS_NewCFunction(ctx, refresh_network, "refreshNetworks", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "networkAction", JS_NewCFunction(ctx, act, "networkAction", 3)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "cancelNetworkConnection", JS_NewCFunction(ctx, cancel_connection, "cancelNetworkConnection", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "replyNetworkAuthentication", JS_NewCFunction(ctx, reply_auth, "replyNetworkAuthentication", 3)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "onNetworkChanged", JS_NULL) >= 0;
}
int pu_network_pump(void)
{
    if (!network.bus) return 0;
    if (!network.fatal) {
        if (!dbus_connection_read_write(network.bus, 0)) {
            reset_service(); network.fatal = true; set_error("System bus disconnected");
        }
        for (int i = 0; i < 64 && !network.fatal && dbus_connection_get_dispatch_status(network.bus) == DBUS_DISPATCH_DATA_REMAINS; i++)
            if (dbus_connection_dispatch(network.bus) == DBUS_DISPATCH_NEED_MEMORY) {
                network.fatal = true; set_error("Cannot dispatch network message");
            }
        struct Pending **slot = &network.pending;
        while (*slot && !network.fatal) {
            struct Pending *pending = *slot;
            bool complete = dbus_pending_call_get_completed(pending->call);
            if (!complete && pu_now_ms() < pending->deadline) { slot = &pending->next; continue; }
            *slot = pending->next;
            DBusMessage *reply = complete ? dbus_pending_call_steal_reply(pending->call) : NULL;
            completed(pending, reply);
            if (reply) dbus_message_unref(reply);
            drop_pending(pending);
            slot = &network.pending;
        }
        if (network.authentication && pu_now_ms() >= network.authentication_deadline) {
            cancel_auth(); set_error("Wi-Fi authentication timed out");
        }
    }
    if (!network.changed) return 0;
    network.changed = false;
    JSContext *ctx = network.ctx;
    JSValue callback = JS_GetPropertyStr(ctx, network.api, "onNetworkChanged"), result = JS_UNDEFINED;
    if (JS_IsException(callback)) result = JS_EXCEPTION;
    else if (JS_IsFunction(ctx, callback)) result = JS_Call(ctx, callback, network.api, 0, NULL);
    else if (!JS_IsUndefined(callback) && !JS_IsNull(callback)) result = JS_ThrowTypeError(ctx, "Network callback must be a function");
    JS_FreeValue(ctx, callback);
    if (JS_IsException(result)) {
        JSValue error = JS_GetException(ctx);
        const char *message = JS_ToCString(ctx, error);
        fprintf(stderr, "[network] Callback failed: %s\n", message ? message : "unknown");
        JS_FreeCString(ctx, message); JS_FreeValue(ctx, error);
    } else JS_FreeValue(ctx, result);
    return 1;
}
void pu_network_shutdown(void)
{
    stop();
    if (network.ctx) JS_FreeValue(network.ctx, network.api);
    memset(&network, 0, sizeof(network));
}
