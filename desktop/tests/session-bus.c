#include "desktop/session-bus.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) { \
    fprintf(stderr, "FAIL session bus line %d: %s\n", __LINE__, #condition); return 1; } } while (0)
int main(void)
{
    for (int fd = 3; fd < 128; fd++) CHECK(fcntl(fd, F_GETFD) < 0 && errno == EBADF);
    CHECK(!getenv("WAYLAND_SOCKET"));
    char *address = pu_session_bus_address();
    CHECK(address && strcmp(address, "disabled:"));
    char error[256];
    DBusConnection *connection = pu_session_bus_connect(error, sizeof(error));
    if (!connection) fprintf(stderr, "%s\n", error);
    CHECK(connection);
    DBusMessage *request = dbus_message_new_method_call(DBUS_SERVICE_DBUS, DBUS_PATH_DBUS, DBUS_INTERFACE_DBUS, "GetId");
    CHECK(request);
    DBusError failure = DBUS_ERROR_INIT;
    DBusMessage *reply = dbus_connection_send_with_reply_and_block(connection, request, 2000, &failure);
    dbus_message_unref(request);
    if (!reply) fprintf(stderr, "Session bus GetId failed: %s\n", failure.message ? failure.message : "unknown");
    CHECK(reply);
    const char *id;
    CHECK(dbus_message_get_args(reply, &failure, DBUS_TYPE_STRING, &id, DBUS_TYPE_INVALID));
    CHECK(strlen(id) == 32);
    printf("PASS: private session bus ID %s\n", id);
    dbus_message_unref(reply);
    dbus_connection_close(connection); dbus_connection_unref(connection);
    CHECK(setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/parent/bus", 1) == 0);
    CHECK(!pu_session_bus_address());
    CHECK(setenv("POLLY_SESSION_BUS_ADDRESS", "unix:path=/parent/bus", 1) == 0);
    CHECK(!pu_session_bus_address());
    CHECK(unsetenv("POLLY_SESSION_BUS_ADDRESS") == 0);
    char *disabled = pu_session_bus_address();
    CHECK(disabled && !strcmp(disabled, "disabled:"));
    free(disabled);
    CHECK(setenv("POLLY_SESSION_BUS_ADDRESS", address, 1) == 0 &&
        setenv("DBUS_SESSION_BUS_ADDRESS", address, 1) == 0);
    free(address);
    puts("PASS: parent-bus leakage and invalid private addresses are rejected");
    return 0;
}
