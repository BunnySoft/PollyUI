#!/usr/bin/env python3
"""Exercise the real early-usr script in a fresh container's private mount namespace."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("--initramfs", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or not Path("/run/.containerenv").exists():
        raise RuntimeError("Early-boot fixture requires an explicitly isolated root container")
    if args.report and (args.report.exists() or args.report.is_symlink()):
        raise RuntimeError("Refusing to overwrite an existing early-boot evidence report")
    subprocess.run(["mount", "--make-rprivate", "/"], check=True, timeout=10)
    with tempfile.TemporaryDirectory(prefix="polly-early-usr-") as temporary:
        temporary = Path(temporary)
        script = temporary / "early-usr"
        script.write_text((args.repo / "desktop/release/storage/early-usr").read_text(),
                          encoding="utf8", newline="\n")
        script.chmod(0o755)
        halt = temporary / "halt"
        halt.write_text("#!/bin/sh\nexit 42\n", encoding="utf8")
        halt.chmod(0o755)
        for program in ("stat", "find", "findmnt", "mount"):
            (temporary / ("polly-storage-" + program)).symlink_to(shutil.which(program))
        sequence = 0

        def seed(root):
            source, target = root / "System/Resources", root / "usr"
            for name in ("bin", "sbin", "lib/systemd", "share"):
                (source / name).mkdir(mode=0o755, parents=True)
            target.mkdir(mode=0o755)
            (source / "share/probe").write_text("one authoritative software tree\n")
            init = source / "lib/systemd/systemd"
            init.write_text("fixture only: never execute this init\n")
            init.chmod(0o755)
            return source, target

        def attempt(change=None, expected=True):
            nonlocal sequence
            sequence += 1
            root = temporary / str(sequence)
            root.mkdir(mode=0o755)
            source, target = seed(root)
            if change is not None:
                change(root)
            environment = {
                "PATH": str(temporary) + ":/usr/sbin:/usr/bin:/sbin:/bin",
                "rootmnt": str(root),
            }
            process = subprocess.Popen(["/bin/sh", str(script)], env=environment,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, start_new_session=True)
            blocked = False
            try:
                try:
                    output, errors = process.communicate(timeout=10 if expected else 1)
                except subprocess.TimeoutExpired:
                    blocked = True
                    os.killpg(process.pid, signal.SIGKILL)
                    output, errors = process.communicate(timeout=10)
                if expected:
                    if blocked or process.returncode != 0 or "POLLY_STORAGE_EARLY_USR_READY" not in output:
                        raise RuntimeError("Early resource mapping failed: " + output + errors)
                    if not os.path.samestat(source.stat(), target.stat()) or \
                            (target / "share/probe").read_text() != (source / "share/probe").read_text():
                        raise RuntimeError("Early mount did not expose the same actual software storage")
                    again = subprocess.run(["/bin/sh", str(script)], env=environment,
                                           capture_output=True, text=True, timeout=10)
                    if again.returncode != 0:
                        raise RuntimeError("Correct existing resource mount was not idempotent")
                elif not blocked or "POLLY_STORAGE_EARLY_FAILED" not in errors or \
                        "POLLY_STORAGE_HALT_FAILED" not in errors or \
                        "POLLY_STORAGE_EARLY_USR_READY" in output:
                    raise RuntimeError("Unsafe state did not block init after halt failed: " + output + errors)
            finally:
                mounted = subprocess.run(["findmnt", "-rn", "-M", str(target)],
                                         capture_output=True, timeout=10)
                if mounted.returncode == 0:
                    subprocess.run(["umount", str(target)], check=True, timeout=10)

        attempt()
        attempt(lambda root: (root / "usr/second-copy").write_text("reject"), False)
        attempt(lambda root: (root / "System/Resources").chmod(0o777), False)
        attempt(lambda root: shutil.rmtree(root / "System/Resources/share"), False)
        attempt(lambda root: (root / "System/Resources/lib/systemd/systemd").unlink(), False)

        def linked(root):
            source = root / "System/Resources"
            source.rename(root / "other")
            source.symlink_to(root / "other")
        attempt(linked, False)

        def wrong_mount(root):
            other = root / "unrelated"
            other.mkdir()
            subprocess.run(["mount", "--bind", str(other), str(root / "usr")], check=True, timeout=10)
        attempt(wrong_mount, False)
        if args.initramfs:
            extracted = temporary / "initramfs"
            subprocess.run(["unmkinitramfs", str(args.initramfs), str(extracted)],
                           check=True, capture_output=True, timeout=60)
            initramfs_root = extracted / "main"
            if not initramfs_root.is_dir():
                raise RuntimeError("Expected Debian initramfs main archive")
            packed_script = initramfs_root / "scripts/local-bottom/polly-storage-usr"
            if packed_script.read_text() != script.read_text():
                raise RuntimeError("Packed early hook does not match the tested source")
            if '/scripts/local-bottom/polly-storage-usr "$@"' not in \
                    (packed_script.parent / "ORDER").read_text().splitlines():
                raise RuntimeError("Debian did not schedule the early hook")
            root = initramfs_root / "root"
            root.mkdir(mode=0o755, exist_ok=True)
            source, target = seed(root)
            proc = initramfs_root / "proc"
            proc.mkdir(exist_ok=True)
            dev = initramfs_root / "dev"
            dev.mkdir(exist_ok=True)
            null = dev / "null"
            null.touch(mode=0o666)
            subprocess.run(["mount", "--bind", "/proc", str(proc)], check=True, timeout=10)
            try:
                subprocess.run(["mount", "--bind", "/dev/null", str(null)], check=True, timeout=10)
                preflight = subprocess.run(
                    ["chroot", str(initramfs_root), "/bin/sh", "-ec",
                     "for tool in polly-storage-stat polly-storage-find polly-storage-findmnt "
                     'polly-storage-mount halt sleep; do command -v "$tool"; done'],
                    capture_output=True, text=True, timeout=10)
                if preflight.returncode != 0:
                    raise RuntimeError("Packed initramfs executable preflight failed: " +
                                       preflight.stdout + preflight.stderr)
                fixture_bin = initramfs_root / "fixture-bin"
                fixture_bin.mkdir()
                shutil.copy2(halt, fixture_bin / "halt")
                process = subprocess.Popen(
                    ["chroot", str(initramfs_root), "/bin/sh",
                     "/scripts/local-bottom/polly-storage-usr"],
                    env={"rootmnt": "/root", "PATH": "/fixture-bin:/usr/bin:/usr/sbin:/bin:/sbin"},
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
                try:
                    output, errors = process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    output, errors = process.communicate(timeout=10)
                    raise RuntimeError("Packed initramfs early mapping blocked: " + output + errors)
                if process.returncode != 0 or "POLLY_STORAGE_EARLY_USR_READY" not in output or \
                        not os.path.samestat(source.stat(), target.stat()):
                    raise RuntimeError("Packed initramfs tools cannot mount usr independently: " +
                                       output + errors)
                print("PASS: exact packed hook/ORDER and actual initramfs-only executable dependencies")
            finally:
                mounted = subprocess.run(["findmnt", "-rn", "-M", str(target)],
                                         capture_output=True, timeout=10)
                if mounted.returncode == 0:
                    subprocess.run(["umount", str(target)], check=True, timeout=10)
                mounted = subprocess.run(["findmnt", "-rn", "-M", str(null)],
                                         capture_output=True, timeout=10)
                if mounted.returncode == 0:
                    subprocess.run(["umount", str(null)], check=True, timeout=10)
                subprocess.run(["umount", str(proc)], check=True, timeout=10)
    print("PASS: real early usr bind/idempotence and six fail-closed resource cases")
    if args.report:
        evidence = {
            "schemaVersion": 1, "result": "pass", "earlyUsrCases": 7,
            "haltFailureBlocksStartup": True,
            "packedInitramfsToolsExecuted": args.initramfs is not None,
            "newLayoutColdBootVerified": False,
            "earlyUsrSha256": hashlib.sha256(
                (args.repo / "desktop/release/storage/early-usr").read_text().encode()).hexdigest(),
        }
        if args.initramfs:
            with args.initramfs.open("rb") as source:
                evidence["initramfsSha256"] = hashlib.file_digest(source, "sha256").hexdigest()
        args.report.parent.mkdir(parents=True, exist_ok=True)
        with args.report.open("x", encoding="utf8") as report:
            json.dump(evidence, report, indent=2)
            report.write("\n")


if __name__ == "__main__":
    main()
