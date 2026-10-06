#!/bin/sh
set -eu
distribution=alpine3.24
recipe=desktop/release/Containerfile.live
base_image=localhost/polly-live-base
tools_image=localhost/polly-live-tools
if [ "${1:-}" = --debian ]; then
    distribution=debian13
    recipe=desktop/release/debian/Containerfile.live
    base_image=localhost/polly-debian-live-base
    tools_image=localhost/polly-debian-live-tools
    shift
fi
if [ "$#" -ne 1 ]; then echo "Usage: build-live.sh [--debian] OUTPUT_DIRECTORY" >&2; exit 2; fi
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo"
case "$1" in /*) output=$1 ;; *) output="$repo/$1" ;; esac
test ! -e "$output" || { echo "Output already exists: $output" >&2; exit 1; }
revision=${POLLY_SOURCE_REVISION:-$(git rev-parse HEAD)}
if [ -n "${POLLY_SOURCE_REVISION:-}" ]; then
    case "${POLLY_SOURCE_DIRTY:-}" in 0|1) dirty=$POLLY_SOURCE_DIRTY ;;
        *) echo "External revision requires POLLY_SOURCE_DIRTY=0 or 1" >&2; exit 2 ;; esac
else
    dirty=0
    if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then dirty=1; fi
fi
version=$(tr -d '\r' < desktop/VERSION)
case "$version" in ''|*[!a-zA-Z0-9.+_-]*) echo "Invalid Live version" >&2; exit 2 ;; esac
if [ "$distribution" = debian13 ]; then
    runtime=${POLLY_RUNTIME_IMAGE:-localhost/polly-debian-runtime}
else
    runtime=${POLLY_RUNTIME_IMAGE:-localhost/pollydesktop-alpha:$version}
fi
runtime_id=$(podman image inspect --format '{{.Id}}' "$runtime")
temporary=$(mktemp -d)
container=
cleanup() {
    if [ -n "$container" ]; then podman rm -f "$container" >/dev/null; fi
    rm -f "$temporary/root.tar"
    rmdir "$temporary"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
podman build --quiet --target live-base --build-arg "RUNTIME_IMAGE=$runtime" \
    -t "$base_image" -f "$recipe" desktop
if [ "$(podman image inspect --format '{{.Id}}' "$runtime")" != "$runtime_id" ]; then
    echo "Runtime image changed during the build; refusing ambiguous provenance" >&2
    exit 1
fi
if [ "$distribution" = debian13 ]; then
    podman run --rm --network=none -v "$repo:/workspace:ro" --entrypoint sh "$base_image" \
        /workspace/desktop/tests/debian-live-payload.sh
fi
podman build --quiet --target image-tools \
    -t "$tools_image" -f "$recipe" desktop
container=$(podman create "$base_image")
podman export --output "$temporary/root.tar" "$container"
podman rm "$container" >/dev/null
container=
mkdir -p "$(dirname -- "$output")"
podman run --rm --network=none \
    -v "$repo:/workspace:ro" -v "$temporary:/export:ro" \
    -v "$(dirname -- "$output"):/output" "$tools_image" \
    python3 /workspace/desktop/tools/build-live-image.py /export/root.tar "/output/$(basename -- "$output")" \
    --source-revision "$revision" --source-dirty "$dirty" --runtime-image "$runtime_id" \
    --distribution "$distribution"
