#!/bin/sh
set -eu
server=${1:?Canvas compositor fixture}
client=${2:?GUI-only playground}
script=${3:?Canvas window fixture}
runtime=$(mktemp -d)
cleanup() {
    rm -f "$runtime/canvas-smoke" "$runtime/canvas-smoke.lock"
    rmdir "$runtime"
}
trap cleanup EXIT
export XDG_RUNTIME_DIR="$runtime" WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 WLR_RENDERER=pixman
export SDL_VIDEODRIVER=wayland PU_RENDERER=raster
"$server" "$client" "$script"
