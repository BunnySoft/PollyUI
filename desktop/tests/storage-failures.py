#!/usr/bin/env python3
"""Root-container record/syscall regressions; no host devices or real credentials."""
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("storage_failure_backend",
    Path(__file__).resolve().parents[1] / "release/storage/storage.py")
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)

VOLUMES = {
    "EFI": "12AB-34CD",
    "SYSTEM": "10000000-0000-4000-8000-000000000001",
    "PERSISTENT": "10000000-0000-4000-8000-000000000002",
    "RECOVERY": "10000000-0000-4000-8000-000000000003",
}


class StorageFailures(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="polly-storage-failure-unit-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root.chmod(0o755)
        self.manifest = self.root / "etc/polly-storage.json"
        self.manifest.parent.mkdir()
        self.value = storage.layout.contract(VOLUMES)
        self.original = json.dumps(self.value).encode()
        self.manifest.write_bytes(self.original)
        self.state = storage.Storage(self.root)

    def test_exact_read_bounds_and_canonical_fingerprint(self):
        for invalid in (True, False, 0, -1, 1.0, None):
            with self.subTest(limit=invalid), self.assertRaisesRegex(ValueError, "read bound"):
                self.state.read(self.manifest, invalid)
        self.assertEqual(self.state.read(self.manifest, len(self.original)), self.original)
        with self.assertRaisesRegex(ValueError, "size limit"):
            self.state.read(self.manifest, len(self.original) - 1)
        self.manifest.write_bytes(self.original + b" " * (65536 - len(self.original)))
        self.assertEqual(storage.Storage(self.root).fingerprint, self.state.fingerprint)
        with self.manifest.open("ab") as target:
            target.write(b" ")
        with self.assertRaisesRegex(ValueError, "size limit"):
            storage.Storage(self.root)

    def test_ambiguous_corrupt_or_incompatible_manifest(self):
        text = self.original.decode()
        cases = {
            "duplicate-schema": text.replace('"schemaVersion": 1', '"schemaVersion": 2, "schemaVersion": 1'),
            "nested-duplicate": text.replace('"phase": "initramfs"',
                '"phase": "system", "phase": "initramfs"'),
            "nonfinite-hidden-by-duplicate": text.replace('"schemaVersion": 1',
                '"schemaVersion": NaN, "schemaVersion": 1'),
            "infinity": text.replace('"schemaVersion": 1', '"schemaVersion": Infinity'),
            "negative-infinity": text.replace('"schemaVersion": 1', '"schemaVersion": -Infinity'),
            "bool-schema": text.replace('"schemaVersion": 1', '"schemaVersion": true'),
            "bool-mode": text.replace('"mode": 493', '"mode": true'),
            "wrong-uuid": text.replace(VOLUMES["PERSISTENT"], VOLUMES["SYSTEM"]),
            "source-alias": text.replace('"source": "System/Resources"', '"source": "System/../usr"'),
            "destination-alias": text.replace('"target": "/usr"', '"target": "/System/Resources"'),
            "truncated": text[:-1],
            "invalid-utf8": b"\xff",
            "deep-json": "[" * 2000 + "]" * 2000,
        }
        for label, contents in cases.items():
            with self.subTest(fault=label):
                self.manifest.write_bytes(contents.encode() if isinstance(contents, str) else contents)
                with self.assertRaises(ValueError):
                    storage.Storage(self.root)
        self.assertFalse((self.root / "run").exists())

    def test_no_link_special_file_or_unsafe_policy(self):
        self.manifest.chmod(0o666)
        with self.assertRaisesRegex(ValueError, "Unsafe storage path"):
            storage.Storage(self.root)
        self.manifest.chmod(0o644)
        self.manifest.parent.chmod(0o777)
        with self.assertRaisesRegex(ValueError, "Unsafe storage ancestor"):
            storage.Storage(self.root)
        self.manifest.parent.chmod(0o755)
        os.chown(self.manifest, 1000, 1000)
        with self.assertRaisesRegex(ValueError, "Unsafe storage path"):
            storage.Storage(self.root)
        os.chown(self.manifest, 0, 0)
        link = self.manifest.with_name("second-authority")
        os.link(self.manifest, link)
        with self.assertRaisesRegex(ValueError, "Linked storage"):
            storage.Storage(self.root)
        link.unlink()
        self.manifest.rename(link)
        self.manifest.symlink_to(link)
        with self.assertRaisesRegex(ValueError, "Unsafe storage path"):
            storage.Storage(self.root)
        self.manifest.unlink()
        os.mkfifo(self.manifest)
        with self.assertRaisesRegex(ValueError, "Unsafe storage path"):
            storage.Storage(self.root)
        self.manifest.unlink()
        self.manifest.mkdir()
        with self.assertRaisesRegex(ValueError, "Unsafe storage path"):
            storage.Storage(self.root)

    def test_open_races_reject_replacement_symlink_and_fifo_without_blocking(self):
        real_open = os.open
        for fault in ("replacement", "symlink", "fifo"):
            with self.subTest(fault=fault):
                replacement = self.manifest.with_name("replacement")
                replacement.write_bytes(self.original)

                def swap(path, flags, *arguments, **options):
                    self.manifest.unlink()
                    if fault == "replacement":
                        replacement.rename(self.manifest)
                    elif fault == "symlink":
                        self.manifest.symlink_to(replacement)
                    else:
                        os.mkfifo(self.manifest)
                    return real_open(path, flags, *arguments, **options)

                started = time.monotonic()
                with patch.object(storage.os, "open", side_effect=swap), \
                        self.assertRaises((ValueError, OSError)):
                    self.state.read(self.manifest, 65536)
                self.assertLess(time.monotonic() - started, 1)
                self.manifest.unlink()
                replacement.unlink(missing_ok=True)
                self.manifest.write_bytes(self.original)

    def test_descriptor_and_final_snapshot_changes_are_rejected(self):
        real_stat = os.fstat
        calls = 0

        def changed(descriptor):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.manifest.chmod(0o600)
            return real_stat(descriptor)

        with patch.object(storage.os, "fstat", side_effect=changed), \
                self.assertRaisesRegex(ValueError, "during inspection"):
            self.state.read(self.manifest, 65536)
        self.manifest.chmod(0o644)
        real_trusted = self.state.trusted
        calls = 0

        def replaced(path, **policy):
            nonlocal calls
            calls += 1
            if calls == 2:
                temporary = path.with_name("new-record")
                temporary.write_bytes(self.original)
                os.replace(temporary, path)
            return real_trusted(path, **policy)

        with patch.object(self.state, "trusted", side_effect=replaced), \
                self.assertRaisesRegex(ValueError, "after inspection"):
            self.state.read(self.manifest, 65536)

    def test_read_growth_is_bounded_and_rejected(self):
        real_fdopen = os.fdopen
        reads = []
        manifest = self.manifest

        class GrowingRecord:
            def __init__(self, descriptor, mode, **options):
                self.source = real_fdopen(descriptor, mode, **options)

            def __enter__(self):
                return self

            def __exit__(self, *error):
                self.source.close()

            def fileno(self):
                return self.source.fileno()

            def read(self, bound):
                reads.append(bound)
                with manifest.open("ab") as target:
                    target.write(b" " * 65536)
                return self.source.read(bound)

        with patch.object(storage.os, "fdopen", side_effect=GrowingRecord), \
                self.assertRaisesRegex(ValueError, "during inspection"):
            self.state.read(self.manifest, 65536)
        self.assertEqual(reads, [65537])

    def test_package_status_prefix_accepts_large_records_but_rejects_empty_or_linked(self):
        status = self.state.persistent / "SystemData/Library/Dpkg/status"
        status.parent.mkdir(parents=True)
        status.write_bytes(b"Package: synthetic-fixture\n" + b"x" * 131072)
        real_fdopen = os.fdopen
        with patch.object(storage.os, "fdopen", wraps=real_fdopen) as opened:
            self.assertEqual(self.state.read(status, 1, prefix=True), b"P")
            self.assertEqual(opened.call_args.kwargs, {"buffering": 0})
        with self.assertRaisesRegex(ValueError, "size limit"):
            self.state.read(status, 65536)
        status.write_bytes(b"")
        self.assertEqual(self.state.read(status, 1, prefix=True), b"")
        os.link(status, status.with_name("linked-status"))
        with self.assertRaisesRegex(ValueError, "Linked storage"):
            self.state.read(status, 1, prefix=True)

    def test_readiness_is_exact_bounded_single_link_and_not_repaired(self):
        ready = self.root / "run/polly-storage/ready"
        ready.parent.mkdir(parents=True)
        valid = (self.state.fingerprint + "\n").encode()
        with patch.object(self.state, "preflight"), patch.object(self.state, "verify_aliases"), \
                patch.object(storage, "command") as command:
            with self.assertRaises(FileNotFoundError):
                self.state.check()
            self.assertFalse(ready.exists())
            ready.write_bytes(valid)
            self.state.check()
            for contents in (b"", valid[:-1], b"0" * 64 + b"\n", valid + b"\n", b"\xff"):
                with self.subTest(contents=contents):
                    ready.write_bytes(contents)
                    with self.assertRaises(ValueError):
                        self.state.check()
                    self.assertEqual(ready.read_bytes(), contents)
            ready.write_bytes(valid)
            linked = ready.with_name("linked-ready")
            os.link(ready, linked)
            with self.assertRaisesRegex(ValueError, "Linked storage"):
                self.state.check()
            command.assert_not_called()

    def test_symlink_alias_cannot_claim_a_required_bind(self):
        source = self.root / "System/Boot"
        source.mkdir(parents=True)
        target = self.root / "boot"
        target.symlink_to(source)
        mapping = next(item for item in self.value["mappings"] if item["target"] == "/boot")
        with patch.object(self.state, "mounted", return_value=True), \
                patch.object(storage, "command") as command, \
                self.assertRaisesRegex(ValueError, "unexpected storage mount"):
            self.state.alias(mapping)
        command.assert_not_called()

    def test_prepare_syscall_failures_never_print_ready(self):
        runtime = self.root / "run/polly-storage"
        runtime.mkdir(parents=True)
        for operation in ("mkstemp", "fchmod", "fsync", "replace"):
            module = storage.tempfile if operation == "mkstemp" else storage.os
            for number in (errno.ENOSPC, errno.EROFS, errno.EIO):
                with self.subTest(operation=operation, errno=number), \
                        patch.object(self.state, "preflight"), patch.object(self.state, "alias"), \
                        patch.object(self.state, "verify_aliases"), \
                        patch.object(module, operation, side_effect=OSError(number, "synthetic fault")), \
                        patch("sys.stdout", new_callable=io.StringIO) as output:
                    with self.assertRaises(OSError) as failure:
                        self.state.prepare()
                    self.assertEqual(failure.exception.errno, number)
                    self.assertEqual(output.getvalue(), "")
                self.assertEqual(list(runtime.iterdir()), [])

    def test_real_and_effective_root_are_required_before_preflight(self):
        for uid, euid in ((1000, 1000), (1000, 0), (0, 1000)):
            with self.subTest(uid=uid, euid=euid), \
                    patch.object(storage.os, "getuid", return_value=uid), \
                    patch.object(storage.os, "geteuid", return_value=euid), \
                    patch.object(self.state, "preflight") as preflight:
                with self.assertRaises(PermissionError):
                    self.state.prepare()
                preflight.assert_not_called()

    def test_prepare_directory_sync_failure_is_explicit(self):
        real_sync = os.fsync
        (self.root / "run/polly-storage").mkdir(parents=True)

        def fail_directory(descriptor):
            if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                raise OSError(errno.EIO, "synthetic directory sync failure")
            return real_sync(descriptor)

        with patch.object(self.state, "preflight"), patch.object(self.state, "alias"), \
                patch.object(self.state, "verify_aliases"), \
                patch.object(storage.os, "fsync", side_effect=fail_directory), \
                patch("sys.stdout", new_callable=io.StringIO) as output:
            with self.assertRaises(OSError):
                self.state.prepare()
        self.assertEqual(output.getvalue(), "")
        runtime = self.root / "run/polly-storage"
        self.assertEqual([path.name for path in runtime.iterdir()], ["ready"])
        self.assertEqual((runtime / "ready").read_text(), self.state.fingerprint + "\n")

    def test_cli_failure_shape_and_logging(self):
        for operation in ("prepare", "check"):
            for error in (ValueError("synthetic corrupt state"), PermissionError("requires root"),
                          OSError(errno.ENOSPC, "synthetic full"), RuntimeError("synthetic command")):
                with self.subTest(operation=operation, error=error), \
                        patch.object(storage.sys, "argv", ["storage.py", operation]), \
                        patch.object(storage, "Storage", return_value=self.state), \
                        patch.object(self.state, operation, side_effect=error), \
                        patch.object(storage.syslog, "syslog") as log, \
                        patch("sys.stderr", new_callable=io.StringIO) as stderr, \
                        patch("sys.stdout", new_callable=io.StringIO) as stdout:
                    self.assertEqual(storage.main(), 1)
                    message = "POLLY_STORAGE_FAILED: " + str(error)
                    self.assertEqual(stderr.getvalue(), message + "\n")
                    self.assertEqual(stdout.getvalue(), "")
                    log.assert_called_once_with(storage.syslog.LOG_ERR, message)


if __name__ == "__main__":
    if os.geteuid() != 0 or not Path("/run/.containerenv").exists():
        raise RuntimeError("Storage failure tests require an isolated root container")
    unittest.main()
