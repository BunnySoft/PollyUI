#!/usr/bin/python3 -I
"""Required storage mappings; never initialize, migrate or repair missing state."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import syslog
import tempfile

spec = importlib.util.spec_from_file_location("polly_storage_layout", Path(__file__).resolve().with_name("layout.py"))
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)

RUNTIME = "/run/polly-storage"


def command(*arguments):
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=20)
    if result.returncode != 0:
        raise RuntimeError("Storage command failed: " + " ".join(arguments) + ": " + result.stderr.strip())
    return result.stdout.strip()


def validate_volume(record, expected, filesystem, flags, forbidden=()):
    fields = record.split()
    if len(fields) != 3 or fields[:2] != [expected, filesystem] or \
            not set(flags).issubset(fields[2].split(",")) or \
            set(forbidden).intersection(fields[2].split(",")):
        raise ValueError("Required filesystem identity, type or mount flags do not match")


class Storage:
    def __init__(self, root=Path("/")):
        self.root = root
        path = self.path(layout.MANIFEST_PATH)
        self.trusted(path, directory=False)
        with path.open("rb") as source:
            contents = source.read(65537)
        if len(contents) > 65536:
            raise ValueError("Storage manifest exceeds its size limit")
        self.contract = layout.validate(json.loads(contents))
        self.fingerprint = hashlib.sha256(json.dumps(
            self.contract, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.volumes = {volume["role"]: volume["uuid"] for volume in self.contract["volumes"]}
        self.persistent = self.path(self.contract["persistentMount"])

    def path(self, name):
        return self.root / name.lstrip("/")

    def trusted(self, path, directory=True, uid=0, gid=0, mode=None):
        for parent in reversed(path.relative_to(self.root).parents):
            ancestor = self.root / parent
            info = ancestor.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError("Unsafe storage ancestor: " + str(ancestor))
        info = path.lstat()
        valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
        if not valid_type or info.st_uid != uid or info.st_gid != gid or \
                (stat.S_IMODE(info.st_mode) != mode if mode is not None else info.st_mode & 0o022):
            raise ValueError("Unsafe storage path: " + str(path))
        return info

    def mounted(self, path):
        result = subprocess.run(["/usr/bin/findmnt", "-rn", "-M", str(path), "-o", "TARGET"],
                                capture_output=True, text=True, timeout=10)
        if result.returncode not in (0, 1):
            raise RuntimeError("Cannot inspect storage mount: " + result.stderr)
        return result.returncode == 0

    def volume(self, path, role, flags):
        record = command("/usr/bin/findmnt", "-rn", "-M", str(path), "-o", "UUID,FSTYPE,OPTIONS")
        forbidden = ("nosuid", "noexec") if role == "SYSTEM" and \
            path in (self.root, self.path("/usr")) else ()
        validate_volume(record, self.volumes[role], "vfat" if role == "EFI" else "ext4", flags, forbidden)

    def source(self, mapping):
        base = self.root if mapping["volume"] == "SYSTEM" else self.persistent
        return base / mapping["source"]

    def preflight(self):
        self.volume(self.root, "SYSTEM", ("rw",))
        self.trusted(self.persistent, mode=0o755)
        self.volume(self.persistent, "PERSISTENT", ("rw", "nodev", "nosuid"))
        boot_efi = self.path("/System/Boot/efi")
        self.trusted(boot_efi)
        self.volume(boot_efi, "EFI", ("rw",))
        for directory in self.contract["directories"]:
            self.trusted(self.persistent / directory["path"], uid=directory["uid"],
                         gid=directory["gid"], mode=directory["mode"])
        users = {f"Users/{user['uid']}": user for user in self.contract["users"]}
        for mapping in self.contract["mappings"]:
            source = self.source(mapping)
            if mapping["source"] in users:
                user = users[mapping["source"]]
                self.trusted(source, uid=user["uid"], gid=user["gid"], mode=0o700)
            else:
                self.trusted(source, mode=0o1777 if mapping["target"] == "/var/tmp" else None)
            if source.stat().st_dev != (self.root if mapping["volume"] == "SYSTEM"
                                        else self.persistent).stat().st_dev:
                raise ValueError("Storage source is on an unexpected filesystem")
        usr = self.path("/usr")
        source = self.path("/System/Resources")
        if not self.mounted(usr) or not os.path.samestat(source.stat(), usr.stat()):
            raise ValueError("Early usr mapping is absent or references another software tree")
        self.volume(usr, "SYSTEM", ())

    def alias(self, mapping):
        source, target = self.source(mapping), self.path(mapping["target"])
        if self.mounted(target):
            if not os.path.samestat(source.stat(), target.stat()):
                raise ValueError("Refusing to replace an unexpected storage mount: " + str(target))
        else:
            self.trusted(target, mode=0o1777 if mapping["target"] == "/var/tmp" else None)
            if any(target.iterdir()):
                raise ValueError("Refusing to hide a second state tree: " + str(target))
            command("/usr/bin/mount", "-n", "--rbind" if mapping["target"] == "/boot" else "--bind",
                    str(source), str(target))
        flags = "remount,bind,rw"
        if mapping["volume"] == "PERSISTENT":
            flags += ",nodev,nosuid"
        command("/usr/bin/mount", "-n", "-o", flags, str(target))

    def verify_aliases(self):
        for mapping in self.contract["mappings"]:
            source, target = self.source(mapping), self.path(mapping["target"])
            if not self.mounted(target) or not os.path.samestat(source.stat(), target.stat()):
                raise ValueError("Required storage mapping is absent or mismatched: " + str(target))
            flags = ("rw",) if mapping["volume"] == "SYSTEM" else ("rw", "nodev", "nosuid")
            self.volume(target, mapping["volume"], flags)
        self.volume(self.path("/boot/efi"), "EFI", ("rw",))
        if not os.path.samestat(self.path("/System/Boot/efi").stat(), self.path("/boot/efi").stat()):
            raise ValueError("Boot compatibility path lost the actual EFI mount")

    def prepare(self):
        if os.geteuid() != 0:
            raise PermissionError("Storage preparation requires root")
        self.preflight()
        for mapping in self.contract["mappings"]:
            self.alias(mapping)
        self.verify_aliases()
        runtime = self.path(RUNTIME)
        runtime.mkdir(mode=0o755, exist_ok=True)
        self.trusted(runtime, mode=0o755)
        fd, name = tempfile.mkstemp(prefix=".ready-", dir=runtime)
        temporary = Path(name)
        try:
            with os.fdopen(fd, "w", encoding="utf8") as target:
                target.write(self.fingerprint + "\n")
                target.flush()
                os.fchmod(target.fileno(), 0o644)
                os.fsync(target.fileno())
            ready = runtime / "ready"
            if ready.exists() or ready.is_symlink():
                self.trusted(ready, directory=False)
            os.replace(temporary, ready)
            directory = os.open(runtime, os.O_DIRECTORY | os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)
        print("POLLY_STORAGE_READY", flush=True)

    def check(self):
        self.preflight()
        self.verify_aliases()
        ready = self.path(RUNTIME) / "ready"
        self.trusted(ready, directory=False)
        with ready.open("rb") as source:
            record = source.read(66)
        if record != (self.fingerprint + "\n").encode():
            raise ValueError("Storage readiness belongs to another contract")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "check"))
    args = parser.parse_args()
    try:
        storage = Storage()
        getattr(storage, args.operation)()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        message = "POLLY_STORAGE_FAILED: " + str(error)
        syslog.syslog(syslog.LOG_ERR, message)
        print(message, file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
