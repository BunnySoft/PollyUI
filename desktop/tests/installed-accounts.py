#!/usr/bin/env python3
"""Bounded account-state unit tests; no real credentials, mounts or account changes."""
import importlib.util
import errno
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("installed_accounts",
    Path(__file__).resolve().parents[1] / "release/install/accounts.py")
accounts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accounts)

UUID = "73c3d806-e114-4691-b1a7-8506c7a44e21"


class InstalledAccounts(unittest.TestCase):
    def test_identities(self):
        text = "root:x:0:0:root:/root:/bin/sh\npolly:x:1000:1000::/home/polly:/usr/bin/polly-installed-session\n"
        self.assertEqual(set(accounts.identities(text)), {"root", "polly"})
        for invalid in (text.replace(":1000:1000:", ":0:1000:"),
                        text.replace(":1000:1000:", ":1000:0:"),
                        text + text, text.splitlines()[0]):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                accounts.identities(invalid)

    def test_managed_password_changes_require_persistent_scope(self):
        with self.assertRaises(ValueError):
            accounts.password_scope(None)
        accounts.password_scope("daemon")
        with patch.object(accounts.Path, "is_file", return_value=False):
            for user in ("root", "polly"):
                with self.subTest(user=user), self.assertRaisesRegex(ValueError, "persistent passwd entry"):
                    accounts.password_scope(user)

    def test_setup_failure_does_not_commit_initialization(self):
        with patch.object(accounts, "require_ready"), \
                patch.object(accounts, "state_lock"), \
                patch.object(accounts, "completed", return_value=False), \
                patch.object(accounts.sys, "stdin") as terminal, \
                patch.object(accounts.subprocess, "run", side_effect=[
                    accounts.subprocess.CompletedProcess(["passwd", "polly"], 0),
                    accounts.subprocess.CalledProcessError(1, ["passwd", "root"]),
                ]) as password_tool, \
                patch.object(accounts, "finish") as commit, \
                patch("builtins.print"):
            terminal.isatty.return_value = True
            with self.assertRaises(accounts.subprocess.CalledProcessError):
                accounts.setup()
            self.assertEqual(password_tool.call_count, 2)
            commit.assert_not_called()

    @unittest.skipUnless(os.geteuid() == 0, "root-owned fixture files require a disposable root runner")
    def test_atomic_failures_preserve_the_old_record(self):
        for operation in ("fsync", "replace"):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / "config.json"
                accounts.atomic(path, "old valid record", 0o600)
                with patch.object(accounts.os, operation, side_effect=OSError(errno.ENOSPC, "fixture full")):
                    with self.assertRaises(OSError):
                        accounts.atomic(path, "must not appear", 0o600)
                self.assertEqual(accounts.read(path), "old valid record")
                self.assertEqual(sorted(child.name for child in root.iterdir()), ["config.json"])
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    @unittest.skipUnless(os.geteuid() == 0, "root-owned fixture files require a disposable root runner")
    def test_state_lock_is_private_bounded_and_released_on_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with accounts.state_lock(root):
                self.assertEqual((root / ".state.lock").stat().st_mode & 0o777, 0o600)
                with self.assertRaisesRegex(TimeoutError, "busy"):
                    with accounts.state_lock(root, timeout=0.01):
                        self.fail("A concurrent writer acquired an already-held state lock")
            with self.assertRaisesRegex(RuntimeError, "fixture"):
                with accounts.state_lock(root):
                    raise RuntimeError("fixture")
            with accounts.state_lock(root, timeout=0):
                pass
            (root / ".state.lock").chmod(0o644)
            with self.assertRaisesRegex(ValueError, "Unsafe account state lock"):
                with accounts.state_lock(root):
                    pass
            (root / ".state.lock").unlink()
            (root / ".state.lock").symlink_to(root / "unexpected")
            with self.assertRaises(OSError):
                with accounts.state_lock(root):
                    pass

    @unittest.skipUnless(os.geteuid() == 0, "root-owned fixture files require a disposable root runner")
    def test_concurrent_configuration_writers_retain_both_updates(self):
        context = multiprocessing.get_context("fork")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            accounts.atomic(root / "config.json", json.dumps({
                "schemaVersion": 3, "persistentUuid": UUID,
                "initialized": False, "automaticLogin": False,
            }))
            start = context.Event()

            def update(field):
                if not start.wait(3):
                    raise RuntimeError("Concurrent fixture did not start")
                with accounts.state_lock(root, timeout=3):
                    settings = accounts.config(root)
                    time.sleep(0.03)
                    settings[field] = True
                    accounts.atomic(root / "config.json", json.dumps(settings))

            processes = [context.Process(target=update, args=(field,))
                         for field in ("initialized", "automaticLogin")]
            try:
                for process in processes:
                    process.start()
                start.set()
                for process in processes:
                    process.join(timeout=5)
                    self.assertEqual(process.exitcode, 0)
                settings = accounts.config(root)
                self.assertTrue(settings["initialized"])
                self.assertTrue(settings["automaticLogin"])
            finally:
                for process in processes:
                    if process.is_alive():
                        process.terminate()
                        process.join(timeout=3)

    @unittest.skipUnless(os.geteuid() == 0, "root-owned fixture files require a disposable root runner")
    def test_directory_sync_failure_is_reported_after_an_atomic_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "config.json"
            accounts.atomic(path, "old complete record", 0o600)
            real_sync = accounts.os.fsync
            calls = 0

            def fail_directory(descriptor):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError(errno.EIO, "fixture directory sync failure")
                real_sync(descriptor)

            with patch.object(accounts.os, "fsync", side_effect=fail_directory):
                with self.assertRaises(OSError):
                    accounts.atomic(path, "new complete record", 0o600)
            self.assertEqual(accounts.read(path), "new complete record")
            self.assertEqual(sorted(child.name for child in root.iterdir()), ["config.json"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_automatic_login_reads_current_configuration_under_lock(self):
        settings = {"schemaVersion": 3, "persistentUuid": UUID,
                    "initialized": True, "automaticLogin": False}
        with patch.object(accounts, "require_ready") as ready, \
                patch.object(accounts, "state_lock") as lock, \
                patch.object(accounts, "config", return_value=settings) as read, \
                patch.object(accounts, "atomic") as write:
            accounts.set_automatic_login(True)
            self.assertEqual(ready.call_count, 2)
            lock.assert_called_once()
            read.assert_called_once()
            self.assertTrue(json.loads(write.call_args.args[1])["automaticLogin"])
            self.assertTrue(json.loads(write.call_args.args[1])["initialized"])

    def test_account_volume_is_layout_specific(self):
        old = {"schemaVersion": 2, "homeUuid": UUID}
        new = {"schemaVersion": 3, "persistentUuid": UUID}
        accounts.state_volume(old, UUID, 2)
        accounts.state_volume(new, UUID, 3)
        for settings, version, expected in ((old, 3, UUID), (new, 2, UUID), (new, 3, "wrong")):
            with self.subTest(settings=settings, version=version), self.assertRaises(ValueError):
                accounts.state_volume(settings, expected, version)

    def test_new_layout_requires_backend_without_legacy_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            program = root / "storage.py"
            program.touch()
            state = SimpleNamespace(check=lambda: None, persistent=root / "persistent",
                                    volumes={"PERSISTENT": UUID}, contract={"users": [
                                        {"name": "root", "uid": 0, "gid": 0},
                                        {"name": "polly", "uid": 1000, "gid": 1000}]})
            module = SimpleNamespace(Storage=lambda: state)
            spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
            with patch.object(accounts, "STORAGE_PROGRAM", program), \
                    patch.object(accounts, "STORAGE_MANIFEST", root / "missing-manifest"), \
                    patch.object(accounts, "trusted"), \
                    patch.object(accounts.importlib.util, "spec_from_file_location", return_value=spec), \
                    patch.object(accounts.importlib.util, "module_from_spec", return_value=module), \
                    patch.object(accounts, "read") as legacy_read:
                self.assertEqual(accounts.backing_store(),
                                 (root / "persistent/SystemData/Accounts", root / "persistent", UUID, 3))
                def unavailable():
                    raise ValueError("missing required storage")
                state.check = unavailable
                with self.assertRaisesRegex(ValueError, "missing required storage"):
                    accounts.backing_store()
                legacy_read.assert_not_called()

    @unittest.skipUnless(os.geteuid() == 0, "root-owned fixture files require a disposable root runner")
    def test_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "config.json"
            valid = {"schemaVersion": 2, "homeUuid": UUID, "automaticLogin": False, "initialized": False}
            accounts.atomic(path, json.dumps(valid))
            self.assertEqual(accounts.config(root), valid)
            for invalid in ({**valid, "automaticLogin": 1}, {**valid, "schemaVersion": True},
                            {**valid, "schemaVersion": 1}, {**valid, "homeUuid": "../other"},
                            {**valid, "initialized": 1},
                            {**valid, "extra": "unknown"}, []):
                accounts.atomic(path, json.dumps(invalid))
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    accounts.config(root)
            valid_new = {"schemaVersion": 3, "persistentUuid": UUID,
                         "automaticLogin": False, "initialized": True}
            accounts.atomic(path, json.dumps(valid_new))
            self.assertEqual(accounts.config(root), valid_new)
            self.assertTrue(accounts.completed(root))
            for invalid in ({**valid_new, "homeUuid": UUID},
                            {**valid_new, "persistentUuid": "../other"},
                            {**valid_new, "schemaVersion": 2}):
                accounts.atomic(path, json.dumps(invalid))
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    accounts.config(root)

    @unittest.skipUnless(os.geteuid() == 0, "root-owned fixture files require a disposable root runner")
    def test_completion_and_unsafe_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "setup-complete"
            settings = {"schemaVersion": 2, "homeUuid": UUID, "automaticLogin": False, "initialized": False}
            accounts.atomic(root / "config.json", json.dumps(settings))
            self.assertFalse(accounts.completed(root))
            settings["initialized"] = True
            accounts.atomic(root / "config.json", json.dumps(settings))
            self.assertTrue(accounts.completed(root))
            accounts.atomic(marker, "1\n")
            self.assertTrue(accounts.completed(root))
            marker.chmod(0o666)
            with self.assertRaises(ValueError):
                accounts.completed(root)
            marker.unlink()
            marker.symlink_to(root / "missing")
            with self.assertRaises(ValueError):
                accounts.completed(root)
            marker.unlink()
            accounts.atomic(marker, "1\n")
            settings["initialized"] = False
            accounts.atomic(root / "config.json", json.dumps(settings))
            with self.assertRaises(ValueError):
                accounts.completed(root)

    @unittest.skipUnless(os.geteuid() == 0, "root-owned fixture files require a disposable root runner")
    def test_atomic_and_limits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "state"
            accounts.atomic(path, "first", 0o600)
            accounts.atomic(path, "second", 0o600)
            self.assertEqual(accounts.read(path), "second")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(sorted(item.name for item in root.iterdir()), ["state"])
            with self.assertRaises(ValueError):
                accounts.read(path, 2)
            root.chmod(0o777)
            with self.assertRaises(ValueError):
                accounts.atomic(path, "unsafe")

    @unittest.skipUnless(os.geteuid() == 0, "root-owned fixture files require a disposable root runner")
    def test_automatic_login_is_once_and_boot_scoped(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            accounts.atomic(runtime / "automatic-login", "off\n", 0o600)
            with patch.object(accounts, "RUNTIME", runtime), \
                    patch.object(accounts, "require_ready"), \
                    patch.object(accounts.os, "execv") as execute, \
                    patch.object(accounts.syslog, "syslog"):
                accounts.getty("tty1")
                self.assertNotIn("--autologin", execute.call_args.args[1])
                accounts.atomic(runtime / "automatic-login", "on\n", 0o600)
                accounts.getty("tty1")
                self.assertIn("--autologin", execute.call_args.args[1])
                accounts.getty("tty1")
                self.assertNotIn("--autologin", execute.call_args.args[1])
                with self.assertRaises(ValueError):
                    accounts.getty("tty2")


if __name__ == "__main__":
    unittest.main()
