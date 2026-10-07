#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

sys.dont_write_bytecode = True
location = Path(__file__).parents[1] / "tools/local-debian-packages.py"
spec = importlib.util.spec_from_file_location("local_packages", location)
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)
if not Path("/run/.containerenv").exists() and not Path("/.dockerenv").exists():
    print("SKIP: local package installation selection is tested only in a disposable container")
    raise SystemExit(77)


def rejects(action):
    try:
        action()
    except (ValueError, OSError, subprocess.SubprocessError):
        return
    raise AssertionError("Invalid local package accepted")


with tempfile.TemporaryDirectory(prefix="polly-local-deb-test-") as temporary:
    root = Path(temporary)
    package = root / "package"
    (package / "DEBIAN").mkdir(parents=True)
    (package / "DEBIAN/control").write_text(
        "Package: polly-mesa-fixture\nVersion: 1.0+polly1\nArchitecture: amd64\n"
        "Maintainer: Fixture <fixture@example.invalid>\nDescription: local source package test\n")
    (package / "fixture").write_text("ordinary fixture bytes")
    deb = root / "fixture.deb"
    subprocess.run(["dpkg-deb", "--build", "--root-owner-group", str(package), str(deb)], check=True)
    source_patch = root / "mesa-lifetime.patch"
    source_patch.write_text("fixture patch")
    (root / "source-inputs.json").write_text("{}")
    record = {"schemaVersion": 1, "kind": "polly-rebuilt-debian-packages", "sourceVersion": "1.0",
              "patchSha256": local.digest(source_patch),
              "packages": [{"name": "polly-mesa-fixture", "version": "1.0+polly1", "architecture": "amd64",
                            "file": deb.name, "bytes": deb.stat().st_size, "sha256": local.digest(deb)}]}

    def metadata():
        (root / "local-packages.json").write_text(json.dumps(record))

    metadata()
    assert local.verify(root)["packages"][0]["name"] == "polly-mesa-fixture"
    output = root / "published"
    local.publish(root, output, record)
    assert local.verify(output) == record
    rejects(lambda: local.publish(root, output, record))
    with patch.object(local.subprocess, "check_output", return_value="polly-mesa-fixture\tinstall ok installed\n"), \
            patch.object(local.subprocess, "run") as install:
        local.install_existing(root, record)
        assert install.call_args.args[0] == ["apt-get", "install", "-y", "--no-install-recommends", str(deb)]
    record["packages"][0]["version"] = "2.0"
    metadata()
    rejects(lambda: local.verify(root))
    record["packages"][0]["version"] = "1.0+polly1"
    record["packages"].append({**record["packages"][0], "name": "polly-mesa-fixture:amd64"})
    metadata()
    rejects(lambda: local.verify(root))
    record["packages"].pop()
    record["packages"][0]["file"] = "../fixture.deb"
    metadata()
    rejects(lambda: local.verify(root))
    record["packages"][0]["file"] = deb.name
    metadata()
    saved = deb.read_bytes()
    deb.write_bytes(b"changed")
    rejects(lambda: local.verify(root))
    deb.unlink()
    (root / "outside").write_bytes(saved)
    deb.symlink_to(root / "outside")
    rejects(lambda: local.verify(root))
    deb.unlink()
    deb.write_bytes(saved)
    source_patch.write_text("different patch")
    rejects(lambda: local.publish(root, root / "failed", record))
    assert not (root / "failed").exists() and not list(root.glob(".polly-local-debs-*"))
print("PASS: local DEB identity, actual bytes, publication, explicit install selection and invalid input rejection")
