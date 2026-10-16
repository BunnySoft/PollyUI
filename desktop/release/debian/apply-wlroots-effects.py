#!/usr/bin/env python3
"""Apply/check the single pinned scene-effects dependency, never a system library."""
import argparse
import ctypes
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "wlroots-effects.json"


def definition():
    record = json.loads(MANIFEST.read_text())
    patch = HERE.parents[1] / "patches" / record["patch"]
    if record["schemaVersion"] != 1 or record["upstreamVersion"] != "0.19.3" or record["abi"] != 2:
        raise ValueError("Unsupported wlroots scene-effects definition")
    if hashlib.sha256(patch.read_bytes()).hexdigest() != record["patchSha256"]:
        raise ValueError("wlroots scene-effects patch checksum mismatch")
    return record, patch


def apply(source):
    record, patch = definition()
    if not source.is_dir() or source.is_symlink():
        raise ValueError("An extracted pinned wlroots source directory is required")
    meson = (source / "meson.build").read_text()
    if "version: '0.19.3'" not in meson:
        raise ValueError("wlroots source version does not match the effects patch")
    command = ["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i", str(patch)]
    subprocess.run(command + ["--dry-run"], cwd=source, check=True)
    subprocess.run(command, cwd=source, check=True)
    return record


def record_install(prefix):
    definition()
    destination = prefix / "share/pollyui/wlroots-effects.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(json.loads(MANIFEST.read_text()), sort_keys=True, indent=2) + "\n")


def check_install(prefix):
    record, _ = definition()
    installed = prefix / "share/pollyui/wlroots-effects.json"
    if json.loads(installed.read_text()) != record:
        raise ValueError("SDK wlroots effects recipe differs from the package source")
    library = ctypes.CDLL(str(prefix / "lib/libwlroots-0.19-polly-effects2.so"))
    marker = library.wlr_scene_effects_abi_v2
    marker.argtypes = []
    marker.restype = ctypes.c_uint32
    if marker() != record["abi"]:
        raise ValueError("SDK wlroots effects ABI differs from its recipe")
    identity = library.wlr_scene_effects_source_sha256_v2
    identity.argtypes = []
    identity.restype = ctypes.c_char_p
    if identity().decode("ascii") != record["patchSha256"]:
        raise ValueError("Built wlroots scene-effects patch differs from its recipe")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check-installed", action="store_true")
    mode.add_argument("--record-installed", action="store_true")
    args = parser.parse_args()
    if args.check_installed:
        check_install(args.directory)
    elif args.record_installed:
        record_install(args.directory)
    else:
        apply(args.directory)
