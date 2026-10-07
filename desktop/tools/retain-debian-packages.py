#!/usr/bin/env python3
"""Explicitly retain exact APT binary inputs; never install or execute payloads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def run(*command, cwd=None):
    return subprocess.check_output(command, cwd=cwd, text=True, stderr=subprocess.PIPE, timeout=120)


def digest(file):
    result = hashlib.sha256()
    with file.open("rb") as source:
        while block := source.read(1024 * 1024):
            result.update(block)
    return result.hexdigest()


def parse_records(text):
    records = []
    for paragraph in text.strip().split("\n\n"):
        fields = {}
        for line in paragraph.splitlines():
            if line[:1].isspace():
                continue
            if ":" in line:
                key, value = line.split(":", 1)
                fields[key] = value.strip()
        if fields:
            records.append(fields)
    return records


def package_record(text, name, version):
    package = name.split(":")[0]
    records = [record for record in parse_records(text)
               if record.get("Package") == package and record.get("Version") == version
               and record.get("Architecture") in ("amd64", "all")]
    if not records:
        raise ValueError("Pinned package is not available in current signed indexes: " + name + "=" + version)
    identities = {(item.get("SHA256"), item.get("Size"), item.get("Architecture")) for item in records}
    if len(identities) != 1:
        raise ValueError("Conflicting binary payloads for package pin: " + name + "=" + version)
    record = records[0]
    if not re.fullmatch("[0-9a-f]{64}", record.get("SHA256", "")):
        raise ValueError("Package index does not provide a valid SHA256")
    size = int(record.get("Size", "0"))
    if not 0 < size <= 512 * 1024 * 1024:
        raise ValueError("Package exceeds binary input limit")
    return {"name": name, "version": version, "architecture": record["Architecture"],
            "sha256": record["SHA256"], "bytes": size,
            "sourcePackage": record.get("Source", package)}


def verify_input_pack(root):
    metadata = root / "input-pack.json"
    if metadata.is_symlink() or not metadata.is_file() or metadata.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("Invalid binary input-pack metadata")
    manifest = json.loads(metadata.read_text())
    if manifest.get("schemaVersion") != 1 or manifest.get("kind") != "debian-runtime-binary-inputs":
        raise ValueError("Unknown binary input-pack format")
    items = manifest.get("packages")
    if not isinstance(items, list) or not 0 < len(items) <= 4096:
        raise ValueError("Invalid binary input package count")
    seen = set()
    pins = set()
    total = 0
    for item in items:
        filename = item.get("file", "")
        sha = item.get("sha256", "")
        if (not re.fullmatch(r"packages/[0-9a-f]{64}\.deb", filename) or filename in seen
                or filename != f"packages/{sha}.deb" or item.get("architecture") not in ("amd64", "all")
                or not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::amd64)?", item.get("name", ""))
                or not re.fullmatch(r"[A-Za-z0-9._+~:-]+", item.get("version", ""))
                or item["name"] in pins or not isinstance(item.get("bytes"), int)
                or not 0 < item["bytes"] <= 512 * 1024 * 1024):
            raise ValueError("Invalid or duplicate binary input file")
        seen.add(filename)
        pins.add(item["name"])
        total += item["bytes"]
        if total > 4 * 1024 * 1024 * 1024:
            raise ValueError("Retained package set exceeds 4 GiB")
        target = root / filename
        if (target.parent.is_symlink() or target.is_symlink() or not target.is_file()
                or target.stat().st_size != item.get("bytes") or digest(target) != item.get("sha256")):
            raise ValueError("Retained package changed or is missing: " + filename)
    pin_file = root / "runtime-packages.txt"
    if pin_file.is_symlink() or not pin_file.is_file() or pin_file.stat().st_size > 1024 * 1024:
        raise ValueError("Retained input pack has no valid pin list")
    expected = [line for line in pin_file.read_text().splitlines() if line]
    actual = [item["name"] + "=" + item["version"] for item in items]
    if sorted(expected) != sorted(actual):
        raise ValueError("Retained input pins differ from the manifest")
    return manifest


def retain(release, output):
    if not Path("/run/.containerenv").exists() and not Path("/.dockerenv").exists():
        raise RuntimeError("Retain binary inputs only in an explicitly invoked disposable Debian container")
    if "VERSION_CODENAME=trixie" not in Path("/etc/os-release").read_text():
        raise RuntimeError("Binary input retention requires Debian trixie")
    if output.exists():
        raise ValueError("Refusing to overwrite retained inputs: " + str(output))
    report_tool = Path(__file__).with_name("release-report.mjs")
    report = json.loads(run("node", str(report_tool), str(release)))
    if report.get("kind") != "runtime" or report.get("distribution") != "debian13":
        raise ValueError("Use a verified Debian runtime package")
    pins = report["packages"]
    if not 0 < len(pins) <= 4096:
        raise ValueError("Runtime package count exceeds retention bound")
    output.parent.mkdir(parents=True, exist_ok=True)
    publication = None
    with tempfile.TemporaryDirectory(prefix="polly-input-retain-") as temporary:
        stage = Path(temporary)
        packages = stage / "packages"
        packages.mkdir()
        download = stage / "download"
        download.mkdir(mode=0o755)
        # _apt retains its sandbox for inbound files even when the container caller is root.
        stage.chmod(0o755)
        if os.getuid() == 0:
            import pwd
            os.chown(download, pwd.getpwnam("_apt").pw_uid, 0)
        entries = []
        total = 0
        for pin in pins:
            spec = pin["name"] + "=" + pin["version"]
            record = package_record(run("apt-cache", "show", spec), pin["name"], pin["version"])
            total += record["bytes"]
            if total > 4 * 1024 * 1024 * 1024:
                raise ValueError("Runtime binary input set exceeds 4 GiB")
            run("apt-get", "download", spec, cwd=download)
            fetched = list(download.iterdir())
            if len(fetched) != 1 or fetched[0].is_symlink() or not fetched[0].is_file():
                raise ValueError("APT download produced unexpected files")
            target = fetched[0]
            if target.stat().st_size != record["bytes"] or digest(target) != record["sha256"]:
                raise ValueError("Downloaded payload differs from indexed checksum: " + spec)
            record["file"] = "packages/" + record["sha256"] + ".deb"
            destination = stage / record["file"]
            if destination.exists():
                raise ValueError("Two pins unexpectedly reference the same payload")
            target.rename(destination)
            destination.chmod(0o644)
            entries.append(record)
            print("Retained " + spec, flush=True)
        download.rmdir()
        (stage / "release-report.json").write_text(json.dumps(report, indent=2) + "\n")
        shutil.copyfile(release / "runtime-packages.txt", stage / "runtime-packages.txt")
        manifest = {"schemaVersion": 1, "kind": "debian-runtime-binary-inputs", "source": report["source"],
                    "distribution": "debian13", "architecture": "amd64", "totalBytes": total, "packages": entries,
                    "limits": [
                        "Binary runtime dependency inputs only, not a complete Debian mirror or source-compliance archive.",
                        "The bootstrap/minbase and custom source builds remain separate inputs.",
                        "APT verifies downloaded packages against indexed metadata; this manifest is not a publisher signature.",
                        "No package is installed, upgraded or executed by this tool.",
                    ]}
        (stage / "input-pack.json").write_text(json.dumps(manifest, indent=2) + "\n")
        verify_input_pack(stage)
        try:
            publication = Path(tempfile.mkdtemp(prefix=".polly-inputs-", dir=output.parent))
            shutil.copytree(stage, publication, dirs_exist_ok=True)
            verify_input_pack(publication)
            publication.rename(output)
            publication = None
        finally:
            if publication is not None:
                shutil.rmtree(publication)
    print("Retained exact runtime binary inputs: " + str(output))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release", type=Path)
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if args.verify:
        if args.output:
            parser.error("--verify accepts only an existing input-pack directory")
        manifest = verify_input_pack(args.release.resolve())
        print("PASS: verified %d retained binary packages" % len(manifest["packages"]))
    else:
        if not args.output:
            parser.error("Provide a new output directory")
        retain(args.release.resolve(), args.output.resolve())


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        import sys
        print("[retain-debian-packages] " + str(error), file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        raise SystemExit(1)
