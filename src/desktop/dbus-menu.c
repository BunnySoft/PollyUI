#include "dbus-menu.h"
#include <string.h>

static bool text(DBusMessageIter *value, char *out, size_t size)
{
    if (dbus_message_iter_get_arg_type(value) != DBUS_TYPE_STRING) return false;
    const char *input;
    dbus_message_iter_get_basic(value, &input);
    if (strlen(input) >= size) return false;
    strcpy(out, input); return true;
}
static bool boolean(DBusMessageIter *value, bool *out)
{
    if (dbus_message_iter_get_arg_type(value) != DBUS_TYPE_BOOLEAN) return false;
    dbus_bool_t input;
    dbus_message_iter_get_basic(value, &input);
    *out = input; return true;
}
static bool node(DBusMessageIter *value, int32_t parent, unsigned depth, struct PuBusMenu *out)
{
    if (depth > 8 || out->count >= PU_BUS_MENU_ITEMS) return false;
    char *signature = dbus_message_iter_get_signature(value);
    bool valid = signature && !strcmp(signature, "(ia{sv}av)");
    dbus_free(signature);
    if (!valid) return false;
    struct PuBusMenuItem *item = &out->items[out->count];
    DBusMessageIter tuple, properties, children;
    dbus_message_iter_recurse(value, &tuple);
    dbus_message_iter_get_basic(&tuple, &item->id);
    if (item->id < 0) return false;
    for (unsigned i = 0; i < out->count; i++) if (out->items[i].id == item->id) return false;
    out->count++;
    item->parent = parent; item->visible = item->enabled = true; item->toggle_state = -1;
    dbus_message_iter_next(&tuple); dbus_message_iter_recurse(&tuple, &properties);
    unsigned count = 0;
    while (dbus_message_iter_get_arg_type(&properties) != DBUS_TYPE_INVALID) {
        if (++count > 32) return false;
        DBusMessageIter entry, property;
        dbus_message_iter_recurse(&properties, &entry);
        const char *name;
        dbus_message_iter_get_basic(&entry, &name); dbus_message_iter_next(&entry);
        dbus_message_iter_recurse(&entry, &property);
        bool ok = true;
        if (!strcmp(name, "label")) ok = text(&property, item->label, sizeof(item->label));
        else if (!strcmp(name, "enabled")) ok = boolean(&property, &item->enabled);
        else if (!strcmp(name, "visible")) ok = boolean(&property, &item->visible);
        else if (!strcmp(name, "toggle-type")) {
            ok = text(&property, item->toggle, sizeof(item->toggle));
            if (ok) ok = !*item->toggle || !strcmp(item->toggle, "checkmark") || !strcmp(item->toggle, "radio");
        } else if (!strcmp(name, "toggle-state")) {
            ok = dbus_message_iter_get_arg_type(&property) == DBUS_TYPE_INT32;
            if (ok) dbus_message_iter_get_basic(&property, &item->toggle_state);
        } else if (!strcmp(name, "type") || !strcmp(name, "children-display")) {
            char type[64];
            ok = text(&property, type, sizeof(type));
            if (ok && !strcmp(name, "type")) {
                item->separator = !strcmp(type, "separator");
                if (strcmp(type, "standard") && !item->separator) item->enabled = false;
            } else if (ok) {
                item->submenu = !strcmp(type, "submenu");
                if (*type && !item->submenu) ok = false;
            }
        }
        if (!ok) return false;
        dbus_message_iter_next(&properties);
    }
    dbus_message_iter_next(&tuple); dbus_message_iter_recurse(&tuple, &children);
    while (dbus_message_iter_get_arg_type(&children) != DBUS_TYPE_INVALID) {
        DBusMessageIter child;
        dbus_message_iter_recurse(&children, &child);
        if (!node(&child, item->id, depth + 1, out)) return false;
        item->submenu = true;
        dbus_message_iter_next(&children);
    }
    return true;
}
bool pu_bus_menu_parse(DBusMessage *reply, int32_t root, struct PuBusMenu *out)
{
    memset(out, 0, sizeof(*out));
    if (!dbus_message_has_signature(reply, "u(ia{sv}av)")) return false;
    DBusMessageIter tuple;
    dbus_message_iter_init(reply, &tuple);
    dbus_message_iter_get_basic(&tuple, &out->version);
    dbus_message_iter_next(&tuple);
    out->root = root;
    return node(&tuple, -1, 0, out) && out->items[0].id == root;
}
