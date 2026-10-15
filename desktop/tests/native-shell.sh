#!/bin/sh
set -eu
launcher=$1
wm=$2
ui=$3
client=$4
temporary=$(mktemp -d)
cleanup() {
    rm -rf "$temporary/config" "$temporary/data" "$temporary/cache" "$temporary/captures"
    rm -f "$temporary/cycle.log" "$temporary/reload.log"
    rmdir "$temporary/run"
    rmdir "$temporary"
}
trap cleanup EXIT
mkdir -m 700 "$temporary/run" "$temporary/captures"
export XDG_RUNTIME_DIR="$temporary/run" XDG_CONFIG_HOME="$temporary/config"
export XDG_DATA_HOME="$temporary/data" XDG_CACHE_HOME="$temporary/cache"
export SDL_RENDER_DRIVER=software
for mode in cycle reload; do
    if ! sh "$launcher" --headless "$wm" "$ui" "$client" "$mode" "$temporary/captures/shell" \
        >"$temporary/$mode.log" 2>&1; then
        cat "$temporary/$mode.log"; exit 1
    fi
    if grep -q 'FAIL:' "$temporary/$mode.log" ||
       ! grep -q "PASS: native themed shell $mode complete" "$temporary/$mode.log"; then
        cat "$temporary/$mode.log"; exit 1
    fi
done
python3 - "$temporary/captures" "$(dirname "$client")/../resources/themes/builtin.json" <<'PY'
import json
import pathlib
import sys
from PIL import Image

directory = pathlib.Path(sys.argv[1])
themes = json.loads(pathlib.Path(sys.argv[2]).read_text())["themes"]
wallpapers = set()
for definition in themes:
    theme, panel = definition["id"], definition["panel"]
    dock = panel["kind"] == "dock"
    start, end = (definition["window"]["titleFrom"], definition["window"]["titleTo"]) if dock else (panel["from"], panel["to"])
    height = definition["layout"]["menuBarHeight"] if dock else panel["height"]
    with Image.open(directory / f"shell-{theme}-wallpaper.png") as image:
        wallpapers.add(image.tobytes())
    with Image.open(directory / f"shell-{theme}-panel.png") as image:
        assert image.height == height, (theme, image.size)
        color = image.convert("RGB").getpixel((image.width // 2, height // 2))
        a = tuple(bytes.fromhex(start.removeprefix("#"))); b = tuple(bytes.fromhex(end.removeprefix("#")))
        assert all(min(lo, hi) - 3 <= v <= max(lo, hi) + 3 for v, lo, hi in zip(color, a, b)), (theme, color)
    if dock:
        with Image.open(directory / f"shell-{theme}-dock.png") as image:
            assert image.convert("RGBA").getpixel((0, 0))[3] == 0, (theme, "opaque Dock corner")
assert len(wallpapers) == len(themes), "Catalog wallpapers must render distinct appearances"
print("PASS: actual shell palettes, panel geometry, wallpaper artwork and transparent Dock corners")
PY
