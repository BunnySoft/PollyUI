#include "../../desktop/native/power.c"
#include <assert.h>

long long pu_now_ms(void) { return 100; }

static void initialize(void)
{
    memset(&power, 0, sizeof(power));
    strcpy(power.owner, ":1.42");
    strcpy(power.operation, "reboot");
    strcpy(power.outcome, "checking");
    power.sent = true;
}

int main(void)
{
    DBusMessage *reply;
    assert(ordinary_identity(1000, 1000));
    assert(!ordinary_identity(0, 0) && !ordinary_identity(1000, 0) && !ordinary_identity(0, 1000));
    initialize();
    complete(ACTION, NULL);
    assert(power.sent && !strcmp(power.outcome, "uncertain") && !*power.operation);
    reset();
    assert(power.sent && !strcmp(power.outcome, "uncertain"));

    initialize();
    reply = dbus_message_new(DBUS_MESSAGE_TYPE_ERROR);
    assert(reply && dbus_message_set_sender(reply, power.owner) &&
        dbus_message_set_error_name(reply, DBUS_ERROR_FAILED));
    complete(ACTION, reply);
    dbus_message_unref(reply);
    assert(power.sent && !strcmp(power.outcome, "uncertain"));

    initialize();
    reply = dbus_message_new(DBUS_MESSAGE_TYPE_METHOD_RETURN);
    assert(reply && dbus_message_set_sender(reply, power.owner));
    complete(ACTION, reply);
    dbus_message_unref(reply);
    assert(power.sent && !strcmp(power.outcome, "accepted"));
    reset();
    assert(power.sent && !strcmp(power.outcome, "accepted"));

    initialize();
    reply = dbus_message_new(DBUS_MESSAGE_TYPE_ERROR);
    assert(reply && dbus_message_set_sender(reply, power.owner) &&
        dbus_message_set_error_name(reply, DBUS_ERROR_ACCESS_DENIED));
    complete(ACTION, reply);
    dbus_message_unref(reply);
    assert(!power.sent && !strcmp(power.outcome, "rejected"));

    initialize();
    reply = dbus_message_new(DBUS_MESSAGE_TYPE_ERROR);
    assert(reply && dbus_message_set_sender(reply, power.owner) &&
        dbus_message_set_error_name(reply, DBUS_ERROR_NO_REPLY));
    complete(ACTION, reply);
    dbus_message_unref(reply);
    assert(power.sent && !strcmp(power.outcome, "uncertain"));

    initialize();
    reply = dbus_message_new(DBUS_MESSAGE_TYPE_METHOD_RETURN);
    const char *unexpected = "not an acknowledgment";
    assert(reply && dbus_message_set_sender(reply, power.owner) &&
        dbus_message_append_args(reply, DBUS_TYPE_STRING, &unexpected, DBUS_TYPE_INVALID));
    complete(ACTION, reply);
    dbus_message_unref(reply);
    assert(power.sent && !strcmp(power.outcome, "uncertain"));

    initialize();
    power.sent = false;
    complete(SESSION, NULL);
    assert(!power.sent && !strcmp(power.outcome, "failed"));
    puts("PASS: ordinary non-setid identity, power result loss, accepted reply, denial, malformed acknowledgment and preflight failure");
    return 0;
}
