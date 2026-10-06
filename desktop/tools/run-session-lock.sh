#!/bin/sh
set -eu
ui=${POLLY_LOCK_RUNTIME:?Explicit session-lock runtime is required}
case "$ui" in /*) ;; *) echo "Lock runtime must be absolute" >&2; exit 1 ;; esac
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo"
exec "$ui" --session-lock --app-id org.pollyui.lock "$repo/desktop/session/lock.mjs"
