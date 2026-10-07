#!/usr/bin/env python3
"""Verify locally rebuilt Debian packages, distinct from archive-signed binaries."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def digest(path):
    with path.open("rb") as contents:
        return hashlib.file_digest(contents, "sha256").hexdigest()


def verify(root):
    metadata = root / "local-packages.json"
    if metadata.is_symlink() or not metadata.is_file() or metadata.stat().st_size > 1024 * 1024:
        raise ValueError("Invalid local Debian package metadata")
    record = json.loads(metadata.read_text())
    if record.get("schemaVersion") != 1 or record.get("kind") != "polly-rebuilt-debian-packages":
        raise ValueError("Unsupported local Debian package format")
    if not re.fullmatch("[0-9a-f]{64}", record.get("patchSha256", "")):
        raise ValueError("Missing local source patch identity")
    items = record.get("packages")
    if not isinstance(items, list) or not 0 < len(items) <= 128:
        raise ValueError("Invalid local package count")
    names, files = set(), set()
    for item in items:
        name, version, filename = item.get("name", ""), item.get("version", ""), item.get("file", "")
        if (not re.fullmatch("[a-z0-9][a-z0-9+.-]*(?::amd64)?", name)
                or not re.fullmatch("[A-Za-z0-9._+~:-]+", version)
                or not re.fullmatch("[A-Za-z0-9_+.~-]+[.]deb", filename)
                or item.get("architecture") not in ("amd64", "all")
                or not re.fullmatch("[0-9a-f]{64}", item.get("sha256", ""))
                or not isinstance(item.get("bytes"), int) or not 0 < item["bytes"] <= 512 * 1024 * 1024
                or name.split(":")[0] in names or filename in files):
            raise ValueError("Invalid or duplicate local package")
        names.add(name.split(":")[0])
        files.add(filename)
        path = root / filename
        if path.is_symlink() or not path.is_file() or path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise ValueError("Local package bytes changed: " + filename)
        fields = subprocess.check_output(["dpkg-deb", "-f", str(path), "Package", "Version", "Architecture"], text=True)
        control = dict(line.split(": ", 1) for line in fields.splitlines())
        if (control["Package"] != name.split(":")[0] or control["Version"] != version
                or control["Architecture"] != item["architecture"]):
            raise ValueError("Local package control metadata differs from inventory")
    return record


def publish(root, target, record):
    if target.exists():
        raise ValueError("Refusing to replace a local package cache")
    target.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".polly-local-debs-", dir=target.parent))
    try:
        for name in [item["file"] for item in record["packages"]] + [
                "local-packages.json", "source-inputs.json", "mesa-lifetime.patch"]:
            source = root / name
            if source.is_symlink() or not source.is_file():
                raise ValueError("Expected a regular local build input")
            shutil.copyfile(source, stage / name)
        if digest(stage / "mesa-lifetime.patch") != record["patchSha256"]:
            raise ValueError("Local package patch identity changed")
        verify(stage)
        stage.rename(target)
    except BaseException:
        shutil.rmtree(stage)
        raise


def install_existing(root, record):
    if not Path("/run/.containerenv").exists() and not Path("/.dockerenv").exists():
        raise RuntimeError("Install rebuilt packages only in an explicitly invoked build container")
    rows = subprocess.check_output(["dpkg-query", "-W", "-f=${Package}\t${Status}\n"], text=True)
    installed = {line.split("\t")[0] for line in rows.splitlines() if line.endswith("\tinstall ok installed")}
    selected = [str(root / item["file"]) for item in record["packages"] if item["name"].split(":")[0] in installed]
    if not selected:
        raise ValueError("No installed packages match the rebuilt input set")
    subprocess.run(["apt-get", "install", "-y", "--no-install-recommends", *selected], check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--install-existing", action="store_true")
    parser.add_argument("--publish", type=Path)
    args = parser.parse_args()
    try:
        root = args.directory.resolve()
        record = verify(root)
        if args.install_existing and args.publish:
            raise ValueError("Choose installation or cache publication, not both")
        if args.install_existing:
            install_existing(root, record)
        elif args.publish:
            publish(root, args.publish.resolve(), record)
        else:
            print(json.dumps(record))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print("[local-debian-packages] " + str(error), file=sys.stderr)
        raise SystemExit(1)
