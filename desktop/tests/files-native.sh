#!/bin/sh
set -eu
test "$(id -u)" = 1000
test "$(id -g)" = 1000
repo=${1:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
build=$(mktemp -d /tmp/polly-files-build-XXXXXX)
cc -std=c11 -Wall -Wextra -Werror -I"$repo" \
    -Dfdopendir=pu_files_fixture_fdopendir -c "$repo/sysrt/providers/linux/files.c" -o "$build/core.o"
cc -std=c11 -Wall -Wextra -Werror -I"$repo" \
    "$build/core.o" "$repo/desktop/tests/files-native.c" -lcrypto -o "$build/files-native"
"$build/files-native"
cc -std=c11 -Wall -Wextra -Werror -I"$repo" \
    -c "$repo/sysrt/providers/linux/files.c" -o "$build/files.o"
cc -std=c11 -Wall -Wextra -Werror -I"$repo/third_party/quickjs" -I"$repo" \
    -c "$repo/sysrt/projection/quickjs/files.c" -o "$build/projection.o"
cc -std=c11 -Wall -Wextra -Werror -I"$repo/third_party/quickjs" -I"$repo" \
    -c "$repo/desktop/tests/files-api-native.c" -o "$build/api.o"
cc -D_GNU_SOURCE -O0 -I"$repo/third_party/quickjs" \
    "$repo/third_party/quickjs/quickjs.c" "$repo/third_party/quickjs/dtoa.c" \
    "$repo/third_party/quickjs/libregexp.c" "$repo/third_party/quickjs/libunicode.c" \
    "$build/files.o" "$build/projection.o" "$build/api.o" -lm -lpthread -ldl -lcrypto -o "$build/files-api-native"
"$build/files-api-native" "$repo/desktop/tests/files-api-native.js"
sha256sum "$repo/sysrt/providers/linux/files.c" "$repo/sysrt/providers/linux/files.h" \
    "$repo/sysrt/projection/quickjs/files.c" "$repo/sysrt/projection/quickjs/files.h" \
    "$build/files-native" "$build/files-api-native"
