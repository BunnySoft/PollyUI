#!/bin/sh
set -eu
runtime=$(mktemp -d)
bus=0
bus_pid=
if [ "${1:-}" = --bus ]; then
    bus=1; shift
    . "$(dirname -- "$0")/../tools/session-bus.sh"
fi
cleanup() {
    if [ "$bus" -eq 1 ]; then stop_private_bus; fi
    rm -f "$runtime/runtime-client" "$runtime/runtime-client.lock"
    rm -rf "$runtime/config" "$runtime/data" "$runtime/cache"
    rmdir "$runtime"
}
trap cleanup EXIT
export XDG_RUNTIME_DIR="$runtime" XDG_CONFIG_HOME="$runtime/config"
export XDG_DATA_HOME="$runtime/data" XDG_CACHE_HOME="$runtime/cache"
if [ "$bus" -eq 1 ]; then POLLY_BUS_DISPLAY=runtime-client; start_private_bus; fi
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
