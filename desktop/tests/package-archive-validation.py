#!/usr/bin/env python3
"""Check real archive validation with contradictory/tampered archive records."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

checker = Path(__file__).with_name("package-modes.py")
with tempfile.TemporaryDirectory(prefix="polly-package-verify-") as temporary:
    root = Path(temporary)
    payload = b"test runtime payload"
    item = {"path": "usr/bin/example", "mode": "0755", "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest()}
    (root / "manifest.json").write_text(json.dumps({"files": [item]}))

    def verify(mode, success):
        with tarfile.open(root / "pollydesktop-test-x86_64.tar.gz", "w:gz") as archive:
            entry = tarfile.TarInfo("usr/bin/example")
            entry.uid = 1000 if mode == "owner" else 0
            entry.mode = 0o777 if mode == "mode" else 0o755
            entry.size = len(payload)
            data = bytes([payload[0] ^ 1]) + payload[1:] if mode == "hash" else payload
            if mode == "escape":
                entry.name = "../example"
            elif mode == "symlink":
                entry.type = tarfile.SYMTYPE
                entry.linkname = "/etc/passwd"
                entry.size = 0
            archive.addfile(entry, io.BytesIO(data) if entry.isfile() else None)
            if mode == "duplicate":
                archive.addfile(entry, io.BytesIO(data))
            if mode == "duplicate-dir":
                directory = tarfile.TarInfo("usr")
                directory.type = tarfile.DIRTYPE
                directory.mode = 0o755
                archive.addfile(directory)
                archive.addfile(directory)
        result = subprocess.run([sys.executable, str(checker), str(root)], capture_output=True, text=True, timeout=10)
        assert (result.returncode == 0) == success, (mode, result.stdout, result.stderr)

    verify("valid", True)
    for mode in ("owner", "mode", "hash", "escape", "symlink", "duplicate", "duplicate-dir"):
        verify(mode, False)
    (root / "manifest.json").write_text(json.dumps({"files": [item, item]}))
    verify("valid", False)
print("PASS: actual tar validation rejects changed bytes, duplicate inventory, links, traversal and unsafe modes")
