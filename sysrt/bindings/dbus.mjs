export const dbusConstants = Object.freeze({
  TYPE_UINT32: 117, MESSAGE_METHOD_RETURN: 2, MESSAGE_ERROR: 3,
});

export const dbusBindings = {
  linux: {
    library: 'libdbus-1.so.3',
    target: { architecture: 'x86_64', pointerSize: 8, longSize: 8 },
    functions: {
      open: { symbol: 'dbus_connection_open_private', result: 'pointer', parameters: ['cstring', 'pointer'] },
      register: { symbol: 'dbus_bus_register', result: 'u32', parameters: ['pointer', 'pointer'] },
      exitOnDisconnect: { symbol: 'dbus_connection_set_exit_on_disconnect', result: 'void', parameters: ['pointer', 'u32'] },
      connected: { symbol: 'dbus_connection_get_is_connected', result: 'u32', parameters: ['pointer'] },
      readWriteDispatch: { symbol: 'dbus_connection_read_write_dispatch', result: 'u32', parameters: ['pointer', 'i32'] },
      close: { symbol: 'dbus_connection_close', result: 'void', parameters: ['pointer'] },
      unref: { symbol: 'dbus_connection_unref', result: 'void', parameters: ['pointer'] },
      newCall: { symbol: 'dbus_message_new_method_call', result: 'pointer', parameters: ['cstring', 'cstring', 'cstring', 'cstring'] },
      messageUnref: { symbol: 'dbus_message_unref', result: 'void', parameters: ['pointer'] },
      messageType: { symbol: 'dbus_message_get_type', result: 'i32', parameters: ['pointer'] },
      hasSignature: { symbol: 'dbus_message_has_signature', result: 'u32', parameters: ['pointer', 'cstring'] },
      isError: { symbol: 'dbus_message_is_error', result: 'u32', parameters: ['pointer', 'cstring'] },
      initAppend: { symbol: 'dbus_message_iter_init_append', result: 'void', parameters: ['pointer', 'pointer'] },
      appendBasic: { symbol: 'dbus_message_iter_append_basic', result: 'u32', parameters: ['pointer', 'i32', 'pointer'] },
      initRead: { symbol: 'dbus_message_iter_init', result: 'u32', parameters: ['pointer', 'pointer'] },
      getBasic: { symbol: 'dbus_message_iter_get_basic', result: 'void', parameters: ['pointer', 'pointer'] },
      send: { symbol: 'dbus_connection_send_with_reply', result: 'u32', parameters: ['pointer', 'pointer', 'pointer', 'i32'] },
      completed: { symbol: 'dbus_pending_call_get_completed', result: 'u32', parameters: ['pointer'] },
      stealReply: { symbol: 'dbus_pending_call_steal_reply', result: 'pointer', parameters: ['pointer'] },
      cancel: { symbol: 'dbus_pending_call_cancel', result: 'void', parameters: ['pointer'] },
      pendingUnref: { symbol: 'dbus_pending_call_unref', result: 'void', parameters: ['pointer'] },
      validDestination: { symbol: 'dbus_validate_bus_name', result: 'u32', parameters: ['cstring', 'pointer'] },
      validPath: { symbol: 'dbus_validate_path', result: 'u32', parameters: ['cstring', 'pointer'] },
      validInterface: { symbol: 'dbus_validate_interface', result: 'u32', parameters: ['cstring', 'pointer'] },
      validMember: { symbol: 'dbus_validate_member', result: 'u32', parameters: ['cstring', 'pointer'] },
      shutdown: { symbol: 'dbus_shutdown', result: 'void', parameters: [] },
    },
    // Public stack-allocatable ABI storage, not an extent for a libdbus-owned object.
    layouts: { messageIter: { byteLength: 72, fields: {
      storage: { type: 'bytes', offset: 0, byteLength: 72 },
    } } },
  },
};
