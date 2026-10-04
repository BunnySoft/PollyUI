#!/bin/sh
set -eu
source=${1:?Pass the SDL source/build directory}
prefix=${2:-/usr/local}
revision=8e37db5e797b6167f3a00d697d816a684bd259c7
patch=$(CDPATH= cd -- "$(dirname -- "$0")/../patches" && pwd)/sdl-wayland-sync-lifetime.patch
if [ ! -d "$source/.git" ]; then
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch release-3.4.10 https://github.com/libsdl-org/SDL.git "$source"
fi
if [ "$(git -C "$source" rev-parse HEAD)" != "$revision" ]; then
    echo "SDL source revision does not match the pinned 3.4.10 build" >&2
    exit 1
fi
if git -C "$source" apply --check "$patch" 2>/dev/null; then
    git -C "$source" apply "$patch"
elif ! git -C "$source" apply --reverse --check "$patch" 2>/dev/null; then
    echo "SDL callback lifetime patch does not match this source tree" >&2
    exit 1
fi
cmake -S "$source" -B "$source/build-polly" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_INSTALL_LIBDIR=lib \
    -DSDL_SHARED=ON -DSDL_STATIC=OFF -DSDL_TESTS=OFF -DSDL_TEST_LIBRARY=OFF \
    -DSDL_WAYLAND=ON -DSDL_OPENGLES=ON -DSDL_IBUS=OFF -DSDL_WAYLAND_LIBDECOR=OFF
cmake --build "$source/build-polly" -j 2
cmake --install "$source/build-polly"
