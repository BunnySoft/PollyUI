#!/usr/bin/env python3
"""Synthetic root metadata/checkpoint tests; no radio, bus, host mount or credentials."""
import argparse
from contextlib import ExitStack, contextmanager
import errno
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import importlib.machinery
import importlib.util


def load(name, path):
    spec = importlib.util.spec_from_loader(name, importlib.machinery.SourceFileLoader(name, str(path)))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


VOLUMES = {"EFI": "12AB-34CD", "SYSTEM": "10000000-0000-4000-8000-000000000001",
           "PERSISTENT": "10000000-0000-4000-8000-000000000002",
           "RECOVERY": "10000000-0000-4000-8000-000000000003"}
INVOCATION = "1" * 32
FAKE = b"[Security]\nPassphrase=SyntheticOnly-NotARealCredential\n[Settings]\nAutoConnect=true\n"


class Checkpoints(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        temporary = self.stack.enter_context(tempfile.TemporaryDirectory(prefix="polly-t171-unit-"))
        self.root = Path(temporary)
        self.root.chmod(0o755)
        self.storage = load("test_network_storage", REPO / "desktop/release/storage/storage.py")
        self.accounts = load("test_network_accounts", REPO / "desktop/release/install/accounts.py")
        self.net = load("test_network_state", REPO / "desktop/release/network/state.py")
        self.state = self.net.NetworkState(self.storage, self.accounts, self.root)
        manifest = self.root / "etc/polly-storage.json"
        manifest.parent.mkdir()
        manifest.write_text(json.dumps(self.storage.layout.contract(VOLUMES)))
        manifest.chmod(0o644)
        self.private = self.root / "run/polly-storage/persistent/SystemData/Network"
        self.private.mkdir(parents=True, mode=0o700)
        self.state.network = self.private
        self.state.runtime.mkdir(parents=True, mode=0o700)
        self.state.iwd.mkdir(parents=True, mode=0o700)
        self.guard = self.root / "usr/lib/polly-account-profile-check"
        self.guard.parent.mkdir(parents=True)
        self.guard.write_bytes((REPO / "desktop/release/debian/profile-check").read_bytes())
        self.guard.chmod(0o755)
        self.mode_file = self.root / "etc/polly-account-profile"
        self.mode_file.write_text("installed\n")
        self.mode_file.chmod(0o644)
        self.configuration = self.root / "etc/iwd/main.conf"
        self.configuration.parent.mkdir()
        self.configuration.write_bytes((REPO / "desktop/system/iwd-main.conf").read_bytes())
        self.configuration.chmod(0o644)
        for name, text in (
                ("passwd", "root:x:0:0:root:/root:/bin/sh\npolly:x:1000:1000:fixture:/home/polly:/bin/sh\n"),
                ("group", "root:x:0:\npolly:x:1000:\nshadow:x:42:\n"),
                ("shadow", "root:!:20000:0:99999:7:::\npolly:!:20000:0:99999:7:::\n")):
            path = self.root / "etc" / name
            path.write_text(text)
            path.chmod(0o640 if name == "shadow" else 0o644)
            if name == "shadow":
                os.chown(path, 0, 42)
        self.checked = self.stack.enter_context(patch.object(self.storage.Storage, "check"))
        self.stopped = self.stack.enter_context(patch.object(self.state, "stopped"))
        self.volatile = self.stack.enter_context(patch.object(self.state, "volatile"))
        self.memory = self.stack.enter_context(patch.object(self.state, "memory_runtime"))
        self.process = self.stack.enter_context(patch.object(
            self.net.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)))
        self.initialize()

    def initialize(self):
        return self.net.initialize_empty(self.private, VOLUMES["PERSISTENT"],
                                        self.storage, self.accounts, self.root, image_root=self.root)

    def run_state(self, operation, invocation=INVOCATION, result="success"):
        return self.state.run(operation, invocation, result)

    def record(self):
        return json.loads((self.private / "state.json").read_text())

    def write_record(self, value):
        self.accounts.atomic(self.private / "state.json", json.dumps(value), mode=0o600)

    def working(self, name="Fixture Network.psk", contents=FAKE):
        path = self.state.iwd / name
        path.write_bytes(contents)
        path.chmod(0o600)
        return path

    def persist(self):
        self.run_state("load")
        self.working()
        self.run_state("save")
        return self.record()

    def test_fresh_empty_is_explicit_not_missing_state(self):
        self.assertEqual(self.run_state("load")["profileCount"], 0)
        self.assertTrue((self.state.runtime / "lease.json").exists())
        self.checked.assert_called_once()
        self.process.assert_called_once()
        self.assertEqual(self.process.call_args.args[0], [str(self.guard), "installed"])
        with self.assertRaises(ValueError):
            self.initialize()
        (self.private / "state.json").unlink()
        with self.assertRaises(FileNotFoundError):
            self.run_state("save")
        self.assertFalse((self.private / "state.json").exists())

    def test_clean_stop_restart_and_forget(self):
        first = self.record()
        saved = self.persist()
        self.assertNotEqual(saved["generation"], first["generation"])
        self.assertEqual((self.private / saved["generation"] / "Fixture Network.psk").read_bytes(), FAKE)
        self.assertEqual(stat.S_IMODE((self.private / "state.json").stat().st_mode), 0o600)
        (self.state.iwd / "Fixture Network.psk").unlink()
        loaded = self.run_state("load", "2" * 32)
        self.assertEqual(loaded["profileCount"], 1)
        self.assertEqual((self.state.iwd / "Fixture Network.psk").read_bytes(), FAKE)
        (self.state.iwd / "Fixture Network.psk").unlink()
        self.assertEqual(self.run_state("save", "2" * 32)["profileCount"], 0)
        self.assertEqual(self.run_state("load", "3" * 32)["profileCount"], 0)
        self.assertTrue((self.private / saved["generation"]).is_dir())

    def test_live_never_reads_or_saves_private_state(self):
        self.mode_file.write_text("live\n")
        (self.private / "state.json").unlink()
        self.working("Fixture.8021x", b"fake enterprise data\n")
        for operation in ("load", "save"):
            value = self.run_state(operation)
            self.assertFalse(value["persistent"])
            self.assertEqual(value["checkpoint"], "not-applicable")
            self.assertNotIn("profileCount", value)
        self.checked.assert_not_called()
        self.assertFalse((self.private / "state.json").exists())
        self.assertTrue((self.state.iwd / "Fixture.8021x").exists())

    def test_invalid_modes_have_no_live_fallback(self):
        for contents in (b"", b"live", b"live\n\n", b"template\n", b"recovery\n",
                         b"installed\0\n", b"unsupported\n"):
            with self.subTest(contents=contents):
                self.mode_file.write_bytes(contents)
                with self.assertRaises(ValueError):
                    self.run_state("load")
        self.mode_file.unlink()
        with self.assertRaises(FileNotFoundError):
            self.run_state("load")
        self.assertFalse((self.state.runtime / "lease.json").exists())

    def test_profile_metadata_and_guard_are_required(self):
        for attribute, value in (("mode", 0o666), ("uid", 1000), ("gid", 1000)):
            with self.subTest(attribute=attribute):
                if attribute == "mode":
                    self.mode_file.chmod(value)
                else:
                    os.chown(self.mode_file, value if attribute == "uid" else 0,
                             value if attribute == "gid" else 0)
                with self.assertRaises(ValueError):
                    self.run_state("load")
                os.chown(self.mode_file, 0, 0)
                self.mode_file.chmod(0o644)
        os.link(self.mode_file, self.root / "etc/profile-linked")
        with self.assertRaises(ValueError):
            self.run_state("load")
        (self.root / "etc/profile-linked").unlink()
        self.process.return_value = subprocess.CompletedProcess([], 1)
        with self.assertRaises(ValueError):
            self.run_state("load")

    def test_iwd_configuration_is_trusted_not_reinterpreted(self):
        original = self.configuration.read_bytes()
        self.configuration.chmod(0o666)
        with self.assertRaises(ValueError):
            self.run_state("load")
        self.configuration.chmod(0o644)
        self.configuration.unlink()
        self.configuration.symlink_to(self.root / "missing")
        with self.assertRaises(ValueError):
            self.run_state("load")
        self.configuration.unlink()
        self.configuration.write_bytes(original)
        self.configuration.chmod(0o644)
        self.assertEqual(self.run_state("load")["checkpoint"], "loaded")

    def test_installed_required_storage_failure_is_not_reinitialized(self):
        before = (self.private / "state.json").read_bytes()
        for error in (ValueError("UUID or mapping mismatch"), FileNotFoundError("missing volume"),
                      OSError(errno.EROFS, "read-only"), OSError(errno.ENOSPC, "no-space")):
            with self.subTest(error=type(error).__name__):
                self.checked.side_effect = error
                with self.assertRaises((ValueError, OSError)):
                    self.run_state("load")
                self.assertEqual((self.private / "state.json").read_bytes(), before)
        self.assertFalse((self.state.runtime / "lease.json").exists())

    def test_snapshot_version_uuid_and_duplicate_json_fields(self):
        original = self.record()
        for key, value in (("schemaVersion", 2), ("schemaVersion", True),
                           ("persistentUuid", VOLUMES["SYSTEM"]),
                           ("generation", "../escape"), ("profiles", [])):
            with self.subTest(key=key):
                self.write_record({**original, key: value})
                with self.assertRaises(ValueError):
                    self.run_state("load")
        (self.private / "state.json").write_text('{"schemaVersion":1,"schemaVersion":1}')
        with self.assertRaises(ValueError):
            self.run_state("load")
        self.assertEqual(list(self.state.iwd.iterdir()), [])

    def test_snapshot_integrity_and_exact_inventory(self):
        saved = self.persist()
        path = self.private / saved["generation"] / "Fixture Network.psk"
        path.write_bytes(b"tampered synthetic data\n")
        with self.assertRaises(ValueError):
            self.run_state("load")
        path.write_bytes(FAKE)
        extra = self.private / saved["generation"] / "unexpected"
        extra.write_text("fake")
        with self.assertRaises(ValueError):
            self.run_state("load")
        extra.unlink()
        path.unlink()
        with self.assertRaises(ValueError):
            self.run_state("load")

    def test_secret_file_links_permissions_and_owners(self):
        saved = self.persist()
        path = self.private / saved["generation"] / "Fixture Network.psk"
        for uid, gid, mode in ((0, 0, 0o644), (1000, 0, 0o600), (0, 1000, 0o600)):
            os.chown(path, uid, gid)
            path.chmod(mode)
            with self.assertRaises(ValueError):
                self.run_state("load")
        os.chown(path, 0, 0)
        path.chmod(0o600)
        os.link(path, self.root / "linked-secret")
        with self.assertRaises(ValueError):
            self.run_state("load")
        (self.root / "linked-secret").unlink()
        path.unlink()
        path.symlink_to(self.root / "missing")
        with self.assertRaises(ValueError):
            self.run_state("load")

    def test_private_directories_and_ancestors(self):
        for path in (self.private, self.state.runtime):
            path.chmod(0o755)
            with self.assertRaises(ValueError):
                self.run_state("load")
            path.chmod(0o700)
            os.chown(path, 0, 1000)
            with self.assertRaises(ValueError):
                self.run_state("load")
            os.chown(path, 0, 0)
        self.private.parent.chmod(0o777)
        with self.assertRaises(ValueError):
            self.run_state("load")

    def test_nonroot_and_self_reported_root_cannot_call(self):
        for uid, euid in ((1000, 1000), (1000, 0), (0, 1000)):
            with patch.object(self.net.os, "getuid", return_value=uid), \
                    patch.object(self.net.os, "geteuid", return_value=euid):
                with self.assertRaises(PermissionError):
                    self.run_state("load")
        self.stopped.assert_not_called()

    def test_handoff_invocation_active_process_and_lock(self):
        self.run_state("load")
        with self.assertRaises(ValueError):
            self.run_state("load", "2" * 32)
        with self.assertRaises(ValueError):
            self.run_state("save", "2" * 32)
        self.stopped.side_effect = ValueError("iwd is active")
        with self.assertRaises(ValueError):
            self.run_state("save")
        self.stopped.side_effect = None
        with self.accounts.state_lock(root=self.state.runtime):
            with self.assertRaises(TimeoutError):
                self.run_state("save")

    def test_unclean_stop_retains_authority_and_blocks_restart(self):
        before = self.record()
        self.run_state("load")
        self.working()
        for result in ("", "exit-code", "signal", "timeout", "resources"):
            with self.assertRaises(ValueError):
                self.run_state("save", result=result)
            self.assertEqual(self.record(), before)
        with self.assertRaises(ValueError):
            self.run_state("load")

    def test_unsupported_state_is_not_silently_lost(self):
        before = self.record()
        self.run_state("load")
        for name in ("Fixture.8021x", ".eap-tls-session-cache", "Fixture.psk.ABCDEF.tmp",
                     "unclassified", ".hidden.psk"):
            path = self.working(name)
            with self.assertRaises(ValueError):
                self.run_state("save")
            self.assertEqual(self.record(), before)
            self.assertTrue(path.exists())
            path.unlink()
        hotspot = self.state.iwd / "hotspot"
        hotspot.mkdir(mode=0o700)
        (hotspot / "fixture").write_text("fake AP state")
        with self.assertRaises(ValueError):
            self.run_state("save")

    def test_classified_frequency_cache_is_volatile(self):
        self.run_state("load")
        self.working()
        self.working(".known_network.freq", b"[Fixture Network]\nList=2412\n")
        (self.state.iwd / "hotspot").mkdir(mode=0o700)
        self.assertEqual(self.run_state("save")["profileCount"], 1)
        self.assertEqual(set(self.record()["profiles"]), {"Fixture Network.psk"})
        self.assertTrue((self.state.iwd / ".known_network.freq").exists())

    def test_owner_bytes_are_not_reparsed_or_normalized(self):
        self.run_state("load")
        encoded = "=466978747572652fe6b58be8af95.psk"
        contents = FAKE + b"# opaque iwd extension settings stay with ell\n"
        self.working(encoded, contents)
        self.working("Fixture Open.open", b"")
        self.run_state("save")
        generation = self.record()["generation"]
        self.assertEqual((self.private / generation / encoded).read_bytes(), contents)
        self.assertEqual(self.run_state("load")["profileCount"], 2)

    def test_profile_name_encoding_and_bounds(self):
        for name in ("../Fake.psk", "Fake.psk/escape", "=00.psk", "=ff.psk",
                     "=ABCDEF.psk", "x" * 33 + ".psk", "Fake.8021x"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.net.profile_name(name)
        for contents in (b"bad\0fake", b"\xff", b"x" * (self.net.PROFILE_LIMIT + 1)):
            with self.assertRaises(ValueError):
                self.net.profile_text(contents)
        self.run_state("load")
        for number in range(self.net.PROFILE_COUNT + 1):
            self.working("Fixture" + str(number) + ".open", b"")
        with self.assertRaises(ValueError):
            self.run_state("save")

    def test_readonly_and_space_refusal_before_publication(self):
        self.run_state("load")
        self.working()
        before = self.record()
        actual = os.statvfs(self.private)
        for flags, blocks, inodes, expected in (
                (os.ST_RDONLY, actual.f_bavail, actual.f_favail, errno.EROFS),
                (0, 0, actual.f_favail, errno.ENOSPC),
                (0, actual.f_bavail, 0, errno.ENOSPC)):
            values = list(actual)
            values[4], values[7], values[8] = blocks, inodes, flags
            with patch.object(self.net.os, "statvfs", return_value=os.statvfs_result(values)):
                with self.assertRaises(OSError) as failure:
                    self.run_state("save")
                self.assertEqual(failure.exception.errno, expected)
            self.assertEqual(self.record(), before)

    def test_write_failure_is_not_success_and_old_pointer_survives(self):
        self.run_state("load")
        self.working()
        before = self.record()
        with patch.object(self.accounts, "atomic", side_effect=OSError(errno.ENOSPC, "fake full")):
            with self.assertRaises(OSError):
                self.run_state("save")
        self.assertEqual(self.record(), before)
        self.assertTrue((self.state.runtime / "lease.json").exists())

    def test_postrename_fsync_uncertainty_remains_failed(self):
        self.run_state("load")
        self.working()
        real_atomic = self.accounts.atomic

        def uncertain(path, text, mode):
            real_atomic(path, text, mode)
            if path.name == "state.json":
                raise OSError(errno.EIO, "synthetic directory sync uncertainty")

        with patch.object(self.accounts, "atomic", side_effect=uncertain):
            with self.assertRaises(OSError):
                self.run_state("save")
        self.assertTrue((self.state.runtime / "lease.json").exists())
        with self.assertRaises(ValueError):
            self.run_state("load")

    def test_ram_release_has_no_post_unlink_runtime_sync(self):
        self.run_state("load")
        self.working()
        real_sync = self.state.sync

        def runtime_eio(path):
            if path == self.state.runtime:
                raise OSError(errno.EIO, "synthetic post-unlink runtime sync failure")
            return real_sync(path)

        with patch.object(self.state, "sync", side_effect=runtime_eio) as sync:
            self.assertEqual(self.run_state("save")["checkpoint"], "committed")
        self.assertNotIn(self.state.runtime, [call.args[0] for call in sync.call_args_list])
        self.assertFalse((self.state.runtime / "lease.json").exists())
        self.assertEqual(self.run_state("load", "2" * 32)["checkpoint"], "loaded")

    def test_lease_unlink_failure_keeps_guard_after_durable_commit(self):
        self.run_state("load")
        self.working()
        before = self.record()
        lease = self.state.runtime / "lease.json"
        real_unlink = Path.unlink

        def unlink(path, *args, **kwargs):
            if path == lease:
                raise OSError(errno.EIO, "synthetic lease unlink failure")
            return real_unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", unlink):
            with self.assertRaises(OSError):
                self.run_state("save")
        self.assertNotEqual(self.record()["generation"], before["generation"])
        self.assertTrue(lease.exists())
        with self.assertRaises(ValueError):
            self.run_state("load", "2" * 32)

    def test_lock_cleanup_failure_keeps_guard_after_durable_commit(self):
        self.run_state("load")
        self.working()
        before = self.record()
        real_lock = self.accounts.state_lock

        @contextmanager
        def lock_close_eio(*args, **kwargs):
            with real_lock(*args, **kwargs):
                yield
            raise OSError(errno.EIO, "synthetic lock close failure")

        with patch.object(self.accounts, "state_lock", lock_close_eio):
            with self.assertRaises(OSError):
                self.run_state("save")
        self.assertNotEqual(self.record()["generation"], before["generation"])
        self.assertTrue((self.state.runtime / "lease.json").exists())
        with self.assertRaises(ValueError):
            self.run_state("load", "2" * 32)

    def test_guard_release_is_after_all_checkpoint_and_lock_work(self):
        self.run_state("load")
        self.working()
        events = []
        real_lock, real_sync, real_unlink = self.accounts.state_lock, self.state.sync, Path.unlink

        @contextmanager
        def lock(*args, **kwargs):
            with real_lock(*args, **kwargs):
                yield
            events.append("lock-closed")

        def sync(path):
            events.append("sync")
            return real_sync(path)

        def unlink(path, *args, **kwargs):
            if path == self.state.runtime / "lease.json":
                events.append("guard-release")
            return real_unlink(path, *args, **kwargs)

        with patch.object(self.accounts, "state_lock", lock), \
                patch.object(self.state, "sync", sync), patch.object(Path, "unlink", unlink):
            self.assertEqual(self.run_state("save")["checkpoint"], "committed")
        self.assertEqual(events[-2:], ["lock-closed", "guard-release"])

    def test_ram_runtime_qualification(self):
        run = self.state.path("/run")
        for record in ("ext4 rw,nodev,nosuid", "tmpfs ro,nodev,nosuid",
                       "tmpfs rw,nosuid", "tmpfs rw,nodev"):
            with patch.object(self.storage, "command", return_value=record):
                with self.assertRaises(ValueError):
                    self.net.NetworkState.memory_runtime(self.state, "installed")
        with patch.object(self.storage, "command", return_value="tmpfs rw,nodev,nosuid") as query:
            self.net.NetworkState.memory_runtime(self.state, "installed")
        self.assertEqual([call.args[2:4] for call in query.call_args_list],
                         [("-M", str(run)), ("-T", str(self.state.runtime))])
        with patch.object(self.storage, "command", side_effect=RuntimeError("missing run mount")):
            with self.assertRaises(RuntimeError):
                self.net.NetworkState.memory_runtime(self.state, "installed")
        with patch.object(self.storage, "command", return_value="tmpfs rw"):
            self.net.NetworkState.memory_runtime(self.state, "live")
        real_stat = Path.stat

        def foreign_device(path, *args, **kwargs):
            info = real_stat(path, *args, **kwargs)
            if path == self.state.runtime and kwargs.get("follow_symlinks", True):
                values = list(info)
                values[2] = real_stat(run).st_dev + 1
                return os.stat_result(values)
            return info

        with patch.object(self.storage, "command", return_value="tmpfs rw,nodev,nosuid"), \
                patch.object(Path, "stat", foreign_device):
            with self.assertRaises(ValueError):
                self.net.NetworkState.memory_runtime(self.state, "installed")

    def test_runtime_inspection_failure_retains_existing_guard(self):
        self.run_state("load")
        self.working()
        before = self.record()
        self.memory.side_effect = OSError(errno.EIO, "synthetic runtime qualification failure")
        with self.assertRaises(OSError):
            self.run_state("save")
        self.assertEqual(self.record(), before)
        self.assertTrue((self.state.runtime / "lease.json").exists())
        self.memory.side_effect = None
        with self.assertRaises(ValueError):
            self.run_state("load", "2" * 32)

    def test_load_between_lock_close_and_release_still_sees_guard(self):
        self.run_state("load")
        self.working()
        real_lock = self.accounts.state_lock
        interleaved = False

        @contextmanager
        def lock(*args, **kwargs):
            nonlocal interleaved
            with real_lock(*args, **kwargs):
                yield
            if not interleaved:
                interleaved = True
                self.assertTrue((self.state.runtime / "lease.json").exists())
                with self.assertRaises(ValueError):
                    self.run_state("load", "2" * 32)
                self.assertEqual((self.state.iwd / "Fixture Network.psk").read_bytes(), FAKE)

        with patch.object(self.accounts, "state_lock", lock):
            self.assertEqual(self.run_state("save")["checkpoint"], "committed")
        self.assertTrue(interleaved)
        self.assertFalse((self.state.runtime / "lease.json").exists())

    def test_cli_guard_unlink_failure_is_not_confirmed_and_blocks_reload(self):
        self.run_state("load")
        self.working()
        real_unlink = Path.unlink
        stderr, stdout = io.StringIO(), io.StringIO()

        def unlink(path, *args, **kwargs):
            if path == self.state.runtime / "lease.json":
                raise OSError(errno.EIO, "synthetic final unlink failure")
            return real_unlink(path, *args, **kwargs)

        with patch.object(sys, "argv", ["state.py", "save"]), \
                patch.dict(os.environ, {"INVOCATION_ID": INVOCATION, "SERVICE_RESULT": "success"}), \
                patch.object(self.net, "deployment"), patch.object(self.net, "no_new_privileges"), \
                patch.object(self.net, "module", side_effect=[self.storage, self.accounts]), \
                patch.object(self.net, "NetworkState", return_value=self.state), \
                patch.object(Path, "unlink", unlink), \
                patch.object(self.net.sys, "stderr", stderr), patch.object(self.net.sys, "stdout", stdout), \
                patch.object(self.net.syslog, "syslog"):
            self.assertEqual(self.net.main(), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn('"checkpoint":"not-confirmed"', stderr.getvalue())
        self.assertNotIn("SyntheticOnly", stderr.getvalue())
        self.assertTrue((self.state.runtime / "lease.json").exists())
        with self.assertRaises(ValueError):
            self.run_state("load", "2" * 32)

    def test_changed_authority_and_unowned_runtime_are_refused(self):
        self.run_state("load")
        self.state.publish(self.private, VOLUMES["PERSISTENT"], {})
        with self.assertRaises(ValueError):
            self.run_state("save")
        (self.state.runtime / "lease.json").unlink()
        self.working()
        with self.assertRaises(ValueError):
            self.run_state("load")

    def test_volatility_qualification_is_exact(self):
        records = ("ext4 rw,nodev,nosuid", "tmpfs ro,nodev,nosuid",
                   "tmpfs rw,nosuid", "tmpfs rw,nodev")
        for record in records:
            with patch.object(self.storage, "command", return_value=record):
                with self.assertRaises(ValueError):
                    self.net.NetworkState.volatile(self.state)
        with patch.object(self.storage, "command", return_value="tmpfs rw,nodev,nosuid"):
            self.net.NetworkState.volatile(self.state)
        with patch.object(self.storage, "command", return_value="ext4 rw"):
            with self.assertRaises(ValueError):
                self.net.NetworkState.volatile(self.state, live=True)
        with patch.object(self.storage, "command", return_value="tmpfs rw"):
            self.net.NetworkState.volatile(self.state, live=True)

    def test_stopped_process_query_is_fixed_not_a_generic_root_command(self):
        for status, stdout in ((1, ""), (0, "123\n"), (0, "")):
            self.process.return_value = subprocess.CompletedProcess([], status, stdout)
            with self.assertRaises(ValueError):
                self.net.NetworkState.stopped(self.state)
        self.process.return_value = subprocess.CompletedProcess([], 0, "0\n")
        self.net.NetworkState.stopped(self.state)
        self.assertEqual(self.process.call_args.args[0],
                         ["/usr/bin/systemctl", "show", "iwd.service", "--property=MainPID", "--value"])

    def test_ambiguous_ssid_aliases_do_not_publish(self):
        self.run_state("load")
        self.working("Fixture.psk")
        self.working("=46697874757265.psk")
        before = self.record()
        with self.assertRaises(ValueError):
            self.run_state("save")
        self.assertEqual(self.record(), before)

    def test_cli_failure_redacts_exception_credentials(self):
        error = ValueError("Fake SSID SyntheticOnly-NotARealCredential")
        stderr, stdout = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", ["state.py", "load"]), \
                patch.object(self.net, "deployment"), \
                patch.object(self.net, "no_new_privileges"), \
                patch.object(self.net, "module", side_effect=error), \
                patch.object(self.net.sys, "stderr", stderr), \
                patch.object(self.net.sys, "stdout", stdout), \
                patch.object(self.net.syslog, "syslog") as log:
            self.assertEqual(self.net.main(), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn("SyntheticOnly", stderr.getvalue())
        self.assertNotIn("Fake SSID", str(log.call_args))
        self.assertIn('"status":"refused"', stderr.getvalue())

    def test_nonfixed_cli_deployment_is_refused(self):
        with self.assertRaises(ValueError):
            self.net.deployment()

    def test_fresh_initializer_uses_only_explicit_locked_image(self):
        other = self.private.parent / "FreshNetwork"
        other.mkdir(mode=0o700)
        for contents in ("live\n", "template\n", "corrupt\n"):
            self.mode_file.write_text(contents)
            with self.assertRaises(ValueError):
                self.net.initialize_empty(other, VOLUMES["PERSISTENT"], self.storage,
                                          self.accounts, self.root, image_root=self.root)
            self.assertEqual(list(other.iterdir()), [])
        self.mode_file.write_text("installed\n")
        (self.root / "etc/shadow").write_text(
            "root:$6$SyntheticOnly$NotARealHash:20000:0:99999:7:::\n"
            "polly:!:20000:0:99999:7:::\n")
        with self.assertRaises(ValueError):
            self.net.initialize_empty(other, VOLUMES["PERSISTENT"], self.storage,
                                      self.accounts, self.root, image_root=self.root)
        self.assertEqual(list(other.iterdir()), [])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    args = parser.parse_args()
    if os.getuid() != 0 or not Path("/run/.containerenv").exists():
        raise RuntimeError("Network tests require an isolated root container")
    REPO = args.repo
    unittest.main(argv=[sys.argv[0]], verbosity=2)
