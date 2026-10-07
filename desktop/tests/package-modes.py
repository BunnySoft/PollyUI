#!/usr/bin/env python3
import json
import hashlib
from pathlib import Path, PurePosixPath
import sys
import tarfile

directory = Path(sys.argv[1])
manifest = json.loads((directory / "manifest.json").read_text())
expected = {entry["path"]: entry for entry in manifest["files"]}
assert len(expected) == len(manifest["files"]), "Duplicate manifest file path"
archives = list(directory.glob("pollydesktop-*-x86_64.tar.gz"))
assert len(archives) == 1
with tarfile.open(archives[0], "r:gz") as archive:
    seen = set()
    names = set()
    for entry in archive:
        relative = entry.name.removeprefix("./")
        normalized = PurePosixPath(relative)
        assert not normalized.is_absolute() and ".." not in normalized.parts and "\\" not in relative, entry.name
        assert relative == "." or (relative and relative == normalized.as_posix()), entry.name
        assert relative not in names, "Duplicate archive path: " + entry.name
        names.add(relative)
        assert entry.uid == 0 and entry.gid == 0, entry.name
        assert not entry.mode & 0o022, entry.name
        if entry.isdir():
            assert entry.mode == 0o755, entry.name
        else:
            assert entry.isfile() and relative in expected, entry.name
            assert relative not in seen, "Duplicate archive member: " + entry.name
            assert entry.mode == int(expected[relative]["mode"], 8), entry.name
            assert entry.size == expected[relative]["size"], entry.name
            with archive.extractfile(entry) as payload:
                digest = hashlib.sha256()
                while block := payload.read(1024 * 1024):
                    digest.update(block)
            assert digest.hexdigest() == expected[relative]["sha256"], entry.name
            seen.add(relative)
    assert seen == set(expected)
print("PASS: archive ownership and install modes are independent of Windows checkout permissions")
