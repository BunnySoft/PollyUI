#!/usr/bin/env python3
"""Required-storage faults on private tmpfs; not ext4, boot or power-cut proof."""
import argparse
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from unittest.mock import patch

VOLUMES = {
    "EFI": "12AB-34CD",
    "SYSTEM": "10000000-0000-4000-8000-000000000001",
    "PERSISTENT": "10000000-0000-4000-8000-000000000002",
    "RECOVERY": "10000000-0000-4000-8000-000000000003",
}


def run(*arguments, **options):
    return subprocess.run(arguments, check=True, timeout=20, **options)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if os.getuid() != 0 or os.geteuid() != 0 or not Path("/run/.containerenv").exists():
        raise RuntimeError("Storage faults require an isolated root container")
    if args.report and (args.report.exists() or args.report.is_symlink()):
        raise RuntimeError("Refusing to overwrite storage fault evidence")
    program = args.repo / "desktop/release/storage/storage.py"
    spec = importlib.util.spec_from_file_location("storage_fault_backend", program)
    storage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(storage)
    contract = storage.layout.contract(VOLUMES)
    results = []

    def refused(label, action, message=None, number=None):
        started = time.monotonic()
        with patch("sys.stdout", new_callable=io.StringIO) as output:
            try:
                action()
            except (OSError, ValueError, RuntimeError) as error:
                error_type = type(error).__name__
                observed_errno = getattr(error, "errno", None)
                if message and message not in str(error):
                    raise RuntimeError("Fault failed for an unrelated reason: " + label) from error
                if number is not None and getattr(error, "errno", None) != number:
                    raise RuntimeError("Fault returned the wrong errno: " + label) from error
            else:
                raise RuntimeError("Required refusal was not enforced: " + label)
        if "POLLY_STORAGE_READY" in output.getvalue():
            raise RuntimeError("Failure printed a success marker: " + label)
        elapsed = time.monotonic() - started
        if elapsed > 10:
            raise RuntimeError("Fault exceeded its 10-second bound: " + label)
        results.append({"fault": label, "result": "refused", "errorType": error_type,
                        "errno": observed_errno, "milliseconds": round(elapsed * 1000, 2)})

    run("mount", "--make-rprivate", "/")
    with tempfile.TemporaryDirectory(prefix="polly-storage-fault-") as temporary:
        stage = Path(temporary)
        stage.chmod(0o755)
        root = stage / "root"
        root.mkdir()
        run("mount", "-t", "tmpfs", "-o", "mode=755,size=4m", "tmpfs", str(root))
        try:
            manifest = root / "etc/polly-storage.json"
            manifest.parent.mkdir()
            manifest.write_text(json.dumps(contract))
            manifest.chmod(0o644)
            run_root = root / "run"
            run_root.mkdir()
            run("mount", "-t", "tmpfs", "-o", "mode=755,nodev,nosuid,size=64k",
                "tmpfs", str(run_root))
            state = storage.Storage(root)
            persistent = state.persistent
            persistent.mkdir(parents=True)
            run("mount", "-t", "tmpfs", "-o", "mode=755,nodev,nosuid,size=2m",
                "tmpfs", str(persistent))
            for directory in contract["directories"]:
                path = persistent / directory["path"]
                path.mkdir(parents=True, exist_ok=True)
                path.chmod(directory["mode"])
            for user in contract["users"]:
                path = persistent / f"Users/{user['uid']}"
                path.mkdir(mode=0o700)
                os.chown(path, user["uid"], user["gid"])
            for mapping in contract["mappings"]:
                source, target = state.source(mapping), state.path(mapping["target"])
                source.mkdir(parents=True, exist_ok=True)
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(0o1777 if mapping["target"] == "/var/tmp" else 0o755)
            efi = state.path("/System/Boot/efi")
            efi.mkdir()
            run("mount", "-t", "tmpfs", "-o", "mode=755,size=1m", "tmpfs", str(efi))
            retained = root / "retained"
            retained.mkdir()
            for role, path in (("persistent", persistent), ("efi", efi)):
                (retained / role).mkdir()
                run("mount", "--bind", str(path), str(retained / role))
            packages = persistent / "SystemData/Library/Dpkg/status"
            packages.write_text("Package: synthetic-fixture\nStatus: install ok installed\n\n")
            accounts = persistent / "SystemData/Accounts/fixture-authority"
            accounts.write_text("synthetic initialized authority; no credentials\n")
            authorities = {path: path.read_bytes() for path in (packages, accounts)}
            usr = state.path("/usr")
            run("mount", "--bind", str(state.path("/System/Resources")), str(usr))
            devices = {path.stat().st_dev: role for role, path in
                       (("SYSTEM", root), ("PERSISTENT", persistent), ("EFI", efi))}
            if len(devices) != 3:
                raise RuntimeError("Private fixture volumes must be distinct tmpfs instances")
            real_command = storage.command
            observed = dict(VOLUMES)
            command_log = []

            def synthetic_command(*arguments):
                command_log.append(arguments)
                if arguments[0] == "/usr/bin/findmnt" and arguments[-1] == "UUID,FSTYPE,OPTIONS":
                    path = Path(arguments[3])
                    record = real_command(*arguments[:-1], "FSTYPE,OPTIONS").split()
                    if len(record) != 2 or record[0] != "tmpfs":
                        raise ValueError("Fixture mount is absent or not synthetic tmpfs")
                    role = devices.get(path.stat().st_dev)
                    if role is None:
                        raise ValueError("Fixture source belongs to an unexpected filesystem")
                    # Substitute only the nonexistent tmpfs UUID and type; production
                    # validate_volume, exact mount lookup, inode and real flags still run.
                    return observed[role] + " " + ("vfat" if role == "EFI" else "ext4") + " " + record[1]
                return real_command(*arguments)

            def checked():
                command_log.clear()
                try:
                    state.check()
                finally:
                    if any(arguments[0] != "/usr/bin/findmnt" for arguments in command_log):
                        raise RuntimeError("Read-only check attempted a state-changing command")

            with patch.object(storage, "command", side_effect=synthetic_command):
                state.prepare()
                checked()
                ready = state.path("/run/polly-storage/ready")
                ready_bytes = ready.read_bytes()
                baseline = {
                    "sourceSha256": hashlib.sha256(program.read_bytes()).hexdigest(),
                    "layoutSha256": hashlib.sha256(program.with_name("layout.py").read_bytes()).hexdigest(),
                    "manifestFingerprint": state.fingerprint,
                    "mappedPaths": len(contract["mappings"]),
                }
                for mapping in reversed(contract["mappings"]):
                    target = state.path(mapping["target"])
                    run("umount", "--recursive", str(target))
                    before = list(target.iterdir())
                    if before:
                        raise RuntimeError("Missing-mount destination must start empty")
                    refused("missing-mapping:" + mapping["target"], checked,
                            "Early usr mapping" if mapping["target"] == "/usr" else "Required storage mapping")
                    if list(target.iterdir()) or ready.read_bytes() != ready_bytes:
                        raise RuntimeError("Missing mount was initialized or readiness changed")
                    state.alias(mapping)
                    checked()

                for role in ("SYSTEM", "PERSISTENT", "EFI"):
                    observed[role] = "FFFF-FFFF" if role == "EFI" else VOLUMES["RECOVERY"]
                    refused("wrong-uuid:" + role, checked, "filesystem identity")
                    observed[role] = VOLUMES[role]
                    checked()

                package_bytes = packages.read_bytes()
                packages.write_bytes(package_bytes + b" " * 131072)
                checked()
                packages.write_bytes(b"")
                refused("empty-package-database", checked, "package database is empty")
                packages.unlink()
                refused("missing-package-database", checked, number=errno.ENOENT)
                packages.mkdir()
                refused("directory-package-database", checked, "Unsafe storage path")
                packages.rmdir()
                packages.write_bytes(package_bytes)
                packages.chmod(0o666)
                refused("writable-package-database", checked, "Unsafe storage path")
                packages.chmod(0o644)
                os.chown(packages, 1000, 1000)
                refused("unowned-package-database", checked, "Unsafe storage path")
                os.chown(packages, 0, 0)
                linked_status = packages.with_name("linked-status")
                os.link(packages, linked_status)
                refused("hardlinked-package-database", checked, "Linked storage")
                linked_status.unlink()
                packages.rename(linked_status)
                packages.symlink_to(linked_status)
                refused("symlink-package-database", checked, "Unsafe storage path")
                packages.unlink()
                linked_status.rename(packages)
                checked()

                for directory in contract["directories"]:
                    path = persistent / directory["path"]
                    wrong = 0o755 if directory["mode"] in (0o700, 0o1777) else 0o777
                    path.chmod(wrong)
                    refused("permissions:" + directory["path"], checked, "Unsafe storage")
                    path.chmod(directory["mode"])
                    checked()

                for target in (root, persistent, usr, efi):
                    bind = target == usr
                    run("mount", "-o", "remount," + ("bind," if bind else "") + "ro", str(target))
                    refused("readonly:" + str(target.relative_to(root) or "."), checked, "filesystem identity")
                    run("mount", "-o", "remount," + ("bind," if bind else "") +
                        ("rw,nodev,nosuid" if target == persistent else "rw"), str(target))
                    checked()

                for missing in ("nodev", "nosuid"):
                    flags = "rw," + ("dev,nosuid" if missing == "nodev" else "nodev,suid")
                    run("mount", "-o", "remount," + flags, str(persistent))
                    refused("persistent-missing-flag:" + missing, checked, "filesystem identity")
                    run("mount", "-o", "remount,rw,nodev,nosuid", str(persistent))
                    checked()
                for forbidden in ("nosuid", "noexec"):
                    run("mount", "-o", "remount,bind,rw," + forbidden, str(usr))
                    refused("usr-forbidden-flag:" + forbidden, checked, "filesystem identity")
                    run("mount", "-o", "remount,bind,rw,suid,exec", str(usr))
                    checked()

                apt = next(item for item in contract["mappings"] if item["target"] == "/var/lib/apt")
                target = state.path(apt["target"])
                run("umount", str(target))
                run("mount", "--bind", str(persistent / "SystemData/Cache"), str(target))
                refused("same-volume-wrong-source", checked, "Required storage mapping")
                run("umount", str(target))
                state.alias(apt)
                checked()

                resources = state.path("/System/Resources")
                run("mount", "-t", "tmpfs", "-o", "mode=755,size=64k", "tmpfs", str(resources))
                refused("source-on-other-filesystem", checked, "unexpected filesystem")
                run("umount", str(resources))
                checked()

                for role, path in (("PERSISTENT", persistent), ("EFI", efi)):
                    run("umount", str(path))
                    refused("missing-volume:" + role, checked)
                    run("mount", "--bind", str(retained / role.lower()), str(path))
                    checked()

                for contents in (b"", b"0" * 64 + b"\n", ready_bytes + b"\n"):
                    ready.write_bytes(contents)
                    refused("bad-readiness:" + str(len(contents)), checked)
                    if ready.read_bytes() != contents:
                        raise RuntimeError("Check repaired a bad readiness record")
                ready.unlink()
                refused("missing-readiness", checked, number=errno.ENOENT)
                ready.write_bytes(ready_bytes)
                link = ready.with_name("linked-ready")
                os.link(ready, link)
                refused("hardlinked-readiness", checked, "Linked storage")
                link.unlink()
                ready.chmod(0o666)
                refused("writable-readiness", checked, "Unsafe storage")
                ready.chmod(0o644)
                checked()

                # The root filesystem remains writable; only this private runtime
                # is made read-only/full, exercising actual readiness publication.
                runtime = ready.parent
                run("mount", "-o", "remount,ro,nodev,nosuid", str(run_root))
                refused("prepare-runtime-readonly", state.prepare, number=errno.EROFS)
                run("mount", "-o", "remount,rw,nodev,nosuid", str(run_root))
                checked()
                filler = run_root / "full-fixture"
                with filler.open("wb", buffering=0) as target:
                    while os.statvfs(run_root).f_bavail:
                        available = os.statvfs(run_root)
                        target.write(b"x" * min(4096, available.f_bavail * available.f_frsize))
                if os.statvfs(run_root).f_bavail != 0:
                    raise RuntimeError("ENOSPC fixture did not actually fill its 64KiB tmpfs")
                checked()
                refused("prepare-runtime-full", state.prepare, number=errno.ENOSPC)
                filler.unlink()
                if ready.read_bytes() != ready_bytes:
                    raise RuntimeError("Failed prepare changed the prior readiness record")
                checked()
                for path, contents in authorities.items():
                    if path.read_bytes() != contents:
                        raise RuntimeError("Fault handling changed a persistent authority")
                if any(path.name.startswith(".ready-") for path in runtime.iterdir()):
                    raise RuntimeError("Failed prepare leaked a temporary readiness file")

                full_checks = ["RUNTIME"]
                for role, volume_root in (("SYSTEM", root), ("PERSISTENT", persistent)):
                    filler = volume_root / "full-volume-fixture"
                    with filler.open("wb", buffering=0) as target:
                        while os.statvfs(volume_root).f_bavail:
                            available = os.statvfs(volume_root)
                            target.write(b"x" * min(4096, available.f_bavail * available.f_frsize))
                    if os.statvfs(volume_root).f_bavail != 0:
                        raise RuntimeError("Read-only full-volume test did not reach zero available blocks")
                    checked()
                    filler.unlink()
                    full_checks.append(role)
                inode_state = os.statvfs(persistent)
                used_inodes = inode_state.f_files - inode_state.f_ffree
                if used_inodes < 1:
                    raise RuntimeError("Cannot measure allocated private tmpfs inodes")
                run("mount", "-o", "remount,rw,nodev,nosuid,nr_inodes=" + str(used_inodes),
                    str(persistent))
                if os.statvfs(persistent).f_favail != 0:
                    raise RuntimeError("Read-only inode test did not reach zero available inodes")
                checked()
                run("mount", "-o", "remount,rw,nodev,nosuid,nr_inodes=" + str(inode_state.f_files),
                    str(persistent))
                checked()
                for path, contents in authorities.items():
                    if path.read_bytes() != contents:
                        raise RuntimeError("Read-only full-volume checks changed an authority")

                ordinary = run(
                    "/usr/bin/python3", "-I", "-B", "-c",
                    "import importlib.util,json,os,sys;from pathlib import Path;"
                    "assert os.getuid()==os.geteuid()==1000;"
                    "spec=importlib.util.spec_from_file_location('ordinary_storage',sys.argv[1]);"
                    "s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s);"
                    "state=s.Storage(Path(sys.argv[2]));command=s.command;"
                    "devices={state.root.stat().st_dev:'SYSTEM',"
                    "state.persistent.stat().st_dev:'PERSISTENT',"
                    "state.path('/System/Boot/efi').stat().st_dev:'EFI'};"
                    "\ndef synthetic(*args):\n"
                    " if args[0]=='/usr/bin/findmnt' and args[-1]=='UUID,FSTYPE,OPTIONS':\n"
                    "  record=command(*args[:-1],'FSTYPE,OPTIONS').split();"
                    "assert len(record)==2 and record[0]=='tmpfs';"
                    "role=devices[Path(args[3]).stat().st_dev];"
                    "return state.volumes[role]+' '+('vfat' if role=='EFI' else 'ext4')+' '+record[1]\n"
                    " assert args[0]=='/usr/bin/findmnt';return command(*args)\n"
                    "s.command=synthetic;state.check()\n"
                    "try: state.prepare()\n"
                    "except PermissionError: pass\n"
                    "else: raise RuntimeError('Ordinary UID prepared privileged mappings')\n"
                    "print(json.dumps({'uid':os.getuid(),'euid':os.geteuid(),"
                    "'check':'pass','prepare':'refused'}))\n",
                    str(program), str(root), user=1000, group=1000, extra_groups=[],
                    capture_output=True, text=True)
                ordinary_result = json.loads(ordinary.stdout)
                if ordinary_result != {"uid": 1000, "euid": 1000, "check": "pass", "prepare": "refused"}:
                    raise RuntimeError("Ordinary user proof returned an invalid result")
                if len({result["fault"] for result in results}) != len(results):
                    raise RuntimeError("Fault report contains duplicate matrix rows")

        finally:
            run("umount", "--recursive", str(root))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        with args.report.open("x", encoding="utf8") as report:
            json.dump({"schemaVersion": 1, "result": "pass", **baseline,
                       "uid": os.getuid(), "euid": os.geteuid(), "faults": results,
                       "ordinaryUser": ordinary_result, "authoritiesUnchanged": True,
                       "zeroAvailableBlockReadOnlyChecks": full_checks,
                       "zeroAvailableInodeReadOnlyCheck": True,
                       "filesystem": "synthetic-private-tmpfs",
                       "uuidAndTypeSubstitution": True, "realMountFlagsAndInodes": True,
                       "newLayoutColdBootVerified": False, "powerCutVerified": False},
                      report, indent=2)
            report.write("\n")
    print("PASS: bounded storage fault matrix (" + str(len(results)) + " faults)")


if __name__ == "__main__":
    main()
