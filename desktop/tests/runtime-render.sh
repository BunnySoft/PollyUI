#!/bin/sh
set -eu
ui=${1:?Pass the PollyUI executable}
display=${2:?Pass the Wayland display}
temporary=$(mktemp -d)
cleanup() {
    rm -f "$temporary/raster.png" "$temporary/gl.png" "$temporary/auto.png" "$temporary/output.log"
    rmdir "$temporary"
}
trap cleanup EXIT
for mode in raster gl auto; do
    if ! WAYLAND_DISPLAY="$display" PU_RENDERER="$mode" LIBGL_ALWAYS_SOFTWARE=true \
        PU_CAPTURE_FRAME="$temporary/$mode.png" PU_TRACE_FRAMES=1 \
        timeout 30 "$ui" desktop/tests/runtime-render.mjs >"$temporary/output.log" 2>&1; then
        cat "$temporary/output.log"
        exit 1
    fi
    backend=GLES
    if [ "$mode" = raster ]; then backend=raster; fi
    if ! grep -q "driver=wayland, Skia=$backend" "$temporary/output.log" ||
       ! grep -q 'Render fixture complete' "$temporary/output.log"; then
        cat "$temporary/output.log"
        echo "Expected successful $mode frame presentation" >&2
        exit 1
    fi
    if [ "$mode" != raster ]; then
        grep 'Skia GLES renderer:' "$temporary/output.log"
    fi
    sizes=$(sed -n 's/.*PollyUI frame presented: \([^,]*\),.*/\1/p' "$temporary/output.log" | sort -u | wc -l)
    if [ "$sizes" -lt 2 ]; then
        cat "$temporary/output.log"
        echo "The render fixture did not exercise a window resize" >&2
        exit 1
    fi
    python3 desktop/tests/check-render.py "$temporary/$mode.png"
done
echo "PASS: raster, GLES and auto paths survived resize/restore and produced correct pixels"
