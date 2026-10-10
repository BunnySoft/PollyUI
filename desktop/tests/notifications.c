#include "native/session-bus.h"
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define SERVICE "org.freedesktop.Notifications"
#define OBJECT "/org/freedesktop/Notifications"
#define CHECK(value) do { if (!(value)) { fprintf(stderr, "FAIL notification line %d: %s\n", __LINE__, #value); exit(1); } } while (0)
static DBusConnection *connection;
static DBusMessage *call(DBusMessage *request, const char *expected)
{
    DBusError error = DBUS_ERROR_INIT;
    CHECK(request);
    DBusMessage *reply = dbus_connection_send_with_reply_and_block(connection, request, 5000, &error);
    dbus_message_unref(request);
    if (expected) {
        CHECK(!reply && dbus_error_has_name(&error, expected));
        dbus_error_free(&error); return NULL;
    }
    if (!reply) fprintf(stderr, "D-Bus call failed: %s\n", error.message ? error.message : "unknown");
    CHECK(reply);
    return reply;
}
static DBusMessage *method(const char *name)
{ return dbus_message_new_method_call(SERVICE, OBJECT, SERVICE, name); }
static uint32_t notify(const char *summary, uint32_t replace, const char **actions, int count, bool resident,
    int32_t timeout, const char *expected)
{
    DBusMessage *request = method("Notify");
    const char *app = "Protocol fixture", *icon = "/must/not/be/opened", *body = "<b>literal text</b> \xe4\xbd\xa0";
    CHECK(dbus_message_append_args(request, DBUS_TYPE_STRING, &app, DBUS_TYPE_UINT32, &replace,
        DBUS_TYPE_STRING, &icon, DBUS_TYPE_STRING, &summary, DBUS_TYPE_STRING, &body,
        DBUS_TYPE_ARRAY, DBUS_TYPE_STRING, &actions, count, DBUS_TYPE_INVALID));
    DBusMessageIter iter, hints, item, variant;
    dbus_message_iter_init_append(request, &iter);
    CHECK(dbus_message_iter_open_container(&iter, DBUS_TYPE_ARRAY, "{sv}", &hints));
    CHECK(dbus_message_iter_open_container(&hints, DBUS_TYPE_DICT_ENTRY, NULL, &item));
    const char *name = "resident";
    dbus_bool_t value = resident;
    CHECK(dbus_message_iter_append_basic(&item, DBUS_TYPE_STRING, &name));
    CHECK(dbus_message_iter_open_container(&item, DBUS_TYPE_VARIANT, "b", &variant));
    CHECK(dbus_message_iter_append_basic(&variant, DBUS_TYPE_BOOLEAN, &value));
    CHECK(dbus_message_iter_close_container(&item, &variant) && dbus_message_iter_close_container(&hints, &item) &&
        dbus_message_iter_close_container(&iter, &hints));
    CHECK(dbus_message_iter_append_basic(&iter, DBUS_TYPE_INT32, &timeout));
    DBusMessage *reply = call(request, expected);
    if (expected) return 0;
    uint32_t id;
    CHECK(dbus_message_get_args(reply, NULL, DBUS_TYPE_UINT32, &id, DBUS_TYPE_INVALID) && id);
    dbus_message_unref(reply);
    return id;
}
static void close_notice(uint32_t id, const char *expected)
{
    DBusMessage *request = method("CloseNotification");
    CHECK(dbus_message_append_args(request, DBUS_TYPE_UINT32, &id, DBUS_TYPE_INVALID));
    DBusMessage *reply = call(request, expected);
    if (reply) dbus_message_unref(reply);
}
static void wait_signal(uint32_t id, const char *action, uint32_t reason)
{
    for (int i = 0; i < 500; i++) {
        CHECK(dbus_connection_read_write(connection, 20));
        DBusMessage *message;
        while ((message = dbus_connection_pop_message(connection))) {
            if (dbus_message_is_signal(message, SERVICE, action ? "ActionInvoked" : "NotificationClosed")) {
                uint32_t actual, closed;
                const char *key;
                bool valid = action ? dbus_message_get_args(message, NULL, DBUS_TYPE_UINT32, &actual,
                    DBUS_TYPE_STRING, &key, DBUS_TYPE_INVALID) :
                    dbus_message_get_args(message, NULL, DBUS_TYPE_UINT32, &actual, DBUS_TYPE_UINT32, &closed, DBUS_TYPE_INVALID);
                CHECK(valid && actual == id && (action ? !strcmp(key, action) : closed == reason));
                dbus_message_unref(message); return;
            }
            dbus_message_unref(message);
        }
    }
    CHECK(false);
}
int main(int argc, char **argv)
{
    char error[256];
    connection = pu_session_bus_connect(error, sizeof(error));
    if (!connection) fprintf(stderr, "%s\n", error);
    CHECK(connection);
    if (argc == 2) {
        uint32_t id = (uint32_t)strtoul(argv[1], NULL, 10);
        close_notice(id, DBUS_ERROR_ACCESS_DENIED);
        notify("Forged", id, NULL, 0, false, 0, DBUS_ERROR_ACCESS_DENIED);
        puts("PASS: foreign notification replacement and close are denied");
    } else {
        DBusMessage *signal = dbus_message_new_signal(OBJECT, SERVICE, "Notify");
        CHECK(signal && dbus_message_set_destination(signal, SERVICE) &&
            dbus_connection_send(connection, signal, NULL));
        dbus_message_unref(signal);
        DBusMessage *reply = call(method("GetCapabilities"), NULL);
        DBusMessageIter iter, array;
        CHECK(dbus_message_has_signature(reply, "as"));
        dbus_message_iter_init(reply, &iter); dbus_message_iter_recurse(&iter, &array);
        unsigned count = 0;
        while (dbus_message_iter_get_arg_type(&array) != DBUS_TYPE_INVALID) {
            const char *value; dbus_message_iter_get_basic(&array, &value);
            CHECK(!strcmp(value, "actions") || !strcmp(value, "body"));
            count++; dbus_message_iter_next(&array);
        }
        CHECK(count == 2); dbus_message_unref(reply);
        reply = call(method("GetServerInformation"), NULL);
        CHECK(dbus_message_has_signature(reply, "ssss")); dbus_message_unref(reply);
        call(method("Notify"), DBUS_ERROR_INVALID_ARGS);
        const char *odd[] = { "odd" };
        notify("Malformed", 0, odd, 1, false, 0, DBUS_ERROR_INVALID_ARGS);
        const char *duplicate[] = { "same", "First", "same", "Second" };
        notify("Duplicate actions", 0, duplicate, 4, false, 0, DBUS_ERROR_INVALID_ARGS);
        notify("Invalid timeout", 0, NULL, 0, false, -2, DBUS_ERROR_INVALID_ARGS);
        char oversized[1026];
        memset(oversized, 'x', sizeof(oversized) - 1); oversized[sizeof(oversized) - 1] = 0;
        notify(oversized, 0, NULL, 0, false, 0, DBUS_ERROR_LIMITS_EXCEEDED);
        const char *advance[] = { "advance", "Continue" };
        uint32_t id = notify("Stage one", 0, advance, 2, true, 0, NULL);
        wait_signal(id, "advance", 0);
        const char *open[] = { "open", "Open" };
        CHECK(notify("Stage two", id, open, 2, false, 0, NULL) == id);
        wait_signal(id, "open", 0);
        wait_signal(id, NULL, 2);
        id = notify("Expires", 0, NULL, 0, false, 100, NULL);
        wait_signal(id, NULL, 1);
        id = notify("Close from app", 0, NULL, 0, false, 0, NULL);
        close_notice(id, NULL); wait_signal(id, NULL, 3);
        close_notice(id, NULL);
        id = notify("Dismiss", 0, NULL, 0, false, 0, NULL);
        wait_signal(id, NULL, 2);
        uint32_t ids[16];
        for (int i = 0; i < 16; i++) ids[i] = notify("Quota", 0, NULL, 0, false, 0, NULL);
        notify("Overflow", 0, NULL, 0, false, 0, DBUS_ERROR_LIMITS_EXCEEDED);
        for (int i = 0; i < 16; i++) { close_notice(ids[i], NULL); wait_signal(ids[i], NULL, 3); }
        notify("Source exited", 0, NULL, 0, false, 0, NULL);
        puts("PASS: notification methods, replacement, actions, expiry, reasons and quotas");
    }
    dbus_connection_close(connection); dbus_connection_unref(connection);
    return 0;
}
