#!/usr/bin/env python3
"""Compose production GUI-generated caption pixels through the native effect tree."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

repo = Path(__file__).resolve().parents[2]
rendered = subprocess.run([sys.argv[1], "--test", "desktop/tests/native-caption-effects.mjs"],
                          cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
if rendered.returncode:
    raise RuntimeError(rendered.stdout + rendered.stderr)
records = [json.loads(line.removeprefix("NATIVE_CAPTION ")) for line in rendered.stdout.splitlines()
           if line.startswith("NATIVE_CAPTION ")]
assert len(records) == 8 and "default/none bytes retained" in rendered.stdout
with tempfile.TemporaryDirectory(prefix="polly-native-caption-") as directory:
    pixels = Path(directory) / "caption-pixels.bin"
    with pixels.open("wb") as output:
        output.write(struct.pack("<II", 0x50554345, len(records)))
        for record in records:
            rgba = bytes.fromhex(record["rgba"])
            assert len(rgba) == record["pixelWidth"] * record["pixelHeight"] * 4
            assert all(alpha == 255 for alpha in rgba[3::4])
            output.write(struct.pack("<8I", *(record[key] for key in
                ("width", "height", "title", "radius", "scale", "state", "pixelWidth", "pixelHeight"))))
            output.write(rgba)
    subprocess.run([sys.argv[2], "--caption", str(pixels)], cwd=repo, check=True, timeout=30)
print("PASS: actual GUI strip alpha and native partial-top-corner oracle agree with one coverage, not squared coverage")
