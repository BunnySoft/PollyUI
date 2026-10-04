#!/bin/sh
set -eu
launcher=$1
wm=$2
ui=$3
client=$4
temporary=$(mktemp -d)
pid=
cleanup() {
    if [ -n "$pid" ]; then
        kill -TERM "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    rm -f "$temporary/session.log" "$temporary/error.log"
    rm -rf "$temporary/config" "$temporary/data" "$temporary/cache"
    if [ -d "$temporary/run" ]; then rmdir "$temporary/run"; fi
    rmdir "$temporary"
}
trap cleanup EXIT
mkdir -m 700 "$temporary/run"
export XDG_RUNTIME_DIR="$temporary/run" XDG_CONFIG_HOME="$temporary/config"
export XDG_DATA_HOME="$temporary/data" XDG_CACHE_HOME="$temporary/cache"
export PU_RENDERER=raster SDL_RENDER_DRIVER=software PU_TRACE_STARTUP=1
if sh "$launcher" --headless --nested >"$temporary/error.log" 2>&1; then
    echo "Conflicting session backends were accepted" >&2; exit 1
fi
if ! sh "$launcher" --headless --restarts 2 "$wm" "$ui" "$client" \
    'argument with spaces' '; not a shell command' >"$temporary/session.log" 2>&1; then
    cat "$temporary/session.log"; exit 1
fi
grep -q 'PASS: development session arguments and identity' "$temporary/session.log"
grep -q 'PollyUI frame presented' "$temporary/session.log"
grep -q 'Shell exited normally; ending the requested session' "$temporary/session.log"
rmdir "$temporary/run"
mkdir -m 700 "$temporary/run"
: >"$temporary/session.log"
sh "$launcher" --headless --restarts 2 "$wm" "$ui" "$client" hold >"$temporary/session.log" 2>&1 &
pid=$!
i=0
while ! grep -q 'PollyUI frame presented' "$temporary/session.log"; do
    if ! kill -0 "$pid" 2>/dev/null || [ "$i" -ge 500 ]; then
        cat "$temporary/session.log"; exit 1
    fi
    sleep 0.02
    i=$((i + 1))
done
kill -TERM "$pid"
if wait "$pid"; then result=0; else result=$?; fi
pid=
if [ "$result" -ne 143 ]; then cat "$temporary/session.log"; exit 1; fi
rmdir "$temporary/run"
echo "PASS: development session startup, arguments, exit, signal forwarding and runtime cleanup"
