#define _POSIX_C_SOURCE 200809L
#include "native/session-bus.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    if (argc != 5) { fprintf(stderr, "Usage: service NAME PATH LOG MODE\n"); return 2; }
    const char *starter = getenv("DBUS_STARTER_ADDRESS");
    if (!starter || !getenv("DBUS_STARTER_BUS_TYPE") || strcmp(getenv("DBUS_STARTER_BUS_TYPE"), "session") ||
        setenv("POLLY_SESSION_BUS_ADDRESS", starter, 1) || setenv("DBUS_SESSION_BUS_ADDRESS", starter, 1)) return 2;
    char error_text[256];
    DBusConnection *bus = pu_session_bus_connect(error_text, sizeof(error_text));
    if (!bus) { fprintf(stderr, "FAIL: %s\n", error_text); return 1; }
    DBusError error = DBUS_ERROR_INIT;
    if (dbus_bus_request_name(bus, argv[1], DBUS_NAME_FLAG_DO_NOT_QUEUE, &error) != DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER)
        return 1;
    FILE *log = fopen(argv[3], "a");
    if (!log) return 1;
    fprintf(log, "started\t%ld\t%s\n", (long)getpid(), argv[1]); fflush(log);
    while (dbus_connection_read_write(bus, 50)) {
        DBusMessage *message;
        while ((message = dbus_connection_pop_message(bus))) {
            if (dbus_message_get_type(message) != DBUS_MESSAGE_TYPE_METHOD_CALL) { dbus_message_unref(message); continue; }
            const char *path = dbus_message_get_path(message), *interface = dbus_message_get_interface(message),
                *member = dbus_message_get_member(message);
            DBusMessageIter body, list, data;
            bool valid = path && !strcmp(path, argv[2]) && interface && !strcmp(interface, "org.freedesktop.Application") &&
                member && !strcmp(member, "Open") && dbus_message_has_signature(message, "asa{sv}") &&
                !dbus_message_contains_unix_fds(message) && dbus_message_iter_init(message, &body);
            fprintf(log, "call\t%s\t%s\t%s\t%s\t%d\n", path ? path : "", interface ? interface : "",
                member ? member : "", dbus_message_get_signature(message), dbus_message_get_auto_start(message));
            unsigned count = 0;
            if (valid) {
                dbus_message_iter_recurse(&body, &list);
                while (dbus_message_iter_get_arg_type(&list) == DBUS_TYPE_STRING) {
                    const char *uri;
                    dbus_message_iter_get_basic(&list, &uri);
                    fprintf(log, "uri\t%s\n", uri);
                    if (strncmp(uri, "file:///", 8) || ++count > 32) valid = false;
                    dbus_message_iter_next(&list);
                }
                valid = valid && count && dbus_message_iter_get_arg_type(&list) == DBUS_TYPE_INVALID &&
                    dbus_message_iter_next(&body) && dbus_message_iter_get_arg_type(&body) == DBUS_TYPE_ARRAY;
                if (valid) {
                    dbus_message_iter_recurse(&body, &data);
                    valid = dbus_message_iter_get_arg_type(&data) == DBUS_TYPE_INVALID && !dbus_message_iter_next(&body);
                }
            }
            fprintf(log, "body\t%u\t%d\n", count, valid); fflush(log);
            DBusMessage *reply = NULL;
            long long elapsed = 0;
            if (!valid) reply = dbus_message_new_error(message, DBUS_ERROR_UNKNOWN_METHOD, "Invalid synthetic Open");
            else if (!strcmp(argv[4], "error"))
                reply = dbus_message_new_error(message, "org.pollyui.DocumentFixture.Failed", "Synthetic Open refused");
            else if (!strcmp(argv[4], "malformed") || !strcmp(argv[4], "oversized")) {
                char *text = malloc(32769);
                if (!text) return 1;
                memset(text, 'x', 32768); text[!strcmp(argv[4], "malformed") ? 1 : 32768] = 0;
                reply = dbus_message_new_method_return(message);
                if (!reply || !dbus_message_append_args(reply, DBUS_TYPE_STRING, &text, DBUS_TYPE_INVALID)) return 1;
                free(text);
            } else if (!strcmp(argv[4], "fds")) {
                int descriptors[2];
                if (pipe(descriptors)) return 1;
                reply = dbus_message_new_method_return(message);
                bool appended = reply && dbus_message_append_args(reply, DBUS_TYPE_UNIX_FD, &descriptors[0], DBUS_TYPE_INVALID);
                close(descriptors[0]); close(descriptors[1]);
                if (!appended) return 1;
            } else if (!strcmp(argv[4], "ack") || !strcmp(argv[4], "late")) {
                struct timespec begin, end;
                struct timespec pause = { .tv_sec = !strcmp(argv[4], "late") ? 3 : 0,
                    .tv_nsec = !strcmp(argv[4], "late") ? 500000000 : 300000000 };
                if (clock_gettime(CLOCK_MONOTONIC, &begin)) return 1;
                while (nanosleep(&pause, &pause)) if (errno != EINTR) return 1;
                if (clock_gettime(CLOCK_MONOTONIC, &end)) return 1;
                elapsed = (long long)(end.tv_sec - begin.tv_sec) * 1000 + (end.tv_nsec - begin.tv_nsec) / 1000000;
                reply = dbus_message_new_method_return(message);
            } else if (strcmp(argv[4], "timeout") && strcmp(argv[4], "disconnect")) return 2;
            if (reply) {
                if (!dbus_connection_send(bus, reply, NULL)) return 1;
                dbus_connection_flush(bus); dbus_message_unref(reply);
                fprintf(log, "reply\t%s\n", argv[4]); fflush(log);
                if (elapsed) { fprintf(log, "elapsed\t%lld\n", elapsed); fflush(log); }
            } else if (strcmp(argv[4], "timeout") && strcmp(argv[4], "disconnect")) return 1;
            dbus_message_unref(message);
        }
    }
    fclose(log); dbus_connection_close(bus); dbus_connection_unref(bus);
    return 0;
}
