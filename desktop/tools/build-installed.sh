#!/bin/sh
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] ||
    { [ "$#" -eq 2 ] && [ "$2" != --verification-fixture ]; }; then
    echo "Usage: build-installed.sh OUTPUT_DIRECTORY [--verification-fixture]" >&2
    exit 2
fi
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
live=${POLLY_LIVE_IMAGE:-localhost/polly-debian-live-base}
live_id=$(podman image inspect --format '{{.Id}}' "$live")
tools=localhost/polly-debian-live-tools
base=localhost/polly-debian-installed-base
sdk_id=$(podman image inspect --format '{{.Id}}' "${POLLY_SDK_IMAGE:-localhost/polly-debian-sdk-mesa:polly1}")
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
podman run --rm --network=none -v "$repo:/workspace:ro" --entrypoint sh "$live_id" \
    /workspace/desktop/tests/debian-live-payload.sh
podman build --quiet --build-arg "LIVE_IMAGE=$live_id" --build-arg "SDK_IMAGE=$sdk_id" -t "$base" \
    -f desktop/release/debian/Containerfile.install desktop
base_id=$(podman image inspect --format '{{.Id}}' "$base")
podman build --quiet --target image-tools -t "$tools" \
    -f desktop/release/debian/Containerfile.live desktop
tools_id=$(podman image inspect --format '{{.Id}}' "$tools")
container=$(podman create "$base_id")
podman export --output "$temporary/root.tar" "$container"
podman rm "$container" >/dev/null
container=
mkdir -p "$(dirname -- "$output")"
fixture=
if [ "${2:-}" = --verification-fixture ]; then fixture=--verification-fixture; fi
podman run --rm --network=none -v "$repo:/workspace:ro" -v "$temporary:/export:ro" \
    -v "$(dirname -- "$output"):/output" "$tools_id" \
    python3 /workspace/desktop/tools/build-installed-image.py /export/root.tar \
    "/output/$(basename -- "$output")" --source-revision "$revision" --source-dirty "$dirty" \
    --base-image "$base_id" $fixture
