#!/usr/bin/env python3
"""Original Polly cursor pixel masters -> deterministic, prebuilt Xcursor files.

No downloaded artwork, font, image library, SVG decoder or runtime generator.
Coordinates below are the editable 32px masters; nearest-neighbor expansion
preserves crisp edges at 2x/3x. The rabbit's input tip never follows its body.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1] / "resources" / "icons"
SIZES = (24, 32, 48, 64, 96)
SHAPES = ("default context-menu help pointer progress wait cell crosshair text "
          "vertical-text alias copy move no-drop not-allowed grab grabbing "
          "e-resize n-resize ne-resize nw-resize s-resize se-resize sw-resize "
          "w-resize ew-resize ns-resize nesw-resize nwse-resize col-resize "
          "row-resize all-scroll zoom-in zoom-out").split()
ACTIONS = {"default": (1, 0), "motion": (4, 70), "press": (1, 0),
           "click": (5, 40), "drag": (4, 80), "drag-copy": (4, 80),
           "drag-move": (4, 80), "drag-no-drop": (4, 80)}
DARK, WHITE, PINK, BLUE = 0xff18202d, 0xfffffbef, 0xfff59aaa, 0xff477dc8


class Canvas:
    def __init__(self):
        self.pixels = [0] * 1024

    def dot(self, x, y, color):
        if 0 <= x < 32 and 0 <= y < 32:
            self.pixels[y * 32 + x] = color

    def ellipse(self, x, y, rx, ry, color):
        for py in range(32):
            for px in range(32):
                if ((px - x) / rx) ** 2 + ((py - y) / ry) ** 2 <= 1:
                    self.dot(px, py, color)

    def line(self, points, color, width=1):
        radius = width / 2
        for (x1, y1), (x2, y2) in zip(points, points[1:]):
            steps = max(1, math.ceil(max(abs(x2 - x1), abs(y2 - y1)) * 2))
            for i in range(steps + 1):
                self.ellipse(x1 + (x2 - x1) * i / steps,
                             y1 + (y2 - y1) * i / steps, radius, radius, color)

    def outline(self, points, width=3):
        self.line(points, DARK, width + 2)
        self.line(points, WHITE, width)

    def polygon(self, points, color):
        for y in range(32):
            for x in range(32):
                inside = False
                for (ax, ay), (bx, by) in zip(points, points[1:] + points[:1]):
                    if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
                        inside = not inside
                if inside:
                    self.dot(x, y, color)


def rabbit(name, frame):
    c = Canvas()
    hop = (0, -2, -4, -2, 0)[frame] if name == "click" else 0
    effort = name.startswith("drag")
    crouch = 2 if name == "press" else 0
    run = name == "motion"
    dy = hop + crouch + ((0, -1, 0, 1)[frame] if run else 0)
    # A fixed, high-contrast input tip, independent of every animated limb.
    c.polygon([(2, 18), (6, 16), (6, 20)], DARK)
    c.dot(3, 18, WHITE)
    c.ellipse(20, 27, 8, 1, 0x70303850)
    c.ellipse(28, 19 + dy, 3, 3, DARK)
    c.ellipse(28, 19 + dy, 2, 2, WHITE)
    c.ellipse(21, 20 + dy, 8, 6 - (1 if crouch else 0), DARK)
    c.ellipse(21, 20 + dy, 6, 4 - (1 if crouch else 0), WHITE)
    leg = (0, 3, 1, -3)[frame] if run or effort else 0
    c.outline([(18, 24 + dy), (15 + leg, 26 + min(dy, 0))], 2)
    c.outline([(24, 24 + dy), (26 - leg, 26 + min(dy, 0))], 2)
    tilt = (frame % 2) if run else (3 if effort else 0)
    for x in (12, 17):
        ear = [(x - 2, 14 + dy), (x - 2 + tilt, 3 + dy),
               (x + 1 + tilt, 3 + dy), (x + 2, 14 + dy)]
        c.polygon(ear, DARK)
        c.line([(x + tilt, 5 + dy), (x, 12 + dy)], WHITE, 2)
        c.line([(x + tilt, 6 + dy), (x, 11 + dy)], PINK, 1)
    c.ellipse(12, 16 + dy + (1 if effort else 0), 6, 5, DARK)
    c.ellipse(12, 16 + dy + (1 if effort else 0), 4, 3, WHITE)
    c.dot(10, 15 + dy + (1 if effort else 0), DARK)
    c.dot(7, 18 + dy, PINK)
    if effort:
        c.line([(10, 13 + dy), (12, 14 + dy)], DARK)
        c.outline([(15, 21), (9, 23 + frame % 2)], 1)
    if name == "drag-copy":
        badge(c, "copy")
    elif name == "drag-move":
        badge(c, "move")
    elif name == "drag-no-drop":
        badge(c, "not-allowed")
    return c.pixels, (2, 18)


def badge(c, kind):
    c.ellipse(25, 25, 6, 6, DARK)
    c.ellipse(25, 25, 5, 5, WHITE)
    if kind in ("not-allowed", "no-drop"):
        c.ellipse(25, 25, 4, 4, 0xffbd334d)
        c.ellipse(25, 25, 2, 2, WHITE)
        c.line([(22, 22), (28, 28)], 0xffbd334d, 2)
    elif kind == "copy":
        c.line([(22, 25), (28, 25)], BLUE, 2)
        c.line([(25, 22), (25, 28)], BLUE, 2)
    else:
        c.line([(22, 27), (27, 22), (24, 22), (27, 22), (27, 25)], BLUE, 2)


def classic(name):
    c, hot = Canvas(), (3, 3)
    if name in ("text", "vertical-text"):
        c.outline([(12, 5), (20, 5), (16, 5), (16, 27), (12, 27), (20, 27)], 1)
        if name == "vertical-text":
            c.pixels = [c.pixels[(31 - x) * 32 + y] for y in range(32) for x in range(32)]
        return c.pixels, (16, 16)
    if "resize" in name or name in ("move", "all-scroll", "crosshair", "cell"):
        directions = {
            "e": (1, 0), "w": (-1, 0), "n": (0, -1), "s": (0, 1),
            "ne": (1, -1), "nw": (-1, -1), "se": (1, 1), "sw": (-1, 1),
        }
        prefix = name.split("-")[0]
        selected = {"ew": ("e", "w"), "ns": ("n", "s"), "nesw": ("ne", "sw"),
                    "nwse": ("nw", "se"), "col": ("e", "w"), "row": ("n", "s")}
        axes = selected.get(prefix, (prefix,)) if "resize" in name else ("e", "w", "n", "s")
        for axis in axes:
            dx, dy = directions[axis]
            end = (16 + dx * 10, 16 + dy * 10)
            c.outline([(16, 16), end], 1)
            if name not in ("crosshair", "cell"):
                c.outline([(end[0] - dx * 4 + dy * 4, end[1] - dy * 4 - dx * 4),
                           end, (end[0] - dx * 4 - dy * 4, end[1] - dy * 4 + dx * 4)], 1)
        return c.pixels, (16, 16)
    if name in ("pointer", "grab", "grabbing"):
        points = [(10, 26), (6, 18), (7, 16), (12, 19), (12, 5),
                  (15, 5), (15, 14), (23, 14), (25, 18), (23, 27)]
        if name == "grabbing":
            points = [(10, 26), (8, 16), (12, 12), (23, 13), (25, 19), (23, 27)]
        c.polygon(points, DARK)
        c.line(points + points[:1], DARK, 2)
        c.polygon([(11, 25), (8, 18), (13, 22), (13, 6), (14, 6),
                   (14, 16), (22, 16), (23, 20), (22, 25)], WHITE)
        return c.pixels, (13, 5)
    if name == "wait":
        c.ellipse(16, 16, 11, 11, DARK)
        c.ellipse(16, 16, 9, 9, WHITE)
        c.line([(16, 8), (16, 16), (21, 19)], BLUE, 2)
        return c.pixels, (16, 16)
    if name in ("zoom-in", "zoom-out"):
        c.ellipse(13, 13, 9, 9, DARK)
        c.ellipse(13, 13, 7, 7, WHITE)
        c.outline([(20, 20), (27, 27)], 2)
        c.line([(9, 13), (17, 13)], BLUE, 2)
        if name == "zoom-in":
            c.line([(13, 9), (13, 17)], BLUE, 2)
        return c.pixels, (13, 13)
    c.polygon([(3, 3), (3, 24), (9, 19), (14, 29), (18, 27), (13, 17), (22, 17)], DARK)
    c.polygon([(5, 7), (5, 20), (10, 16), (15, 26), (16, 26), (11, 15), (17, 15)], WHITE)
    if name in ("copy", "alias", "no-drop", "not-allowed"):
        badge(c, name)
    elif name in ("help", "context-menu", "progress"):
        c.ellipse(25, 25, 6, 6, DARK)
        c.ellipse(25, 25, 5, 5, WHITE)
        c.line([(22, 23), (27, 23), (24, 25)], BLUE, 1)
        c.dot(24, 28, BLUE)
    return c.pixels, hot


def scaled(pixels, hotspot, size):
    factor = size / 32
    return ([pixels[min(31, int(y / factor)) * 32 + min(31, int(x / factor))]
             for y in range(size) for x in range(size)],
            tuple(int(v * factor) for v in hotspot))


def xcursor(frames, delay):
    chunks, entries = [], []
    offset = 16 + 12 * len(frames) * len(SIZES)
    for size in SIZES:
        for pixels, hotspot in frames:
            pixels, (x, y) = scaled(pixels, hotspot, size)
            chunk = struct.pack("<9I", 36, 0xfffd0002, size, 1, size, size, x, y, delay)
            chunk += struct.pack(f"<{len(pixels)}I", *pixels)
            entries.append(struct.pack("<3I", 0xfffd0002, size, offset))
            chunks.append(chunk)
            offset += len(chunk)
    return struct.pack("<4I", 0x72756358, 16, 0x10000, len(entries)) + b"".join(entries + chunks)


def png(width, height, pixels):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + b"".join(bytes((p >> 16 & 255, p >> 8 & 255, p & 255, p >> 24))
                                     for p in pixels[y * width:(y + 1) * width])
                    for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    records, sheets = {}, []
    for theme in ("PollyRabbit", "PollyClassic"):
        files = {}
        names = dict(ACTIONS) if theme == "PollyRabbit" else {}
        names.update({name: (1, 0) for name in SHAPES if name not in names})
        for name, (count, delay) in names.items():
            frames = [rabbit(name, i) if theme == "PollyRabbit" and name in ACTIONS else classic(name)
                      for i in range(count)]
            raw = xcursor(frames, delay)
            files["cursors/" + name] = raw
            records[f"{theme}/{name}"] = {
                "sizes": list(SIZES), "frames": count, "delayMs": delay,
                "hotspot32": list(frames[0][1]), "sha256": hashlib.sha256(raw).hexdigest()}
            if theme == "PollyRabbit" and name in ACTIONS:
                sheets.append((name, frames))
        files["index.theme"] = (f"[Icon Theme]\nName={theme}\n"
                                "Comment=Original PollyUI deterministic cursor artwork\n").encode()
        for name, raw in files.items():
            target = ROOT / theme / name
            if args.write:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
            elif not target.is_file() or target.read_bytes() != raw:
                raise ValueError("Missing or non-deterministic cursor: " + str(target))
    manifest = (json.dumps({"author": "PollyUI contributors", "license": "MIT",
                           "masterSize": 32, "themes": records}, indent=2, sort_keys=True) + "\n").encode()
    if args.write:
        (ROOT / "cursor-manifest.json").write_bytes(manifest)
    elif (ROOT / "cursor-manifest.json").read_bytes() != manifest:
        raise ValueError("Cursor manifest differs from source masters")
    if args.evidence:
        args.evidence.mkdir(parents=True, exist_ok=True)
        width, height = 5 * 96, len(sheets) * 96
        pixels = [0xffeeeeee] * (width * height)
        for row, (_, frames) in enumerate(sheets):
            for column, (frame, hot) in enumerate(frames):
                expanded, _ = scaled(frame, hot, 96)
                for y in range(96):
                    for x in range(96):
                        color = expanded[y * 96 + x]
                        if color >> 24 == 255:
                            pixels[(row * 96 + y) * width + column * 96 + x] = color
        (args.evidence / "rabbit-assets.png").write_bytes(png(width, height, pixels))
        (args.evidence / "rabbit-assets.json").write_text(json.dumps({
            "kind": "source-assets-not-desktop-framebuffer", "rowNames": [n for n, _ in sheets],
            "cellSize": 96, "column": "frame index", "manifest": records}, indent=2) + "\n")
    print("PASS: deterministic original cursor masters, all names/frames/sizes/hotspots and manifest")


if __name__ == "__main__":
    main()
