#!/usr/bin/env python3
"""Validate storage refusal rules without device access or mount privileges."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("storage",
    Path(__file__).resolve().parents[1] / "release/storage/storage.py")
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)

VOLUMES = {
    "EFI": "12AB-34CD",
    "SYSTEM": "10000000-0000-4000-8000-000000000001",
    "PERSISTENT": "10000000-0000-4000-8000-000000000002",
    "RECOVERY": "10000000-0000-4000-8000-000000000003",
}


class StorageMappings(unittest.TestCase):
    def test_volume_identity_type_and_flags(self):
        storage.validate_volume(VOLUMES["PERSISTENT"] + " ext4 rw,nodev,nosuid",
                                VOLUMES["PERSISTENT"], "ext4", ("rw", "nodev", "nosuid"))
        for record in ("", "wrong ext4 rw,nodev,nosuid",
                       VOLUMES["PERSISTENT"] + " tmpfs rw,nodev,nosuid",
                       VOLUMES["PERSISTENT"] + " ext4 ro,nodev,nosuid",
                       VOLUMES["PERSISTENT"] + " ext4 rw,nodev"):
            with self.subTest(record=record), self.assertRaises(ValueError):
                storage.validate_volume(record, VOLUMES["PERSISTENT"], "ext4",
                                        ("rw", "nodev", "nosuid"))
        with self.assertRaises(ValueError):
            storage.validate_volume(VOLUMES["SYSTEM"] + " ext4 rw,nosuid",
                                    VOLUMES["SYSTEM"], "ext4", ("rw",), ("nosuid", "noexec"))

    def fixture(self, root):
        path = root / "etc/polly-storage.json"
        path.parent.mkdir()
        path.write_text(json.dumps(storage.layout.contract(VOLUMES)))
        return path

    def test_manifest_is_the_only_path_authority(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = self.fixture(root)
            with patch.object(storage.Storage, "trusted"):
                state = storage.Storage(root)
                self.assertEqual(state.persistent, root / "run/polly-storage/persistent")
                self.assertEqual(state.source(state.contract["mappings"][0]), root / "System/Resources")
                value = json.loads(path.read_text())
                value["mappings"][0]["target"] = "/etc"
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    storage.Storage(root)

    def test_second_state_tree_not_hidden(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            target = root / "var/lib/dpkg"
            target.mkdir(parents=True)
            (target / "status").write_text("existing authority")
            with patch.object(storage.Storage, "trusted"), \
                    patch.object(storage.Storage, "mounted", return_value=False), \
                    patch.object(storage, "command") as command:
                state = storage.Storage(root)
                mapping = next(item for item in state.contract["mappings"] if item["target"] == "/var/lib/dpkg")
                with self.assertRaisesRegex(ValueError, "second state tree"):
                    state.alias(mapping)
                command.assert_not_called()

    def test_wrong_existing_mount_not_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            (root / "System/Boot").mkdir(parents=True)
            (root / "boot").mkdir()
            with patch.object(storage.Storage, "trusted"), \
                    patch.object(storage.Storage, "mounted", return_value=True), \
                    patch.object(storage, "command") as command:
                state = storage.Storage(root)
                mapping = next(item for item in state.contract["mappings"] if item["target"] == "/boot")
                with self.assertRaisesRegex(ValueError, "unexpected storage mount"):
                    state.alias(mapping)
                command.assert_not_called()

    def test_correct_mount_remounted_writable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            source = root / "System/Boot"
            source.mkdir(parents=True)
            # Mock only inode equality; actual bind execution is covered by the namespace fixture.
            with patch.object(storage.Storage, "trusted"), \
                    patch.object(storage.Storage, "mounted", return_value=True), \
                    patch.object(storage.os.path, "samestat", return_value=True), \
                    patch.object(storage, "command") as command:
                (root / "boot").mkdir()
                state = storage.Storage(root)
                mapping = next(item for item in state.contract["mappings"] if item["target"] == "/boot")
                state.alias(mapping)
                command.assert_called_once_with("/usr/bin/mount", "-n", "-o",
                                                "remount,bind,rw", str(root / "boot"))

    def test_nonroot_cannot_prepare(self):
        with patch.object(storage.os, "geteuid", return_value=1000), \
                patch.object(storage.Storage, "preflight") as preflight:
            state = object.__new__(storage.Storage)
            with self.assertRaises(PermissionError):
                state.prepare()
            preflight.assert_not_called()

    def test_manifest_size_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = self.fixture(root)
            path.write_text(" " * 65537)
            with patch.object(storage.Storage, "trusted"), self.assertRaisesRegex(ValueError, "size limit"):
                storage.Storage(root)

    def test_unsafe_nodes_or_ancestors_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = self.fixture(root)
            with patch.object(storage.Storage, "trusted"):
                state = storage.Storage(root)
            original = Path.lstat

            def guest_owner(node):
                info = original(node)
                return SimpleNamespace(st_uid=0, st_gid=0, st_mode=info.st_mode)

            with patch.object(Path, "lstat", guest_owner):
                state.trusted(path, directory=False)
                path.chmod(0o666)
                with self.assertRaisesRegex(ValueError, "Unsafe storage path"):
                    state.trusted(path, directory=False)
                path.chmod(0o644)
                path.parent.chmod(0o777)
                with self.assertRaisesRegex(ValueError, "Unsafe storage ancestor"):
                    state.trusted(path, directory=False)
                path.parent.chmod(0o755)
                path.unlink()
                path.symlink_to(root / "absent")
                with self.assertRaises(ValueError):
                    state.trusted(path, directory=False)


if __name__ == "__main__":
    unittest.main()
