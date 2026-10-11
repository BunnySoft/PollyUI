#include <dbus/dbus.h>
#include <stddef.h>
#include <stdint.h>

size_t sr_dbus_size(int32_t index)
{
    const size_t sizes[] = { sizeof(DBusMessageIter), sizeof(DBusError), sizeof(dbus_int16_t),
                            sizeof(dbus_bool_t), sizeof(dbus_uint32_t), sizeof(long) };
    return index >= 0 && (size_t)index < sizeof(sizes) / sizeof(sizes[0]) ? sizes[index] : 0;
}

int32_t sr_dbus_constant(int32_t index)
{
    const int32_t values[] = { DBUS_TYPE_INT16, DBUS_TYPE_ARRAY, DBUS_TYPE_STRUCT, DBUS_TYPE_DICT_ENTRY,
                              DBUS_TYPE_VARIANT, DBUS_MESSAGE_TYPE_SIGNAL };
    return index >= 0 && (size_t)index < sizeof(values) / sizeof(values[0]) ? values[index] : -1;
}
