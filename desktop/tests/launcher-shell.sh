#!/bin/sh
set -eu
temporary=$(mktemp -d)
cleanup() {
    rm -f "$temporary/session.log"
    rm -rf "$temporary/config" "$temporary/data" "$temporary/cache"
    rmdir "$temporary/run"
    rmdir "$temporary"
}
trap cleanup EXIT
mkdir -m 700 "$temporary/run"
mkdir -p "$temporary/data/applications"
printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=Launch fixture' \
    'OnlyShowIn=Polly;' 'Exec=foot --app-id=org.pollyui.launch-fixture /bin/sh -c "sleep 0.3"' \
    >"$temporary/data/applications/launch-fixture.desktop"
export XDG_RUNTIME_DIR="$temporary/run" XDG_CONFIG_HOME="$temporary/config"
export XDG_DATA_HOME="$temporary/data" XDG_DATA_DIRS=/polly-no-system-apps XDG_CACHE_HOME="$temporary/cache"
export PU_RENDERER=raster SDL_RENDER_DRIVER=software
if ! sh "$1" --headless "$2" "$3" "$4" >"$temporary/session.log" 2>&1; then
    cat "$temporary/session.log"; exit 1
fi
if grep -q 'FAIL:' "$temporary/session.log" ||
   ! grep -q 'PASS: real Shell application launch complete' "$temporary/session.log" ||
   ! grep -q 'Mapped org.pollyui.launch-fixture' "$temporary/session.log"; then
    cat "$temporary/session.log"; exit 1
fi
echo "PASS: application menu launched a real independent foot client on PollyWM"
