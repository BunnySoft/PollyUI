#define _POSIX_C_SOURCE 200809L
#include <dbus/dbus.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

_Static_assert(sizeof(void *) == 8 && sizeof(long) == 8, "D-Bus fixture requires Linux x86_64");
_Static_assert(sizeof(DBusMessageIter) == 72, "JS D-Bus iterator ABI mismatch");
_Static_assert(sizeof(DBusError) == 32 && offsetof(DBusError, name) == 0 &&
               offsetof(DBusError, message) == 8, "JS D-Bus error ABI mismatch");
_Static_assert(DBUS_TYPE_UINT32 == 117 && DBUS_MESSAGE_TYPE_METHOD_RETURN == 2 &&
               DBUS_MESSAGE_TYPE_ERROR == 3, "JS D-Bus constants mismatch");
_Static_assert(DBUS_TYPE_BOOLEAN == 98 && DBUS_TYPE_STRING == 115 &&
               DBUS_TYPE_OBJECT_PATH == 111, "JS D-Bus scalar constants mismatch");
_Static_assert(DBUS_MESSAGE_TYPE_METHOD_CALL == 1 && DBUS_NAME_FLAG_DO_NOT_QUEUE == 4 &&
               DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER == 1, "JS D-Bus service constants mismatch");

static int scalar_reply(DBusConnection *connection, DBusMessage *request, int type, const void *payload)
{
    DBusMessage *message = dbus_message_new_method_return(request);
    if (!message) return 0;
    DBusMessageIter iter;
    dbus_message_iter_init_append(message, &iter);
    int ok = (!type || dbus_message_iter_append_basic(&iter, type, payload)) &&
             dbus_connection_send(connection, message, NULL);
    dbus_message_unref(message);
    return ok;
}

static int reply(DBusConnection *connection, DBusMessage *request, dbus_uint32_t number)
{
    return scalar_reply(connection, request, DBUS_TYPE_UINT32, &number);
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
    const char *text = "not a uint32";
    return scalar_reply(connection, request, DBUS_TYPE_STRING, &text);
}

static int tuple_reply(DBusConnection *connection, DBusMessage *request)
{
    DBusMessage *message = dbus_message_new_method_return(request);
    if (!message) return 0;
    DBusMessageIter iter;
    dbus_uint32_t number = 7;
    dbus_bool_t boolean = TRUE;
    const char *text = "tuple \xe2\x82\xac", *path = "/org/polly/Test";
    dbus_message_iter_init_append(message, &iter);
    int ok = dbus_message_iter_append_basic(&iter, DBUS_TYPE_UINT32, &number) &&
             dbus_message_iter_append_basic(&iter, DBUS_TYPE_BOOLEAN, &boolean) &&
             dbus_message_iter_append_basic(&iter, DBUS_TYPE_STRING, &text) &&
             dbus_message_iter_append_basic(&iter, DBUS_TYPE_OBJECT_PATH, &path) &&
             dbus_connection_send(connection, message, NULL);
    dbus_message_unref(message);
    return ok;
}

static int sized_error(DBusConnection *connection, DBusMessage *request, dbus_uint32_t length)
{
    char *text = malloc((size_t)length + 1);
    if (!text) return 0;
    memset(text, 'x', length); text[length] = '\0';
    DBusMessage *message = dbus_message_new_error(request, "org.polly.Test.SizedError", text);
    free(text);
    if (!message) return 0;
    int ok = dbus_connection_send(connection, message, NULL);
    dbus_message_unref(message);
    if (ok) dbus_connection_flush(connection);
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
                if (!dbus_message_has_path(request, "/org/polly/Test") ||
                    !dbus_message_has_interface(request, "org.polly.Test")) {
                    ok = error_reply(connection, request);
                } else if (dbus_message_has_member(request, "Empty") && dbus_message_has_signature(request, "")) {
                    ok = scalar_reply(connection, request, 0, NULL);
                } else if (dbus_message_has_member(request, "Tuple") && dbus_message_has_signature(request, "")) {
                    ok = tuple_reply(connection, request);
                } else if (dbus_message_has_member(request, "User") && dbus_message_has_signature(request, "")) {
                    ok = reply(connection, request, (dbus_uint32_t)getuid());
                } else if (dbus_message_has_member(request, "Toggle") && dbus_message_has_signature(request, "b")) {
                    DBusMessageIter iter;
                    dbus_bool_t boolean = FALSE;
                    dbus_message_iter_init(request, &iter);
                    dbus_message_iter_get_basic(&iter, &boolean);
                    boolean = !boolean;
                    ok = scalar_reply(connection, request, DBUS_TYPE_BOOLEAN, &boolean);
                } else if ((dbus_message_has_member(request, "Echo") && dbus_message_has_signature(request, "s")) ||
                           (dbus_message_has_member(request, "EchoPath") && dbus_message_has_signature(request, "o"))) {
                    DBusMessageIter iter;
                    const char *text;
                    dbus_message_iter_init(request, &iter);
                    int type = dbus_message_iter_get_arg_type(&iter);
                    dbus_message_iter_get_basic(&iter, &text);
                    ok = scalar_reply(connection, request, type, &text);
                } else if (!dbus_message_has_signature(request, "u")) {
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
                    } else if (dbus_message_has_member(request, "GetSessionByPID")) {
                        char storage[80];
                        snprintf(storage, sizeof(storage), "/org/freedesktop/login1/session/p%u", number);
                        const char *path = storage;
                        ok = scalar_reply(connection, request, DBUS_TYPE_OBJECT_PATH, &path);
                    } else if (dbus_message_has_member(request, "ErrorSize")) {
                        ok = sized_error(connection, request, number);
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
