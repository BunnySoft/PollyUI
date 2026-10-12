"""Original bitmap/catalog fixtures in an explicitly supplied private test directory."""
from pathlib import Path
import json
import struct
import sys
import zlib

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
row = b"\0" + bytes((32, 144, 224, 255)) * 32
image = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 32, 8, 6, 0, 0, 0)) + \
    chunk(b"IDAT", zlib.compress(row * 32)) + chunk(b"IEND", b"")
store = root / "bundle-store"
files = []
objects = []
for digest in ("a" * 64, "b" * 64):
    directory = store / "objects" / digest
    directory.mkdir(parents=True, exist_ok=True)
    objects.append(directory)
    (directory / "icon.png").write_bytes(image)
    (directory / "invalid.png").write_bytes(b"not a bitmap")
    manifest = dict(schemaVersion=1, id="org.pollyui.icon-fixture", name="BD04 original icon fixture",
        version="1.0.0", target=dict(os="linux", architecture="x86_64", libc="glibc"),
        launch=dict(kind="pollyui", entry="main.mjs"), data=dict(layout="pollyui", schema=1), icon="icon.png")
    record = dict(schemaVersion=1, current=dict(digest=digest, manifest=manifest), previous=None)
    files.append(dict(id=manifest["id"], store=str(store), contents=json.dumps(record)))
link = objects[0] / "link.png"
if not link.is_symlink():
    link.symlink_to(objects[0] / "icon.png")
with (objects[0] / "oversized.png").open("wb") as stream:
    stream.truncate(4 * 1024 * 1024 + 1)
invalid = dict(files[1])
record = json.loads(invalid["contents"])
record["current"]["manifest"]["icon"] = "invalid.png"
invalid["contents"] = json.dumps(record)
(root / "artwork-entry.mjs").write_text("globalThis.desktopArtworkFixture = " +
    json.dumps(dict(file=files[0], alternate=files[1], invalid=invalid)) +
    ";\nawait import('./desktop/tests/desktop-shortcuts-native.mjs');\n", encoding="utf-8")
(root / "icons-entry.mjs").write_text("globalThis.desktopIconFixture = " +
    json.dumps(dict(root=str(objects[0]), alternate=str(objects[1]))) +
    ";\nawait import('./desktop/tests/desktop-icon-resources.mjs');\n", encoding="utf-8")
