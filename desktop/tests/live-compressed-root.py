#!/usr/bin/env python3
"""Small real archive/SquashFS/tool tests; never boots a guest or uses block devices."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
root = runpy.run_path(str(REPO / "desktop/tools/live-root.py"))
verify = runpy.run_path(str(REPO / "desktop/tools/verify-live-runtime.py"))


def archive(entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as target:
        for name, kind, content in entries:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.mode = 0o755 if kind == tarfile.DIRTYPE else 0o644
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                entry.linkname = content
            elif kind == tarfile.REGTYPE:
                entry.size = len(content)
            target.addfile(entry, io.BytesIO(content) if kind == tarfile.REGTYPE else None)
    stream.seek(0)
    return tarfile.open(fileobj=stream)


class CompressedRoot(unittest.TestCase):
    def test_archive_escape_duplicates_and_link_parents_rejected_before_writes(self):
        for entries in (
                [("../escape", tarfile.REGTYPE, b"x")],
                [("/absolute", tarfile.REGTYPE, b"x")],
                [("a//b", tarfile.REGTYPE, b"x")],
                [("a", tarfile.REGTYPE, b"x"), ("./a", tarfile.REGTYPE, b"y")],
                [("a", tarfile.SYMTYPE, "/outside"), ("a/b", tarfile.REGTYPE, b"x")],
                [("a", tarfile.LNKTYPE, "../outside")],
                [("a", tarfile.SYMTYPE, "target"), ("b", tarfile.LNKTYPE, "a")],
                [("a", tarfile.LNKTYPE, "run/excluded"), ("run/excluded", tarfile.REGTYPE, b"x")]):
            with self.subTest(entries=entries), archive(entries) as source, tempfile.TemporaryDirectory() as temp:
                with self.assertRaises(ValueError):
                    root["extract_root"](source, Path(temp) / "root")

    def test_real_safe_extract_merged_usr_links_hardlinks_owners_modes_and_xattrs(self):
        with archive([
                ("usr", tarfile.DIRTYPE, b""), ("usr/bin", tarfile.DIRTYPE, b""),
                ("bin", tarfile.SYMTYPE, "usr/bin"), ("usr/bin/tool", tarfile.REGTYPE, b"tool"),
                ("usr/bin/copy", tarfile.LNKTYPE, "usr/bin/tool"),
                ("etc/absolute", tarfile.SYMTYPE, "/usr/bin/tool"),
                ("run/drop", tarfile.REGTYPE, b"excluded")]) as source, tempfile.TemporaryDirectory() as temp:
            source.getmember("usr/bin/tool").mode = 0o751
            source.getmember("usr/bin/copy").mode = 0o751
            source.getmember("usr/bin/tool").pax_headers = {"SCHILY.xattr.user.polly-test": "retained"}
            target = Path(temp) / "root"
            root["extract_root"](source, target)
            self.assertEqual(os.readlink(target / "bin"), "usr/bin")
            self.assertEqual(root["root_file"](target, "etc/absolute"), target / "usr/bin/tool")
            self.assertEqual((target / "usr/bin/tool").stat().st_ino, (target / "usr/bin/copy").stat().st_ino)
            self.assertEqual((target / "usr/bin/tool").stat().st_mode & 0o777, 0o751)
            self.assertEqual(os.getxattr(target / "usr/bin/tool", "user.polly-test"), b"retained")
            self.assertFalse((target / "run/drop").exists())
            self.assertEqual((target / "etc/resolv.conf").readlink(), Path("/run/polly-network/resolv.conf"))

    def test_actual_squashfs_stream_bytes_metadata_origin_and_unexpected_namespace(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / "root"
            (directory / "usr/bin").mkdir(parents=True)
            (directory / "usr/share/pollyui").mkdir(parents=True)
            data = b"real small squashfs fixture"
            (directory / "usr/bin/pollyui").write_bytes(data)
            capability = struct.pack("<IIIII", 0x02000001, 0x400, 0, 0, 0)
            os.setxattr(directory / "usr/bin/pollyui", "security.capability", capability)
            origin = {"runtimeSourceRevision": "a" * 40}
            (directory / "usr/share/pollyui/runtime-origin.json").write_text(json.dumps(origin))
            expected = {"usr/bin/pollyui": {"mode": "0644", "size": len(data),
                                           "sha256": hashlib.sha256(data).hexdigest()}}
            squashfs = Path(temp) / "root.squashfs"

            def build():
                squashfs.unlink(missing_ok=True)
                subprocess.run(["mksquashfs", str(directory), str(squashfs), "-noappend", "-processors", "1",
                                "-no-progress", "-quiet"], check=True, stdout=subprocess.DEVNULL)
            build()
            verify["check_squashfs"](squashfs, expected, origin)
            extracted = Path(temp) / "extracted"
            subprocess.run(["unsquashfs", "-processors", "1", "-no-progress", "-quiet",
                            "-d", str(extracted), str(squashfs), "usr/bin/pollyui"],
                           check=True, stdout=subprocess.DEVNULL)
            self.assertEqual(os.getxattr(extracted / "usr/bin/pollyui", "security.capability"), capability)
            with self.assertRaisesRegex(ValueError, "bytes differ"):
                verify["check_squashfs"](squashfs, {name: {**record, "sha256": "0" * 64}
                                                  for name, record in expected.items()}, origin)
            (directory / "usr/bin/pollyui").chmod(0o777)
            build()
            with self.assertRaisesRegex(ValueError, "metadata differs"):
                verify["check_squashfs"](squashfs, expected, origin)
            (directory / "usr/bin/pollyui").chmod(0o644)
            (directory / "usr/share/pollyui/stale").symlink_to("/usr/bin/pollyui")
            build()
            with self.assertRaisesRegex(ValueError, "Old/unlisted"):
                verify["check_squashfs"](squashfs, expected, origin)

    def test_packed_bootstrap_is_bounded_and_binds_root_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / "bootstrap"
            (directory / "bin").mkdir(parents=True)
            (directory / "etc").mkdir()
            (directory / "dev").mkdir()
            identity, sha, size = "a" * 32, "b" * 64, 100
            (directory / "etc/polly-live-root").write_text(
                f"POLLY_MEDIA_ID={identity}\nPOLLY_ROOT_SHA256={sha}\nPOLLY_ROOT_BYTES={size}\n")
            (directory / "init").write_bytes(b"fixture-not-a-bootable-init")
            (directory / "bin/busybox").write_bytes(b"fixture-not-an-executable")
            path = Path(temp) / "initramfs.gz"
            total = root["write_cpio"](directory, path)
            files = [{"path": item.relative_to(directory).as_posix(), "mode": item.stat().st_mode,
                      **({"size": item.stat().st_size, "sha256": root["digest"](item)} if item.is_file() else {})}
                     for item in sorted(directory.rglob("*"))]
            files.extend({"path": name, "mode": stat.S_IFCHR | mode, "device": [major, minor]}
                         for name, (major, minor, mode) in root["DEVICES"].items())
            layout = {"mediaIdentity": identity, "sha256": sha, "size": size, "bootstrap": {
                "size": path.stat().st_size, "sha256": root["digest"](path), "uncompressedBytes": total,
                "files": files}}
            verify["check_bootstrap"](path, layout)
            broken = copy.deepcopy(layout)
            broken["mediaIdentity"] = "c" * 32
            with self.assertRaisesRegex(ValueError, "exact root identity"):
                verify["check_bootstrap"](path, broken)
            (directory / "root.squashfs").write_bytes(b"never embed the full root")
            with self.assertRaisesRegex(ValueError, "contain no SquashFS"):
                root["write_cpio"](directory, path)

    def test_first_mount_failures_are_visible_before_proc_and_never_continue_boot(self):
        for failed in ("devtmpfs", "proc"):
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                for name in ("bin", "dev", "proc", "sys", "run", "tmp"):
                    (directory / name).mkdir()
                (directory / "usr/lib").mkdir(parents=True)
                shutil.copyfile(REPO / "desktop/release/debian/live-splash-control",
                                directory / "usr/lib/polly-live-splash-control")
                (directory / "dev/console").write_bytes(b"")
                (directory / "bin/busybox").write_bytes(Path(shutil.which("busybox")).read_bytes())
                (directory / "bin/busybox").chmod(0o755)
                (directory / "bin/chmod").symlink_to("busybox")
                (directory / "bin/mount").write_text(
                    '#!/bin/busybox sh\nprintf "%s\\n" "$2" >>/mount-attempts\n'
                    '[ "$2" != "$FAIL_MOUNT" ]\n')
                (directory / "bin/mount").chmod(0o755)
                (directory / "bin/sh").write_text(
                    '#!/bin/busybox sh\nprintf diagnostic-shell >/failure-path\n'
                    'kill -TERM "$PPID"\nexit 0\n')
                (directory / "bin/sh").chmod(0o755)
                (directory / "init").write_bytes((REPO / "desktop/release/debian/live-bootstrap").read_bytes())
                result = subprocess.run(["chroot", str(directory), "/bin/busybox", "sh", "/init"],
                                        text=True, capture_output=True, timeout=5,
                                        env={**os.environ, "FAIL_MOUNT": failed})
                self.assertNotEqual(result.returncode, 0)
                text = (directory / "dev/console").read_text()
                self.assertIn("[untimed: /proc/uptime unavailable] Polly Live: ERROR:", text)
                self.assertIn("No disk writes or alternate root attempted", text)
                self.assertNotIn("Copying compressed root", text)
                self.assertEqual((directory / "failure-path").read_text(), "diagnostic-shell")
                self.assertEqual((directory / "mount-attempts").read_text().splitlines(),
                                 ["devtmpfs"] if failed == "devtmpfs" else ["devtmpfs", "proc"])

    def test_exact_tool_applet_and_dynamic_uuid_probe_closure(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / "bin").mkdir()
            root["copy_elf"]("blkid", directory, "bin/blkid")
            result = subprocess.run(["chroot", str(directory), "/bin/blkid", "--version"],
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("blkid", result.stdout)
        applets = subprocess.check_output(["busybox", "--list"], text=True).splitlines()
        self.assertFalse(set(root["APPLETS"]) - set(applets))
        for script in ("desktop/release/live/init", "desktop/release/debian/live-bootstrap"):
            subprocess.run(["busybox", "sh", "-n", str(REPO / script)], check=True)


def mount_handoff():
    """Exercise real move/overlay/switch_root, not discovery, SquashFS mounts or boot."""
    with tempfile.TemporaryDirectory(prefix="polly-handoff-") as temporary:
        directory = Path(temporary)
        initroot = directory / "initroot"
        initroot.mkdir()
        bootstrap = (REPO / "desktop/release/debian/live-bootstrap").read_text()
        functions = bootstrap.split("set -eu\n", 1)[0]
        transfer = bootstrap.split("for name in dev proc sys; do\n", 1)[1]
        (directory / "setup.sh").write_text(
            '#!/bin/sh\nset -eu\nbase=$1\n'
            'busybox mount --make-rprivate /\n'
            'mount -t tmpfs -o size=64m tmpfs "$base"\n'
            'mkdir -p "$base/bin" "$base/dev" "$base/proc" "$base/sys" "$base/run" "$base/newroot"\n'
            'cp /bin/busybox "$base/bin/busybox"\n'
            'for name in sh mount switch_root; do ln -s busybox "$base/bin/$name"; done\n'
            'mount -t tmpfs -o size=32m tmpfs "$base/run"\n'
            'mkdir -p "$base/run/polly-live/lower" "$base/run/polly-live/upper" "$base/run/polly-live/work"\n'
            'lower="$base/run/polly-live/lower"\n'
            'mkdir -p "$lower/bin" "$lower/sbin" "$lower/dev" "$lower/proc" "$lower/sys" "$lower/run" "$lower/tmp"\n'
            'cp /bin/busybox "$lower/bin/busybox"\n'
            'for name in sh chmod mkdir mount grep cat; do ln -s busybox "$lower/bin/$name"; done\n'
            'cp "$2" "$lower/init"\nchmod 755 "$lower/init"\n'
            'cp "$3" "$lower/sbin/init"\nchmod 755 "$lower/sbin/init"\n'
            'printf retained >"$base/run/polly-live/root.squashfs"\n'
            'printf fixture >"$base/run/polly-live/root-ready"\n'
            'mount -t tmpfs tmpfs "$base/dev"\n'
            ': >"$base/dev/console"\n'
            'mount -t proc proc "$base/proc"\n'
            'mount -t tmpfs tmpfs "$base/sys"\n'
            'mount -t overlay overlay -o "lowerdir=$lower,upperdir=$base/run/polly-live/upper,'
            'workdir=$base/run/polly-live/work" "$base/newroot"\n'
            'cp "$4" "$base/init"\n'
            'exec chroot "$base" /bin/sh /init\n')
        # PID 1 exits at the final init fixture; no daemon or background helper remains.
        (directory / "system-init").write_text(
            '#!/bin/sh\nset -eu\n'
            '[ "$(cat /run/polly-live/root.squashfs)" = retained ]\n'
            'grep -q " / overlay " /proc/mounts\n'
            'grep -q " /run tmpfs " /proc/mounts\n'
            'grep -q "switching root" /run/polly-live/early-boot.log\n'
            'printf HANDOFF_OK > /run/polly-live/upper/handoff-result\n'
            'printf "HANDOFF_OK\\n" > /dev/console\n')
        (directory / "transfer").write_text(
            functions + 'set -eu\nserial=0\nsplash_active=0\nsplash_runtime=/run/plymouth\n'
            'proc_directory=/proc\nconsole=/dev/console\nuptime_file=/proc/uptime\n'
            'log_directory=/run/polly-live\nexec 3>/dev/console\n'
            'trap \'fail "handoff fixture failure"\' EXIT\n'
            'for name in dev proc sys; do\n' + transfer)
        # A mounted RAM root, not the real compressed-root copy or full OS.
        process = subprocess.run(
            ["unshare", "--mount", "--pid", "--fork", "--kill-child",
             "sh", "-x", str(directory / "setup.sh"), str(initroot),
             str(REPO / "desktop/release/live/init"), str(directory / "system-init"),
             str(directory / "transfer")], text=True, capture_output=True, timeout=20)
        if process.returncode:
            raise RuntimeError("Private mount handoff failed: " + process.stdout + process.stderr)
        print("PASS: real private tmpfs/overlay/mount-move/switch_root and root /init handoff; NOT a boot or SquashFS mount")


if __name__ == "__main__":
    if sys.argv[1:] == ["--mount-handoff"]:
        mount_handoff()
    else:
        unittest.main()
