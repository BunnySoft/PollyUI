#!/bin/sh
set -eu

if [ "$(uname -s)" != Linux ] || [ "$#" -ne 1 ]; then
    echo "Usage (Linux): sh build-skia-linux.sh /absolute/skia-source-directory" >&2
    exit 2
fi
source_dir=$1
case "$source_dir" in
    /*) ;;
    *) echo "Skia source directory must be absolute" >&2; exit 2 ;;
esac
for tool in git python3 gn ninja clang-18 clang++-18 pkg-config; do
    if ! command -v "$tool" >/dev/null; then
        echo "Missing build dependency: $tool" >&2
        exit 1
    fi
done
pkg-config --exists fontconfig freetype2 libpng libjpeg libwebp libwebpdemux libwebpmux zlib
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
revision=08a5439a6be726021c1c1905d23ce298a3edc5e4
if [ ! -e "$source_dir" ]; then
    git init -q "$source_dir"
    git -C "$source_dir" remote add origin https://github.com/aseprite/skia.git
    git -C "$source_dir" fetch -q --depth=1 origin "$revision"
    git -C "$source_dir" checkout -q --detach FETCH_HEAD
fi
if [ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ]; then
    echo "Skia source must be the pinned revision $revision; refusing another checkout" >&2
    exit 1
fi
if ! git -C "$source_dir" diff --quiet HEAD --; then
    echo "Skia checkout has source changes; refusing to build a modified dependency" >&2
    exit 1
fi
cd "$source_dir"
mkdir -p out/Release-linux
cp "$here/skia-linux.gn" out/Release-linux/args.gn
gn gen out/Release-linux --fail-on-unused-args
# Keep memory/CPU use bounded on shared development machines.
ninja -C out/Release-linux -j "${PU_BUILD_JOBS:-2}" skia
test -f out/Release-linux/libskia.a
printf '\nSKIA_ROOT=%s\nSKIA_LIB_DIR=%s/out/Release-linux\n' "$source_dir" "$source_dir"
