#ifndef POLLY_DBUS_MENU_H
#define POLLY_DBUS_MENU_H
#include <dbus/dbus.h>
#include <stdbool.h>
#include <stdint.h>
#define PU_BUS_MENU_ITEMS 128
struct PuBusMenuItem {
    int32_t id, parent, toggle_state;
    bool visible, enabled, separator, submenu;
    char label[513], toggle[16];
};
struct PuBusMenu {
    uint32_t version;
    int32_t root;
    unsigned count;
    struct PuBusMenuItem items[PU_BUS_MENU_ITEMS];
};
bool pu_bus_menu_parse(DBusMessage *reply, int32_t root, struct PuBusMenu *out);
#endif
