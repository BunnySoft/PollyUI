#!/bin/sh
set -eu
ui=${1:?Pass the PollyUI executable}
temporary=$(mktemp -d)
cleanup() {
    rm -f "$temporary/output.log" "$temporary/storage.dat"
    rmdir "$temporary"
}
trap cleanup EXIT
export PU_TEST_STORAGE="$temporary/storage.dat"
for test in smoke.js text.js textwrap.js linux-fonts.mjs visual.js \
    style.js dom.js events.js keyboard.js scroll.js modules.mjs \
    runtime.js workers.js fetch.js storage.js storage.js storage-values.mjs input-events.mjs pointer-events.mjs \
    reconciler.mjs vue.mjs textinput.mjs inputcaret.mjs teardown.mjs desktop-appearance.mjs native-shell.mjs desktop-applications.mjs; do
    case "$test" in
        fetch.js|storage.js|storage-values.mjs) script="sysrt/tests/$test" ;;
        desktop-*|native-shell.mjs) script="desktop/tests/$test" ;;
        *) script="gui/tests/$test" ;;
    esac
    if ! timeout 45 "$ui" --test "$script" >"$temporary/output.log" 2>&1; then
        cat "$temporary/output.log"
        exit 1
    fi
    if grep -q '^FAIL:' "$temporary/output.log"; then
        cat "$temporary/output.log"
        exit 1
    fi
    echo "PASS: Linux UI $test"
done
expect_failure() {
    if "$@" >"$temporary/output.log" 2>&1; then code=0; else code=$?; fi
    if [ "$code" -ne 1 ]; then
        cat "$temporary/output.log"
        echo "Expected startup failure status 1, got $code" >&2
        exit 1
    fi
}
expect_log() {
    if ! grep -q "$1" "$temporary/output.log"; then
        cat "$temporary/output.log"
        echo "Missing expected diagnostic: $1" >&2
        exit 1
    fi
}
expect_failure env FONTCONFIG_FILE="$PWD/desktop/tests/empty-fonts.conf" "$ui" --test gui/tests/smoke.js
expect_log 'No system fonts available'
expect_failure env SDL_VIDEODRIVER=pollyui-invalid "$ui" desktop/tests/runtime-window.mjs
expect_log 'Failed to create application window'
expect_failure env PU_RENDERER=raster SDL_VIDEODRIVER=dummy SDL_RENDER_DRIVER=pollyui-invalid "$ui" desktop/tests/runtime-window.mjs
expect_log 'SDL_CreateRenderer failed'
expect_failure env PU_RENDERER=invalid "$ui" desktop/tests/runtime-window.mjs
expect_log 'PU_RENDERER must be'
expect_failure env PU_RENDERER=gl SDL_VIDEODRIVER=dummy "$ui" desktop/tests/runtime-window.mjs
expect_log 'GLES initialization failed'
if ! PU_RENDERER=auto SDL_VIDEODRIVER=dummy SDL_RENDER_DRIVER=software PU_TRACE_STARTUP=1 \
    timeout 20 "$ui" desktop/tests/runtime-window.mjs >"$temporary/output.log" 2>&1; then
    cat "$temporary/output.log"; exit 1
fi
expect_log 'falling back to Skia raster'
expect_log 'driver=dummy, Skia=raster'
expect_failure bash tools/fetch_skia.sh
expect_log 'Linux requires a native Skia build'
expect_failure bash tools/build.sh --skia-root "$temporary/missing-skia"
expect_log 'Native Linux Skia missing'
echo "PASS: Linux font, video and presentation startup errors are explicit"
node desktop/tests/http-fixture.mjs "$ui"
node desktop/tests/xdg-fixture.mjs "$ui"
