#include "native/session-bus.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define IWD "net.connman.iwd"
#define ROOT "/net/connman/iwd"
#define DEVICE ROOT "/0/1"
#define NETWORK DEVICE "/test_psk"
#define KNOWN ROOT "/known_test"
#define AGENT "/org/pollyui/NetworkAgent"
#define MANAGER "org.freedesktop.DBus.ObjectManager"
#define CHECK(value) do { if (!(value)) { fprintf(stderr, "FAIL iwd fixture line %d: %s\n", __LINE__, #value); exit(1); } } while (0)
static DBusConnection *bus;
static bool powered = true, connected, known, running = true, connecting;
static bool restarting, multi_network;
static long long prompt_deadline;
static unsigned scans, canceled, authenticated, disconnected, forgotten, powers;
static char *agent_owner;
static DBusMessage *connect_request;
static DBusPendingCall *credentials;
static long long now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
static void send_message(DBusMessage *message)
{ CHECK(message && dbus_connection_send(bus, message, NULL)); dbus_message_unref(message); }
static void property(DBusMessageIter *array, const char *name, const char *signature, int type, const void *value)
{
    DBusMessageIter entry, variant;
    CHECK(dbus_message_iter_open_container(array, DBUS_TYPE_DICT_ENTRY, NULL, &entry));
    CHECK(dbus_message_iter_append_basic(&entry, DBUS_TYPE_STRING, &name));
    CHECK(dbus_message_iter_open_container(&entry, DBUS_TYPE_VARIANT, signature, &variant));
    CHECK(dbus_message_iter_append_basic(&variant, type, value));
    CHECK(dbus_message_iter_close_container(&entry, &variant) && dbus_message_iter_close_container(array, &entry));
}
static void interface(DBusMessageIter *array, const char *name, const char *path)
{
    DBusMessageIter entry, props;
    CHECK(dbus_message_iter_open_container(array, DBUS_TYPE_DICT_ENTRY, NULL, &entry));
    CHECK(dbus_message_iter_append_basic(&entry, DBUS_TYPE_STRING, &name));
    CHECK(dbus_message_iter_open_container(&entry, DBUS_TYPE_ARRAY, "{sv}", &props));
    if (!strcmp(name, IWD ".Device")) {
        const char *device = "wlan-test", *address = "02:00:00:00:00:01", *mode = "station";
        dbus_bool_t power = powered;
        property(&props, "Name", "s", DBUS_TYPE_STRING, &device);
        property(&props, "Address", "s", DBUS_TYPE_STRING, &address);
        property(&props, "Mode", "s", DBUS_TYPE_STRING, &mode);
        property(&props, "Powered", "b", DBUS_TYPE_BOOLEAN, &power);
    } else if (!strcmp(name, IWD ".Station")) {
        const char *state = connected ? "connected" : connecting ? "connecting" : "disconnected";
        dbus_bool_t scanning = false;
        property(&props, "State", "s", DBUS_TYPE_STRING, &state);
        property(&props, "Scanning", "b", DBUS_TYPE_BOOLEAN, &scanning);
        if (connected || connecting) { const char *path = NETWORK; property(&props, "ConnectedNetwork", "o", DBUS_TYPE_OBJECT_PATH, &path); }
    } else {
        const char *ssid = !strcmp(path, NETWORK) ? "Polly test network" : "Polly extra network";
        const char *type = "psk", *device = DEVICE, *saved = KNOWN;
        dbus_bool_t selected = !strcmp(path, NETWORK) && (connected || connecting);
        property(&props, "Name", "s", DBUS_TYPE_STRING, &ssid);
        property(&props, "Type", "s", DBUS_TYPE_STRING, &type);
        property(&props, "Device", "o", DBUS_TYPE_OBJECT_PATH, &device);
        property(&props, "Connected", "b", DBUS_TYPE_BOOLEAN, &selected);
        if (known && !strcmp(path, NETWORK)) property(&props, "KnownNetwork", "o", DBUS_TYPE_OBJECT_PATH, &saved);
    }
    CHECK(dbus_message_iter_close_container(&entry, &props) && dbus_message_iter_close_container(array, &entry));
}
static void changed(void)
{
    DBusMessage *signal = dbus_message_new_signal(DEVICE, DBUS_INTERFACE_PROPERTIES, "PropertiesChanged");
    DBusMessageIter args, props, invalidated;
    dbus_message_iter_init_append(signal, &args);
    const char *name = IWD ".Station";
    CHECK(dbus_message_iter_append_basic(&args, DBUS_TYPE_STRING, &name));
    CHECK(dbus_message_iter_open_container(&args, DBUS_TYPE_ARRAY, "{sv}", &props));
    const char *state = connected ? "connected" : connecting ? "connecting" : "disconnected";
    property(&props, "State", "s", DBUS_TYPE_STRING, &state);
    CHECK(dbus_message_iter_close_container(&args, &props));
    CHECK(dbus_message_iter_open_container(&args, DBUS_TYPE_ARRAY, "s", &invalidated) &&
        dbus_message_iter_close_container(&args, &invalidated));
    send_message(signal);
}
static void request_credentials(void)
{
    const char *path = NETWORK;
    DBusMessage *request = dbus_message_new_method_call(agent_owner, AGENT, IWD ".Agent", "RequestPassphrase");
    CHECK(dbus_message_append_args(request, DBUS_TYPE_OBJECT_PATH, &path, DBUS_TYPE_INVALID));
    CHECK(dbus_connection_send_with_reply(bus, request, &credentials, 15000));
    dbus_message_unref(request);
}
static DBusHandlerResult method(DBusConnection *connection, DBusMessage *message, void *data)
{
    (void)connection; (void)data;
    if (dbus_message_is_method_call(message, MANAGER, "GetManagedObjects")) {
        DBusMessage *reply = dbus_message_new_method_return(message);
        DBusMessageIter args, objects;
        dbus_message_iter_init_append(reply, &args);
        CHECK(dbus_message_iter_open_container(&args, DBUS_TYPE_ARRAY, "{oa{sa{sv}}}", &objects));
        for (int i = 0; i < (multi_network ? 14 : 2); i++) {
            char extra[96];
            snprintf(extra, sizeof(extra), DEVICE "/extra_psk_%d", i - 1);
            const char *path = i == 0 ? DEVICE : i == 1 ? NETWORK : extra;
            DBusMessageIter entry, interfaces;
            CHECK(dbus_message_iter_open_container(&objects, DBUS_TYPE_DICT_ENTRY, NULL, &entry));
            CHECK(dbus_message_iter_append_basic(&entry, DBUS_TYPE_OBJECT_PATH, &path));
            CHECK(dbus_message_iter_open_container(&entry, DBUS_TYPE_ARRAY, "{sa{sv}}", &interfaces));
            if (!i) { interface(&interfaces, IWD ".Device", path); interface(&interfaces, IWD ".Station", path); }
            else interface(&interfaces, IWD ".Network", path);
            CHECK(dbus_message_iter_close_container(&entry, &interfaces) && dbus_message_iter_close_container(&objects, &entry));
        }
        CHECK(dbus_message_iter_close_container(&args, &objects));
        send_message(reply); return DBUS_HANDLER_RESULT_HANDLED;
    }
    if (dbus_message_is_method_call(message, IWD ".Station", "GetOrderedNetworks")) {
        DBusMessage *reply = dbus_message_new_method_return(message);
        DBusMessageIter args, array, tuple;
        dbus_message_iter_init_append(reply, &args);
        CHECK(dbus_message_iter_open_container(&args, DBUS_TYPE_ARRAY, "(on)", &array));
        for (int i = 0; i < (multi_network ? 13 : 1); i++) {
            char extra[96];
            snprintf(extra, sizeof(extra), DEVICE "/extra_psk_%d", i);
            const char *path = i == 0 ? NETWORK : extra;
            int16_t signal = (int16_t)(-4500 - i * 100);
            CHECK(dbus_message_iter_open_container(&array, DBUS_TYPE_STRUCT, NULL, &tuple));
            CHECK(dbus_message_iter_append_basic(&tuple, DBUS_TYPE_OBJECT_PATH, &path) &&
                dbus_message_iter_append_basic(&tuple, DBUS_TYPE_INT16, &signal));
            CHECK(dbus_message_iter_close_container(&array, &tuple));
        }
        CHECK(dbus_message_iter_close_container(&args, &array));
        send_message(reply); return DBUS_HANDLER_RESULT_HANDLED;
    }
    if (dbus_message_is_method_call(message, IWD ".Daemon", "GetInfo")) {
        DBusMessage *reply = dbus_message_new_method_return(message);
        DBusMessageIter args, props; dbus_bool_t enabled = true;
        dbus_message_iter_init_append(reply, &args);
        CHECK(dbus_message_iter_open_container(&args, DBUS_TYPE_ARRAY, "{sv}", &props));
        property(&props, "NetworkConfigurationEnabled", "b", DBUS_TYPE_BOOLEAN, &enabled);
        CHECK(dbus_message_iter_close_container(&args, &props));
        send_message(reply); return DBUS_HANDLER_RESULT_HANDLED;
    }
    if (dbus_message_is_method_call(message, IWD ".AgentManager", "RegisterAgent")) {
        const char *path;
        CHECK(dbus_message_get_args(message, NULL, DBUS_TYPE_OBJECT_PATH, &path, DBUS_TYPE_INVALID) && !strcmp(path, AGENT));
        free(agent_owner); agent_owner = strdup(dbus_message_get_sender(message)); CHECK(agent_owner);
        send_message(dbus_message_new_method_return(message)); return DBUS_HANDLER_RESULT_HANDLED;
    }
    if (dbus_message_is_method_call(message, IWD ".AgentManager", "UnregisterAgent")) {
        free(agent_owner); agent_owner = NULL;
        if (!dbus_message_get_no_reply(message)) send_message(dbus_message_new_method_return(message));
        return DBUS_HANDLER_RESULT_HANDLED;
    }
    if (dbus_message_is_method_call(message, IWD ".Network", "Connect")) {
        CHECK(agent_owner && !connect_request && !credentials);
        connecting = true;
        connect_request = dbus_message_ref(message);
        if (multi_network) prompt_deadline = now() + 100;
        else request_credentials();
        changed(); return DBUS_HANDLER_RESULT_HANDLED;
    }
    if (dbus_message_is_method_call(message, IWD ".Station", "Scan")) scans++;
    else if (dbus_message_is_method_call(message, IWD ".Station", "Disconnect")) {
        disconnected++; connected = connecting = false;
        if (prompt_deadline) {
            prompt_deadline = 0;
            send_message(dbus_message_new_error(connect_request, IWD ".Aborted", "Canceled before credentials"));
            dbus_message_unref(connect_request); connect_request = NULL;
        }
    }
    else if (dbus_message_is_method_call(message, IWD ".KnownNetwork", "Forget")) { forgotten++; known = connected = false; }
    else if (dbus_message_is_method_call(message, DBUS_INTERFACE_PROPERTIES, "Set")) {
        CHECK(dbus_message_has_signature(message, "ssv"));
        DBusMessageIter args, variant;
        const char *iface, *property;
        dbus_message_iter_init(message, &args); dbus_message_iter_get_basic(&args, &iface);
        dbus_message_iter_next(&args); dbus_message_iter_get_basic(&args, &property);
        dbus_message_iter_next(&args); dbus_message_iter_recurse(&args, &variant);
        CHECK(!strcmp(iface, IWD ".Device") && !strcmp(property, "Powered") &&
            dbus_message_iter_get_arg_type(&variant) == DBUS_TYPE_BOOLEAN);
        dbus_bool_t value; dbus_message_iter_get_basic(&variant, &value); powered = value; powers++;
    } else if (dbus_message_is_method_call(message, "org.pollyui.Test", "Agent")) {
        DBusMessage *reply = dbus_message_new_method_return(message);
        const char *owner = agent_owner ? agent_owner : "";
        CHECK(dbus_message_append_args(reply, DBUS_TYPE_STRING, &owner, DBUS_TYPE_INVALID));
        send_message(reply); return DBUS_HANDLER_RESULT_HANDLED;
    } else if (dbus_message_is_method_call(message, "org.pollyui.Test", "Quit")) {
        CHECK(restarting || (scans && canceled && authenticated && disconnected && forgotten && powers >= 2));
        running = false;
        send_message(dbus_message_new_method_return(message));
        return DBUS_HANDLER_RESULT_HANDLED;
    } else return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
    send_message(dbus_message_new_method_return(message)); changed();
    return DBUS_HANDLER_RESULT_HANDLED;
}
static const DBusObjectPathVTable vtable = { .message_function = method };
int main(int argc, char **argv)
{
    char error[256];
    bus = pu_system_bus_connect(error, sizeof(error));
    if (!bus) fprintf(stderr, "%s\n", error);
    CHECK(bus);
    DBusError failure = DBUS_ERROR_INIT;
    restarting = argc == 2 && !strcmp(argv[1], "restart");
    multi_network = argc == 2 && !strcmp(argv[1], "multi");
    if (argc == 2 && !restarting && !multi_network) {
        bool spoof = !strcmp(argv[1], "spoof");
        DBusMessage *request = dbus_message_new_method_call(IWD, ROOT, "org.pollyui.Test", spoof ? "Agent" : "Quit");
        DBusMessage *reply = dbus_connection_send_with_reply_and_block(bus, request, 3000, &failure);
        CHECK(reply); dbus_message_unref(request);
        if (spoof) {
            const char *owner;
            CHECK(dbus_message_get_args(reply, NULL, DBUS_TYPE_STRING, &owner, DBUS_TYPE_INVALID) && *owner);
            request = dbus_message_new_method_call(owner, AGENT, IWD ".Agent", "RequestPassphrase");
            const char *path = NETWORK;
            CHECK(dbus_message_append_args(request, DBUS_TYPE_OBJECT_PATH, &path, DBUS_TYPE_INVALID));
            DBusMessage *answer = dbus_connection_send_with_reply_and_block(bus, request, 3000, &failure);
            CHECK(!answer && dbus_error_has_name(&failure, DBUS_ERROR_ACCESS_DENIED));
            dbus_error_free(&failure); dbus_message_unref(request);
        }
        dbus_message_unref(reply);
    } else {
        CHECK(dbus_bus_request_name(bus, IWD, DBUS_NAME_FLAG_DO_NOT_QUEUE, &failure) == DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER);
        CHECK(dbus_connection_register_fallback(bus, "/", &vtable, NULL));
        long long deadline = now() + (multi_network ? 240000 : 60000);
        while (running && now() < deadline) {
            CHECK(dbus_connection_read_write_dispatch(bus, 10));
            if (prompt_deadline && now() >= prompt_deadline) {
                prompt_deadline = 0;
                request_credentials();
            }
            if (credentials && dbus_pending_call_get_completed(credentials)) {
                DBusMessage *reply = dbus_pending_call_steal_reply(credentials);
                CHECK(reply);
                connecting = false;
                if (dbus_message_get_type(reply) == DBUS_MESSAGE_TYPE_ERROR) {
                    CHECK(dbus_message_is_error(reply, IWD ".Agent.Error.Canceled"));
                    canceled++;
                    send_message(dbus_message_new_error(connect_request, IWD ".Aborted", "Canceled"));
                } else {
                    const char *passphrase;
                    CHECK(dbus_message_get_args(reply, NULL, DBUS_TYPE_STRING, &passphrase, DBUS_TYPE_INVALID));
                    CHECK(!strcmp(passphrase, "testpass"));
                    authenticated++; connected = known = true;
                    send_message(dbus_message_new_method_return(connect_request));
                }
                dbus_message_unref(reply); dbus_pending_call_unref(credentials); credentials = NULL;
                dbus_message_unref(connect_request); connect_request = NULL;
                changed();
            }
        }
        CHECK(!running);
        dbus_connection_flush(bus);
        dbus_connection_unregister_object_path(bus, "/");
        puts("PASS: isolated iwd discovery, radio, scan, authentication, cancellation, connection and forgetting");
    }
    free(agent_owner);
    dbus_connection_close(bus); dbus_connection_unref(bus);
    return 0;
}
