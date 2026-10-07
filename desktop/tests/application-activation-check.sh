#!/bin/sh
set -eu
# Only scoped source checks and fixture infrastructure; never build PollyUI or use a native cache.
cd "$(dirname "$0")/../.."
if [ "$#" -ne 1 ]; then echo "Usage: $0 ABSOLUTE_EVIDENCE_DIRECTORY" >&2; exit 2; fi
case "$1" in /*) output=$1 ;; *) echo "Evidence directory must be absolute" >&2; exit 2 ;; esac
mkdir -p "$output"
cc -std=c11 -Wall -Wextra -Werror -isystem third_party/quickjs -I src \
  $(pkg-config --cflags dbus-1) -c src/desktop/applications.c -o "$output/applications.o"
cc -std=c11 -Wall -Wextra -Werror -isystem third_party/quickjs -I src -DPU_LAYER_SHELL \
  $(pkg-config --cflags dbus-1) -fsyntax-only src/desktop/applications.c
cc -std=c11 -Wall -Wextra -Wpedantic -Werror -I src $(pkg-config --cflags dbus-1) \
  desktop/tests/application-activation-service.c src/desktop/session-bus.c \
  -D_POSIX_C_SOURCE=200809L $(pkg-config --libs dbus-1) -o "$output/application-activation-service"
node --test desktop/tests/application-activation.mjs desktop/tests/menu-host.mjs desktop/tests/xp-startup-compatibility.mjs
node desktop/tests/application-activation-fixture.mjs --probe "$output/application-activation-service" "$output"
