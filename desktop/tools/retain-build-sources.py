#!/usr/bin/env python3
"""Retain already-fetched custom dependency sources; no network or SDK binaries."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[2]
RECIPE_PATHS = (
    "desktop/release/debian/Containerfile.sdk", "desktop/release/debian/sources.json",
    "desktop/release/debian/libinput.json", "desktop/release/debian/build-wlroots.py",
    "desktop/release/debian/build-libinput.sh", "desktop/tools/build-skia-linux.sh",
    "desktop/tools/skia-linux.gn", "desktop/tools/build-sdl-linux.sh", "desktop/tools/build-harfbuzz-linux.sh",
    "desktop/patches/sdl-wayland-sync-lifetime.patch",
)


def digest(path, algorithm="sha256"):
    value = hashlib.new(algorithm)
    with path.open("rb") as file:
        while block := file.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()


def git(source, *args, env=None):
    return subprocess.check_output(["git", "-C", str(source), *args], env=env, timeout=120)


def dsc_files(text):
    version = None
    entries = []
    active = False
    for line in text.splitlines():
        if line.startswith("Version: "):
            version = line.removeprefix("Version: ")
        if line == "Checksums-Sha256:":
            active = True
            continue
        if not line.startswith(" "):
            active = False
        if active:
            match = re.fullmatch(r" ([0-9a-f]{64}) ([0-9]+) ([A-Za-z0-9_.+~-]+)", line)
            if not match or match[3] in (".", ".."):
                raise ValueError("Invalid source archive checksum entry")
            entries.append({"sha256": match[1], "bytes": int(match[2]), "name": match[3]})
    if not version or not entries or len({item["name"] for item in entries}) != len(entries):
        raise ValueError("Source descriptor has no unique archive checksum set")
    return version, entries


def verify(root):
    file = root / "source-pack.json"
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 1024 * 1024:
        raise ValueError("Invalid custom source pack")
    manifest = json.loads(file.read_text())
    if manifest.get("schemaVersion") != 1 or manifest.get("kind") != "custom-dependency-sources":
        raise ValueError("Unsupported source-pack metadata")
    seen = set()
    for entry in manifest["files"]:
        name = entry["path"]
        if not re.fullmatch(r"(?:sources|recipes)/[A-Za-z0-9_.+~-]+", name) or name in seen:
            raise ValueError("Invalid or duplicate retained source path")
        seen.add(name)
        path = root / name
        if path.parent.is_symlink() or path.is_symlink() or not path.is_file():
            raise ValueError("Source input must be a regular file")
        if path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]:
            raise ValueError("Retained source or recipe changed: " + name)
    if not seen:
        raise ValueError("Source input pack is empty")
    return manifest


def retain(output):
    if not Path("/run/.containerenv").exists() and not Path("/.dockerenv").exists():
        raise RuntimeError("Use an explicitly invoked disposable SDK container")
    if output.exists():
        raise ValueError("Refusing to replace existing source inputs")
    output.parent.mkdir(parents=True, exist_ok=True)
    definition = json.loads((REPO / "desktop/release/debian/sources.json").read_text())
    publication = None
    with tempfile.TemporaryDirectory(prefix="polly-source-pack-") as temporary:
        stage = Path(temporary)
        sources, recipes = stage / "sources", stage / "recipes"
        sources.mkdir()
        recipes.mkdir()
        records = []
        for name in ("skia", "sdl", "harfbuzz"):
            source = Path("/opt") / ("pollyui-" + name)
            revision = definition["sharedBuildPins"][name]
            if git(source, "rev-parse", "HEAD").decode().strip() != revision:
                raise ValueError("SDK source revision differs from the committed pin: " + name)
            actual = git(source, "diff", "--binary", "HEAD", "--")
            if name == "sdl":
                patch = REPO / "desktop/patches/sdl-wayland-sync-lifetime.patch"
                environment = dict(os.environ, GIT_INDEX_FILE=str(stage / "expected-sdl-index"))
                git(source, "read-tree", "HEAD", env=environment)
                git(source, "apply", "--cached", str(patch), env=environment)
                expected = git(source, "diff", "--cached", "--binary", "HEAD", "--", env=environment)
                if actual != expected:
                    raise ValueError("SDL source differs from exactly the recorded lifetime patch")
                (stage / "expected-sdl-index").unlink()
                shutil.copyfile(patch, recipes / patch.name)
            elif actual:
                raise ValueError("Unexpected tracked source changes: " + name)
            filename = name + "-" + revision + ".tar.gz"
            git(source, "archive", "--format=tar.gz", "--prefix=" + name + "/", "--output=" + str(sources / filename), revision)
            bundle = name + "-" + revision + ".bundle"
            git(source, "bundle", "create", str(sources / bundle), "HEAD")
            shallow = source / ".git/shallow"
            boundary = None
            if shallow.exists():
                contents = shallow.read_text()
                if not contents.strip() or not all(re.fullmatch("[0-9a-f]{40}", line) for line in contents.splitlines()):
                    raise ValueError("SDK has an invalid shallow source boundary")
                boundary = "sources/" + name + "-shallow.txt"
                (stage / boundary).write_text(contents)
            records.append({"name": name, "revision": revision, "file": "sources/" + filename,
                            "format": "git archive of tracked pristine upstream source",
                            "gitBundle": "sources/" + bundle, "shallowBoundary": boundary,
                            "patch": "recipes/sdl-wayland-sync-lifetime.patch" if name == "sdl" else None})
        for name in ("wlroots", "wlr-protocols"):
            expected = definition[name]
            source = Path("/opt") / expected["archive"]
            if source.is_symlink() or digest(source, "sha512") != expected["sha512"]:
                raise ValueError("SDK archive differs from pinned checksum: " + name)
            shutil.copyfile(source, sources / source.name)
            records.append({"name": name, "version": expected["version"], "url": expected["url"],
                            "sha512": expected["sha512"], "file": "sources/" + source.name})
        input_pin = json.loads((REPO / "desktop/release/debian/libinput.json").read_text())
        descriptor = Path("/opt/pollyui-input-source") / ("libinput_" + input_pin["version"] + ".dsc")
        version, archives = dsc_files(descriptor.read_text())
        if version != input_pin["version"]:
            raise ValueError("Debian libinput source version does not match")
        for entry in archives:
            archive = descriptor.parent / entry["name"]
            if archive.is_symlink() or archive.stat().st_size != entry["bytes"] or digest(archive) != entry["sha256"]:
                raise ValueError("Debian source component checksum mismatch: " + entry["name"])
            shutil.copyfile(archive, sources / archive.name)
        shutil.copyfile(descriptor, sources / descriptor.name)
        records.append({"name": "libinput", "version": version, "file": "sources/" + descriptor.name,
                        "format": "Debian source descriptor and verified referenced archives"})
        for file in RECIPE_PATHS:
            shutil.copyfile(REPO / file, recipes / Path(file).name)
        inventory = [{"path": str(file.relative_to(stage)), "bytes": file.stat().st_size, "sha256": digest(file)}
                     for directory in (sources, recipes) for file in sorted(directory.iterdir())]
        manifest = {"schemaVersion": 1, "kind": "custom-dependency-sources", "components": records, "files": inventory,
                    "limits": [
                        "Custom dependency inputs and matching recipes only; not all Debian source packages or a complete toolchain.",
                        "Project sources are retained separately in Git; this pack contains no application/user data.",
                        "A source archive is not a completed redistribution license audit or proof of bit-identical rebuilding.",
                        "No archive is extracted or executed, and no network is accessed.",
                    ]}
        (stage / "source-pack.json").write_text(json.dumps(manifest, indent=2) + "\n")
        verify(stage)
        try:
            publication = Path(tempfile.mkdtemp(prefix=".polly-source-inputs-", dir=output.parent))
            shutil.copytree(stage, publication, dirs_exist_ok=True)
            verify(publication)
            publication.rename(output)
            publication = None
        finally:
            if publication is not None:
                shutil.rmtree(publication)
    print("Retained custom dependency sources and patch/build recipes: " + str(output))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    try:
        if args.verify:
            result = verify(args.directory.resolve())
            print("PASS: verified %d retained source/build files" % len(result["files"]))
        else:
            retain(args.directory.resolve())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        import sys
        print("[retain-build-sources] " + str(error), file=sys.stderr)
        raise SystemExit(1)
