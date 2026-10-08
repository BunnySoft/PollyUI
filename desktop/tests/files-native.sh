#!/bin/sh
set -eu
test "$(id -u)" = 1000
test "$(id -g)" = 1000
repo=${1:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
build=$(mktemp -d /tmp/polly-files-build-XXXXXX)
cc -std=c11 -Wall -Wextra -Werror -DPU_FILES_CORE_ONLY -I"$repo/src/desktop" \
    "$repo/src/desktop/files.c" "$repo/desktop/tests/files-native.c" -lcrypto -o "$build/files-native"
"$build/files-native"
cc -std=c11 -Wall -Wextra -Werror -I"$repo/third_party/quickjs" -I"$repo/src/desktop" \
    -c "$repo/src/desktop/files.c" -o "$build/files.o"
cc -std=c11 -Wall -Wextra -Werror -I"$repo/third_party/quickjs" -I"$repo/src/desktop" \
    -c "$repo/desktop/tests/files-api-native.c" -o "$build/api.o"
cc -D_GNU_SOURCE -O0 -I"$repo/third_party/quickjs" \
    "$repo/third_party/quickjs/quickjs.c" "$repo/third_party/quickjs/dtoa.c" \
    "$repo/third_party/quickjs/libregexp.c" "$repo/third_party/quickjs/libunicode.c" \
    "$build/files.o" "$build/api.o" -lm -lpthread -ldl -lcrypto -o "$build/files-api-native"
"$build/files-api-native" "$repo/desktop/tests/files-api-native.js"
sha256sum "$repo/src/desktop/files.c" "$repo/src/desktop/files.h" "$build/files-native" "$build/files-api-native"
