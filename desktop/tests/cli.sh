#!/bin/sh
set -eu
wm=$1
runtime=$(mktemp -d)
pid=
cleanup() {
    if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    rm -f "$runtime/server.log" "$runtime/error.log"
    rmdir "$runtime"
}
trap cleanup EXIT
export XDG_RUNTIME_DIR="$runtime" WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 WLR_RENDERER=pixman
expect_status() {
    expected=$1
    shift
    if timeout -k 2 5 "$@" >"$runtime/error.log" 2>&1; then actual=0; else actual=$?; fi
    if [ "$actual" -ne "$expected" ]; then
        cat "$runtime/error.log"
        echo "Expected status $expected, got $actual" >&2
        exit 1
    fi
}
"$wm" --help >/dev/null
expect_status 2 "$wm" --unknown
expect_status 2 "$wm" --socket
expect_status 2 "$wm" --socket ../unsafe
expect_status 2 "$wm" --shell
expect_status 2 "$wm" --shell ''
expect_status 2 "$wm" --shell-restarts
expect_status 2 "$wm" --shell-restarts -1
expect_status 2 "$wm" --shell-restarts '2x'
expect_status 2 "$wm" --shell-restarts 2
expect_status 2 "$wm" --exit-with-shell
expect_status 1 "$wm" --shell /pollywm-test/nonexistent-shell
grep -q 'Cannot start shell' "$runtime/error.log"
expect_status 1 "$wm" --shell-restarts 2 --shell /pollywm-test/nonexistent-shell
expect_status 0 "$wm" --shell-restarts 2 --exit-with-shell --shell /bin/true
grep -q 'Shell exited normally; ending the requested session' "$runtime/error.log"
if grep -q 'Shell restart .*scheduled' "$runtime/error.log"; then
    echo "A successful shell must not be restarted" >&2
    exit 1
fi
chmod 0755 "$runtime"
expect_status 1 "$wm"
grep -q 'mode 0700' "$runtime/error.log"
chmod 0700 "$runtime"
"$wm" --socket pollywm-test >"$runtime/server.log" 2>&1 &
pid=$!
i=0
while ! grep -q 'PollyWM ready' "$runtime/server.log"; do
    if ! kill -0 "$pid" 2>/dev/null || [ "$i" -ge 100 ]; then
        cat "$runtime/server.log"; exit 1
    fi
    sleep 0.02
    i=$((i + 1))
done
expect_status 1 "$wm" --socket pollywm-test
grep -q 'Cannot bind requested Wayland socket' "$runtime/error.log"
kill -0 "$pid"
kill -TERM "$pid"
wait "$pid"
pid=
test ! -e "$runtime/pollywm-test"
test ! -e "$runtime/pollywm-test.lock"
expect_status 1 env WLR_HEADLESS_OUTPUTS=0 "$wm"
grep -q 'No usable outputs' "$runtime/error.log"
expect_status 1 env WLR_BACKENDS=nonexistent "$wm"
grep -q 'Cannot create wlroots backend' "$runtime/error.log"
echo "PASS: CLI validation, collision handling, failure cleanup and SIGTERM shutdown"
