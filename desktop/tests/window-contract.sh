#!/bin/sh
set -eu
supervisor=${1:?Pass the native compositor fixture}
ui=${2:?Pass the GUI playground}
script=${3:?Pass the JS fixture}
capture=${4:?Pass a private capture prefix}
lifetime=${5:?Pass the native resource lifetime fixture}
close_driver=${6:?Pass the GUI close-tree fixture}
renderer=${7:?Pass the production windowless decorator runtime}
runtime=$(mktemp -d)
cleanup() {
    rm -f "$runtime/native-window-contract" "$runtime/native-window-contract.lock"
    rmdir "$runtime"
}
trap cleanup EXIT
export XDG_RUNTIME_DIR="$runtime" WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 WLR_RENDERER=pixman
timeout 20 "$supervisor" "$renderer" "$ui" "$script" "$capture"
timeout 20 "$supervisor" "$renderer" "$ui" "$script" "$capture" --tooltip
timeout 10 "$supervisor" "$renderer" "$ui" "$script" "$capture" --no-dialog
timeout 10 "$supervisor" "$renderer" "$lifetime" "$script" "$capture" --lifetime
timeout 15 "$supervisor" "$renderer" "$close_driver" "$(dirname "$script")/window-close-tree.mjs" "$capture" --close-tree
