#!/bin/sh
# Uses the paired source trees copied from the existing SDK, rebuilt for musl.
set -eu

jobs=${PU_BUILD_JOBS:-2}
prefix=/work/prefix
run_logged() {
    log=$1
    shift
    if "$@" > "$log" 2>&1; then
        return 0
    else
        status=$?
        tail -n 60 "$log" >&2
        return "$status"
    fi
}
for pin in \
    skia:08a5439a6be726021c1c1905d23ce298a3edc5e4 \
    sdl:8e37db5e797b6167f3a00d697d816a684bd259c7; do
    name=${pin%:*}
    expected=${pin#*:}
    actual=$(git -c safe.directory="/work/$name" -C "/work/$name" rev-parse HEAD)
    [ "$actual" = "$expected" ] || { echo "Wrong source revision for $name: $actual" >&2; exit 1; }
done
git -c safe.directory=/work/skia -C /work/skia diff --quiet HEAD --

mkdir -p /work/skia/out/Release-micro
sed -e 's/skia_enable_ganesh = true/skia_enable_ganesh = false/' \
    -e 's/skia_use_gl = true/skia_use_gl = false/' \
    /repo/desktop/tools/skia-linux.gn > /work/skia/out/Release-micro/args.gn
(cd /work/skia && run_logged /work/skia-configure.log \
    gn gen out/Release-micro --fail-on-unused-args)
run_logged /work/skia-build.log ninja -C /work/skia/out/Release-micro -j "$jobs" skia

for patch in sdl-wayland-sync-lifetime.patch sdl-wayland-shm-framebuffer.patch; do
    if git -C /work/sdl apply --check "/repo/desktop/patches/$patch" 2>/dev/null; then
        git -C /work/sdl apply "/repo/desktop/patches/$patch"
    else
        git -C /work/sdl apply --reverse --check "/repo/desktop/patches/$patch"
    fi
done
run_logged /work/sdl-configure.log cmake -S /work/sdl -B /work/sdl/build-micro -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_INSTALL_LIBDIR=lib \
    -DSDL_SHARED=ON -DSDL_STATIC=OFF -DSDL_TESTS=OFF -DSDL_TEST_LIBRARY=OFF \
    -DSDL_WAYLAND=ON -DSDL_WAYLAND_SHARED=OFF -DSDL_WAYLAND_LIBDECOR=OFF -DSDL_IBUS=OFF \
    -DSDL_OPENGL=OFF -DSDL_OPENGLES=OFF -DSDL_VULKAN=OFF -DSDL_X11=OFF \
    -DSDL_KMSDRM=OFF -DSDL_ALSA=OFF -DSDL_PIPEWIRE=OFF -DSDL_PULSEAUDIO=OFF -DSDL_JACK=OFF
run_logged /work/sdl-build.log cmake --build /work/sdl/build-micro -j "$jobs"
run_logged /work/sdl-install.log cmake --install /work/sdl/build-micro

export PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$prefix/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
run_logged /work/ui-configure.log cmake -S /repo -B /work/ui -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DCMAKE_INSTALL_PREFIX=/usr -DPU_HOST=sdl \
    -DSKIA_ROOT=/work/skia -DSKIA_LIB_DIR=/work/skia/out/Release-micro \
    -DSDL3_DIR="$prefix/lib/cmake/SDL3" \
    -DPU_BUILD_LAUNCHER=ON -DPU_BUILD_DESKTOP=ON -DPU_DESKTOP_SERVICES=ON \
    -DPU_LAYER_SHELL=ON -DPU_BUILD_IME_ENGINE=OFF -DPU_BUILD_SESSION_AUTH=OFF \
    -DPU_WEBGL2=OFF -DPU_WEBGPU=OFF -DPU_METAL=OFF -DPU_SKIA_RASTER_ONLY=ON
run_logged /work/ui-build.log cmake --build /work/ui --target pollyui pollywm -j "$jobs"
