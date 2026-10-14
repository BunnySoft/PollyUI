#!/usr/bin/env python3
"""Generate the original Polly boot monogram without an image-tool dependency."""
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


if __name__ == "__main__":
    Path(sys.argv[1]).write_bytes(logo())
