#!/usr/bin/env python3
"""Assign explicit install modes independent of the checkout filesystem."""
from pathlib import Path
import sys
import tarfile

root, output = map(Path, sys.argv[1:])


def metadata(entry):
    relative = entry.name.removeprefix("./")
    if not entry.isdir() and not entry.isfile():
        raise ValueError("Unexpected runtime archive entry: " + entry.name)
    entry.uid = entry.gid = 0
    entry.uname = entry.gname = "root"
    executable = relative.startswith("usr/bin/") or (
        relative.startswith("usr/share/pollyui/desktop/tools/") and relative.endswith(".sh"))
    entry.mode = 0o755 if entry.isdir() or executable else 0o644
    return entry


with tarfile.open(output, "w:gz") as archive:
    archive.add(root, arcname=".", filter=metadata)
