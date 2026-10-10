#!/usr/bin/env python3
"""Synthetic rejection tests, not Live/VM acceptance."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "overlay", Path(__file__).resolve().parents[1] / "tools/offline-live-overlay.py")
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class Contract(unittest.TestCase):
    def test_payload_and_legacy(self):
        if os.geteuid() != 0:
            self.fail("Run synthetic file-ownership checks in the private root container")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            names = ("usr/share/pollyui/desktop/shared/configuration-files.mjs",
                     "usr/share/pollyui/sysrt/bindings/generated/files-linux-x86_64.mjs",
                     "usr/bin/polly-settings")
            records = []
            for name in names:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b"synthetic-only")
                file.chmod(0o644)
                records.append({"path": name, "size": file.stat().st_size,
                                "sha256": overlay.digest(file), "mode": "0644"})
            manifest = {"files": records}
            expected = overlay.verify_files(root, manifest)
            overlay.verify_namespaces(root, set(expected))
            last = root / names[-1]
            last.write_bytes(b"stale")
            with self.assertRaisesRegex(ValueError, "mismatch"):
                overlay.verify_files(root, manifest)
            last.write_bytes(b"synthetic-only")
            last.chmod(0o777)
            with self.assertRaisesRegex(ValueError, "mismatch"):
                overlay.verify_files(root, manifest)
            legacy = root / "usr/share/pollyui/js/old-fixture.mjs"
            legacy.parent.mkdir()
            legacy.write_text("synthetic-only")
            with self.assertRaisesRegex(ValueError, "Old/unlisted"):
                overlay.verify_namespaces(root, set(expected))

    def test_real_deb_and_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            control = root / "build/DEBIAN/control"
            control.parent.mkdir(parents=True)
            control.write_text("Package: polly-synthetic-input\nVersion: 1.0\nArchitecture: amd64\n"
                               "Maintainer: Test <test@example.invalid>\nDescription: synthetic never-installed input\n")
            archive = root / "input.deb"
            subprocess.run(["dpkg-deb", "--build", str(control.parent.parent), str(archive)],
                           check=True, stdout=subprocess.DEVNULL)
            sha = overlay.digest(archive)
            packages = root / "packages"
            packages.mkdir()
            archive.rename(packages / (sha + ".deb"))
            metadata = {"schemaVersion": 1, "kind": "debian-runtime-binary-inputs", "packages": [
                {"name": "polly-synthetic-input", "version": "1.0", "architecture": "amd64",
                 "sha256": sha, "file": "packages/" + sha + ".deb", "bytes": (packages / (sha + ".deb")).stat().st_size}]}
            record = root / "input-pack.json"
            record.write_text(json.dumps(metadata))
            overlay.verify_offline_inputs(root)
            metadata["packages"][0]["version"] = "2.0"
            record.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, "identity differs"):
                overlay.verify_offline_inputs(root)
            metadata["packages"][0]["file"] = "../escape.deb"
            record.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, "Invalid offline input"):
                overlay.verify_offline_inputs(root)
            metadata["packages"][0]["file"] = "packages/" + sha + ".deb"
            record.write_text(json.dumps(metadata))
            (packages / (sha + ".deb")).write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "changed"):
                overlay.verify_offline_inputs(root)


if __name__ == "__main__":
    unittest.main()
