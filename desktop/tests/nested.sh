#!/bin/sh
set -eu
wm=$1
parent=${WAYLAND_DISPLAY:?Run this test inside a Wayland session}
case "$parent" in
    /*) ;;
    *) parent="${XDG_RUNTIME_DIR:?}/$parent" ;;
esac
runtime=$(mktemp -d)
pid=
first=
second=
cleanup() {
    for child in "$first" "$second" "$pid"; do
        if [ -n "$child" ]; then
            kill "$child" 2>/dev/null || true
            wait "$child" 2>/dev/null || true
        fi
    done
    rm -f "$runtime/server.log" "$runtime/foot1.log" "$runtime/foot2.log"
    rmdir "$runtime"
}
trap cleanup EXIT
export XDG_RUNTIME_DIR="$runtime" WLR_BACKENDS=wayland WLR_RENDERER=pixman
WAYLAND_DISPLAY="$parent" "$wm" --socket pollywm-test >"$runtime/server.log" 2>&1 &
pid=$!
i=0
while ! grep -q 'PollyWM ready' "$runtime/server.log"; do
    if ! kill -0 "$pid" 2>/dev/null || [ "$i" -ge 100 ]; then
        cat "$runtime/server.log"; exit 1
    fi
    sleep 0.02
    i=$((i + 1))
done
WAYLAND_DISPLAY=pollywm-test foot --app-id=org.pollywm.foot1 sh -c 'printf "PollyWM: first terminal\n"; sleep 1' >"$runtime/foot1.log" 2>&1 &
first=$!
WAYLAND_DISPLAY=pollywm-test foot --app-id=org.pollywm.foot2 sh -c 'printf "PollyWM: second terminal\n"; sleep 1' >"$runtime/foot2.log" 2>&1 &
second=$!
if ! wait "$first"; then cat "$runtime/foot1.log"; exit 1; fi
first=
if ! wait "$second"; then cat "$runtime/foot2.log"; exit 1; fi
second=
grep -q 'Mapped org.pollywm.foot1' "$runtime/server.log"
grep -q 'Mapped org.pollywm.foot2' "$runtime/server.log"
kill -TERM "$pid"
wait "$pid"
pid=
echo "PASS: WSLg/nested compositor hosted two independent foot terminals and shut down cleanly"
