#define _POSIX_C_SOURCE 200809L
#include "desktop/session-bus.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static DBusConnection *connect_private(void)
{
    char error[256];
    DBusConnection *bus = pu_session_bus_connect(error, sizeof(error));
    if (!bus) fprintf(stderr, "FAIL: %s\n", error);
    return bus;
}

static int probe(const char *name, const char *path, const char *expected)
{
    DBusConnection *bus = connect_private();
    if (!bus) return 1;
    DBusMessage *message = dbus_message_new_method_call(name, path, "org.freedesktop.Application", "Activate");
    if (!message) return 1;
    DBusMessageIter body, data;
    dbus_message_iter_init_append(message, &body);
    if (!dbus_message_iter_open_container(&body, DBUS_TYPE_ARRAY, "{sv}", &data) ||
        !dbus_message_iter_close_container(&body, &data)) return 1;
    DBusError error = DBUS_ERROR_INIT;
    DBusMessage *reply = dbus_connection_send_with_reply_and_block(bus, message, 3000, &error);
    dbus_message_unref(message);
    bool ok = !strcmp(expected, "ack") ? reply && dbus_message_has_signature(reply, "") :
        !reply && dbus_error_is_set(&error) && strstr(error.name, expected);
    printf("%s: synthetic libdbus fixture probe %s: %s\n", ok ? "PASS" : "FAIL", name,
        reply ? "ack" : error.name ? error.name : "no reply");
    if (reply) dbus_message_unref(reply);
    dbus_error_free(&error);
    dbus_connection_close(bus); dbus_connection_unref(bus);
    return ok ? 0 : 1;
}

int main(int argc, char **argv)
{
    if (argc == 2 && !strcmp(argv[1], "--guard")) {
        char *address = pu_session_bus_address();
        bool rejected = !address || !strcmp(address, "disabled:");
        free(address);
        char error[256];
        DBusConnection *bus = pu_session_bus_connect(error, sizeof(error));
        if (bus) { dbus_connection_close(bus); dbus_connection_unref(bus); }
        if (!rejected || bus) { fprintf(stderr, "FAIL: unqualified bus accepted\n"); return 1; }
        puts("PASS: synthetic fixture trust guard rejection");
        return 0;
    }
    if (argc == 5 && !strcmp(argv[1], "--probe")) return probe(argv[2], argv[3], argv[4]);
    if (argc != 5) { fprintf(stderr, "Usage: service NAME PATH LOG MODE\n"); return 2; }
    if (!strcmp(argv[4], "start-failure")) {
        FILE *log = fopen(argv[3], "a");
        if (!log) return 1;
        fprintf(log, "start-failed\t%ld\t%s\n", (long)getpid(), argv[1]); fclose(log);
        return 5;
    }
    const char *starter = getenv("DBUS_STARTER_ADDRESS");
    if (!starter || !getenv("DBUS_STARTER_BUS_TYPE") ||
        strcmp(getenv("DBUS_STARTER_BUS_TYPE"), "session")) return 2;
    if (setenv("POLLY_SESSION_BUS_ADDRESS", starter, 1) || setenv("DBUS_SESSION_BUS_ADDRESS", starter, 1)) return 2;
    DBusConnection *bus = connect_private();
    if (!bus) return 1;
    DBusError error = DBUS_ERROR_INIT;
    int owned = dbus_bus_request_name(bus, argv[1], DBUS_NAME_FLAG_DO_NOT_QUEUE, &error);
    if (owned != DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER) return 1;
    FILE *log = fopen(argv[3], "a");
    if (!log) return 1;
    fprintf(log, "started\t%ld\t%s\n", (long)getpid(), argv[1]); fflush(log);
    while (dbus_connection_read_write(bus, 50)) {
        DBusMessage *message;
        while ((message = dbus_connection_pop_message(bus))) {
            if (dbus_message_get_type(message) != DBUS_MESSAGE_TYPE_METHOD_CALL) {
                dbus_message_unref(message); continue;
            }
            const char *path = dbus_message_get_path(message), *interface = dbus_message_get_interface(message),
                *member = dbus_message_get_member(message);
            DBusMessageIter body, data;
            bool empty = dbus_message_has_signature(message, "a{sv}") &&
                dbus_message_iter_init(message, &body) && dbus_message_iter_get_arg_type(&body) == DBUS_TYPE_ARRAY;
            if (empty) {
                dbus_message_iter_recurse(&body, &data);
                empty = dbus_message_iter_get_arg_type(&data) == DBUS_TYPE_INVALID && !dbus_message_iter_next(&body);
            }
            fprintf(log, "call\t%s\t%s\t%s\t%s\t%d\t%d\n", path ? path : "", interface ? interface : "",
                member ? member : "", dbus_message_get_signature(message), empty,
                dbus_message_get_auto_start(message)); fflush(log);
            bool valid = path && !strcmp(path, argv[2]) && interface && !strcmp(interface, "org.freedesktop.Application") &&
                member && !strcmp(member, "Activate") && empty;
            DBusMessage *reply = NULL;
            if (!valid || !strcmp(argv[4], "wrong"))
                reply = dbus_message_new_error(message, DBUS_ERROR_UNKNOWN_METHOD, "Synthetic fixture has no such method");
            else if (!strcmp(argv[4], "error"))
                reply = dbus_message_new_error(message, "org.pollyui.ActivationFixture.Failed", "Synthetic activation refused");
            else if (!strcmp(argv[4], "malformed")) {
                reply = dbus_message_new_method_return(message);
                const char *unexpected = "not an empty acknowledgement";
                if (reply && !dbus_message_append_args(reply, DBUS_TYPE_STRING, &unexpected, DBUS_TYPE_INVALID)) return 1;
            } else if (!strcmp(argv[4], "ack") || !strcmp(argv[4], "slow-ack")) {
                if (!strcmp(argv[4], "slow-ack")) {
                    const struct timespec pause = { .tv_sec = 0, .tv_nsec = 300000000 };
                    nanosleep(&pause, NULL);
                }
                reply = dbus_message_new_method_return(message);
            } else if (!strcmp(argv[4], "oversized")) {
                char *large = malloc(32769);
                if (!large) return 1;
                memset(large, 'x', 32768); large[32768] = 0;
                reply = dbus_message_new_method_return(message);
                if (reply && !dbus_message_append_args(reply, DBUS_TYPE_STRING, &large, DBUS_TYPE_INVALID)) return 1;
                free(large);
            }
            else if (strcmp(argv[4], "timeout") && strcmp(argv[4], "disconnect")) return 2;
            if (reply) {
                if (!dbus_connection_send(bus, reply, NULL)) return 1;
                dbus_connection_flush(bus); dbus_message_unref(reply);
            }
            dbus_message_unref(message);
        }
    }
    fclose(log);
    dbus_connection_close(bus); dbus_connection_unref(bus);
    return 0;
}
