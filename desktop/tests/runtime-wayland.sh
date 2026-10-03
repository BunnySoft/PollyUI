#!/bin/sh
set -eu
ui=${1:?Pass the PollyUI executable}
wm=${2:?Pass the PollyWM executable}
backend=wayland
parent=
if [ "$#" -eq 3 ] && [ "$3" = --headless ]; then
    backend=headless
elif [ "$#" -eq 2 ]; then
    parent=${WAYLAND_DISPLAY:?Run inside a Wayland session, or pass --headless}
    case "$parent" in /*) ;; *) parent="${XDG_RUNTIME_DIR:?}/$parent" ;; esac
else
    echo "Usage: runtime-wayland.sh pollyui pollywm [--headless]" >&2
    exit 2
fi
runtime=$(mktemp -d)
pid=
cleanup() {
    if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    rm -f "$runtime/server.log" "$runtime/ui.log"
    rmdir "$runtime"
}
trap cleanup EXIT
export XDG_RUNTIME_DIR="$runtime" SDL_VIDEODRIVER=wayland SDL_RENDER_DRIVER=software
export SDL_APP_ID=org.pollyui.runtime PU_TRACE_STARTUP=1
export PU_RENDERER=raster
run_ui() {
    if ! WAYLAND_DISPLAY="$1" timeout 20 "$ui" desktop/tests/runtime-window.mjs >"$runtime/ui.log" 2>&1; then
        cat "$runtime/ui.log"
        exit 1
    fi
    if ! grep -q 'PollyUI frame presented:.*driver=wayland, Skia=raster' "$runtime/ui.log" ||
       ! grep -q 'PollyUI runtime theme cycle complete' "$runtime/ui.log"; then
        cat "$runtime/ui.log"
        echo "PollyUI did not complete the expected Wayland raster presentation cycle" >&2
        exit 1
    fi
}
if [ "$backend" = wayland ]; then
    run_ui "$parent"
    sh desktop/tests/runtime-render.sh "$ui" "$parent"
    echo "PASS: native PollyUI rendered and cycled five themes on the parent Wayland compositor"
fi
WAYLAND_DISPLAY="$parent" WLR_BACKENDS="$backend" WLR_HEADLESS_OUTPUTS=1 WLR_RENDERER=pixman \
    "$wm" --socket pollyui-runtime --shell "$ui" desktop/tests/runtime-window.mjs \
    >"$runtime/server.log" 2>&1 &
pid=$!
i=0
while ! grep -q 'PollyWM ready' "$runtime/server.log"; do
    if ! kill -0 "$pid" 2>/dev/null || [ "$i" -ge 100 ]; then
        cat "$runtime/server.log"
        exit 1
    fi
    sleep 0.02
    i=$((i + 1))
done
i=0
while ! grep -q 'Shell exited with status 0' "$runtime/server.log"; do
    if ! kill -0 "$pid" 2>/dev/null || [ "$i" -ge 1000 ]; then
        cat "$runtime/server.log"
        echo "Trusted PollyUI shell did not finish successfully" >&2
        exit 1
    fi
    sleep 0.02
    i=$((i + 1))
done
if ! grep -q 'PollyUI frame presented:.*driver=wayland, Skia=raster' "$runtime/server.log" ||
   ! grep -q 'PollyUI runtime theme cycle complete' "$runtime/server.log"; then
    cat "$runtime/server.log"
    echo "Trusted PollyUI shell did not render the expected theme cycle" >&2
    exit 1
fi
run_ui pollyui-runtime
sh desktop/tests/runtime-render.sh "$ui" pollyui-runtime
if ! grep -q 'Mapped org.pollyui.runtime' "$runtime/server.log"; then
    cat "$runtime/server.log"
    echo "PollyWM did not map the native PollyUI client" >&2
    exit 1
fi
kill -TERM "$pid"
wait "$pid"
pid=
echo "PASS: PollyWM hosted private-shell and ordinary PollyUI clients; frames and clean exits confirmed"
