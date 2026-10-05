#include "desktop/session-bus.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define CHECK(value) do { if (!(value)) { fprintf(stderr, "FAIL tray line %d: %s\n", __LINE__, #value); exit(1); } } while (0)
#define WATCHER "org.kde.StatusNotifierWatcher"
#define ITEM "org.kde.StatusNotifierItem"
static DBusConnection *bus;
static int stage, running = 1;
static bool hanging;
static bool menu_mode;
static uint32_t menu_version = 1;
static long long show_at;
static const char *title = "Tray fixture", *status = "Active";
static long long now(void) { struct timespec time; clock_gettime(CLOCK_MONOTONIC, &time); return (long long)time.tv_sec * 1000 + time.tv_nsec / 1000000; }
static void send(DBusMessage *message)
{
    CHECK(message && dbus_connection_send(bus, message, NULL));
    dbus_message_unref(message);
}
static void changed(void)
{ send(dbus_message_new_signal("/StatusNotifierItem", ITEM, "NewTitle")); }
static void property(DBusMessageIter *array, const char *name, const char *signature, const void *value, int type)
{
    DBusMessageIter entry, variant;
    CHECK(dbus_message_iter_open_container(array, DBUS_TYPE_DICT_ENTRY, NULL, &entry));
    CHECK(dbus_message_iter_append_basic(&entry, DBUS_TYPE_STRING, &name));
    CHECK(dbus_message_iter_open_container(&entry, DBUS_TYPE_VARIANT, signature, &variant));
    CHECK(dbus_message_iter_append_basic(&variant, type, value));
    CHECK(dbus_message_iter_close_container(&entry, &variant) && dbus_message_iter_close_container(array, &entry));
}
static void menu_node(DBusMessageIter *container, int32_t id)
{
    DBusMessageIter node, props, children;
    CHECK(dbus_message_iter_open_container(container, DBUS_TYPE_STRUCT, NULL, &node));
    CHECK(dbus_message_iter_append_basic(&node, DBUS_TYPE_INT32, &id));
    CHECK(dbus_message_iter_open_container(&node, DBUS_TYPE_ARRAY, "{sv}", &props));
    const char *label = id == 1 ? "_Open" : id == 2 ? "Disabled" : id == 3 ? "More" :
        id == 5 ? "Hidden" : id == 6 ? menu_version == 1 ? "_Exit" : "_Finish" : "";
    property(&props, "label", "s", &label, DBUS_TYPE_STRING);
    if (id == 2 || id == 5) {
        dbus_bool_t value = false;
        property(&props, id == 2 ? "enabled" : "visible", "b", &value, DBUS_TYPE_BOOLEAN);
    }
    if (id == 1) {
        const char *toggle = "checkmark"; int32_t enabled = 1;
        property(&props, "toggle-type", "s", &toggle, DBUS_TYPE_STRING);
        property(&props, "toggle-state", "i", &enabled, DBUS_TYPE_INT32);
    }
    if (id == 3) { const char *type = "submenu"; property(&props, "children-display", "s", &type, DBUS_TYPE_STRING); }
    if (id == 4) { const char *type = "separator"; property(&props, "type", "s", &type, DBUS_TYPE_STRING); }
    CHECK(dbus_message_iter_close_container(&node, &props));
    CHECK(dbus_message_iter_open_container(&node, DBUS_TYPE_ARRAY, "v", &children));
    if (id == 0 || id == 3) {
        int first = id == 0 ? 1 : 6, last = id == 0 ? 5 : 6;
        for (int child = first; child <= last; child++) {
            DBusMessageIter variant;
            CHECK(dbus_message_iter_open_container(&children, DBUS_TYPE_VARIANT, "(ia{sv}av)", &variant));
            if (id == 0 && child == 3) {
                DBusMessageIter nested, properties, empty;
                int32_t menu_id = 3; const char *name = "More", *display = "submenu";
                CHECK(dbus_message_iter_open_container(&variant, DBUS_TYPE_STRUCT, NULL, &nested));
                CHECK(dbus_message_iter_append_basic(&nested, DBUS_TYPE_INT32, &menu_id));
                CHECK(dbus_message_iter_open_container(&nested, DBUS_TYPE_ARRAY, "{sv}", &properties));
                property(&properties, "label", "s", &name, DBUS_TYPE_STRING);
                property(&properties, "children-display", "s", &display, DBUS_TYPE_STRING);
                CHECK(dbus_message_iter_close_container(&nested, &properties));
                CHECK(dbus_message_iter_open_container(&nested, DBUS_TYPE_ARRAY, "v", &empty) &&
                    dbus_message_iter_close_container(&nested, &empty) && dbus_message_iter_close_container(&variant, &nested));
            } else menu_node(&variant, child);
            CHECK(dbus_message_iter_close_container(&children, &variant));
        }
    }
    CHECK(dbus_message_iter_close_container(&node, &children) && dbus_message_iter_close_container(container, &node));
}
static DBusHandlerResult method(DBusConnection *connection, DBusMessage *request, void *data)
{
    (void)connection; (void)data;
    if (menu_mode && dbus_message_has_interface(request, "com.canonical.dbusmenu")) {
        const char *member = dbus_message_get_member(request);
        DBusMessage *reply = dbus_message_new_method_return(request);
        if (!strcmp(member, "AboutToShow")) {
            int32_t root; dbus_bool_t update = true;
            CHECK(dbus_message_get_args(request, NULL, DBUS_TYPE_INT32, &root, DBUS_TYPE_INVALID) && (root == 0 || root == 3));
            CHECK(dbus_message_append_args(reply, DBUS_TYPE_BOOLEAN, &update, DBUS_TYPE_INVALID));
        } else if (!strcmp(member, "GetLayout")) {
            CHECK(dbus_message_has_signature(request, "iias"));
            DBusMessageIter args;
            dbus_message_iter_init(request, &args);
            int32_t root, depth;
            dbus_message_iter_get_basic(&args, &root); dbus_message_iter_next(&args);
            dbus_message_iter_get_basic(&args, &depth);
            CHECK((root == 0 || root == 3) && depth == 1);
            dbus_message_iter_init_append(reply, &args);
            CHECK(dbus_message_iter_append_basic(&args, DBUS_TYPE_UINT32, &menu_version));
            menu_node(&args, root);
        } else if (!strcmp(member, "Event")) {
            CHECK(dbus_message_has_signature(request, "isvu"));
            DBusMessageIter args;
            dbus_message_iter_init(request, &args);
            int32_t id; const char *event;
            dbus_message_iter_get_basic(&args, &id); dbus_message_iter_next(&args);
            dbus_message_iter_get_basic(&args, &event);
            CHECK(id == 6 && !strcmp(event, "clicked") && menu_version == 2);
            running = 0; stage = 4;
        } else CHECK(false);
        send(reply); return DBUS_HANDLER_RESULT_HANDLED;
    }
    if (dbus_message_is_method_call(request, DBUS_INTERFACE_PROPERTIES, "GetAll")) {
        if (hanging) return DBUS_HANDLER_RESULT_HANDLED;
        DBusMessage *reply = dbus_message_new_method_return(request);
        DBusMessageIter root, array, entry, variant, pixmaps, tuple, bytes;
        dbus_message_iter_init_append(reply, &root);
        CHECK(dbus_message_iter_open_container(&root, DBUS_TYPE_ARRAY, "{sv}", &array));
        const char *id = "org.pollyui.tray-test", *name = "does-not-exist";
        property(&array, "Id", "s", &id, DBUS_TYPE_STRING);
        property(&array, "Title", "s", &title, DBUS_TYPE_STRING);
        property(&array, "Status", "s", &status, DBUS_TYPE_STRING);
        property(&array, "IconName", "s", &name, DBUS_TYPE_STRING);
        if (menu_mode) {
            const char *path = "/Menu"; dbus_bool_t only = true;
            property(&array, "Menu", "o", &path, DBUS_TYPE_OBJECT_PATH);
            property(&array, "ItemIsMenu", "b", &only, DBUS_TYPE_BOOLEAN);
        }
        const char *key = "IconPixmap";
        CHECK(dbus_message_iter_open_container(&array, DBUS_TYPE_DICT_ENTRY, NULL, &entry));
        CHECK(dbus_message_iter_append_basic(&entry, DBUS_TYPE_STRING, &key));
        CHECK(dbus_message_iter_open_container(&entry, DBUS_TYPE_VARIANT, "a(iiay)", &variant));
        CHECK(dbus_message_iter_open_container(&variant, DBUS_TYPE_ARRAY, "(iiay)", &pixmaps));
        CHECK(dbus_message_iter_open_container(&pixmaps, DBUS_TYPE_STRUCT, NULL, &tuple));
        int32_t width = 24, height = 24;
        CHECK(dbus_message_iter_append_basic(&tuple, DBUS_TYPE_INT32, &width) &&
            dbus_message_iter_append_basic(&tuple, DBUS_TYPE_INT32, &height));
        unsigned char pixels[24 * 24 * 4];
        for (size_t i = 0; i < sizeof(pixels); i += 4) {
            pixels[i] = 255; pixels[i + 1] = 32; pixels[i + 2] = 144; pixels[i + 3] = 224;
        }
        const unsigned char *data = pixels;
        CHECK(dbus_message_iter_open_container(&tuple, DBUS_TYPE_ARRAY, "y", &bytes));
        CHECK(dbus_message_iter_append_fixed_array(&bytes, DBUS_TYPE_BYTE, &data, sizeof(pixels)));
        CHECK(dbus_message_iter_close_container(&tuple, &bytes) && dbus_message_iter_close_container(&pixmaps, &tuple) &&
            dbus_message_iter_close_container(&variant, &pixmaps) && dbus_message_iter_close_container(&entry, &variant) &&
            dbus_message_iter_close_container(&array, &entry) && dbus_message_iter_close_container(&root, &array));
        send(reply);
        return DBUS_HANDLER_RESULT_HANDLED;
    }
    if (dbus_message_has_interface(request, ITEM) && dbus_message_get_type(request) == DBUS_MESSAGE_TYPE_METHOD_CALL) {
        const char *member = dbus_message_get_member(request);
        if (menu_mode && !strcmp(member, "Scroll")) {
            menu_version++;
            DBusMessage *signal = dbus_message_new_signal("/Menu", "com.canonical.dbusmenu", "LayoutUpdated");
            int32_t root = 0;
            CHECK(dbus_message_append_args(signal, DBUS_TYPE_UINT32, &menu_version, DBUS_TYPE_INT32, &root, DBUS_TYPE_INVALID));
            send(signal); send(dbus_message_new_method_return(request));
            return DBUS_HANDLER_RESULT_HANDLED;
        }
        if (!strcmp(member, "Scroll")) {
            int32_t delta; const char *orientation;
            CHECK(stage == 2 && dbus_message_get_args(request, NULL, DBUS_TYPE_INT32, &delta,
                DBUS_TYPE_STRING, &orientation, DBUS_TYPE_INVALID) && delta == -120 && !strcmp(orientation, "vertical"));
            stage = 3; title = "Tray scrolled"; status = "NeedsAttention";
        } else {
            int32_t x, y;
            CHECK(dbus_message_get_args(request, NULL, DBUS_TYPE_INT32, &x, DBUS_TYPE_INT32, &y, DBUS_TYPE_INVALID));
            CHECK(x >= 0 && x < 2560 && y >= 680 && y < 720);
            if (!strcmp(member, "Activate")) {
                CHECK(stage == 0); stage = 1; title = "Tray activated"; status = "Passive"; show_at = now() + 500;
            } else if (!strcmp(member, "SecondaryActivate")) {
                CHECK(stage == 1); stage = 2; title = "Tray secondary";
            } else if (!strcmp(member, "ContextMenu")) {
                CHECK(stage == 3); stage = 4; title = "Tray menu";
            } else CHECK(false);
        }
        send(dbus_message_new_method_return(request));
        changed();
        if (stage == 4) running = 0;
        return DBUS_HANDLER_RESULT_HANDLED;
    }
    return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
}
static const DBusObjectPathVTable vtable = { .message_function = method };
int main(int argc, char **argv)
{
    char error[256];
    bus = pu_session_bus_connect(error, sizeof(error));
    if (!bus) fprintf(stderr, "%s\n", error);
    CHECK(bus);
    DBusError failure = DBUS_ERROR_INIT;
    if (argc == 2 && !strcmp(argv[1], "foreign")) {
        const char *service = "org.pollyui.TrayFixture";
        DBusMessage *request = dbus_message_new_method_call(WATCHER, "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem");
        CHECK(dbus_message_append_args(request, DBUS_TYPE_STRING, &service, DBUS_TYPE_INVALID));
        DBusMessage *reply = dbus_connection_send_with_reply_and_block(bus, request, 3000, &failure);
        CHECK(!reply && dbus_error_has_name(&failure, DBUS_ERROR_ACCESS_DENIED));
        dbus_message_unref(request); dbus_error_free(&failure);
        puts("PASS: non-owner tray registration denied");
    } else {
        hanging = argc == 2 && !strcmp(argv[1], "hang");
        menu_mode = argc == 2 && !strcmp(argv[1], "menu");
        if (menu_mode) title = "Menu fixture";
        const char *service = hanging ? "org.pollyui.HungTrayFixture" : menu_mode ? "org.pollyui.MenuTrayFixture" : "org.pollyui.TrayFixture";
        CHECK(dbus_bus_request_name(bus, service, DBUS_NAME_FLAG_DO_NOT_QUEUE, &failure) == DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER);
        CHECK(dbus_connection_register_object_path(bus, "/StatusNotifierItem", &vtable, NULL));
        if (menu_mode) CHECK(dbus_connection_register_object_path(bus, "/Menu", &vtable, NULL));
        DBusMessage *request = dbus_message_new_method_call(WATCHER, "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem");
        CHECK(dbus_message_append_args(request, DBUS_TYPE_STRING, &service, DBUS_TYPE_INVALID));
        DBusMessage *reply = dbus_connection_send_with_reply_and_block(bus, request, 3000, &failure);
        if (!reply) fprintf(stderr, "Tray registration failed: %s\n", failure.message ? failure.message : "unknown");
        CHECK(reply); dbus_message_unref(reply); dbus_message_unref(request);
        long long deadline = now() + (hanging ? 4000 : 30000);
        while (running && now() < deadline) {
            CHECK(dbus_connection_read_write_dispatch(bus, 20));
            if (show_at && now() >= show_at) { show_at = 0; status = "Active"; changed(); }
        }
        CHECK(hanging || stage == 4);
        dbus_connection_flush(bus);
        dbus_connection_unregister_object_path(bus, "/StatusNotifierItem");
        if (menu_mode) dbus_connection_unregister_object_path(bus, "/Menu");
        puts("PASS: status tray properties, pixels and actions");
    }
    dbus_connection_close(bus); dbus_connection_unref(bus);
    return 0;
}
