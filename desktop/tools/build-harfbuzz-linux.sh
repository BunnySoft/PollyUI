#!/bin/sh
set -eu
source=${1:?Pass the HarfBuzz source/build directory}
prefix=${2:-/opt/pollyui-text}
revision=6f4c5cec306d31e6822303f5ba248a14293d588e
if [ ! -d "$source/.git" ]; then
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch 13.2.1 \
        https://github.com/harfbuzz/harfbuzz.git "$source"
fi
if [ "$(git -C "$source" rev-parse HEAD)" != "$revision" ]; then
    echo "HarfBuzz revision does not match the pinned toolkit-free build" >&2
    exit 1
fi
meson setup "$source/build-polly" "$source" --prefix "$prefix" --libdir lib --buildtype release --default-library=static \
    --wrap-mode nofallback -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled \
    -Dfreetype=disabled -Dicu=disabled -Dgraphite2=disabled -Dintrospection=disabled \
    -Ddocs=disabled -Dtests=disabled -Dutilities=disabled -Dsubset=disabled -Draster=disabled -Dvector=disabled
meson compile -C "$source/build-polly" -j 2
meson install -C "$source/build-polly"
