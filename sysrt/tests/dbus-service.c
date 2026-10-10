#define _POSIX_C_SOURCE 200809L
#include <dbus/dbus.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

_Static_assert(sizeof(void *) == 8 && sizeof(long) == 8, "D-Bus fixture requires Linux x86_64");
_Static_assert(sizeof(DBusMessageIter) == 72, "JS D-Bus iterator ABI mismatch");
_Static_assert(DBUS_TYPE_UINT32 == 117 && DBUS_MESSAGE_TYPE_METHOD_RETURN == 2 &&
               DBUS_MESSAGE_TYPE_ERROR == 3, "JS D-Bus constants mismatch");

static int reply(DBusConnection *connection, DBusMessage *request, dbus_uint32_t number)
{
    DBusMessage *message = dbus_message_new_method_return(request);
    if (!message) return 0;
    DBusMessageIter iter;
    dbus_message_iter_init_append(message, &iter);
    int ok = dbus_message_iter_append_basic(&iter, DBUS_TYPE_UINT32, &number) &&
             dbus_connection_send(connection, message, NULL);
    dbus_message_unref(message);
    return ok;
}

static int error_reply(DBusConnection *connection, DBusMessage *request)
{
    DBusMessage *message = dbus_message_new_error(request, "org.polly.Test.Failed", "Explicit fixture failure");
    if (!message) return 0;
    int ok = dbus_connection_send(connection, message, NULL);
    dbus_message_unref(message);
    return ok;
}

static int bad_reply(DBusConnection *connection, DBusMessage *request)
{
    DBusMessage *message = dbus_message_new_method_return(request);
    if (!message) return 0;
    DBusMessageIter iter;
    const char *text = "not a uint32";
    dbus_message_iter_init_append(message, &iter);
    int ok = dbus_message_iter_append_basic(&iter, DBUS_TYPE_STRING, &text) &&
             dbus_connection_send(connection, message, NULL);
    dbus_message_unref(message);
    return ok;
}

static int64_t milliseconds(void)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) return -1;
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

int main(int argc, char **argv)
{
    if (argc != 2) return 2;
    DBusError error = DBUS_ERROR_INIT;
    DBusConnection *connection = dbus_connection_open_private(argv[1], &error);
    if (!connection) {
        fprintf(stderr, "Fixture open: %s\n", error.message);
        dbus_error_free(&error);
        return 1;
    }
    dbus_connection_set_exit_on_disconnect(connection, FALSE);
    int ok = dbus_bus_register(connection, &error) &&
        dbus_bus_request_name(connection, "org.polly.Test", DBUS_NAME_FLAG_DO_NOT_QUEUE, &error) ==
        DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER;
    if (!ok) fprintf(stderr, "Fixture register/name: %s\n", error.message ? error.message : "not primary owner");
    dbus_error_free(&error);
    DBusMessage *delayed = NULL;
    dbus_uint32_t delayed_value = 0, calls = 0;
    int64_t due = 0;
    if (ok) { puts("READY"); fflush(stdout); }
    while (ok && dbus_connection_get_is_connected(connection)) {
        int64_t now = milliseconds();
        if (now < 0) { ok = 0; break; }
        if (delayed && now >= due) {
            ok = reply(connection, delayed, delayed_value);
            dbus_message_unref(delayed); delayed = NULL;
        }
        dbus_connection_read_write(connection, 5);
        DBusMessage *request;
        while (ok && (request = dbus_connection_pop_message(connection))) {
            if (dbus_message_get_type(request) == DBUS_MESSAGE_TYPE_METHOD_CALL) {
                if (!dbus_message_has_signature(request, "u") ||
                    !dbus_message_has_path(request, "/org/polly/Test") ||
                    !dbus_message_has_interface(request, "org.polly.Test")) {
                    ok = error_reply(connection, request);
                } else {
                    DBusMessageIter iter;
                    dbus_uint32_t number = 0;
                    dbus_message_iter_init(request, &iter);
                    dbus_message_iter_get_basic(&iter, &number);
                    if (dbus_message_has_member(request, "Increment")) {
                        calls++; ok = reply(connection, request, number + 1);
                    } else if (dbus_message_has_member(request, "Count")) {
                        ok = reply(connection, request, calls);
                    } else if (dbus_message_has_member(request, "Delay") && !delayed) {
                        calls++; delayed = dbus_message_ref(request);
                        delayed_value = number + 1; due = now + 250;
                    } else if (dbus_message_has_member(request, "Hang")) {
                        calls++;
                    } else if (dbus_message_has_member(request, "BadReply")) {
                        ok = bad_reply(connection, request);
                    } else {
                        ok = error_reply(connection, request);
                    }
                }
            }
            dbus_message_unref(request);
        }
    }
    if (delayed) dbus_message_unref(delayed);
    dbus_connection_close(connection);
    dbus_connection_unref(connection);
    return ok ? 0 : 1;
}
