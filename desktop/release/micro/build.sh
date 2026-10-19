#!/bin/sh
# Build the Micro prototype ISO. Run from the repository root:
#   MICRO_WORK=$PWD/build/micro sh desktop/release/micro/build.sh
#
# The output is an experimental Alpine/musl single-application image. It is not
# a PollyOS Debian desktop and does not include Rime, PAM or the PollyUI shell.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=${MICRO_WORK:-"$PWD/build/micro"}
builder=${MICRO_BUILDER:-localhost/polly-micro-builder}
sdk=${MICRO_SDK:-localhost/polly-debian-sdk}

mkdir -p "$work"
if ! podman image exists "$builder" >/dev/null 2>&1; then
    podman build -t "$builder" -f "$here/Containerfile" "$here"
fi

# Reuse the Polly scene-effects wlroots source that is already pinned in the SDK.
podman run --rm --pull=never -v "$work:/work" "$sdk" \
    sh -c 'rm -rf /work/src && cp -a /opt/wlroots-0.19.3 /work/src'

podman run --rm --pull=never -v "$work:/work" -v "$here:/src:ro" "$builder" \
    sh /src/build-inside.sh

test -s "$work/micro.iso"
ls -lh "$work/micro.iso"
