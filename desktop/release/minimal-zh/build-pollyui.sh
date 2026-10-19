#!/bin/sh
# Build the PollyUI shell without WebGL/GLES/Vulkan/GBM.
#
# Usage:
#   OUT=$PWD/build/minimal-zh sh desktop/release/minimal-zh/build-pollyui.sh
set -eu

out=${OUT:-"$PWD/build/minimal-zh"}
vol=${MINI_UI_VOLUME:-polly-minimal-zh-ui}
mkdir -p "$out"
podman volume create "$vol" >/dev/null 2>&1 || true

podman run --rm --pull=never --network=none \
    -v "$PWD:/workspace:ro" -v "$vol:/build" \
    localhost/polly-debian-sdk sh -c '
set -e
cmake -S /workspace -B /build/ui -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DPU_HOST=sdl \
  -DSKIA_ROOT=/opt/pollyui-skia -DSKIA_LIB_DIR=/opt/pollyui-skia/out/Release-linux \
  -DSDL3_DIR=/usr/local/lib/cmake/SDL3 \
  -DPU_BUILD_LAUNCHER=ON -DPU_BUILD_DESKTOP=OFF -DPU_DESKTOP_SERVICES=OFF \
  -DPU_LAYER_SHELL=ON -DPU_BUILD_IME_ENGINE=OFF -DPU_BUILD_SESSION_AUTH=OFF \
  -DPU_WEBGL2=OFF -DPU_WEBGPU=OFF -DPU_METAL=OFF \
  >/build/configure.log 2>&1
cmake --build /build/ui --target pollyui --parallel 16 >/build/build.log 2>&1
cp /build/ui/pollyui /build/pollyui
'

podman run --rm --pull=never -v "$vol:/build" -v "$out:/out" \
    localhost/polly-debian-sdk sh -c '
cp /build/pollyui /out/pollyui
ldd /build/pollyui > /out/pollyui-ldd.txt
grep -E "gbm|EGL|GLES|LLVM" /out/pollyui-ldd.txt && exit 1 || true
'
echo "PASS: CPU-only PollyUI built at $out/pollyui"
