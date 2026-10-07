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
python3 - "$temporary/captures" <<'PY'
import pathlib
import sys
from PIL import Image

directory = pathlib.Path(sys.argv[1])
palettes = {
    "xp": ("245edb", "2663e0", 30), "server2003": ("e9e6df", "d4d0c8", 36),
    "aqua": ("f9fdff", "b4d5e5", 26), "lion": ("d4d9df", "7c8592", 26),
    "bigsur": ("f7edf3", "d7e2f3", 26),
}
wallpapers = set()
for theme, (start, end, height) in palettes.items():
    with Image.open(directory / f"shell-{theme}-wallpaper.png") as image:
        wallpapers.add(image.tobytes())
    with Image.open(directory / f"shell-{theme}-panel.png") as image:
        assert image.height == height, (theme, image.size)
        color = image.convert("RGB").getpixel((image.width // 2, height // 2))
        a = tuple(bytes.fromhex(start)); b = tuple(bytes.fromhex(end))
        assert all(min(lo, hi) - 3 <= v <= max(lo, hi) + 3 for v, lo, hi in zip(color, a, b)), (theme, color)
    if theme in ("aqua", "lion", "bigsur"):
        with Image.open(directory / f"shell-{theme}-dock.png") as image:
            assert image.convert("RGBA").getpixel((0, 0))[3] == 0, (theme, "opaque Dock corner")
assert len(wallpapers) == 5, "Wallpapers must render five distinct appearances"
print("PASS: actual shell palettes, panel geometry, wallpaper artwork and transparent Dock corners")
PY
