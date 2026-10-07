#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
    echo "Usage: check-debian-updates.sh REPOSITORY_RELATIVE_RUNTIME_RELEASE_DIRECTORY" >&2
    exit 2
fi
case "$1" in ''|/*|*\\*|*:*|.|..|../*|*/../*|*/..)
    echo "Choose a release directory inside the repository." >&2
    exit 2 ;;
esac
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
test -d "$repo/$1" || { echo "Release directory is missing." >&2; exit 1; }
podman run --rm -v "$repo:/workspace:ro" -w /workspace localhost/polly-debian-sdk \
    sh -ec 'apt-get update -qq -o APT::Update::Error-Mode=any >&2; exec node desktop/tools/debian-update-report.mjs "$1"' sh "/workspace/$1"
