#!/bin/sh
set -eu
build=${1:?Pass a build directory}
sanitize=${2:-}
if [ -n "$sanitize" ] && [ "$sanitize" != --sanitize ]; then
    echo "Usage: check-linux-runtime.sh build-directory [--sanitize]" >&2
    exit 2
fi
set -- cmake -S . -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo \
    -DPU_HOST=sdl -DSKIA_ROOT=/opt/pollyui-skia -DPU_BUILD_DESKTOP=ON
if [ "$sanitize" = --sanitize ]; then
    set -- "$@" -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
        -DCMAKE_C_FLAGS=-fsanitize=address,undefined -DCMAKE_CXX_FLAGS=-fsanitize=address,undefined
fi
"$@"
cmake --build "$build" -j 2
case "$build" in /*) binary="$build" ;; *) binary="$PWD/$build" ;; esac
sh desktop/tests/runtime-headless.sh "$binary/pollyui"
ctest --test-dir "$build" --output-on-failure
