#!/usr/bin/env python3
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

sys.dont_write_bytecode = True
location = Path(__file__).parents[1] / "tools/retain-build-sources.py"
spec = importlib.util.spec_from_file_location("sources", location)
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


def rejects(action):
    try:
        action()
    except (ValueError, OSError):
        return
    raise AssertionError("Invalid source-pack accepted")


payload = b"source fixture"
checksum = hashlib.sha256(payload).hexdigest()
dsc = f"Format: 3.0 (quilt)\nVersion: 1.0-1\nChecksums-Sha256:\n {checksum} {len(payload)} input.tar.gz\nFiles:\n ignored\n"
version, archives = sources.dsc_files(dsc)
assert version == "1.0-1" and archives[0]["sha256"] == checksum
rejects(lambda: sources.dsc_files(dsc.replace("input.tar.gz", "../escape")))
rejects(lambda: sources.dsc_files("Version: 1.0-1\n"))
with tempfile.TemporaryDirectory(prefix="polly-source-test-") as temporary:
    root = Path(temporary)
    (root / "sources").mkdir()
    file = root / "sources/input.tar.gz"
    file.write_bytes(payload)
    entry = {"path": "sources/input.tar.gz", "bytes": len(payload), "sha256": checksum}
    manifest = {"schemaVersion": 1, "kind": "custom-dependency-sources", "files": [entry]}
    (root / "source-pack.json").write_text(json.dumps(manifest))
    sources.verify(root)
    file.write_bytes(b"x" * len(payload))
    rejects(lambda: sources.verify(root))
    file.unlink()
    (root / "outside").write_bytes(payload)
    file.symlink_to(root / "outside")
    rejects(lambda: sources.verify(root))
    file.unlink()
    file.write_bytes(payload)
    manifest["files"].append(entry)
    (root / "source-pack.json").write_text(json.dumps(manifest))
    rejects(lambda: sources.verify(root))
print("PASS: retained source descriptors, hashes, duplicate entries and symlink rejection")
