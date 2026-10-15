#!/bin/sh
set -eu
runtime=${POLLY_DECORATOR_RUNTIME:?A paired PollyUI runtime is required}
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec "$runtime" --decorator --app-id org.pollyui.decorator "$root/desktop/decorator/main.mjs"
