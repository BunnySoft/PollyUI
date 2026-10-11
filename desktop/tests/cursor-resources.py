#!/usr/bin/env python3
"""Independent Xcursor format/pixel checks plus the actual native C loader."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import os

REPO = Path(__file__).resolve().parents[2]
ICONS = REPO / "desktop/resources/icons"
SHAPES = ("default context-menu help pointer progress wait cell crosshair text vertical-text "
          "alias copy move no-drop not-allowed grab grabbing e-resize n-resize ne-resize "
          "nw-resize s-resize se-resize sw-resize w-resize ew-resize ns-resize nesw-resize "
          "nwse-resize col-resize row-resize all-scroll zoom-in zoom-out").split()


def decode(raw):
    magic, header, version, count = struct.unpack_from("<4I", raw)
    assert magic == 0x72756358 and header == 16 and version == 0x10000
    assert 0 < count <= 512 and header + count * 12 <= len(raw)
    sizes = {}
    for i in range(count):
        kind, size, position = struct.unpack_from("<3I", raw, header + i * 12)
        h, t, subtype, v, w, height, x, y, delay = struct.unpack_from("<9I", raw, position)
        assert kind == t == 0xfffd0002 and size == subtype and h == 36 and v == 1
        assert w == height == size and x < w and y < height
        pixels = raw[position + h:position + h + w * height * 4]
        assert len(pixels) == w * height * 4
        for (pixel,) in struct.iter_unpack("<I", pixels):
            alpha = pixel >> 24
            assert (pixel >> 16 & 255) <= alpha and (pixel >> 8 & 255) <= alpha and (pixel & 255) <= alpha
        sizes.setdefault(size, []).append((pixels, x, y, delay))
    assert list(sizes) == [24, 32, 48, 64, 96]
    for frames in sizes.values():
        assert len({(f[1], f[2]) for f in frames}) == 1
        assert len(frames) == 1 or all(16 <= f[3] <= 1000 for f in frames)
        assert any(any(f[0][3::4]) for f in frames)
    return sizes


def asset(theme, name, size=32):
    return decode((ICONS / theme / "cursors" / name).read_bytes())[size][0][0]


def evidence_png(directory):
    spec = importlib.util.spec_from_file_location("cursor_author", REPO / "desktop/tools/generate-cursors.py")
    author = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(author)
    rows = []
    for line in (directory / "native-frames.tsv").read_text().splitlines():
        name, shape, frame, w, h, x, y, time = line.split("\t")
        w, h = int(w), int(h)
        raw = (directory / (name + ".argb")).read_bytes()
        assert len(raw) == w * h * 4
        pixels = [p[0] for p in struct.iter_unpack("<I", raw)]
        (directory / (name + ".png")).write_bytes(author.png(w, h, pixels))
        rows.append({"name": name, "shape": shape, "equivalentAssetFrame": int(frame),
                     "width": w, "height": h, "hotspot": [int(x), int(y)],
                     "monotonicMs": int(time), "sha256": hashlib.sha256(raw).hexdigest()})
    # Contact sheet uses recorded cursor textures, not simulated body poses.
    width, height = 8 * 96, ((len(rows) + 7) // 8) * 96
    pixels = [0xffeeeeee] * (width * height)
    for i, row in enumerate(rows):
        raw = (directory / (row["name"] + ".argb")).read_bytes()
        src = [p[0] for p in struct.iter_unpack("<I", raw)]
        for y in range(96):
            for x in range(96):
                sx, sy = x * row["width"] // 96, y * row["height"] // 96
                color = src[sy * row["width"] + sx]
                alpha = color >> 24
                background = 238
                r, g, b = [(color >> shift & 255) + background * (255 - alpha) // 255
                           for shift in (16, 8, 0)]
                pixels[((i // 8) * 96 + y) * width + (i % 8) * 96 + x] = 0xff000000 | r << 16 | g << 8 | b
    (directory / "native-contact-sheet.png").write_bytes(author.png(width, height, pixels))
    (directory / "native-frames.json").write_text(json.dumps({
        "kind": "actual-wlroots-output-cursor-texture-readback",
        "backend": "headless", "renderer": "pixman", "hardwareQualification": False,
        "sheetColumns": 8, "cellSize": 96, "frames": rows}, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("native", type=Path)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--render-only", type=Path)
    args = parser.parse_args()
    if args.render_only:
        evidence_png(args.render_only)
        return
    manifest = json.loads((ICONS / "cursor-manifest.json").read_text())
    for name, metadata in manifest["themes"].items():
        theme, cursor = name.split("/")
        raw = (ICONS / theme / "cursors" / cursor).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == metadata["sha256"]
        frames = decode(raw)
        assert len(frames[32]) == metadata["frames"]
        if cursor in ("motion", "drag"):
            assert len({f[0] for f in frames[32]}) == 4
        if cursor == "click":
            assert sum(f[3] for f in frames[32]) == 200
    classic = asset("PollyClassic", "default")
    rabbit = asset("PollyRabbit", "default")
    assert classic != rabbit
    with tempfile.TemporaryDirectory(prefix="polly-cursor-resources-") as tmp:
        root = Path(tmp)
        output = args.evidence or root / "evidence"
        output.mkdir(parents=True, exist_ok=True)
        cases = [("normal", {}, None, rabbit, asset("PollyRabbit", "motion")),
                 ("static", {"POLLY_CURSOR_STATIC": "1"}, None, rabbit, rabbit),
                 ("classic", {"POLLY_CURSOR_THEME": "classic"}, None, classic, classic),
                 ("missing-theme", {}, "missing", classic, classic)]
        partial = root / "partial"
        (partial / "cursors").mkdir(parents=True)
        shutil.copyfile(ICONS / "PollyRabbit/cursors/default", partial / "cursors/default")
        cases.append(("missing-actions-precision", {}, partial, rabbit, rabbit))
        source = bytearray((ICONS / "PollyRabbit/cursors/default").read_bytes())
        first = struct.unpack_from("<I", source, 36)[0]  # 32px image, not the 24px alternative.
        for name, offset, value in [("magic", 0, 0), ("toc", 24, 0xffffffff),
                                    ("hotspot", first + 24, 256), ("dimensions", first + 16, 0xffffffff),
                                    ("version", first + 12, 99)]:
            broken = root / name
            (broken / "cursors").mkdir(parents=True)
            data = bytearray(source)
            struct.pack_into("<I", data, offset, value)
            (broken / "cursors/default").write_bytes(data)
            cases.append(("bad-" + name, {}, broken, classic, classic))
        action_source = bytearray((ICONS / "PollyRabbit/cursors/motion").read_bytes())
        action_first = struct.unpack_from("<I", action_source, 16 + 4 * 12 + 8)[0]
        action_next = struct.unpack_from("<I", action_source, 16 + 5 * 12 + 8)[0]
        for name, offset, value in [("action-delay", action_first + 32, 0),
                                    ("action-hotspot", action_next + 24, 3),
                                    ("action-argb", action_first + 36, 0x000000ff),
                                    ("action-count", 12, 0xffffffff)]:
            broken = root / name
            (broken / "cursors").mkdir(parents=True)
            shutil.copyfile(ICONS / "PollyRabbit/cursors/default", broken / "cursors/default")
            data = bytearray(action_source)
            struct.pack_into("<I", data, offset, value)
            (broken / "cursors/motion").write_bytes(data)
            cases.append(("bad-" + name, {}, broken, rabbit, rabbit))
        for name, extra, theme, default, motion in cases:
            directory = output / name
            directory.mkdir()
            env = dict(os.environ, POLLY_CURSOR_EVIDENCE=str(directory))
            env.pop("POLLY_CURSOR_THEME", None)
            env.pop("POLLY_CURSOR_STATIC", None)
            env.update(extra)
            if theme is not None:
                env["POLLY_CURSOR_THEME"] = str(theme if theme != "missing" else root / "missing")
            result = subprocess.run([str(args.native), "unused", "--cursor-resources"],
                                    env=env, capture_output=True, timeout=12)
            (directory / "native.log").write_bytes(result.stdout + result.stderr)
            assert result.returncode == 0, (name, (result.stdout + result.stderr).decode())
            assert (directory / "resource-default.argb").read_bytes() == default, name
            assert (directory / "resource-motion.argb").read_bytes() == motion, name
            assert (directory / "resource-text.argb").read_bytes() == asset("PollyClassic", "text"), name
            if theme is not None:
                assert b"fallback" in result.stderr, name
            evidence_png(directory)
        for extra in ({"POLLY_CURSOR_THEME": "../escape"}, {"POLLY_CURSOR_STATIC": "yes"}):
            env = dict(os.environ, **extra)
            result = subprocess.run([str(args.native), "unused", "--cursor-resources"],
                                    env=env, capture_output=True, timeout=12)
            assert result.returncode != 0 and b"must be" in result.stderr
        (output / "resource-summary.json").write_text(json.dumps({
            "kind": "native-C-loader-and-independent-actual-pixel-comparison",
            "cases": [c[0] for c in cases], "invalidConfigurationsRejected": 2}, indent=2) + "\n")
        sources = ["desktop/compositor/cursor.c", "desktop/compositor/cursor.h",
                   "desktop/compositor/server.c", "desktop/compositor/server.h",
                   "desktop/compositor/data-device.c", "desktop/CMakeLists.txt",
                   "desktop/install.cmake", "desktop/tools/generate-cursors.py",
                   "desktop/tools/package-contract.mjs", "desktop/tests/CMakeLists.txt",
                   "desktop/tests/integration.c", "desktop/tests/client.c", "desktop/tests/wire.h",
                   "desktop/tests/session-lock.c", "desktop/tests/cursor-resources.py",
                   "desktop/tests/installed-session.mjs", "desktop/tests/package-contract.mjs",
                   "desktop/resources/icons/cursor-manifest.json", "docs/DESKTOP-CURSOR.md",
                   "README.md", "DESIGN.md", "ROADMAP.md"]
        records = []
        for name in sources:
            raw = (REPO / name).read_bytes()
            records.append({"path": name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                            "lfNormalizedSha256": hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()})
        (output / "source-hashes.json").write_text(json.dumps({
            "kind": "actual-read-only-workspace-bytes", "sources": records,
            "nativeDriver": {"path": str(args.native),
                             "sha256": hashlib.sha256(args.native.read_bytes()).hexdigest()},
            "revisionQualification": "development evidence, not a frozen runtime/ISO receipt",
            "cursorAssets": manifest["themes"]}, indent=2) + "\n")
    print("PASS: independent Xcursor format/ARGB checks and native normal/static/classic/missing/corrupt/multiscale pixels")


if __name__ == "__main__":
    main()
