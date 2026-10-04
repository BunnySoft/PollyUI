#!/bin/sh
set -eu
usage() {
    echo "Usage: run-session.sh [--nested | --headless] [--restarts COUNT] pollywm pollyui shell-script [ARG...]" >&2
}
mode=auto
restarts=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --nested|--headless)
            if [ "$mode" != auto ]; then usage; exit 2; fi
            mode=${1#--}; shift ;;
        --restarts)
            if [ "$#" -lt 2 ]; then usage; exit 2; fi
            restarts=$2; shift 2
            case "$restarts" in ''|*[!0-9]*) usage; exit 2 ;; esac ;;
        --help) usage; exit 0 ;;
        --*) usage; exit 2 ;;
        *) break ;;
    esac
done
if [ "$#" -lt 3 ]; then usage; exit 2; fi
wm=$1
ui=$2
script=$3
shift 3
case "$wm" in /*) ;; *) wm="$PWD/$wm" ;; esac
case "$ui" in /*) ;; *) ui="$PWD/$ui" ;; esac
case "$script" in /*) ;; *) script="$PWD/$script" ;; esac
if [ ! -x "$wm" ] || [ ! -x "$ui" ] || [ ! -r "$script" ]; then
    echo "Session requires executable pollywm/pollyui and a readable shell script" >&2
    exit 1
fi
parent=${WAYLAND_DISPLAY:-}
if [ "$mode" = nested ]; then
    if [ -z "$parent" ]; then echo "Nested mode requires WAYLAND_DISPLAY" >&2; exit 1; fi
    case "$parent" in /*) ;; *) parent="${XDG_RUNTIME_DIR:?}/$parent" ;; esac
    if [ ! -S "$parent" ]; then echo "Parent Wayland socket is unavailable: $parent" >&2; exit 1; fi
    export WLR_BACKENDS=wayland WLR_RENDERER="${WLR_RENDERER:-pixman}"
elif [ "$mode" = headless ]; then
    export WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS="${WLR_HEADLESS_OUTPUTS:-1}"
    export WLR_RENDERER="${WLR_RENDERER:-pixman}"
fi
base=${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}
case "$base" in /*) ;; *) echo "Runtime base must be an absolute directory" >&2; exit 1 ;; esac
runtime=$(mktemp -d "$base/polly-session.XXXXXX")
pid=
cleanup() {
    if [ -n "$pid" ]; then
        kill -TERM "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    rm -f "$runtime/pollywm-0" "$runtime/pollywm-0.lock"
    rmdir "$runtime"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo"
export XDG_RUNTIME_DIR="$runtime" SDL_VIDEODRIVER=wayland XDG_CURRENT_DESKTOP=Polly XDG_SESSION_TYPE=wayland
printf 'PollyDesktop runtime: %s\nClient display: %s/pollywm-0\n' "$runtime" "$runtime"
WAYLAND_DISPLAY="$parent" "$wm" --socket pollywm-0 --shell-restarts "$restarts" \
    --exit-with-shell --shell "$ui" --desktop --app-id org.pollyui.shell "$script" "$@" &
pid=$!
if wait "$pid"; then result=0; else result=$?; fi
pid=
exit "$result"
