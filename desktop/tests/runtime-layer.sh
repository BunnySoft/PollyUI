#!/bin/sh
set -eu
ui=${1:?Pass the PollyUI executable}
wm=${2:?Pass the PollyWM executable}
backend=headless
parent=
if [ "$#" -eq 3 ] && [ "$3" = --nested ]; then
    backend=wayland
    parent=${WAYLAND_DISPLAY:?Pass the parent Wayland display}
    case "$parent" in /*) ;; *) parent="${XDG_RUNTIME_DIR:?}/$parent" ;; esac
elif [ "$#" -ne 2 ]; then
    echo "Usage: runtime-layer.sh pollyui pollywm [--nested]" >&2
    exit 2
fi
runtime=$(mktemp -d)
pid=
cleanup() {
    if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    rm -f "$runtime/server.log" "$runtime/public.log" "$runtime/frame-wallpaper.png" \
        "$runtime/frame-panel.png" "$runtime/frame-dock.png" "$runtime/frame-replacement-panel.png" \
        "$runtime/frame-final-layer.png"
    rm -rf "$runtime/config" "$runtime/data" "$runtime/cache"
    rmdir "$runtime"
}
trap cleanup EXIT
export XDG_RUNTIME_DIR="$runtime" XDG_CONFIG_HOME="$runtime/config"
export XDG_DATA_HOME="$runtime/data" XDG_CACHE_HOME="$runtime/cache"
export SDL_VIDEODRIVER=wayland SDL_RENDER_DRIVER=software
export WLR_BACKENDS="$backend" WLR_HEADLESS_OUTPUTS=1 WLR_RENDERER=pixman
: >"$runtime/server.log"
WAYLAND_DISPLAY="$parent" "$wm" --socket pollyui-layer --shell "$ui" desktop/tests/runtime-layer.mjs "$runtime/frame" \
    >"$runtime/server.log" 2>&1 &
pid=$!
i=0
while ! grep -q 'Shell exited with status 0' "$runtime/server.log"; do
    if ! kill -0 "$pid" 2>/dev/null || [ "$i" -ge 1000 ] || grep -q 'FAIL:' "$runtime/server.log"; then
        cat "$runtime/server.log"; exit 1
    fi
    sleep 0.02
    i=$((i + 1))
done
if ! grep -q 'PASS: native multi-layer runtime complete' "$runtime/server.log"; then
    cat "$runtime/server.log"; exit 1
fi
if ! WAYLAND_DISPLAY=pollyui-layer timeout 15 "$ui" desktop/tests/runtime-layer.mjs denied \
    >"$runtime/public.log" 2>&1; then
    cat "$runtime/public.log"; exit 1
fi
if grep -q 'FAIL:' "$runtime/public.log" ||
   ! grep -q 'PASS: layer authorization rejection complete' "$runtime/public.log"; then
    cat "$runtime/public.log"; exit 1
fi
python3 - "$runtime" <<'PY'
import pathlib
import sys
from PIL import Image

root = pathlib.Path(sys.argv[1])
expected = {
    "wallpaper": ((17, 34, 51), None),
    "panel": ((85, 119, 153), (None, 32)),
    "dock": ((153, 119, 68), (160, 48)),
    "replacement-panel": ((119, 85, 187), (None, 44)),
    "final-layer": ((170, 68, 51), (320, 100)),
}
for name, (rgb, dimensions) in expected.items():
    with Image.open(root / f"frame-{name}.png") as image:
        actual = image.convert("RGB").getpixel((5, min(20, image.height // 2)))
        assert actual == rgb, (name, "pixel color", actual, rgb, image.size)
        if name == "dock":
            assert image.convert("RGBA").getpixel((0, 0))[3] == 0, "Dock corner must be transparent"
        if dimensions:
            assert all(wanted is None or actual == wanted for actual, wanted in zip(image.size, dimensions)), (name, image.size)
        print(f"PASS: actual {name} layer pixels and dimensions")
PY
kill -TERM "$pid"
wait "$pid"
pid=
echo "PASS: trusted layer roles, shared rendering, reservations, replacement and public rejection"
