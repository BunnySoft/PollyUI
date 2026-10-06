#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo"
# debootstrap needs temporary /dev and /proc mounts inside the bootstrap namespace.
podman build --cap-add SYS_ADMIN --target minbase -t localhost/polly-debian-minbase \
    -f desktop/release/debian/Containerfile desktop
podman build -t localhost/polly-debian-sdk -f desktop/release/debian/Containerfile.sdk desktop
