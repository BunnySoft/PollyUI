#!/bin/sh
set -eu
driver=${1:?Pass native runtime-client executable}
ui=${2:?Pass production PollyUI executable}
lock=${3:?Pass existing native lock fixture}
evidence=${4:?Pass private evidence directory}
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p "$evidence/home" "$evidence/run" "$evidence/config" "$evidence/data/applications" "$evidence/cache"
chmod 700 "$evidence/run"
export HOME="$evidence/home" XDG_RUNTIME_DIR="$evidence/run" XDG_CONFIG_HOME="$evidence/config"
export XDG_DATA_HOME="$evidence/data" XDG_CACHE_HOME="$evidence/cache"
export SDL_VIDEODRIVER=wayland SDL_RENDER_DRIVER=software PU_RENDERER=raster
export WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=2 WLR_RENDERER=pixman
export PU_DESKTOP_FIXTURE_LOCK="$lock"
unset SDL_MOUSE_FOCUS_CLICKTHROUGH
python3 "$root/desktop/tests/desktop-shortcut-fixtures.py" "$evidence"
python3 - "$XDG_DATA_HOME/applications" "$ui" "$root" <<'PY'
from pathlib import Path
import sys
directory, executable, root = sys.argv[1:]
for letter in ('a', 'b'):
    Path(directory, 'bd04-' + letter + '.desktop').write_text(
        '[Desktop Entry]\nType=Application\nName=BD04 fixture ' + letter.upper() +
        '\nExec="' + executable + '" --app-id org.pollyui.bd04-fixture "' +
        root + '/desktop/tests/desktop-shortcut-app.mjs"\n', encoding='utf-8')
PY
for mode in initial reload; do
    if ! timeout 100 "$driver" "$ui" "$root/desktop/tests/desktop-shortcuts-native.mjs" desktop "$mode" \
        >"$evidence/native-$mode.log" 2>&1; then
        tail -70 "$evidence/native-$mode.log"; exit 1
    fi
    if grep -q '^FAIL:' "$evidence/native-$mode.log"; then tail -70 "$evidence/native-$mode.log"; exit 1; fi
    grep '^PASS:' "$evidence/native-$mode.log"
done
if ! timeout 100 "$driver" "$ui" "$evidence/artwork-entry.mjs" desktop artwork \
    >"$evidence/native-artwork.log" 2>&1; then
    tail -70 "$evidence/native-artwork.log"; exit 1
fi
if grep -q '^FAIL:' "$evidence/native-artwork.log"; then tail -70 "$evidence/native-artwork.log"; exit 1; fi
grep '^PASS:' "$evidence/native-artwork.log"
PU_TEST_STORAGE="$evidence/cache/icon-test-storage.dat" "$ui" --test "$evidence/icons-entry.mjs" \
    >"$evidence/icon-resources.log" 2>&1
grep '^PASS:' "$evidence/icon-resources.log"
python3 "$root/desktop/tests/desktop-shortcuts-pixels.py" "$evidence" >"$evidence/native-pixels.log" 2>&1
cat "$evidence/native-pixels.log"
find "$evidence" -name '*.png' -exec sha256sum {} \; >"$evidence/png-hashes.txt"
