#!/bin/sh
set -eu
# Only run in the private rootless container with explicit fixture mounts/marker.
test "$(id -u)" = 0
test -f /run/polly-readonly-private-fixture
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cc -std=c11 -Wall -Wextra -Werror -I"$repo/third_party/quickjs" \
    -I"$repo/src/desktop" \
    '-DPU_INSTALL_TARGETS_HELPER="/usr/lib/pollyui/install-targets/install/fixture-helper.py"' \
    -Dclock_gettime=pu_install_fixture_clock_gettime -Dread=pu_install_fixture_read \
    -Dwaitpid=pu_install_fixture_waitpid \
    -c "$repo/src/desktop/install-targets.c" -o /tmp/install-targets.o
cc -std=c11 -Wall -Wextra -Werror -I"$repo/third_party/quickjs" \
    -I"$repo/src/desktop" -c "$repo/desktop/tests/install-readonly-native.c" \
    -o /tmp/install-readonly-native.o
cc -D_GNU_SOURCE -O0 -I"$repo/third_party/quickjs" \
    "$repo/third_party/quickjs/quickjs.c" "$repo/third_party/quickjs/dtoa.c" \
    "$repo/third_party/quickjs/libregexp.c" "$repo/third_party/quickjs/libunicode.c" \
    /tmp/install-targets.o /tmp/install-readonly-native.o -lm -lpthread -ldl \
    -o /tmp/install-readonly-native
sha256sum "$repo/src/desktop/install-targets.c" \
    "$repo/desktop/release/install/readonly-helper.py" /tmp/install-readonly-native
python3 -B "$repo/desktop/tests/install-readonly-fixture.py" "$@"
