#!/bin/sh
set -eu
runtime=$(mktemp -d)
trap 'rmdir "$runtime"' EXIT
chmod 700 "$runtime"
export XDG_RUNTIME_DIR="$runtime"
exec_timeout=20
for scenario in text binary empty above-quota multi-format blocked sender-error sdl self reverse released getter-detach cancel escape close owner-close generation target-exit after-drop-exit gc detach quit seat-loss global-loss connection-loss reentrant refuse; do
    timeout "$exec_timeout" "$1" "$2" "$3" "$scenario"
done
