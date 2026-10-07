#!/usr/bin/env python3
"""Rebuild the pinned Debian Mesa packages with the local lifetime correction."""
import argparse
from datetime import datetime, timezone
from email.utils import format_datetime
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def digest(path):
    with path.open("rb") as contents:
        return hashlib.file_digest(contents, "sha256").hexdigest()


def run(*command, **options):
    subprocess.run(command, check=True, **options)


def build(inputs, output):
    if not Path("/run/.containerenv").exists() and not Path("/.dockerenv").exists():
        raise RuntimeError("Mesa rebuilding requires a disposable Debian build container")
    here = Path(__file__).resolve().parent
    pin = json.loads((here / "mesa.json").read_text())
    patch = here.parents[2] / pin["patch"]
    if output.exists():
        raise ValueError("Refusing to replace Mesa build output")
    for name, expected in pin["sourceFiles"].items():
        path = inputs / name
        if path.is_symlink() or not path.is_file() or digest(path) != expected:
            raise ValueError("Pinned Mesa source checksum mismatch: " + name)
    output.mkdir(parents=True)
    source = output / "source"
    descriptor = inputs / ("mesa_" + pin["sourceVersion"] + ".dsc")
    run("dpkg-source", "-x", str(descriptor), str(source))
    run("git", "apply", "--check", str(patch), cwd=source)
    run("git", "apply", str(patch), cwd=source)
    changelog = source / "debian/changelog"
    entry = (f"mesa ({pin['rebuiltVersion']}) trixie; urgency=medium\n\n"
             "  * Release CPU topology storage on unload and empty executable heaps.\n\n"
             " -- PollyDesktop local build <build@pollyui.invalid>  "
             + format_datetime(datetime.now(timezone.utc)) + "\n\n")
    changelog.write_text(entry + changelog.read_text())
    (output / "source-inputs.json").write_text(json.dumps({
        **pin, "patchSha256": digest(patch),
        "patchedFiles": {name: digest(source / name) for name in (
            "src/util/u_cpu_detect.c", "src/gallium/auxiliary/rtasm/rtasm_execmem.c")},
    }, indent=2) + "\n")
    run("dpkg-buildpackage", "--build=binary", "--no-sign", "--jobs=2", cwd=source)
    packages = []
    for file in sorted(output.glob("*.deb")):
        fields = subprocess.check_output(
            ["dpkg-deb", "-f", str(file), "Package", "Version", "Architecture", "Source"], text=True)
        control = dict(line.split(": ", 1) for line in fields.splitlines())
        if control["Version"] != pin["rebuiltVersion"] or control["Architecture"] not in ("amd64", "all"):
            raise ValueError("Unexpected rebuilt Mesa package identity")
        if control["Package"].endswith("-dbgsym"):
            continue
        packages.append({"name": control["Package"], "version": control["Version"],
                         "architecture": control["Architecture"], "sourcePackage": "mesa",
                         "file": file.name, "bytes": file.stat().st_size, "sha256": digest(file)})
    if not packages:
        raise ValueError("Mesa build produced no binary packages")
    shutil.copyfile(patch, output / "mesa-lifetime.patch")
    (output / "local-packages.json").write_text(json.dumps({
        "schemaVersion": 1, "kind": "polly-rebuilt-debian-packages",
        "sourceVersion": pin["sourceVersion"], "patchSha256": digest(patch), "packages": packages,
        "limits": ["Locally rebuilt Debian packages, not binaries signed or published by Debian."],
    }, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build(args.inputs.resolve(), args.output.resolve())
