#include "desktop/session-bus.h"
#include <dbus/dbus.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define NAME "org.freedesktop.login1"
static DBusConnection *bus;
static bool active = true, foreign;
static const char *permission = "yes";
static unsigned actions;
static volatile sig_atomic_t running = 1;
static void finish(int signal) { (void)signal; running = 0; }
static void send(DBusMessage *message)
{
    if (message) { dbus_connection_send(bus, message, NULL); dbus_message_unref(message); }
}
static bool basic(DBusMessageIter *array, const char *key, const char *signature, int type, void *value)
{
    DBusMessageIter entry, variant;
    return dbus_message_iter_open_container(array, DBUS_TYPE_DICT_ENTRY, NULL, &entry) &&
        dbus_message_iter_append_basic(&entry, DBUS_TYPE_STRING, &key) &&
        dbus_message_iter_open_container(&entry, DBUS_TYPE_VARIANT, signature, &variant) &&
        dbus_message_iter_append_basic(&variant, type, value) &&
        dbus_message_iter_close_container(&entry, &variant) && dbus_message_iter_close_container(array, &entry);
}
static bool tuple(DBusMessageIter *array, const char *key, bool user)
{
    DBusMessageIter entry, variant, fields;
    const char *signature = user ? "(uo)" : "(so)", *seat = "seat0", *path = "/org/freedesktop/login1/fixture";
    uint32_t uid = foreign ? 9999 : (uint32_t)getuid();
    return dbus_message_iter_open_container(array, DBUS_TYPE_DICT_ENTRY, NULL, &entry) &&
        dbus_message_iter_append_basic(&entry, DBUS_TYPE_STRING, &key) &&
        dbus_message_iter_open_container(&entry, DBUS_TYPE_VARIANT, signature, &variant) &&
        dbus_message_iter_open_container(&variant, DBUS_TYPE_STRUCT, NULL, &fields) &&
        dbus_message_iter_append_basic(&fields, user ? DBUS_TYPE_UINT32 : DBUS_TYPE_STRING, user ? (void *)&uid : (void *)&seat) &&
        dbus_message_iter_append_basic(&fields, DBUS_TYPE_OBJECT_PATH, &path) &&
        dbus_message_iter_close_container(&variant, &fields) &&
        dbus_message_iter_close_container(&entry, &variant) && dbus_message_iter_close_container(array, &entry);
}
static DBusHandlerResult filter(DBusConnection *connection, DBusMessage *message, void *data)
{
    (void)connection; (void)data;
    if (dbus_message_get_type(message) != DBUS_MESSAGE_TYPE_METHOD_CALL) return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
    const char *member = dbus_message_get_member(message), *interface = dbus_message_get_interface(message);
    DBusMessage *reply = dbus_message_new_method_return(message);
    if (!reply) return DBUS_HANDLER_RESULT_NEED_MEMORY;
    if (interface && !strcmp(interface, "org.polly.PowerFixture")) {
        const char *mode;
        if (!dbus_message_get_args(message, NULL, DBUS_TYPE_STRING, &mode, DBUS_TYPE_INVALID)) goto invalid;
        if (!strcmp(mode, "inactive")) active = false;
        else if (!strcmp(mode, "active")) active = true;
        else if (!strcmp(mode, "foreign")) foreign = true;
        else if (!strcmp(mode, "own")) foreign = false;
        else if (!strcmp(mode, "challenge")) permission = "challenge";
        else if (!strcmp(mode, "yes")) permission = "yes";
        else if (!strcmp(mode, "no")) permission = "no";
        else if (!strcmp(mode, "count")) dbus_message_append_args(reply, DBUS_TYPE_UINT32, &actions, DBUS_TYPE_INVALID);
        else if (!strcmp(mode, "quit")) running = 0;
        else goto invalid;
    } else if (!strcmp(member, "GetSessionByPID")) {
        uint32_t pid;
        if (!dbus_message_get_args(message, NULL, DBUS_TYPE_UINT32, &pid, DBUS_TYPE_INVALID) || !pid) goto invalid;
        const char *path = "/org/freedesktop/login1/session/fixture";
        dbus_message_append_args(reply, DBUS_TYPE_OBJECT_PATH, &path, DBUS_TYPE_INVALID);
    } else if (!strcmp(member, "GetAll")) {
        DBusMessageIter root, array;
        dbus_bool_t yes = active, no = false;
        dbus_message_iter_init_append(reply, &root);
        if (!dbus_message_iter_open_container(&root, DBUS_TYPE_ARRAY, "{sv}", &array) ||
            !basic(&array, "Active", "b", DBUS_TYPE_BOOLEAN, &yes) ||
            !basic(&array, "Remote", "b", DBUS_TYPE_BOOLEAN, &no) ||
            !tuple(&array, "User", true) || !tuple(&array, "Seat", false) ||
            !dbus_message_iter_close_container(&root, &array)) goto invalid;
    } else if (!strcmp(member, "CanPowerOff") || !strcmp(member, "CanReboot")) {
        dbus_message_append_args(reply, DBUS_TYPE_STRING, &permission, DBUS_TYPE_INVALID);
    } else if (!strcmp(member, "PowerOff") || !strcmp(member, "Reboot")) {
        dbus_bool_t interactive;
        if (!dbus_message_get_args(message, NULL, DBUS_TYPE_BOOLEAN, &interactive, DBUS_TYPE_INVALID) ||
            interactive || !active || foreign || strcmp(permission, "yes")) goto invalid;
        actions++;
    } else goto invalid;
    send(reply); return DBUS_HANDLER_RESULT_HANDLED;
invalid:
    dbus_message_unref(reply);
    send(dbus_message_new_error(message, DBUS_ERROR_ACCESS_DENIED, "Rejected fixture request"));
    return DBUS_HANDLER_RESULT_HANDLED;
}
int main(int argc, char **argv)
{
    char error[256];
    bus = pu_system_bus_connect(error, sizeof(error));
    if (!bus) { fprintf(stderr, "%s\n", error); return 1; }
    dbus_connection_set_exit_on_disconnect(bus, false);
    if (argc == 2 || argc == 3) {
        DBusMessage *message = dbus_message_new_method_call(NAME, "/org/polly/PowerFixture", "org.polly.PowerFixture", "Set");
        const char *mode = argv[1];
        dbus_message_append_args(message, DBUS_TYPE_STRING, &mode, DBUS_TYPE_INVALID);
        DBusMessage *reply = dbus_connection_send_with_reply_and_block(bus, message, 3000, NULL);
        dbus_message_unref(message);
        int result = !reply;
        if (reply && !strcmp(mode, "count")) {
            uint32_t count;
            result = !dbus_message_get_args(reply, NULL, DBUS_TYPE_UINT32, &count, DBUS_TYPE_INVALID);
            if (!result) result = argc == 3 && count == (unsigned)strtoul(argv[2], NULL, 10) ? 0 : 1;
        }
        if (reply) dbus_message_unref(reply);
        dbus_connection_close(bus); dbus_connection_unref(bus);
        return result;
    }
    if (argc != 1) return 2;
    if (dbus_bus_request_name(bus, NAME, DBUS_NAME_FLAG_DO_NOT_QUEUE, NULL) != DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER ||
        !dbus_connection_add_filter(bus, filter, NULL, NULL)) return 1;
    signal(SIGTERM, finish); signal(SIGINT, finish);
    while (running && dbus_connection_read_write_dispatch(bus, 20)) {}
    dbus_connection_close(bus); dbus_connection_unref(bus);
    return 0;
}
