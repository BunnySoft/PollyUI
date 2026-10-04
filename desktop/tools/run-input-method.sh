#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo"
runtime=${POLLY_IME_RUNTIME:?Set POLLY_IME_RUNTIME to the PollyUI executable}
data=${POLLY_IME_DATA:-/usr/share/rime-data}
schema=${POLLY_IME_SCHEMA:-luna_pinyin_simp}
exec "$runtime" --input-method --app-id org.pollyui.ime \
    "$repo/desktop/input-method/main.mjs" "$data" "$schema"
