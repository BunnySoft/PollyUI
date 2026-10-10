#include "tray.h"
#include "session-bus.h"
#include "windows.h"
#include "render/skia_c.h"
#include "shared/thread.h"
#include "dbus-menu.h"
#include <math.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WATCHER_PATH "/StatusNotifierWatcher"
#define KDE_WATCHER "org.kde.StatusNotifierWatcher"
#define FDO_WATCHER "org.freedesktop.StatusNotifierWatcher"
#define KDE_ITEM "org.kde.StatusNotifierItem"
#define FDO_ITEM "org.freedesktop.StatusNotifierItem"
#define MAX_TRAY_ITEMS 64

struct TrayData {
    char title[513], name[257], status[32], menu[257], icon_name[257], error[256];
    bool menu_only, icon;
};
struct TrayItem {
    uint32_t id, revision;
    char *owner, *service, *path, *key;
    const char *interface;
    char icon[64];
    struct TrayData data;
    bool refreshing, dirty, ready;
    struct TrayItem *next;
};
enum RequestType { RESOLVE_ITEM, RESOLVE_HOST, REFRESH_ITEM, ITEM_ACTION, MENU_SHOW, MENU_LAYOUT };
struct Request {
    enum RequestType type;
    DBusPendingCall *pending;
    DBusMessage *registration;
    char *service;
    uint32_t item;
    uint32_t menu_revision;
    long long deadline;
    struct Request *next;
};
static struct {
    JSContext *ctx;
    JSValue api;
    DBusConnection *bus;
    struct TrayItem *items;
    struct Request *requests;
    uint32_t next_id, revision;
    bool changed, failed;
    char error[256];
    struct {
        uint32_t item, revision;
        bool pending, dirty;
        int32_t root;
        char path[257], error[256];
        struct PuBusMenu data;
    } menu;
} tray;

static void begin_menu(struct TrayItem *item, int32_t root);
static uint32_t advance(uint32_t *revision)
{ if (!++*revision) ++*revision; return *revision; }
static void fail(const char *message)
{
    if (!tray.failed) {
        tray.failed = tray.changed = true;
        snprintf(tray.error, sizeof(tray.error), "%s", message);
        fprintf(stderr, "[tray] %s\n", message);
    }
}
static bool send_message(DBusMessage *message)
{
    if (!message) { fail("Cannot allocate tray message"); return false; }
    bool ok = dbus_connection_get_outgoing_size(tray.bus) <= 2 * 1024 * 1024 &&
        dbus_connection_send(tray.bus, message, NULL);
    dbus_message_unref(message);
    if (!ok) fail("Cannot queue tray message");
    return ok;
}
static DBusHandlerResult error_reply(DBusMessage *request, const char *name, const char *text)
{
    send_message(dbus_message_new_error(request, name, text));
    return DBUS_HANDLER_RESULT_HANDLED;
}
static void free_request(struct Request *request)
{
    if (request->pending) { dbus_pending_call_cancel(request->pending); dbus_pending_call_unref(request->pending); }
    if (request->registration) dbus_message_unref(request->registration);
    free(request->service); free(request);
}
static struct Request *request(enum RequestType type, uint32_t id, DBusMessage *message)
{
    if (!message) { fail("Cannot allocate tray request"); return NULL; }
    unsigned count = 0;
    for (struct Request *item = tray.requests; item; item = item->next) count++;
    if (count >= 128) { dbus_message_unref(message); fail("Tray request queue exceeds supported limits"); return NULL; }
    struct Request *entry = calloc(1, sizeof(*entry));
    if (!entry || !dbus_connection_send_with_reply(tray.bus, message, entry ? &entry->pending : NULL, 2000) || !entry->pending) {
        free(entry); dbus_message_unref(message); fail("Cannot send asynchronous tray request"); return NULL;
    }
    dbus_message_unref(message);
    entry->type = type; entry->item = id; entry->deadline = pu_now_ms() + 2000;
    entry->next = tray.requests; tray.requests = entry;
    return entry;
}
static struct TrayItem *find_item(uint32_t id)
{
    for (struct TrayItem *item = tray.items; item; item = item->next) if (item->id == id) return item;
    return NULL;
}
static void emit(const char *signal, const char *key)
{
    const char *interfaces[] = { KDE_WATCHER, FDO_WATCHER };
    for (size_t i = 0; i < 2; i++) {
        DBusMessage *message = dbus_message_new_signal(WATCHER_PATH, interfaces[i], signal);
        if (message && key && !dbus_message_append_args(message, DBUS_TYPE_STRING, &key, DBUS_TYPE_INVALID)) {
            dbus_message_unref(message); message = NULL;
        }
        send_message(message);
    }
}
static void item_error(struct TrayItem *item, const char *message)
{
    if (!strcmp(item->data.error, message)) return;
    snprintf(item->data.error, sizeof(item->data.error), "%s", message);
    fprintf(stderr, "[tray] Item %u: %s\n", item->id, message);
    item->revision = advance(&tray.revision);
    tray.changed = true;
}
static void refresh_item(struct TrayItem *item)
{
    if (item->refreshing) { item->dirty = true; return; }
    DBusMessage *message = dbus_message_new_method_call(item->owner, item->path, DBUS_INTERFACE_PROPERTIES, "GetAll");
    if (message && !dbus_message_append_args(message, DBUS_TYPE_STRING, &item->interface, DBUS_TYPE_INVALID)) {
        dbus_message_unref(message); message = NULL;
    }
    if (request(REFRESH_ITEM, item->id, message)) { item->refreshing = true; item->dirty = false; }
}
static void remove_item(struct TrayItem **slot)
{
    struct TrayItem *item = *slot;
    if (tray.menu.item == item->id) {
        tray.menu.item = 0; advance(&tray.menu.revision); tray.menu.pending = false; tray.menu.data.count = 0;
    }
    *slot = item->next;
    struct Request **at = &tray.requests;
    while (*at) {
        if ((*at)->item == item->id) {
            struct Request *old = *at; *at = old->next; free_request(old);
        } else at = &(*at)->next;
    }
    if (!tray.failed) emit("StatusNotifierItemUnregistered", item->key);
    pu_image_remove(item->icon);
    free(item->owner); free(item->service); free(item->path); free(item->key); free(item);
    tray.changed = true;
}
static DBusHandlerResult register_item(DBusMessage *registration, const char *service, const char *owner, const char *path)
{
    size_t count = 0, owned = 0;
    for (struct TrayItem *item = tray.items; item; item = item->next) {
        if (!strcmp(item->owner, owner) && !strcmp(item->path, path)) {
            send_message(dbus_message_new_method_return(registration)); refresh_item(item);
            return DBUS_HANDLER_RESULT_HANDLED;
        }
        count++; if (!strcmp(item->owner, owner)) owned++;
    }
    if (count >= MAX_TRAY_ITEMS || owned >= 8)
        return error_reply(registration, DBUS_ERROR_LIMITS_EXCEEDED, "Tray registration limit reached");
    struct TrayItem *item = calloc(1, sizeof(*item));
    if (!item) return DBUS_HANDLER_RESULT_NEED_MEMORY;
    item->owner = strdup(owner); item->service = strdup(service); item->path = strdup(path);
    size_t length = strlen(service) + strlen(path) + 1;
    item->key = malloc(length);
    if (!item->owner || !item->service || !item->path || !item->key) {
        free(item->owner); free(item->service); free(item->path); free(item->key); free(item);
        return DBUS_HANDLER_RESULT_NEED_MEMORY;
    }
    snprintf(item->key, length, "%s%s", service, path);
    do { item->id = ++tray.next_id; } while (!item->id || find_item(item->id));
    item->revision = advance(&tray.revision); item->interface = KDE_ITEM;
    snprintf(item->icon, sizeof(item->icon), "polly-memory:tray-%u", item->id);
    item->next = tray.items; tray.items = item;
    send_message(dbus_message_new_method_return(registration));
    emit("StatusNotifierItemRegistered", item->key);
    refresh_item(item);
    tray.changed = true;
    return DBUS_HANDLER_RESULT_HANDLED;
}
static bool property(DBusMessageIter *output, const char *name)
{
    const char *signature = !strcmp(name, "RegisteredStatusNotifierItems") ? "as" :
        !strcmp(name, "IsStatusNotifierHostRegistered") ? "b" : !strcmp(name, "ProtocolVersion") ? "i" : NULL;
    if (!signature) return false;
    DBusMessageIter variant;
    if (!dbus_message_iter_open_container(output, DBUS_TYPE_VARIANT, signature, &variant)) return false;
    bool ok = true;
    if (!strcmp(signature, "as")) {
        DBusMessageIter array;
        ok = dbus_message_iter_open_container(&variant, DBUS_TYPE_ARRAY, "s", &array);
        for (struct TrayItem *item = tray.items; ok && item; item = item->next)
            ok = dbus_message_iter_append_basic(&array, DBUS_TYPE_STRING, &item->key);
        if (ok) ok = dbus_message_iter_close_container(&variant, &array);
    } else if (!strcmp(signature, "b")) {
        dbus_bool_t registered = true;
        ok = dbus_message_iter_append_basic(&variant, DBUS_TYPE_BOOLEAN, &registered);
    } else {
        int32_t version = 0;
        ok = dbus_message_iter_append_basic(&variant, DBUS_TYPE_INT32, &version);
    }
    return ok && dbus_message_iter_close_container(output, &variant);
}
static bool watcher_interface(const char *interface)
{ return interface && (!strcmp(interface, KDE_WATCHER) || !strcmp(interface, FDO_WATCHER)); }
static const char introspection[] =
    "<node><interface name='org.kde.StatusNotifierWatcher'>"
    "<method name='RegisterStatusNotifierItem'><arg direction='in' type='s'/></method>"
    "<method name='RegisterStatusNotifierHost'><arg direction='in' type='s'/></method>"
    "<property name='RegisteredStatusNotifierItems' type='as' access='read'/>"
    "<property name='IsStatusNotifierHostRegistered' type='b' access='read'/>"
    "<property name='ProtocolVersion' type='i' access='read'/>"
    "<signal name='StatusNotifierItemRegistered'><arg type='s'/></signal>"
    "<signal name='StatusNotifierItemUnregistered'><arg type='s'/></signal>"
    "<signal name='StatusNotifierHostRegistered'/></interface>"
    "<interface name='org.freedesktop.StatusNotifierWatcher'>"
    "<method name='RegisterStatusNotifierItem'><arg direction='in' type='s'/></method>"
    "<method name='RegisterStatusNotifierHost'><arg direction='in' type='s'/></method>"
    "<property name='RegisteredStatusNotifierItems' type='as' access='read'/>"
    "<property name='IsStatusNotifierHostRegistered' type='b' access='read'/>"
    "<property name='ProtocolVersion' type='i' access='read'/>"
    "<signal name='StatusNotifierItemRegistered'><arg type='s'/></signal>"
    "<signal name='StatusNotifierItemUnregistered'><arg type='s'/></signal>"
    "<signal name='StatusNotifierHostRegistered'/></interface>"
    "<interface name='org.freedesktop.DBus.Properties'>"
    "<method name='Get'><arg direction='in' type='s'/><arg direction='in' type='s'/><arg direction='out' type='v'/></method>"
    "<method name='GetAll'><arg direction='in' type='s'/><arg direction='out' type='a{sv}'/></method></interface>"
    "<interface name='org.freedesktop.DBus.Introspectable'><method name='Introspect'><arg direction='out' type='s'/></method></interface></node>";
static DBusHandlerResult method(DBusConnection *connection, DBusMessage *message, void *data)
{
    (void)connection; (void)data;
    if (dbus_message_get_type(message) != DBUS_MESSAGE_TYPE_METHOD_CALL) return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
    if (tray.failed) return error_reply(message, DBUS_ERROR_FAILED, tray.error);
    const char *interface = dbus_message_get_interface(message), *member = dbus_message_get_member(message);
    bool host = watcher_interface(interface) && !strcmp(member, "RegisterStatusNotifierHost");
    if (host || (watcher_interface(interface) && !strcmp(member, "RegisterStatusNotifierItem"))) {
        const char *service;
        if (!dbus_message_get_args(message, NULL, DBUS_TYPE_STRING, &service, DBUS_TYPE_INVALID) ||
            !*service || strlen(service) > 255)
            return error_reply(message, DBUS_ERROR_INVALID_ARGS, "Invalid tray service or object path");
        const char *sender = dbus_message_get_sender(message);
        if (service[0] == '/') {
            if (host || !dbus_validate_path(service, NULL))
                return error_reply(message, DBUS_ERROR_INVALID_ARGS, "Invalid tray object path");
            return register_item(message, sender, sender, service);
        }
        if (!dbus_validate_bus_name(service, NULL))
            return error_reply(message, DBUS_ERROR_INVALID_ARGS, "Invalid tray service name");
        unsigned owned_pending = 0, total_pending = 0;
        for (struct Request *pending = tray.requests; pending; pending = pending->next) {
            total_pending++;
            if (pending->registration && dbus_message_has_sender(pending->registration, sender)) owned_pending++;
        }
        if (owned_pending >= 8 || total_pending >= 96)
            return error_reply(message, DBUS_ERROR_LIMITS_EXCEEDED, "Tray registration queue is full");
        DBusMessage *query = dbus_message_new_method_call(DBUS_SERVICE_DBUS, DBUS_PATH_DBUS, DBUS_INTERFACE_DBUS, "GetNameOwner");
        if (query && !dbus_message_append_args(query, DBUS_TYPE_STRING, &service, DBUS_TYPE_INVALID)) {
            dbus_message_unref(query); query = NULL;
        }
        struct Request *pending = request(host ? RESOLVE_HOST : RESOLVE_ITEM, 0, query);
        if (!pending) return DBUS_HANDLER_RESULT_NEED_MEMORY;
        pending->registration = dbus_message_ref(message); pending->service = strdup(service);
        if (!pending->service) { fail("Cannot retain tray registration name"); return DBUS_HANDLER_RESULT_NEED_MEMORY; }
        return DBUS_HANDLER_RESULT_HANDLED;
    }
    DBusMessage *reply = NULL;
    if (dbus_message_is_method_call(message, DBUS_INTERFACE_PROPERTIES, "Get") ||
        dbus_message_is_method_call(message, DBUS_INTERFACE_PROPERTIES, "GetAll")) {
        const char *target, *name = NULL;
        bool all = !strcmp(member, "GetAll");
        bool valid = all ? dbus_message_get_args(message, NULL, DBUS_TYPE_STRING, &target, DBUS_TYPE_INVALID) :
            dbus_message_get_args(message, NULL, DBUS_TYPE_STRING, &target, DBUS_TYPE_STRING, &name, DBUS_TYPE_INVALID);
        if (!valid || !watcher_interface(target)) return error_reply(message, DBUS_ERROR_INVALID_ARGS, "Unknown watcher interface");
        reply = dbus_message_new_method_return(message);
        if (!reply) return DBUS_HANDLER_RESULT_NEED_MEMORY;
        DBusMessageIter root;
        dbus_message_iter_init_append(reply, &root);
        if (all) {
            DBusMessageIter array;
            bool ok = dbus_message_iter_open_container(&root, DBUS_TYPE_ARRAY, "{sv}", &array);
            const char *names[] = { "RegisteredStatusNotifierItems", "IsStatusNotifierHostRegistered", "ProtocolVersion" };
            for (size_t i = 0; ok && i < 3; i++) {
                DBusMessageIter entry;
                ok = dbus_message_iter_open_container(&array, DBUS_TYPE_DICT_ENTRY, NULL, &entry) &&
                    dbus_message_iter_append_basic(&entry, DBUS_TYPE_STRING, &names[i]) &&
                    property(&entry, names[i]) && dbus_message_iter_close_container(&array, &entry);
            }
            if (!ok || !dbus_message_iter_close_container(&root, &array)) {
                dbus_message_unref(reply); return DBUS_HANDLER_RESULT_NEED_MEMORY;
            }
        } else if (!property(&root, name)) {
            dbus_message_unref(reply); return error_reply(message, DBUS_ERROR_UNKNOWN_PROPERTY, "Unknown watcher property");
        }
    } else if (dbus_message_is_method_call(message, DBUS_INTERFACE_INTROSPECTABLE, "Introspect") &&
        dbus_message_has_signature(message, "")) {
        reply = dbus_message_new_method_return(message);
        const char *xml = introspection;
        if (reply && !dbus_message_append_args(reply, DBUS_TYPE_STRING, &xml, DBUS_TYPE_INVALID)) {
            dbus_message_unref(reply); reply = NULL;
        }
    } else return error_reply(message, DBUS_ERROR_UNKNOWN_METHOD, "Unsupported watcher method");
    return send_message(reply) ? DBUS_HANDLER_RESULT_HANDLED : DBUS_HANDLER_RESULT_NEED_MEMORY;
}
static DBusHandlerResult filter(DBusConnection *connection, DBusMessage *message, void *data)
{
    (void)connection; (void)data;
    if (dbus_message_is_signal(message, DBUS_INTERFACE_DBUS, "NameOwnerChanged") &&
        dbus_message_has_sender(message, DBUS_SERVICE_DBUS)) {
        const char *name, *old, *owner;
        if (dbus_message_get_args(message, NULL, DBUS_TYPE_STRING, &name, DBUS_TYPE_STRING, &old,
            DBUS_TYPE_STRING, &owner, DBUS_TYPE_INVALID)) {
            struct Request **pending = &tray.requests;
            while (*pending) {
                struct Request *entry = *pending;
                if ((entry->type == RESOLVE_ITEM || entry->type == RESOLVE_HOST) && strcmp(old, owner) &&
                    (dbus_message_has_sender(entry->registration, name) ||
                     (entry->service && !strcmp(entry->service, name)))) {
                    *pending = entry->next;
                    error_reply(entry->registration, DBUS_ERROR_NAME_HAS_NO_OWNER, "Tray owner changed during registration");
                    free_request(entry);
                } else pending = &entry->next;
            }
            struct TrayItem **slot = &tray.items;
            while (*slot) {
                if ((!strcmp((*slot)->owner, name) || !strcmp((*slot)->service, name)) && strcmp((*slot)->owner, owner))
                    remove_item(slot);
                else slot = &(*slot)->next;
            }
        }
    } else if (dbus_message_get_type(message) == DBUS_MESSAGE_TYPE_SIGNAL) {
        const char *sender = dbus_message_get_sender(message), *path = dbus_message_get_path(message);
        if (sender && path) for (struct TrayItem *item = tray.items; item; item = item->next) {
            if (!strcmp(item->owner, sender) && !strcmp(item->path, path) &&
                (dbus_message_has_interface(message, KDE_ITEM) || dbus_message_has_interface(message, FDO_ITEM) ||
                dbus_message_has_interface(message, DBUS_INTERFACE_PROPERTIES))) refresh_item(item);
            if (tray.menu.item == item->id && !strcmp(item->owner, sender) && !strcmp(tray.menu.path, path) &&
                (dbus_message_is_signal(message, "com.canonical.dbusmenu", "LayoutUpdated") ||
                dbus_message_is_signal(message, "com.canonical.dbusmenu", "ItemsPropertiesUpdated"))) {
                if (tray.menu.pending) tray.menu.dirty = true;
                else begin_menu(item, tray.menu.root);
            }
        }
    }
    return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
}
static bool text_property(DBusMessageIter *value, char *out, size_t capacity, int type)
{
    if (dbus_message_iter_get_arg_type(value) != type) return false;
    const char *text; dbus_message_iter_get_basic(value, &text);
    if (strlen(text) >= capacity) return false;
    strcpy(out, text); return true;
}
static bool pixmap_property(DBusMessageIter *value, const unsigned char **pixels, int *width, int *height)
{
    char *signature = dbus_message_iter_get_signature(value);
    bool valid = signature && !strcmp(signature, "a(iiay)");
    dbus_free(signature);
    if (!valid) return false;
    DBusMessageIter array;
    dbus_message_iter_recurse(value, &array);
    unsigned count = 0;
    int distance = INT_MAX;
    while (dbus_message_iter_get_arg_type(&array) != DBUS_TYPE_INVALID) {
        if (++count > 16) return false;
        DBusMessageIter tuple, bytes;
        int32_t w, h; int length; const unsigned char *data;
        dbus_message_iter_recurse(&array, &tuple);
        dbus_message_iter_get_basic(&tuple, &w); dbus_message_iter_next(&tuple);
        dbus_message_iter_get_basic(&tuple, &h); dbus_message_iter_next(&tuple);
        dbus_message_iter_recurse(&tuple, &bytes);
        dbus_message_iter_get_fixed_array(&bytes, &data, &length);
        if (w < 1 || h < 1 || w > 256 || h > 256 || length != w * h * 4) return false;
        int next = abs(w - 24) + abs(h - 24);
        if (next < distance) { *pixels = data; *width = w; *height = h; distance = next; }
        dbus_message_iter_next(&array);
    }
    return true;
}
static bool update_item(struct TrayItem *item, DBusMessage *reply)
{
    if (!dbus_message_has_signature(reply, "a{sv}")) return false;
    struct TrayData pending = {0};
    strcpy(pending.status, "Active");
    const unsigned char *pixels = NULL, *attention = NULL;
    int width = 0, height = 0, attention_width = 0, attention_height = 0;
    DBusMessageIter root, properties;
    dbus_message_iter_init(reply, &root); dbus_message_iter_recurse(&root, &properties);
    unsigned count = 0;
    bool has_id = false, has_status = false;
    while (dbus_message_iter_get_arg_type(&properties) != DBUS_TYPE_INVALID) {
        if (++count > 64) return false;
        DBusMessageIter entry, value;
        dbus_message_iter_recurse(&properties, &entry);
        const char *name; dbus_message_iter_get_basic(&entry, &name); dbus_message_iter_next(&entry);
        dbus_message_iter_recurse(&entry, &value);
        bool ok = true;
        if (!strcmp(name, "Id")) { ok = text_property(&value, pending.name, sizeof(pending.name), DBUS_TYPE_STRING); has_id = ok; }
        else if (!strcmp(name, "Title")) ok = text_property(&value, pending.title, sizeof(pending.title), DBUS_TYPE_STRING);
        else if (!strcmp(name, "Status")) { ok = text_property(&value, pending.status, sizeof(pending.status), DBUS_TYPE_STRING); has_status = ok; }
        else if (!strcmp(name, "Menu")) ok = text_property(&value, pending.menu, sizeof(pending.menu), DBUS_TYPE_OBJECT_PATH);
        else if (!strcmp(name, "IconName")) ok = text_property(&value, pending.icon_name, sizeof(pending.icon_name), DBUS_TYPE_STRING);
        else if (!strcmp(name, "IconPixmap")) ok = pixmap_property(&value, &pixels, &width, &height);
        else if (!strcmp(name, "AttentionIconPixmap")) ok = pixmap_property(&value, &attention, &attention_width, &attention_height);
        else if (!strcmp(name, "ItemIsMenu")) {
            ok = dbus_message_iter_get_arg_type(&value) == DBUS_TYPE_BOOLEAN;
            if (ok) { dbus_bool_t boolean; dbus_message_iter_get_basic(&value, &boolean); pending.menu_only = boolean; }
        }
        if (!ok) return false;
        dbus_message_iter_next(&properties);
    }
    if (!has_id || !has_status || !*pending.name ||
        (strcmp(pending.status, "Active") && strcmp(pending.status, "Passive") && strcmp(pending.status, "NeedsAttention")))
        return false;
    if (!strcmp(pending.status, "NeedsAttention") && attention) {
        pixels = attention; width = attention_width; height = attention_height;
    }
    if (pixels) {
        if (!pu_image_set_argb(item->icon, width, height, pixels, (size_t)width * (size_t)height * 4)) return false;
        pending.icon = true;
    } else pu_image_remove(item->icon);
    if (tray.menu.item == item->id && strcmp(tray.menu.path, pending.menu)) {
        tray.menu.item = 0; advance(&tray.menu.revision); tray.menu.pending = false; tray.menu.data.count = 0;
    }
    item->data = pending;
    item->revision = advance(&tray.revision); item->ready = true; tray.changed = true;
    return true;
}
static void menu_error(const char *error)
{
    tray.menu.pending = false; tray.menu.dirty = false;
    tray.menu.data.count = 0;
    snprintf(tray.menu.error, sizeof(tray.menu.error), "%s", error);
    tray.changed = true;
    fprintf(stderr, "[tray] %s\n", error);
}
static void fetch_menu(struct TrayItem *item)
{
    DBusMessage *message = dbus_message_new_method_call(item->owner, tray.menu.path, "com.canonical.dbusmenu", "GetLayout");
    int32_t depth = 1;
    const char *names[] = { "type", "label", "enabled", "visible", "toggle-type", "toggle-state", "children-display" };
    const char **properties = names;
    if (message && !dbus_message_append_args(message, DBUS_TYPE_INT32, &tray.menu.root, DBUS_TYPE_INT32, &depth,
        DBUS_TYPE_ARRAY, DBUS_TYPE_STRING, &properties, 7, DBUS_TYPE_INVALID)) {
        dbus_message_unref(message); message = NULL;
    }
    struct Request *pending = request(MENU_LAYOUT, item->id, message);
    if (pending) pending->menu_revision = tray.menu.revision;
}
static void begin_menu(struct TrayItem *item, int32_t root)
{
    tray.menu.item = item->id; tray.menu.root = root; advance(&tray.menu.revision);
    tray.menu.pending = true; tray.menu.dirty = false; tray.menu.error[0] = 0; tray.menu.data.count = 0;
    strcpy(tray.menu.path, item->data.menu);
    tray.changed = true;
    DBusMessage *message = dbus_message_new_method_call(item->owner, tray.menu.path, "com.canonical.dbusmenu", "AboutToShow");
    if (message && !dbus_message_append_args(message, DBUS_TYPE_INT32, &root, DBUS_TYPE_INVALID)) {
        dbus_message_unref(message); message = NULL;
    }
    struct Request *pending = request(MENU_SHOW, item->id, message);
    if (pending) pending->menu_revision = tray.menu.revision;
}
static void finished(struct Request *pending, DBusMessage *reply)
{
    bool error = !reply || dbus_message_get_type(reply) == DBUS_MESSAGE_TYPE_ERROR;
    if (pending->type == RESOLVE_ITEM || pending->type == RESOLVE_HOST) {
        const char *owner = NULL;
        if (error || !dbus_message_get_args(reply, NULL, DBUS_TYPE_STRING, &owner, DBUS_TYPE_INVALID) ||
            strcmp(owner, dbus_message_get_sender(pending->registration)))
            error_reply(pending->registration, DBUS_ERROR_ACCESS_DENIED, "Only the service owner may register a tray item");
        else if (pending->type == RESOLVE_HOST) {
            send_message(dbus_message_new_method_return(pending->registration));
            emit("StatusNotifierHostRegistered", NULL);
        } else register_item(pending->registration, pending->service, owner, "/StatusNotifierItem");
        return;
    }
    struct TrayItem *item = find_item(pending->item);
    if (!item) return;
    if (pending->type == MENU_SHOW || pending->type == MENU_LAYOUT) {
        if (tray.menu.item != item->id || tray.menu.revision != pending->menu_revision) return;
        if (pending->type == MENU_SHOW) {
            if (error && (!reply || !dbus_message_is_error(reply, DBUS_ERROR_UNKNOWN_METHOD))) {
                menu_error("Tray menu preparation failed or timed out"); return;
            }
            if (!error && !dbus_message_has_signature(reply, "b")) {
                menu_error("Tray menu preparation returned an invalid reply"); return;
            }
            fetch_menu(item); return;
        }
        if (error || !pu_bus_menu_parse(reply, tray.menu.root, &tray.menu.data)) {
            menu_error(error ? "Tray menu request failed or timed out" : "Tray menu returned an invalid or oversized layout"); return;
        }
        if (tray.menu.dirty) begin_menu(item, tray.menu.root);
        else { tray.menu.pending = false; tray.changed = true; }
        return;
    }
    if (pending->type == REFRESH_ITEM) {
        item->refreshing = false;
        if (!error && !strcmp(item->interface, KDE_ITEM) && dbus_message_has_signature(reply, "a{sv}")) {
            DBusMessageIter root, properties;
            dbus_message_iter_init(reply, &root); dbus_message_iter_recurse(&root, &properties);
            if (dbus_message_iter_get_arg_type(&properties) == DBUS_TYPE_INVALID) {
                item->interface = FDO_ITEM; refresh_item(item); return;
            }
        }
        if (error && !strcmp(item->interface, KDE_ITEM) && reply &&
            (dbus_message_is_error(reply, DBUS_ERROR_UNKNOWN_INTERFACE) ||
             dbus_message_is_error(reply, DBUS_ERROR_UNKNOWN_METHOD) || dbus_message_is_error(reply, DBUS_ERROR_INVALID_ARGS))) {
            item->interface = FDO_ITEM; refresh_item(item); return;
        }
        if (error || !update_item(item, reply)) item_error(item, error ?
            "Tray item properties request failed or timed out" : "Tray item returned invalid or oversized properties");
        if (item->dirty) refresh_item(item);
    } else if (error) item_error(item, "Tray item action failed or timed out");
}
static const DBusObjectPathVTable watcher = { .message_function = method };
static void stop(void)
{
    tray.failed = true;
    while (tray.requests) { struct Request *next = tray.requests->next; free_request(tray.requests); tray.requests = next; }
    while (tray.items) remove_item(&tray.items);
    if (tray.bus) {
        dbus_connection_remove_filter(tray.bus, filter, NULL);
        dbus_connection_unregister_object_path(tray.bus, WATCHER_PATH);
        dbus_connection_close(tray.bus); dbus_connection_unref(tray.bus); tray.bus = NULL;
    }
    tray.failed = tray.changed = false; tray.error[0] = 0;
    tray.menu.item = 0; advance(&tray.menu.revision); tray.menu.pending = false; tray.menu.data.count = 0;
}
static JSValue start(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!pu_desktop_windows_ready(ctx)) return JS_EXCEPTION;
    if (tray.bus) return tray.failed ? JS_ThrowInternalError(ctx, "%s", tray.error) : JS_UNDEFINED;
    char error[256];
    tray.bus = pu_session_bus_connect(error, sizeof(error));
    if (!tray.bus) return JS_ThrowInternalError(ctx, "%s", error);
    dbus_connection_set_max_message_size(tray.bus, 1024 * 1024);
    if (!dbus_connection_register_object_path(tray.bus, WATCHER_PATH, &watcher, NULL) ||
        !dbus_connection_add_filter(tray.bus, filter, NULL, NULL)) { stop(); return JS_ThrowOutOfMemory(ctx); }
    DBusError failure = DBUS_ERROR_INIT;
    const char *names[] = { KDE_WATCHER, FDO_WATCHER };
    for (size_t i = 0; i < 2; i++)
        if (dbus_bus_request_name(tray.bus, names[i], DBUS_NAME_FLAG_DO_NOT_QUEUE, &failure) != DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER) {
            snprintf(error, sizeof(error), "%s", failure.message ? failure.message : "Another tray watcher owns the session name");
            dbus_error_free(&failure); stop(); return JS_ThrowInternalError(ctx, "%s", error);
        }
    const char *matches[] = {
        "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged'",
        "type='signal',interface='" KDE_ITEM "'",
        "type='signal',interface='" FDO_ITEM "'",
        "type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'",
        "type='signal',interface='com.canonical.dbusmenu',member='LayoutUpdated'",
        "type='signal',interface='com.canonical.dbusmenu',member='ItemsPropertiesUpdated'",
    };
    for (size_t i = 0; i < sizeof(matches) / sizeof(matches[0]); i++) {
        dbus_bus_add_match(tray.bus, matches[i], &failure);
        if (dbus_error_is_set(&failure)) {
            snprintf(error, sizeof(error), "%s", failure.message);
            dbus_error_free(&failure); stop(); return JS_ThrowInternalError(ctx, "%s", error);
        }
    }
    emit("StatusNotifierHostRegistered", NULL);
    tray.changed = true;
    return JS_UNDEFINED;
}
static JSValue stop_server(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{ (void)ctx; (void)self; (void)argc; (void)argv; stop(); return JS_UNDEFINED; }
static int ready(JSContext *ctx)
{
    if (!tray.bus || tray.failed) {
        JS_ThrowInternalError(ctx, "%s", tray.failed ? tray.error : "Tray watcher is not started"); return 0;
    }
    return 1;
}
static JSValue snapshot(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ready(ctx)) return JS_EXCEPTION;
    JSValue result = JS_NewArray(ctx);
    if (JS_IsException(result)) return result;
    uint32_t index = 0;
    for (struct TrayItem *item = tray.items; item && !JS_HasException(ctx); item = item->next) {
        if (!item->ready && !item->data.error[0]) continue;
        JSValue value = JS_NewObject(ctx);
        if (JS_IsException(value)) break;
        JS_SetPropertyStr(ctx, value, "id", JS_NewUint32(ctx, item->id));
        JS_SetPropertyStr(ctx, value, "revision", JS_NewUint32(ctx, item->revision));
        JS_SetPropertyStr(ctx, value, "title", JS_NewString(ctx, item->data.title[0] ? item->data.title :
            item->data.name[0] ? item->data.name : item->service));
        JS_SetPropertyStr(ctx, value, "status", JS_NewString(ctx, item->data.status));
        JS_SetPropertyStr(ctx, value, "icon", item->data.icon ? JS_NewString(ctx, item->icon) : JS_NULL);
        JS_SetPropertyStr(ctx, value, "iconName", JS_NewString(ctx, item->data.icon_name));
        JS_SetPropertyStr(ctx, value, "menu", JS_NewString(ctx, item->data.menu));
        JS_SetPropertyStr(ctx, value, "menuOnly", JS_NewBool(ctx, item->data.menu_only));
        JS_SetPropertyStr(ctx, value, "error", JS_NewString(ctx, item->data.error));
        JS_SetPropertyUint32(ctx, result, index++, value);
    }
    if (JS_HasException(ctx)) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    return result;
}
static bool number(JSContext *ctx, JSValueConst value, int64_t minimum, int64_t maximum, int64_t *out)
{
    double parsed;
    if (!JS_IsNumber(value) || JS_ToFloat64(ctx, &parsed, value) < 0 ||
        !isfinite(parsed) || floor(parsed) != parsed || parsed < minimum || parsed > maximum) return false;
    *out = (int64_t)parsed; return true;
}
static JSValue action(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!ready(ctx)) return JS_EXCEPTION;
    int64_t id, revision, x, y;
    if (argc != 5 || !number(ctx, argv[0], 1, UINT32_MAX, &id) || !number(ctx, argv[1], 1, UINT32_MAX, &revision) ||
        !JS_IsString(argv[2]) || !number(ctx, argv[3], INT32_MIN, INT32_MAX, &x) || !number(ctx, argv[4], INT32_MIN, INT32_MAX, &y))
        return JS_ThrowTypeError(ctx, "Tray action requires ID, revision, kind and coordinates");
    struct TrayItem *item = find_item((uint32_t)id);
    if (!item || item->revision != (uint32_t)revision || !item->ready)
        return JS_ThrowTypeError(ctx, "Stale or unavailable tray item");
    size_t length;
    const char *kind = JS_ToCStringLen(ctx, &length, argv[2]);
    if (!kind) return JS_EXCEPTION;
    const char *member = !strcmp(kind, "activate") ? "Activate" : !strcmp(kind, "secondary") ? "SecondaryActivate" :
        !strcmp(kind, "menu") ? "ContextMenu" : NULL;
    bool valid = member && strlen(kind) == length;
    JS_FreeCString(ctx, kind);
    if (!valid) return JS_ThrowTypeError(ctx, "Unknown tray action");
    if (item->data.menu_only && !strcmp(member, "Activate")) member = "ContextMenu";
    DBusMessage *message = dbus_message_new_method_call(item->owner, item->path, item->interface, member);
    int32_t px = (int32_t)x, py = (int32_t)y;
    if (message && !dbus_message_append_args(message, DBUS_TYPE_INT32, &px, DBUS_TYPE_INT32, &py, DBUS_TYPE_INVALID)) {
        dbus_message_unref(message); message = NULL;
    }
    if (!request(ITEM_ACTION, item->id, message)) return JS_ThrowInternalError(ctx, "%s", tray.error);
    return JS_UNDEFINED;
}
static JSValue scroll_item(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!ready(ctx)) return JS_EXCEPTION;
    int64_t id, revision, delta;
    if (argc != 4 || !number(ctx, argv[0], 1, UINT32_MAX, &id) || !number(ctx, argv[1], 1, UINT32_MAX, &revision) ||
        !number(ctx, argv[2], INT32_MIN, INT32_MAX, &delta) || !JS_IsBool(argv[3]))
        return JS_ThrowTypeError(ctx, "Tray scroll requires ID, revision, delta and horizontal boolean");
    struct TrayItem *item = find_item((uint32_t)id);
    if (!item || item->revision != (uint32_t)revision || !item->ready) return JS_ThrowTypeError(ctx, "Stale tray scroll");
    const char *orientation = JS_ToBool(ctx, argv[3]) ? "horizontal" : "vertical";
    int32_t amount = (int32_t)delta;
    DBusMessage *message = dbus_message_new_method_call(item->owner, item->path, item->interface, "Scroll");
    if (message && !dbus_message_append_args(message, DBUS_TYPE_INT32, &amount, DBUS_TYPE_STRING, &orientation, DBUS_TYPE_INVALID)) {
        dbus_message_unref(message); message = NULL;
    }
    if (!request(ITEM_ACTION, item->id, message)) return JS_ThrowInternalError(ctx, "%s", tray.error);
    return JS_UNDEFINED;
}
static JSValue open_menu(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!ready(ctx)) return JS_EXCEPTION;
    int64_t id, revision, root;
    if (argc != 3 || !number(ctx, argv[0], 1, UINT32_MAX, &id) ||
        !number(ctx, argv[1], 1, UINT32_MAX, &revision) || !number(ctx, argv[2], 0, INT32_MAX, &root))
        return JS_ThrowTypeError(ctx, "Tray menu requires item ID, revision and root ID");
    struct TrayItem *item = find_item((uint32_t)id);
    if (!item || item->revision != (uint32_t)revision || !item->ready || !item->data.menu[0] || !strcmp(item->data.menu, "/"))
        return JS_ThrowTypeError(ctx, "Tray item has no current exported menu");
    if (root) {
        bool found = false;
        if (tray.menu.item == item->id && !tray.menu.pending && !tray.menu.error[0])
            for (unsigned i = 0; i < tray.menu.data.count; i++) {
                struct PuBusMenuItem *entry = &tray.menu.data.items[i];
                if (entry->id == root && entry->parent == tray.menu.root && entry->submenu && entry->enabled && entry->visible)
                    found = true;
            }
        if (!found) return JS_ThrowTypeError(ctx, "Unknown or disabled tray submenu");
    }
    begin_menu(item, (int32_t)root);
    return tray.failed ? JS_ThrowInternalError(ctx, "%s", tray.error) : JS_UNDEFINED;
}
static JSValue close_menu(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)ctx; (void)self; (void)argc; (void)argv;
    tray.menu.item = 0; advance(&tray.menu.revision); tray.menu.pending = false;
    tray.menu.data.count = 0; tray.changed = true;
    return JS_UNDEFINED;
}
static JSValue menu_snapshot(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!ready(ctx)) return JS_EXCEPTION;
    JSValue result = JS_NewObject(ctx), items = JS_NewArray(ctx);
    if (JS_IsException(result) || JS_IsException(items)) {
        JS_FreeValue(ctx, result); JS_FreeValue(ctx, items); return JS_EXCEPTION;
    }
    JS_SetPropertyStr(ctx, result, "itemId", JS_NewUint32(ctx, tray.menu.item));
    JS_SetPropertyStr(ctx, result, "revision", JS_NewUint32(ctx, tray.menu.revision));
    JS_SetPropertyStr(ctx, result, "root", JS_NewInt32(ctx, tray.menu.root));
    JS_SetPropertyStr(ctx, result, "pending", JS_NewBool(ctx, tray.menu.pending));
    JS_SetPropertyStr(ctx, result, "error", JS_NewString(ctx, tray.menu.error));
    unsigned at = 0;
    for (unsigned i = 0; tray.menu.item && !tray.menu.pending && !JS_HasException(ctx) && i < tray.menu.data.count; i++) {
        struct PuBusMenuItem *entry = &tray.menu.data.items[i];
        if (entry->parent != tray.menu.root || !entry->visible) continue;
        JSValue item = JS_NewObject(ctx);
        if (JS_IsException(item)) break;
        JS_SetPropertyStr(ctx, item, "id", JS_NewInt32(ctx, entry->id));
        JS_SetPropertyStr(ctx, item, "label", JS_NewString(ctx, entry->label));
        JS_SetPropertyStr(ctx, item, "enabled", JS_NewBool(ctx, entry->enabled));
        JS_SetPropertyStr(ctx, item, "separator", JS_NewBool(ctx, entry->separator));
        JS_SetPropertyStr(ctx, item, "submenu", JS_NewBool(ctx, entry->submenu));
        JS_SetPropertyStr(ctx, item, "toggle", JS_NewString(ctx, entry->toggle));
        JS_SetPropertyStr(ctx, item, "toggleState", JS_NewInt32(ctx, entry->toggle_state));
        JS_SetPropertyUint32(ctx, items, at++, item);
    }
    JS_SetPropertyStr(ctx, result, "items", items);
    if (JS_HasException(ctx)) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    return result;
}
static JSValue menu_action(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    if (!ready(ctx)) return JS_EXCEPTION;
    int64_t id, revision, target;
    if (argc != 3 || !number(ctx, argv[0], 1, UINT32_MAX, &id) || !number(ctx, argv[1], 1, UINT32_MAX, &revision) ||
        !number(ctx, argv[2], 0, INT32_MAX, &target)) return JS_ThrowTypeError(ctx, "Invalid tray menu action");
    struct TrayItem *item = find_item((uint32_t)id);
    if (!item || tray.menu.item != id || tray.menu.revision != revision || tray.menu.pending || tray.menu.error[0])
        return JS_ThrowTypeError(ctx, "Stale tray menu action");
    bool found = false;
    for (unsigned i = 0; i < tray.menu.data.count; i++) {
        struct PuBusMenuItem *entry = &tray.menu.data.items[i];
        if (entry->id == target && entry->parent == tray.menu.root && entry->visible &&
            entry->enabled && !entry->separator && !entry->submenu) found = true;
    }
    if (!found) return JS_ThrowTypeError(ctx, "Unknown or disabled tray menu action");
    DBusMessage *message = dbus_message_new_method_call(item->owner, tray.menu.path, "com.canonical.dbusmenu", "Event");
    DBusMessageIter args, variant;
    int32_t menu_id = (int32_t)target, data = 0;
    uint32_t time = (uint32_t)pu_now_ms();
    const char *event = "clicked";
    if (message) {
        dbus_message_iter_init_append(message, &args);
        if (!dbus_message_iter_append_basic(&args, DBUS_TYPE_INT32, &menu_id) ||
            !dbus_message_iter_append_basic(&args, DBUS_TYPE_STRING, &event) ||
            !dbus_message_iter_open_container(&args, DBUS_TYPE_VARIANT, "i", &variant) ||
            !dbus_message_iter_append_basic(&variant, DBUS_TYPE_INT32, &data) ||
            !dbus_message_iter_close_container(&args, &variant) ||
            !dbus_message_iter_append_basic(&args, DBUS_TYPE_UINT32, &time)) {
            dbus_message_unref(message); message = NULL;
        }
    }
    if (!request(ITEM_ACTION, item->id, message)) return JS_ThrowInternalError(ctx, "%s", tray.error);
    return close_menu(ctx, self, 0, NULL);
}
int pu_tray_install(JSContext *ctx, JSValueConst api)
{
    tray.ctx = ctx; tray.api = JS_DupValue(ctx, api);
    const char *bus = getenv("POLLY_SESSION_BUS_ADDRESS");
    return JS_SetPropertyStr(ctx, api, "trayAvailable", JS_NewBool(ctx, bus && *bus)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "startTray", JS_NewCFunction(ctx, start, "startTray", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "stopTray", JS_NewCFunction(ctx, stop_server, "stopTray", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "trayItems", JS_NewCFunction(ctx, snapshot, "trayItems", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "trayAction", JS_NewCFunction(ctx, action, "trayAction", 5)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "trayScroll", JS_NewCFunction(ctx, scroll_item, "trayScroll", 4)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "openTrayMenu", JS_NewCFunction(ctx, open_menu, "openTrayMenu", 3)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "closeTrayMenu", JS_NewCFunction(ctx, close_menu, "closeTrayMenu", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "trayMenu", JS_NewCFunction(ctx, menu_snapshot, "trayMenu", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "invokeTrayMenu", JS_NewCFunction(ctx, menu_action, "invokeTrayMenu", 3)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "onTrayChanged", JS_NULL) >= 0;
}
int pu_tray_pump(void)
{
    if (!tray.bus) return 0;
    if (!tray.failed) {
        if (!dbus_connection_read_write(tray.bus, 0)) fail("Private tray bus disconnected");
        if (dbus_connection_get_dispatch_status(tray.bus) == DBUS_DISPATCH_NEED_MEMORY)
            fail("Cannot allocate tray dispatch state");
        for (int i = 0; i < 64 && !tray.failed && dbus_connection_get_dispatch_status(tray.bus) == DBUS_DISPATCH_DATA_REMAINS; i++)
            if (dbus_connection_dispatch(tray.bus) == DBUS_DISPATCH_NEED_MEMORY) fail("Cannot dispatch tray message");
        struct Request **at = &tray.requests;
        while (*at && !tray.failed) {
            struct Request *entry = *at;
            bool complete = dbus_pending_call_get_completed(entry->pending);
            if (!complete && pu_now_ms() < entry->deadline) { at = &entry->next; continue; }
            *at = entry->next;
            DBusMessage *reply = complete ? dbus_pending_call_steal_reply(entry->pending) : NULL;
            finished(entry, reply);
            if (reply) dbus_message_unref(reply);
            free_request(entry);
            at = &tray.requests;
        }
    }
    if (!tray.changed) return 0;
    tray.changed = false;
    JSContext *ctx = tray.ctx;
    JSValue callback = JS_GetPropertyStr(ctx, tray.api, "onTrayChanged"), result = JS_UNDEFINED;
    if (JS_IsException(callback)) result = JS_EXCEPTION;
    else if (JS_IsFunction(ctx, callback)) result = JS_Call(ctx, callback, tray.api, 0, NULL);
    else if (!JS_IsNull(callback) && !JS_IsUndefined(callback)) result = JS_ThrowTypeError(ctx, "Tray callback must be a function");
    JS_FreeValue(ctx, callback);
    if (JS_IsException(result)) {
        JSValue error = JS_GetException(ctx); const char *message = JS_ToCString(ctx, error);
        fprintf(stderr, "[tray] Callback failed: %s\n", message ? message : "unknown");
        JS_FreeCString(ctx, message); JS_FreeValue(ctx, error);
    } else JS_FreeValue(ctx, result);
    return 1;
}
void pu_tray_shutdown(void)
{
    stop();
    if (tray.ctx) JS_FreeValue(tray.ctx, tray.api);
    memset(&tray, 0, sizeof(tray));
}
