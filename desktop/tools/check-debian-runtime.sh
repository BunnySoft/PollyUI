#!/bin/sh
set -eu
build=${1:?Pass a Debian build directory}
sanitize=${2:-}
case "$sanitize" in ''|--sanitize) ;; *) echo "Unknown check option: $sanitize" >&2; exit 2 ;; esac
set -- cmake -S . -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo \
    -DPU_HOST=sdl -DSKIA_ROOT=/opt/pollyui-skia -DPU_BUILD_DESKTOP=ON \
    -DPU_BUILD_IME_ENGINE=ON -DPU_BUILD_SESSION_AUTH=ON \
    -DSDL3_DIR=/usr/local/lib/cmake/SDL3 -DCMAKE_INSTALL_LIBDIR=lib \
    '-DCMAKE_INSTALL_RPATH=$ORIGIN/../lib/pollyui'
if [ "$sanitize" = --sanitize ]; then
    set -- "$@" -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
        -DCMAKE_C_FLAGS=-fsanitize=address,undefined -DCMAKE_CXX_FLAGS=-fsanitize=address,undefined
fi
"$@"
cmake --build "$build" -j 2
case "$build" in /*) binary="$build/pollyui" ;; *) binary="$PWD/$build/pollyui" ;; esac
sh tools/test-core.sh "$binary"
ctest --test-dir "$build" --output-on-failure
