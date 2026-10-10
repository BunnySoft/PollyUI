#!/bin/sh
set -eu
ui=${1:?Pass the native PollyUI executable}
node --test tests/module-boundaries.mjs
ctest --test-dir "$(dirname -- "$ui")" --output-on-failure --no-tests=error -R '^sysrt-(ffi|process|network)$'
temporary=$(mktemp -d)
cleanup() {
    rm -f "$temporary/storage.dat" "$temporary/output.log"
    rmdir "$temporary"
}
trap cleanup EXIT
export PU_TEST_STORAGE="$temporary/storage.dat"
while IFS= read -r test; do
    if ! "$ui" --test "$test" >"$temporary/output.log" 2>&1; then
        cat "$temporary/output.log"; exit 1
    fi
    if grep -q '^FAIL:' "$temporary/output.log"; then
        cat "$temporary/output.log"; exit 1
    fi
    echo "PASS: $test"
done < tools/core-tests.txt
