#!/usr/bin/env python3
"""Retain exact generated overlay/origin bytes beside a private exported root."""
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import tarfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", type=Path)
    args = parser.parse_args()
    root_tools = runpy.run_path(str(Path(__file__).with_name("live-root.py")))
    with tarfile.open(args.inputs / "root.tar", "r:") as archive:
        members = root_tools["export_members"](archive)

        def read(name):
            member = members[name]
            if not member.isfile() or member.uid or member.gid:
                raise ValueError("Invalid regular root-owned retained input: " + name)
            with archive.extractfile(member) as source:
                return source.read()

        data = read("usr/share/pollyui/runtime-origin.json")
        origin = json.loads(data)
        target = args.inputs / "runtime-origin.json"
        with target.open("xb") as output:
            output.write(data)
        frozen = args.inputs / "frozen-overlays"
        frozen.mkdir()
        seen = set()
        for item in origin["overlays"]:
            name = root_tools["safe_name"](item["path"])
            if name in seen:
                raise ValueError("Duplicate retained overlay: " + name)
            seen.add(name)
            data = read(name)
            if hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise ValueError("Exported overlay differs from origin: " + name)
            target = frozen / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as output:
                output.write(data)
            target.chmod(int(item["mode"], 8) if "mode" in item else
                         0o755 if name == "init" or name.startswith("usr/bin/") or name.endswith(".sh") else 0o644)
    print("PASS: retained actual root origin and every frozen overlay")


if __name__ == "__main__":
    main()
