#!/usr/bin/env python3
"""Generate original Polly boot artwork without an image-tool dependency."""
from pathlib import Path
import re
import struct
import sys
import zlib

BACKGROUND = (16, 24, 36)
FOREGROUND = (197, 226, 255)


def logo():
    source = Path(__file__).with_name("boot-brand.h").read_text()
    rectangles = [tuple(map(int, match)) for match in
                  re.findall(r"POLLY_BOOT_RECT\((\d+), (\d+), (\d+), (\d+)\)", source)]
    if not rectangles or any(x + w > 64 or y + h > 64 for x, y, w, h in rectangles):
        raise ValueError("Invalid boot monogram")
    rows = bytearray()
    for y in range(128):
        rows.append(0)
        for x in range(128):
            inside = any(rx <= x // 2 < rx + w and ry <= y // 2 < ry + h
                         for rx, ry, w, h in rectangles)
            rows.extend((*FOREGROUND, 255) if inside else (*BACKGROUND, 255))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", 128, 128, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def png(width, height, pixel):
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend(pixel(x, y))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    return (b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def theme_assets():
    assets = {"polly.png": logo()}
    source = Path(__file__).with_name("boot-brand.h").read_text()
    rectangles = [tuple(map(int, match)) for match in
                  re.findall(r"POLLY_BOOT_RECT\((\d+), (\d+), (\d+), (\d+)\)", source)]
    def boot_pixel(x, y):
        x, y = x - 576, y - 272
        inside = any(rx * 2 <= x < (rx + w) * 2 and ry * 2 <= y < (ry + h) * 2
                     for rx, ry, w, h in rectangles)
        return (*(FOREGROUND if inside else BACKGROUND), 255)
    assets["boot-background.png"] = png(1280, 800, boot_pixel)
    icons = {
        "polly": ((8, 5, 5, 22), (13, 5, 10, 5), (21, 10, 5, 8),
                  (13, 16, 8, 5), (22, 23, 4, 4)),
        "advanced": ((6, 8, 20, 2), (6, 15, 20, 2), (6, 22, 20, 2),
                     (10, 5, 4, 8), (20, 12, 4, 8), (12, 19, 4, 8)),
        "gpu": ((8, 8, 16, 2), (8, 22, 16, 2), (8, 10, 2, 12), (22, 10, 2, 12),
                (13, 13, 6, 6), (4, 11, 4, 2), (4, 19, 4, 2), (24, 11, 4, 2),
                (24, 19, 4, 2), (11, 4, 2, 4), (19, 4, 2, 4),
                (11, 24, 2, 4), (19, 24, 2, 4)),
        "verbose": ((8, 5, 16, 2), (8, 25, 16, 2), (8, 7, 2, 18), (22, 7, 2, 18),
                    (12, 11, 8, 2), (12, 15, 8, 2), (12, 19, 6, 2)),
        "console": ((4, 6, 24, 2), (4, 24, 24, 2), (4, 8, 2, 16), (26, 8, 2, 16),
                    (9, 11, 2, 2), (11, 13, 2, 2), (13, 15, 2, 2),
                    (11, 17, 2, 2), (9, 19, 2, 2), (17, 19, 6, 2)),
        "serial": ((5, 7, 22, 2), (5, 21, 22, 2), (5, 9, 2, 12), (25, 9, 2, 12),
                   (10, 12, 2, 2), (15, 12, 2, 2), (20, 12, 2, 2),
                   (12, 17, 2, 2), (18, 17, 2, 2), (9, 23, 2, 4), (21, 23, 2, 4)),
    }
    for name, rectangles in icons.items():
        def pixel(x, y):
            inside = any(rx <= x < rx + w and ry <= y < ry + h
                         for rx, ry, w, h in rectangles)
            return (*FOREGROUND, 255) if inside else (0, 0, 0, 0)
        assets[f"icons/{name}.png"] = png(32, 32, pixel)

    for name, size, radius, fill, border in (
            ("item", 36, 12, (25, 36, 51), (45, 61, 79)),
            ("selected", 36, 12, (38, 62, 88), FOREGROUND),
            ("scroll", 9, 3, (36, 49, 65), (36, 49, 65)),
            ("thumb", 9, 3, (155, 170, 188), (155, 170, 188))):
        def pixel(x, y):
            dx = max(radius - x - 0.5, 0, x + 0.5 - (size - radius))
            dy = max(radius - y - 0.5, 0, y + 0.5 - (size - radius))
            if dx * dx + dy * dy > radius * radius:
                return (0, 0, 0, 0)
            edge = (min(x, y, size - 1 - x, size - 1 - y) < 2 or
                    dx * dx + dy * dy > (radius - 2) ** 2)
            return (*(border if edge else fill), 255)
        step = size // 3
        for row, vertical in enumerate(("n", "", "s")):
            for column, horizontal in enumerate(("w", "", "e")):
                suffix = vertical + horizontal or "c"
                assets[f"{name}_{suffix}.png"] = png(
                    step, step, lambda x, y: pixel(column * step + x, row * step + y))
    return assets


def write_theme(directory):
    directory = Path(directory)
    resources = []
    for name, data in theme_assets().items():
        target = directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        resources.append("boot/grub/themes/polly/" + name + "=" + str(target))
    return resources


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--theme":
        write_theme(sys.argv[2])
    elif len(sys.argv) == 2 and sys.argv[1] != "--theme":
        Path(sys.argv[1]).write_bytes(logo())
    else:
        raise SystemExit("Usage: boot-assets.py OUTPUT.png | --theme DIRECTORY")
