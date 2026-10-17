#!/bin/sh
set -eu
driver=$1
ui=$2
wire=$3
temporary=$(mktemp -d)
cleanup() {
    rm -f "$temporary/run/decorator-fixture" "$temporary/run/decorator-fixture.lock"
    rm -f "$temporary/lifecycle.log"
    rm -rf "$temporary/config" "$temporary/data" "$temporary/cache"
    rmdir "$temporary/run" "$temporary"
}
trap cleanup EXIT
mkdir -m 700 "$temporary/run"
export XDG_RUNTIME_DIR="$temporary/run" XDG_CONFIG_HOME="$temporary/config"
export XDG_DATA_HOME="$temporary/data" XDG_CACHE_HOME="$temporary/cache"
export WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 WLR_RENDERER=pixman
export SDL_VIDEODRIVER=wayland SDL_RENDER_DRIVER=software PU_RENDERER=raster
for mode in ${4:-cold-missing cold normal crash cold-saved cold-corrupt cold-legacy}; do
    preferences="$temporary/config/pollyui/org.pollyui.shell/shell-preferences.json"
    legacy="$temporary/data/pollyui/org.pollyui.shell/localstorage.dat"
    case "$mode" in
        cold-saved)
            mkdir -p "$(dirname "$preferences")"
            chmod 700 "$(dirname "$preferences")"
            printf '%s\n' '{"version":2,"theme":{"id":"server2003","filesEnabled":false},"audio":null,"display":null,"workspace":null,"shortcuts":null,"desktop":{"version":1,"shortcuts":[]}}' >"$preferences"
            chmod 600 "$preferences" ;;
        cold-corrupt)
            mkdir -p "$(dirname "$preferences")"
            chmod 700 "$(dirname "$preferences")"
            printf '%s\n' 'not valid configuration JSON' >"$preferences"
            chmod 600 "$preferences" ;;
        cold-legacy)
            rm -f "$preferences"
            mkdir -p "$(dirname "$legacy")"
            chmod 700 "$(dirname "$legacy")"
            printf 'PUST1\n13\ndesktop.theme\n10\nserver2003\n' >"$legacy"
            chmod 600 "$legacy" ;;
    esac
    before=
    if [ -f "$preferences" ]; then before=$(cksum "$preferences"); fi
    if ! timeout -k 3 25 "$driver" "$ui" "$wire" "$mode" >"$temporary/lifecycle.log" 2>&1; then
        cat "$temporary/lifecycle.log"; exit 1
    fi
    if grep -E 'Frame failed:|GUI callback failed|Decorator exited with status [1-9]' "$temporary/lifecycle.log"; then
        cat "$temporary/lifecycle.log"; exit 1
    fi
    grep -q 'Decorator exited with status 0' "$temporary/lifecycle.log"
    grep '^PASS:' "$temporary/lifecycle.log"
    if [ -n "$before" ]; then
        [ "$before" = "$(cksum "$preferences")" ]
    else
        [ ! -e "$preferences" ]
    fi
    [ ! -e "$preferences.lock" ]
    [ ! -d "$temporary/config/pollyui/org.pollyui.decorator" ]
    [ ! -d "$temporary/data/pollyui/org.pollyui.decorator" ]
    [ ! -d "$temporary/cache/pollyui/org.pollyui.decorator" ]
    if [ "$mode" = cold-missing ]; then
        [ ! -d "$temporary/config/pollyui/org.pollyui.shell" ]
        [ ! -d "$temporary/data/pollyui/org.pollyui.shell" ]
    fi
done
