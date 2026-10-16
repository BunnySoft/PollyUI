#!/usr/bin/env python3
"""Dependency identity tests against the already-present pinned source archive."""
import hashlib
from importlib.util import module_from_spec, spec_from_file_location
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

REPO = Path(__file__).resolve().parents[2]
RECIPE = REPO / "desktop/release/debian"
spec = spec_from_file_location("effects", RECIPE / "apply-wlroots-effects.py")
effects = module_from_spec(spec)
spec.loader.exec_module(effects)
record, patch = effects.definition()
effects.check_install(Path(sys.argv[1]))
archive = Path(sys.argv[2])
definition = json.loads((RECIPE / "sources.json").read_text())["wlroots"]
with archive.open("rb") as stream:
    assert hashlib.file_digest(stream, "sha512").hexdigest() == definition["sha512"]
with tempfile.TemporaryDirectory(prefix="polly-effects-dependency-") as temporary:
    temporary = Path(temporary)
    with tarfile.open(archive) as contents:
        contents.extractall(temporary, filter="data")
    source = temporary / "wlroots-0.19.3"
    effects.apply(source)
    duplicate = subprocess.run([sys.executable, str(RECIPE / "apply-wlroots-effects.py"), str(source)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert duplicate.returncode != 0, "Already-patched source must not be accepted"
    shadow = temporary / "desktop/release/debian"
    shadow.mkdir(parents=True)
    for name in ("apply-wlroots-effects.py", "wlroots-effects.json"):
        shutil.copyfile(RECIPE / name, shadow / name)
    bad_patch = temporary / "desktop/patches" / patch.name
    bad_patch.parent.mkdir()
    bad_patch.write_bytes(patch.read_bytes() + b"\n")
    tampered = subprocess.run([sys.executable, str(shadow / "apply-wlroots-effects.py"),
                              str(source)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert tampered.returncode != 0 and b"checksum mismatch" in tampered.stderr
    fake = temporary / "wrong-prefix/share/pollyui"
    fake.mkdir(parents=True)
    (fake / "wlroots-effects.json").write_text("{}\n")
    mismatch = subprocess.run([sys.executable, str(RECIPE / "apply-wlroots-effects.py"),
                               str(fake.parents[1]), "--check-installed"],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert mismatch.returncode != 0 and b"differs from the package source" in mismatch.stderr
print("PASS: pinned source/patch, duplicate application, tampered patch, installed recipe and actual library ABI/hash")
