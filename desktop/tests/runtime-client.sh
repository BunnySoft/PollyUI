#!/bin/sh
set -eu
runtime=$(mktemp -d)
bus=0
bus_pid=
system_bus=0
audio=0
audio_pid=
if [ "${1:-}" = --audio ]; then audio=1; fi
if [ "${1:-}" = --iwd ]; then system_bus=1; fi
if [ "${1:-}" = --bus ] || [ "$system_bus" -eq 1 ] || [ "$audio" -eq 1 ]; then
    bus=1; shift
    . "$(dirname -- "$0")/../tools/session-bus.sh"
fi
if [ "$audio" -eq 1 ]; then
    repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
    . "$repo/desktop/tools/session-audio.sh"
fi
cleanup() {
    if [ "$audio" -eq 1 ]; then stop_private_audio; fi
    if [ "$bus" -eq 1 ]; then stop_private_bus; fi
    rm -f "$runtime/runtime-client" "$runtime/runtime-client.lock"
    rm -rf "$runtime/config" "$runtime/data" "$runtime/cache"
    rmdir "$runtime"
}
trap cleanup EXIT
export XDG_RUNTIME_DIR="$runtime" XDG_CONFIG_HOME="$runtime/config"
export XDG_DATA_HOME="$runtime/data" XDG_CACHE_HOME="$runtime/cache"
if [ "$bus" -eq 1 ]; then POLLY_BUS_DISPLAY=runtime-client; start_private_bus; fi
if [ "$system_bus" -eq 1 ]; then export DBUS_SYSTEM_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"; fi
if [ "$audio" -eq 1 ]; then
    start_private_audio "$repo/desktop/tests/audio.conf"
fi
export SDL_VIDEODRIVER=wayland SDL_RENDER_DRIVER=software
unset SDL_MOUSE_FOCUS_CLICKTHROUGH
export WLR_RENDERER=pixman
if [ "${1:-}" = --nested ]; then
    shift
    export WLR_BACKENDS=wayland WLR_WL_OUTPUTS=2
else
    export WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=2
fi
"$@"
