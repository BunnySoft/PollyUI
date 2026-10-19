#!/bin/sh
# Build PollyWM against the Pixman-only wlroots prefix.
#
# Prerequisite: PIXMAN_DIR from desktop/tools/experiments/pixman-build.sh.
# The output binary must not link libgbm/libEGL/libGLES/libLLVM.
#
# Usage:
#   PIXMAN_DIR=$PWD/build/pixman-exp OUT=$PWD/build/minimal-zh \
#     sh desktop/release/minimal-zh/build-pollywm.sh
set -eu

out=${OUT:-"$PWD/build/minimal-zh"}
pixman=${PIXMAN_DIR:-"$PWD/build/pixman-exp"}
vol=${MINI_BUILD_VOLUME:-polly-minimal-zh-build}

test -f "$pixman/prefix/lib/libwlroots-0.19-polly-effects4.so"
mkdir -p "$out"
podman volume create "$vol" >/dev/null 2>&1 || true

podman run --rm --pull=never --network=none \
    -v "$PWD:/workspace:ro" -v "$vol:/build" -v "$pixman:/exp:ro" \
    localhost/polly-debian-sdk sh -c '
set -e
export PKG_CONFIG_PATH=/exp/prefix/lib/pkgconfig:/opt/pollyui-input/lib/pkgconfig:/opt/pollyui-text/lib/pkgconfig:/usr/local/lib/x86_64-linux-gnu/pkgconfig:/usr/local/lib/pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig
cmake -S /workspace -B /build/mini -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DPU_HOST=sdl \
  -DSKIA_ROOT=/opt/pollyui-skia -DSKIA_LIB_DIR=/opt/pollyui-skia/out/Release-linux \
  -DSDL3_DIR=/usr/local/lib/cmake/SDL3 \
  -DPU_BUILD_LAUNCHER=OFF -DPU_BUILD_DESKTOP=ON -DPU_DESKTOP_SERVICES=ON \
  -DPU_LAYER_SHELL=ON -DPU_BUILD_IME_ENGINE=OFF -DPU_BUILD_SESSION_AUTH=OFF \
  -DPU_WEBGL2=OFF -DPU_WEBGPU=OFF -DPU_METAL=OFF \
  >/build/configure.log 2>&1
cmake --build /build/mini --target pollywm --parallel 16 >/build/build.log 2>&1
cp /build/mini/desktop/pollywm /build/pollywm
'

podman run --rm --pull=never -v "$vol:/build" -v "$out:/out" \
    -v "$pixman:/exp:ro" localhost/polly-debian-sdk sh -c '
cp /build/pollywm /out/pollywm
ldd /build/pollywm > /out/ldd.txt
grep -E "gbm|EGL|GLES|LLVM" /out/ldd.txt && exit 1 || true
'
echo "PASS: Pixman PollyWM built at $out/pollywm"
