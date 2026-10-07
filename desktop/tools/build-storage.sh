#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
    echo "Usage: build-storage.sh OUTPUT_DIRECTORY" >&2
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
installed_id=$(podman image inspect --format '{{.Id}}' "${POLLY_INSTALLED_IMAGE:-localhost/polly-debian-installed-base}")
sdk_id=$(podman image inspect --format '{{.Id}}' "${POLLY_SDK_IMAGE:-localhost/polly-debian-sdk-mesa:polly1}")
tools_id=$(podman image inspect --format '{{.Id}}' "${POLLY_IMAGE_TOOLS:-localhost/polly-debian-live-tools}")
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
podman build --quiet --network=none --build-arg "INSTALLED_IMAGE=$installed_id" --build-arg "SDK_IMAGE=$sdk_id" \
    -t localhost/polly-debian-storage-base -f desktop/release/debian/Containerfile.storage desktop
base_id=$(podman image inspect --format '{{.Id}}' localhost/polly-debian-storage-base)
container=$(podman create "$base_id")
podman export --output "$temporary/root.tar" "$container"
podman rm "$container" >/dev/null
container=
mkdir -p "$(dirname -- "$output")"
podman run --rm --network=none -v "$repo:/workspace:ro" -v "$temporary:/export:ro" \
    -v "$(dirname -- "$output"):/output" "$tools_id" \
    python3 -B /workspace/desktop/tools/build-storage-image.py /export/root.tar \
    "/output/$(basename -- "$output")" --source-revision "$revision" --source-dirty "$dirty" \
    --base-image "$base_id"
