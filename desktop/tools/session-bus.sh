# Sourced by a session owner with a private $runtime directory.
start_private_bus() {
    if ! command -v dbus-daemon >/dev/null 2>&1; then
        echo "Private session bus requires dbus-daemon" >&2; return 1
    fi
    unset DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID DBUS_STARTER_ADDRESS DBUS_STARTER_BUS_TYPE POLLY_SESSION_BUS_ADDRESS
    bus_path=$(printf '%s' "$runtime/bus" | od -An -v -tx1 | tr -d ' \n' | sed 's/../%&/g')
    (
        unset DISPLAY WAYLAND_SOCKET SDL_APP_ID PU_CAPTURE_FRAME PU_TRACE_FRAMES PU_TRACE_STARTUP
        export WAYLAND_DISPLAY=${POLLY_BUS_DISPLAY:-pollywm-0}
        exec dbus-daemon --session --nofork --nopidfile \
            --address="unix:path=$bus_path" --print-address=3
    ) 3>"$runtime/bus.address" 2>"$runtime/bus.error" &
    bus_pid=$!
    i=0
    while [ ! -s "$runtime/bus.address" ] || [ ! -S "$runtime/bus" ]; do
        if ! kill -0 "$bus_pid" 2>/dev/null || [ "$i" -ge 100 ]; then
            echo "Cannot start private D-Bus session" >&2; cat "$runtime/bus.error" >&2; return 1
        fi
        sleep 0.02; i=$((i + 1))
    done
    DBUS_SESSION_BUS_ADDRESS=$(cat "$runtime/bus.address")
    POLLY_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
    export DBUS_SESSION_BUS_ADDRESS POLLY_SESSION_BUS_ADDRESS
}
stop_private_bus() {
    if [ -n "${bus_pid:-}" ]; then
        kill -TERM "$bus_pid" 2>/dev/null || true
        wait "$bus_pid" 2>/dev/null || true
        bus_pid=
    fi
    rm -f "$runtime/bus" "$runtime/bus.address" "$runtime/bus.error"
    if [ -d "$runtime/dbus-1/services" ]; then rmdir "$runtime/dbus-1/services"; fi
    if [ -d "$runtime/dbus-1" ]; then rmdir "$runtime/dbus-1"; fi
}
