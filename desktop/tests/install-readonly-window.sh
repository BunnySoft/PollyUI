#!/bin/sh
set -eu
test "$#" -eq 4 || { echo "Usage: fixture POLLYWM POLLYUI FIXTURE_POLLYUI EVIDENCE" >&2; exit 2; }
test "$(id -u)" -eq 1000
test -f /run/polly-readonly-private-fixture
test -f /usr/lib/pollyui/install-targets/install/fixture-helper.py
test "$(cat /run/polly-install-fixture/mode)" = success
for path in "$@"; do
    case "$path" in /*) ;; *) echo "Fixture target/evidence paths must be absolute" >&2; exit 2 ;; esac
done
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p "$4"
evidence=$(mktemp -d "$4/window.XXXXXX")
temporary=$(mktemp -d)
mkdir -m 700 "$temporary/run"
export XDG_RUNTIME_DIR="$temporary/run" XDG_CONFIG_HOME="$temporary/config"
export XDG_DATA_HOME="$temporary/data" XDG_CACHE_HOME="$temporary/cache"
export SDL_RENDER_DRIVER=software PU_RENDERER=raster
if ! sh "$repo/desktop/tools/run-session.sh" --headless --health-check "$1" "$2" \
        "$repo/desktop/tests/install-readonly-window-supervisor.mjs" \
        "$3" "$repo/desktop/installer/native-fixture-main.mjs" > "$evidence/window.log" 2>&1; then
    cat "$evidence/window.log"
    exit 1
fi
cat "$evidence/window.log"
if grep -q 'NATIVE READONLY ORDINARY WINDOW FAIL' "$evidence/window.log" ||
    ! grep -q 'NATIVE READONLY ORDINARY WINDOW PASS' "$evidence/window.log"; then
    echo "Actual ordinary window did not qualify; retained evidence: $evidence" >&2
    exit 1
fi
echo "PASS: actual separate SDL window; private collector source only, no production source/enumeration/write proof"
