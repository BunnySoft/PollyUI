#include "session-bus.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

char *pu_session_bus_address(void)
{
    const char *owned = getenv("POLLY_SESSION_BUS_ADDRESS");
    if (!owned || !*owned) return strdup("disabled:");
    const char *address = getenv("DBUS_SESSION_BUS_ADDRESS");
    const char *runtime = getenv("XDG_RUNTIME_DIR");
    struct stat info;
    if (!address || strcmp(owned, address) || !runtime || runtime[0] != '/' ||
        lstat(runtime, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0777) != 0700)
        goto invalid;
    DBusError error = DBUS_ERROR_INIT;
    DBusAddressEntry **entries = NULL;
    int count = 0;
    if (!dbus_parse_address(address, &entries, &count, &error)) {
        dbus_error_free(&error); goto invalid;
    }
    bool valid = false;
    if (count == 1 && !strcmp(dbus_address_entry_get_method(entries[0]), "unix")) {
        const char *path = dbus_address_entry_get_value(entries[0], "path");
        size_t length = strlen(runtime);
        valid = path && !strncmp(path, runtime, length) && !strcmp(path + length, "/bus") &&
            !lstat(path, &info) && S_ISSOCK(info.st_mode) && info.st_uid == getuid();
    }
    dbus_address_entries_free(entries);
    if (valid) return strdup(address);
invalid:
    fprintf(stderr, "[session] Private D-Bus address or runtime socket is invalid\n");
    return NULL;
}
DBusConnection *pu_session_bus_connect(char *error, size_t error_size)
{
    char *address = pu_session_bus_address();
    if (!address || !strcmp(address, "disabled:")) {
        snprintf(error, error_size, "%s", address ? "No private D-Bus session is configured" : "Invalid private D-Bus session");
        free(address); return NULL;
    }
    DBusError failure = DBUS_ERROR_INIT;
    DBusConnection *connection = dbus_connection_open_private(address, &failure);
    free(address);
    if (!connection || !dbus_bus_register(connection, &failure)) {
        snprintf(error, error_size, "Cannot connect to session bus: %s", failure.message ? failure.message : "unknown error");
        dbus_error_free(&failure);
        if (connection) { dbus_connection_close(connection); dbus_connection_unref(connection); }
        return NULL;
    }
    dbus_connection_set_exit_on_disconnect(connection, false);
    dbus_connection_set_max_received_size(connection, 2 * 1024 * 1024);
    dbus_connection_set_max_message_size(connection, 256 * 1024);
    dbus_connection_set_max_received_unix_fds(connection, 16);
    dbus_connection_set_max_message_unix_fds(connection, 0);
    return connection;
}
