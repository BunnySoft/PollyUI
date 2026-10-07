#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then
    echo "Usage: test-offline-debian.sh REPOSITORY_RELATIVE_RUNTIME REPOSITORY_RELATIVE_INPUT_PACK" >&2
    exit 2
fi
for argument in "$@"; do
    case "$argument" in ''|/*|*\\*|*:*|.|..|../*|*/../*|*/..)
        echo "Inputs must be explicit repository-relative directories." >&2; exit 2 ;;
    esac
done
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
runtime=$repo/$1
inputs=$repo/$2
test -d "$runtime"
test -d "$inputs"
podman run --rm --network=none -v "$repo:/workspace:ro" -w /workspace localhost/polly-debian-sdk \
    sh -ec 'node desktop/tests/package-manifest.mjs "$1"; python3 -B desktop/tools/retain-debian-packages.py "$2" --verify; cmp "$1/runtime-packages.txt" "$2/runtime-packages.txt"' \
    sh "/workspace/$1" "/workspace/$2"
podman run --rm --network=none -v "$runtime:/runtime:ro" -v "$inputs:/inputs:ro" \
    -v "$repo/desktop/tests/bundle-sample:/fixture:ro" \
    -v "$repo/desktop/tests/offline-debian-runtime.sh:/offline-check.sh:ro" \
    localhost/polly-debian-minbase sh /offline-check.sh
