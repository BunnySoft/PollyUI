#ifndef POLLY_SESSION_BUS_H
#define POLLY_SESSION_BUS_H
#include <stddef.h>
#include <stdbool.h>
#include <dbus/dbus.h>
/* Return an allocated private-session address, "disabled:" outside our
 * launcher, or NULL for an explicitly configured invalid session. */
char *pu_session_bus_address(void);
DBusConnection *pu_session_bus_connect(char *error, size_t error_size);
DBusConnection *pu_system_bus_connect(char *error, size_t error_size);
#endif
