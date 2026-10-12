#!/bin/sh
set -eu
runtime=$(mktemp -d)
cleanup() {
    rm -f "$runtime/ordinary-transparency" "$runtime/ordinary-transparency.lock"
    rmdir "$runtime"
}
trap cleanup EXIT
export XDG_RUNTIME_DIR="$runtime" WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 WLR_RENDERER=pixman
for renderer in raster gl auto; do
    for scale in 1 1.5; do
        timeout 20 "$1" "$2" "$3" "$renderer" "$scale"
    done
done
export SDL_RENDER_DRIVER=software
for scale in 1 1.5; do
    timeout 20 "$1" "$2" "$3" raster "$scale"
done
