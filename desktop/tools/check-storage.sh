#!/bin/sh
set -eu
mode=${1:-fast}
if [ "$#" -gt 1 ]; then
    echo "Usage: check-storage.sh [fast|mounts|initramfs]" >&2
    exit 2
fi
case "$mode" in fast|mounts|initramfs) ;; *)
    echo "Usage: check-storage.sh [fast|mounts|initramfs]" >&2; exit 2 ;;
esac
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
sdk=${POLLY_SDK_IMAGE:-localhost/polly-debian-sdk-mesa:polly1}
podman image exists "$sdk" || { echo "Cached SDK is missing: $sdk" >&2; exit 1; }
podman run --rm --network=none -v "$repo:/workspace:ro" "$sdk" \
    python3 -I -B /workspace/desktop/tools/check-storage.py /workspace
if [ "$mode" != fast ]; then
    base=${POLLY_STORAGE_IMAGE:-localhost/polly-debian-storage-base}
    podman image exists "$base" || { echo "Cached storage base is missing: $base" >&2; exit 1; }
    if [ "$mode" = initramfs ]; then
        podman run --rm --network=none --cap-add=SYS_ADMIN --security-opt seccomp=unconfined \
            -v "$repo:/workspace:ro" "$base" sh -c \
            'python3 -I -B /workspace/desktop/tests/storage-early-usr.py /workspace --initramfs /boot/initrd.img-*'
    else
        podman run --rm --network=none --cap-add=SYS_ADMIN --security-opt seccomp=unconfined \
            -v "$repo:/workspace:ro" "$base" sh -c \
            'python3 -I -B /workspace/desktop/tests/storage-early-usr.py /workspace &&
             python3 -I -B /workspace/desktop/tests/storage-mount-fixture.py /workspace &&
             python3 -I -B /workspace/desktop/tests/storage-home-migration-fixture.py /workspace'
    fi
fi
