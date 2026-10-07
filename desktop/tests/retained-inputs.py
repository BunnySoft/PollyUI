#!/usr/bin/env python3
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile

location = Path(__file__).parents[1] / "tools/retain-debian-packages.py"
spec = importlib.util.spec_from_file_location("retain", location)
retain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retain)


def rejects(action):
    try:
        action()
    except (ValueError, OSError):
        return
    raise AssertionError("Invalid retained inputs accepted")


payload = b"unit test binary input"
checksum = hashlib.sha256(payload).hexdigest()
text = f"Package: example\nVersion: 1.0-1\nArchitecture: amd64\nSize: {len(payload)}\nSHA256: {checksum}\n"
record = retain.package_record(text, "example:amd64", "1.0-1")
assert record["sha256"] == checksum
rejects(lambda: retain.package_record(text, "example", "2"))
rejects(lambda: retain.package_record(text.replace(checksum, "invalid"), "example", "1.0-1"))
rejects(lambda: retain.package_record(text + "\n" + text.replace(checksum, "b" * 64), "example", "1.0-1"))
rejects(lambda: retain.package_record(text.replace("amd64", "arm64"), "example", "1.0-1"))

with tempfile.TemporaryDirectory(prefix="polly-retained-test-") as temporary:
    root = Path(temporary)
    (root / "packages").mkdir()
    record["file"] = f"packages/{checksum}.deb"
    target = root / record["file"]
    target.write_bytes(payload)
    manifest = {"schemaVersion": 1, "kind": "debian-runtime-binary-inputs", "packages": [record]}
    (root / "input-pack.json").write_text(json.dumps(manifest))
    (root / "runtime-packages.txt").write_text("example:amd64=1.0-1\n")
    retain.verify_input_pack(root)
    target.write_bytes(b"x" * len(payload))
    rejects(lambda: retain.verify_input_pack(root))
    target.unlink()
    (root / "outside").write_bytes(payload)
    target.symlink_to(root / "outside")
    rejects(lambda: retain.verify_input_pack(root))
    target.unlink()
    target.write_bytes(payload)
    manifest["packages"].append(record)
    (root / "input-pack.json").write_text(json.dumps(manifest))
    rejects(lambda: retain.verify_input_pack(root))
    manifest["packages"] = [{**record, "file": "../outside"}]
    (root / "input-pack.json").write_text(json.dumps(manifest))
    rejects(lambda: retain.verify_input_pack(root))
print("PASS: retained binary input pins, checksum conflicts, modification and path/link rejection")
