#!/bin/sh
set -eu
temporary=$(mktemp -d)
cleanup() {
    rm -f "$temporary/save.log" "$temporary/reload.log"
    rm -rf "$temporary/config" "$temporary/data" "$temporary/cache"
    rmdir "$temporary/run" "$temporary"
}
trap cleanup EXIT
mkdir -m 700 "$temporary/run"
export XDG_RUNTIME_DIR="$temporary/run" XDG_CONFIG_HOME="$temporary/config"
export XDG_DATA_HOME="$temporary/data" XDG_CACHE_HOME="$temporary/cache"
export PU_RENDERER=raster SDL_RENDER_DRIVER=software
for mode in save reload; do
    if ! sh "$1" --headless "$2" "$3" "$4" "$mode" >"$temporary/$mode.log" 2>&1; then
        cat "$temporary/$mode.log"; exit 1
    fi
    if grep -q 'FAIL:' "$temporary/$mode.log" ||
       ! grep -q "PASS: shortcut persistence $mode" "$temporary/$mode.log"; then
        cat "$temporary/$mode.log"; exit 1
    fi
done
echo "PASS: shortcut preferences survive compositor/session restart"
