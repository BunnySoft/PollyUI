#!/usr/bin/env python3
"""Restore checksummed dependency inputs in a disposable build container."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
definition = importlib.util.spec_from_file_location("source_retention", Path(__file__).with_name("retain-build-sources.py"))
source_retention = importlib.util.module_from_spec(definition)
definition.loader.exec_module(source_retention)


def run(*command):
    return subprocess.check_output(command, stderr=subprocess.STDOUT, timeout=120)


def restore(source, target):
    if not Path("/run/.containerenv").exists() and not Path("/.dockerenv").exists():
        raise RuntimeError("Restore dependency sources only in an explicitly invoked disposable build container")
    manifest = source_retention.verify(source)
    if target.exists():
        raise ValueError("Refusing to replace existing restored sources")
    files = {entry["path"] for entry in manifest["files"]}
    records = {entry["name"]: entry for entry in manifest["components"]}
    required = {"skia", "sdl", "harfbuzz", "wlroots", "wlr-protocols", "libinput"}
    if len(records) != len(manifest["components"]) or set(records) not in (required, required | {"mesa"}):
        raise ValueError("Unexpected custom dependency set")
    recipes = source_retention.RECIPE_PATHS + (source_retention.MESA_RECIPE_PATHS if "mesa" in records else ())
    for path in recipes:
        if "recipes/" + Path(path).name not in files:
            raise ValueError("Missing verified recipe: " + path)
    pins = json.loads((source / "recipes/sources.json").read_text())
    input_pin = json.loads((source / "recipes/libinput.json").read_text())
    for name in ("skia", "sdl", "harfbuzz"):
        entry = records[name]
        if (not re.fullmatch("[0-9a-f]{40}", entry["revision"]) or entry.get("gitBundle") not in files
                or entry["revision"] != pins["sharedBuildPins"][name]
                or (entry.get("shallowBoundary") and entry["shallowBoundary"] not in files)):
            raise ValueError("Source pack lacks a verifiable offline Git input for " + name)
    if records["sdl"].get("patch") != "recipes/sdl-wayland-sync-lifetime.patch":
        raise ValueError("Unexpected SDL patch")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".polly-restore-", dir=target.parent))
    try:
        for name in ("skia", "sdl", "harfbuzz"):
            entry = records[name]
            directory = staging / ("pollyui-" + name)
            run("git", "-c", "init.defaultBranch=main", "clone", "--quiet", "--no-checkout", "--",
                str(source / entry["gitBundle"]), str(directory))
            boundary = entry.get("shallowBoundary")
            if boundary:
                text = (source / boundary).read_text()
                if not text.strip() or not all(re.fullmatch("[0-9a-f]{40}", line) for line in text.splitlines()):
                    raise ValueError("Invalid preserved shallow boundary")
                (directory / ".git/shallow").write_text(text)
            run("git", "-C", str(directory), "fsck", "--no-reflogs")
            run("git", "-C", str(directory), "checkout", "--quiet", "--detach", entry["revision"])
            if run("git", "-C", str(directory), "rev-parse", "HEAD").decode().strip() != entry["revision"]:
                raise ValueError("Restored Git revision does not match")
            if run("git", "-C", str(directory), "status", "--porcelain").strip():
                raise ValueError("Restored upstream source is not pristine")
            # No hooks/config are imported; origin remains the local retained bundle.
        for name in ("wlroots", "wlr-protocols"):
            entry = records[name]
            if (entry["file"] not in files or entry["version"] != pins[name]["version"]
                    or not re.fullmatch("[A-Za-z0-9_.+-]+", entry["version"])):
                raise ValueError("Missing or mismatched verified archive")
            archive = source / entry["file"]
            if source_retention.digest(archive, "sha512") != pins[name]["sha512"]:
                raise ValueError("Archive disagrees with retained build pin")
            with tarfile.open(archive) as contents:
                expected = name + "-" + entry["version"]
                for item in contents.getmembers():
                    if item.name.split("/")[0] != expected:
                        raise ValueError("Unexpected upstream archive prefix")
                contents.extractall(staging, filter="data")
        libinput = records["libinput"]
        if libinput["file"] not in files:
            raise ValueError("Missing verified Debian source descriptor")
        descriptor = source / libinput["file"]
        version, archive_files = source_retention.dsc_files(descriptor.read_text())
        if (version != libinput["version"] or version != input_pin["version"]
                or not re.fullmatch("[A-Za-z0-9_.+~-]+", version)):
            raise ValueError("Libinput source descriptor version mismatch")
        for item in archive_files:
            if "sources/" + item["name"] not in files:
                raise ValueError("Missing referenced Debian source archive")
            archive = source / "sources" / item["name"]
            if archive.stat().st_size != item["bytes"] or source_retention.digest(archive) != item["sha256"]:
                raise ValueError("Debian source descriptor disagrees with retained archive bytes")
        source_directory = staging / "pollyui-input-source"
        source_directory.mkdir()
        extracted = source_directory / ("libinput-" + version.rsplit("-", 1)[0])
        print(run("dpkg-source", "-x", str(descriptor), str(extracted)).decode(), end="")
        if "mesa" in records:
            mesa = records["mesa"]
            mesa_pin = json.loads((source / "recipes/mesa.json").read_text())
            if (mesa["version"] != mesa_pin["sourceVersion"] or mesa["rebuiltVersion"] != mesa_pin["rebuiltVersion"]
                    or mesa.get("patch") != "recipes/mesa-lifetime.patch"):
                raise ValueError("Mesa source and retained recipe differ")
            for name, expected in mesa_pin["sourceFiles"].items():
                if "sources/" + name not in files or source_retention.digest(source / "sources" / name) != expected:
                    raise ValueError("Mesa source archive differs from its retained pin")
            descriptor_name = "sources/mesa_" + mesa_pin["sourceVersion"] + ".dsc"
            if mesa["file"] != descriptor_name or descriptor_name not in files:
                raise ValueError("Mesa source descriptor mismatch")
            print(run("dpkg-source", "-x", str(source / descriptor_name), str(staging / "pollyui-mesa-source")).decode(), end="")
        for path in recipes:
            destination = staging / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / "recipes" / Path(path).name, destination)
        (staging / "restore-manifest.json").write_text(json.dumps({
            "schemaVersion": 1, "sourcePackSha256": source_retention.digest(source / "source-pack.json"),
            "components": manifest["components"],
            "limits": [
                "Preserved shallow Git boundaries are intentional; no full upstream history is claimed.",
                "SDK toolchain and system build dependencies are not installed by this source restoration.",
                "SDL remains pristine; apply the retained patch with the existing pinned build recipe.",
            ],
        }, indent=2) + "\n")
        staging.rename(target)
    except BaseException:
        shutil.rmtree(staging)
        raise
    print("Restored verified offline dependency sources: " + str(target))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    try:
        restore(args.source.resolve(), args.target.resolve())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, tarfile.TarError) as error:
        print("[restore-build-sources] " + str(error), file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.output.decode(errors="replace"), file=sys.stderr)
        raise SystemExit(1)
