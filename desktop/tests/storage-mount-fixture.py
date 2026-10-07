#!/usr/bin/env python3
"""Real mapping operations in a disposable namespace; tmpfs is not ext4/UUID boot evidence."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or not Path("/run/.containerenv").exists():
        raise RuntimeError("Mapping fixture requires an isolated root container")
    if args.report and (args.report.exists() or args.report.is_symlink()):
        raise RuntimeError("Refusing to overwrite storage evidence")
    spec = importlib.util.spec_from_file_location("storage",
        args.repo / "desktop/release/storage/storage.py")
    storage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(storage)
    volumes = {"EFI": "12AB-34CD", "SYSTEM": "10000000-0000-4000-8000-000000000001",
               "PERSISTENT": "10000000-0000-4000-8000-000000000002",
               "RECOVERY": "10000000-0000-4000-8000-000000000003"}
    contract = storage.layout.contract(volumes)
    subprocess.run(["mount", "--make-rprivate", "/"], check=True, timeout=10)
    with tempfile.TemporaryDirectory(prefix="polly-storage-mount-") as temporary:
        root = Path(temporary) / "root"
        root.mkdir()
        subprocess.run(["mount", "-t", "tmpfs", "-o", "mode=755", "tmpfs", str(root)],
                       check=True, timeout=10)
        try:
            manifest = root / "etc/polly-storage.json"
            manifest.parent.mkdir()
            manifest.write_text(json.dumps(contract))
            state = storage.Storage(root)
            persistent = state.persistent
            persistent.mkdir(mode=0o755, parents=True)
            subprocess.run(["mount", "-t", "tmpfs", "-o", "mode=755,nodev,nosuid",
                            "tmpfs", str(persistent)], check=True, timeout=10)
            for directory in contract["directories"]:
                path = persistent / directory["path"]
                path.mkdir(mode=directory["mode"], parents=True, exist_ok=True)
                path.chmod(directory["mode"])
            for user in contract["users"]:
                path = persistent / f"Users/{user['uid']}"
                path.mkdir(mode=0o700)
                os.chown(path, user["uid"], user["gid"])
            for mapping in contract["mappings"]:
                source, target = state.source(mapping), state.path(mapping["target"])
                source.mkdir(mode=0o755, parents=True, exist_ok=True)
                target.mkdir(mode=0o755, parents=True, exist_ok=True)
                if mapping["target"] == "/var/tmp":
                    target.chmod(0o1777)
            efi = state.path("/System/Boot/efi")
            efi.mkdir()
            subprocess.run(["mount", "-t", "tmpfs", "-o", "mode=755", "tmpfs", str(efi)],
                           check=True, timeout=10)
            (efi / "probe").write_text("actual EFI child mount\n")
            (persistent / "SystemData/Library/Dpkg/probe").write_text("package authority\n")
            usr = state.path("/usr")
            subprocess.run(["mount", "--bind", str(state.path("/System/Resources")), str(usr)],
                           check=True, timeout=10)
            subprocess.run(["mount", "-o", "remount,bind,ro", str(usr)], check=True, timeout=10)

            def volume(path, role, flags):
                record = storage.command("/usr/bin/findmnt", "-rn", "-M", str(path), "-o", "OPTIONS")
                if not set(flags).issubset(record.split(",")):
                    raise RuntimeError("Real mount flags do not match the contract: " + record)
                expected = {"SYSTEM": root, "PERSISTENT": persistent, "EFI": efi}[role]
                if path.stat().st_dev != expected.stat().st_dev:
                    raise RuntimeError("Real mapping references another volume")

            with patch.object(state, "volume", side_effect=volume):
                state.prepare()
                state.check()
                state.prepare()
                state.check()
                if (state.path("/boot/efi/probe")).read_text() != "actual EFI child mount\n":
                    raise RuntimeError("Recursive boot alias lost the mounted EFI child")
                target = state.path("/var/lib/dpkg/probe")
                if target.read_text() != "package authority\n":
                    raise RuntimeError("Package state mapping references a second database")
                target.write_text("same authority through compatibility path\n")
                if (persistent / "SystemData/Library/Dpkg/probe").read_text() != target.read_text():
                    raise RuntimeError("Package writes did not reach the persistent authority")
                (usr / "writable-probe").write_text("usr writable after root remount\n")
                if (state.path("/System/Resources/writable-probe")).read_text() != \
                        "usr writable after root remount\n":
                    raise RuntimeError("Writable usr does not reach system resources")
                subprocess.run(["umount", str(state.path("/var/lib/apt"))], check=True, timeout=10)
                try:
                    state.check()
                except ValueError:
                    pass
                else:
                    raise RuntimeError("Missing apt state mapping did not refuse maintenance")
                apt = next(mapping for mapping in contract["mappings"] if mapping["target"] == "/var/lib/apt")
                state.alias(apt)
                state.check()
                (root / "run/polly-storage/ready").write_text("another contract\n")
                try:
                    state.check()
                except ValueError as error:
                    if "another contract" not in str(error):
                        raise RuntimeError("Wrong readiness test failed for an unrelated reason") from error
                else:
                    raise RuntimeError("Wrong readiness record was accepted")
                (root / "run/polly-storage/ready").write_text(state.fingerprint + "\n")
                (persistent / "SystemData/Network").chmod(0o755)
                try:
                    state.check()
                except ValueError as error:
                    if "SystemData/Network" not in str(error):
                        raise RuntimeError("Private state permissions test failed elsewhere") from error
                else:
                    raise RuntimeError("Public permissions on private network state were accepted")
        finally:
            subprocess.run(["umount", "--recursive", str(root)], check=True, timeout=10)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        with args.report.open("x", encoding="utf8") as report:
            json.dump({"schemaVersion": 1, "result": "pass", "mappedPaths": len(contract["mappings"]),
                       "idempotent": True, "usrRemountedWritable": True,
                       "efiChildRetained": True, "stateLossRejected": True,
                       "filesystem": "tmpfs-fixture", "newLayoutColdBootVerified": False}, report, indent=2)
            report.write("\n")
    print("PASS: actual required binds, writable usr, EFI child, idempotence and missing-state refusal")


if __name__ == "__main__":
    main()
