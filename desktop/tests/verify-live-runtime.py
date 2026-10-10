#!/usr/bin/env python3
"""Synthetic newc integrity rejection cases; no VM or ISO is accepted by these tests."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "verify", Path(__file__).resolve().parents[1] / "tools/verify-live-runtime.py")
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


def entry(name, data=b"", mode=stat.S_IFREG | 0o644, uid=0):
    encoded = name.encode() + b"\0"
    fields = [1, mode, uid, 0, 1, 0, len(data), 0, 0, 0, 0, len(encoded), 0]
    result = ("070701" + "".join(f"{value:08x}" for value in fields)).encode() + encoded
    result += b"\0" * (-len(result) % 4)
    result += data + b"\0" * (-len(data) % 4)
    return result


class CpioContract(unittest.TestCase):
    def test_real_stream_validation(self):
        origin = {"runtimeSourceRevision": "a" * 40}
        name, data = "usr/bin/pollyui", b"synthetic-only"
        expected = {name: {"size": len(data), "mode": "0644",
                           "sha256": hashlib.sha256(data).hexdigest()}}
        receipt = entry("usr/share/pollyui/runtime-origin.json", json.dumps(origin).encode())
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "initramfs.gz"

            def check(content):
                path.write_bytes(gzip.compress(content + entry("TRAILER!!!", mode=0)))
                verify.check_initramfs(path, expected, origin)

            check(entry(name, data) + receipt)
            for broken, message in (
                    (entry(name, b"changed") + receipt, "metadata differs"),
                    (entry(name, b"synthetic-onlz") + receipt, "bytes differ"),
                    (entry(name, data, mode=stat.S_IFREG | 0o777) + receipt, "metadata differs"),
                    (entry(name, data, uid=1000) + receipt, "metadata differs"),
                    (receipt, "omits frozen"),
                    (entry(name, data), "omits the actual"),
                    (entry(name, data) * 2 + receipt, "Duplicate runtime"),
                    (entry(name, data) + receipt * 2, "Duplicate initramfs"),
                    (entry(name, data) + entry("usr/share/pollyui/runtime-origin.json", b"{}"),
                     "origin receipt differs")):
                with self.subTest(message=message):
                    with self.assertRaisesRegex(ValueError, message):
                        check(broken)


if __name__ == "__main__":
    unittest.main()
