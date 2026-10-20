#!/bin/sh
# Run from the repository root on Linux. Existing demo builds are unchanged.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../../.." && pwd)
product=${MICRO_PRODUCT:-micro}
case "$product" in
    mini) image=mini; default_work="$repo/build/mini" ;;
    micro) image=micro-shell; default_work="$repo/build/micro-shell" ;;
    *) echo "Unknown product for the Alpine Shell recipe: $product" >&2; exit 2 ;;
esac
work=${MICRO_WORK:-"$default_work"}
base=${MICRO_BUILDER:-localhost/polly-micro-builder}
builder=${MICRO_SHELL_BUILDER:-localhost/polly-micro-shell-builder}
sdk=${MICRO_SDK:-localhost/polly-debian-sdk}

mkdir -p "$work"
work=$(CDPATH= cd -- "$work" && pwd)
case "$work" in /|"$repo"|"$HOME") echo "Refusing an unsafe Micro work directory" >&2; exit 2 ;; esac
podman image exists "$sdk"
if ! podman image exists "$base" >/dev/null 2>&1; then
    podman build -t "$base" -f "$here/Containerfile" "$here"
fi
podman build --build-arg "MICRO_BASE=$base" -t "$builder" \
    -f "$here/Containerfile.shell" "$here"

podman run --rm --pull=never --network=none \
    -v "$work:/work" "$sdk" sh -ec '
for pair in wlroots-0.19.3:src pollyui-skia:skia pollyui-sdl:sdl; do
    source=${pair%:*}
    destination=${pair#*:}
    if [ "$destination" = src ]; then
        rm -rf /work/src
    fi
    if [ ! -d "/work/$destination" ]; then
        cp -a "/opt/$source" "/work/$destination"
    fi
done
'
podman run --rm --pull=never --network=none \
    -e MICRO_VARIANT=shell -e MICRO_PRODUCT="$product" -e PU_BUILD_JOBS="${PU_BUILD_JOBS:-2}" \
    -v "$work:/work" -v "$here:/src:ro" -v "$repo:/repo:ro" \
    "$builder" sh /src/build-inside.sh

test -s "$work/$image.iso"
sha256sum "$work/$image.iso"
ls -lh "$work/$image.iso"
