#!/usr/bin/env python3
import json
from pathlib import Path
import sys
import tarfile

directory = Path(sys.argv[1])
manifest = json.loads((directory / "manifest.json").read_text())
expected = {entry["path"]: entry for entry in manifest["files"]}
archives = list(directory.glob("pollydesktop-*-alpine3.24-x86_64.tar.gz"))
assert len(archives) == 1
with tarfile.open(archives[0], "r:gz") as archive:
    seen = set()
    for entry in archive:
        assert entry.uid == 0 and entry.gid == 0, entry.name
        assert not entry.mode & 0o022, entry.name
        if entry.isdir():
            assert entry.mode == 0o755, entry.name
        else:
            relative = entry.name.removeprefix("./")
            assert entry.isfile() and relative in expected, entry.name
            assert entry.mode == int(expected[relative]["mode"], 8), entry.name
            assert entry.size == expected[relative]["size"], entry.name
            seen.add(relative)
    assert seen == set(expected)
print("PASS: archive ownership and install modes are independent of Windows checkout permissions")
