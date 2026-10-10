#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
if [ "$#" -ne 1 ]; then echo "Usage: $0 ABSOLUTE_EVIDENCE_DIRECTORY" >&2; exit 2; fi
case "$1" in /*) output=$1 ;; *) echo "Evidence directory must be absolute" >&2; exit 2 ;; esac
mkdir -p "$output"
cc -std=c11 -Wall -Wextra -Werror -isystem third_party/quickjs -I gui/src -I gui/include -I . -I desktop \
  $(pkg-config --cflags dbus-1) -c desktop/native/documents.c -o "$output/documents.o"
cc -std=c11 -Wall -Wextra -Werror -isystem third_party/quickjs -I gui/src -I gui/include -I . -I desktop \
  $(pkg-config --cflags dbus-1) -c desktop/native/applications.c -o "$output/applications.o"
cc -std=c11 -Wall -Wextra -Werror -isystem third_party/quickjs -I gui/src -I gui/include -I . -I desktop -DPU_LAYER_SHELL \
  $(pkg-config --cflags dbus-1) -fsyntax-only desktop/native/applications.c
node --test desktop/tests/document-association.mjs desktop/tests/application-activation.mjs \
  desktop/tests/menu-host.mjs desktop/tests/xp-startup-compatibility.mjs
node --check desktop/tests/document-association-client.mjs
node --check desktop/tests/document-association-fixture.mjs
cc -std=c11 -Wall -Wextra -Wpedantic -Werror -I gui/src -I gui/include -I . -I desktop $(pkg-config --cflags dbus-1) \
  desktop/tests/document-association-service.c desktop/native/session-bus.c \
  -D_POSIX_C_SOURCE=200809L $(pkg-config --libs dbus-1) -o "$output/document-association-service"
cc -std=c11 -Wall -Wextra -Wpedantic -Werror desktop/tests/document-association-process.c \
  -o "$output/document-association-process"
echo "PASS: scoped objects/Node/syntax only; newly built PollyUI native acceptance remains required"
