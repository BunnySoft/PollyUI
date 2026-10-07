#!/bin/sh
set -eu
mode=${1:-fast}
if [ "$#" -gt 1 ]; then
    echo "Usage: check-storage.sh [fast|mounts|initramfs|migration]" >&2
    exit 2
fi
case "$mode" in fast|mounts|initramfs|migration) ;; *)
    echo "Usage: check-storage.sh [fast|mounts|initramfs|migration]" >&2; exit 2 ;;
esac
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
sdk=${POLLY_SDK_IMAGE:-localhost/polly-debian-sdk-mesa:polly1}
podman image exists "$sdk" || { echo "Cached SDK is missing: $sdk" >&2; exit 1; }
podman run --rm --network=none -v "$repo:/workspace:ro" "$sdk" \
    python3 -I -B /workspace/desktop/tools/check-storage.py /workspace
if [ "$mode" = migration ]; then
    native=${POLLY_NATIVE_BUILD_VOLUME:-polly-debian-build-fde67803}
    podman volume exists "$native" || { echo "Cached native build is missing: $native" >&2; exit 1; }
    podman run --rm --network=none --cap-add=SYS_ADMIN --security-opt seccomp=unconfined \
        -v "$repo:/workspace:ro" -v "$native:/build:ro" "$sdk" \
        python3 -I -B /workspace/desktop/tests/storage-managed-migration-fixture.py \
        /workspace /build/normal/polly-app
elif [ "$mode" != fast ]; then
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
        installed=${POLLY_INSTALLED_IMAGE:-localhost/polly-debian-installed-base}
        podman image exists "$installed" || { echo "Cached installed base is missing: $installed" >&2; exit 1; }
        podman run --rm --network=none --cap-add=SYS_ADMIN --security-opt seccomp=unconfined \
            -v "$repo:/workspace:ro" "$installed" \
            python3 -I -B /workspace/desktop/tests/storage-account-migration-fixture.py /workspace
        for profile in installed live recovery; do
            podman run --rm --network=none -v "$repo:/workspace:ro" "$installed" \
                python3 -I -B /workspace/desktop/tests/account-profile-fixture.py /workspace "$profile"
        done
    fi
fi
