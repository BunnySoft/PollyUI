#!/bin/sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
product=${MICRO_PRODUCT:-micro}
case "$product" in
    mini) image=mini; default_work="$PWD/build/mini" ;;
    micro) image=micro-shell; default_work="$PWD/build/micro-shell" ;;
    *) echo "Unknown Alpine Shell product: $product" >&2; exit 2 ;;
esac
work=${MICRO_WORK:-"$default_work"}
tools=${MICRO_TOOLS:-localhost/polly-sku-live-tools}
test -s "$work/$image.iso"
podman run --rm --pull=never --network=none --device /dev/kvm \
    -v "$work:/test" -v "$here:/src:ro" "$tools" \
    python3 /src/test-shell.py /test --product "$product" --display "${MICRO_DISPLAY:-virtio}" "$@"
