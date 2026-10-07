#!/usr/bin/env python3
"""In-memory/small-directory assembly tests; no mkfs, export, disk image or VM."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("storage_image",
    Path(__file__).resolve().parents[1] / "tools/build-storage-image.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
spec = importlib.util.spec_from_file_location("persistent_boot",
    Path(__file__).with_name("persistent-boot.py"))
boot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot)


class StorageImage(unittest.TestCase):
    def test_normal_menu_is_single_system_and_fail_closed(self):
        menu = builder.boot_config("test-system-uuid", "vmlinuz-test", "initrd.img-test")
        self.assertEqual(menu.count("menuentry "), 4)
        self.assertEqual(menu.count("panic=0"), 4)
        self.assertEqual(menu.count("root=UUID=test-system-uuid"), 4)
        self.assertIn("/System/Boot/vmlinuz-test", menu)
        self.assertNotIn("installed A", menu)
        self.assertNotIn("Rootfs.img", menu)
        self.assertNotIn("recovery", menu.lower())

    def test_relocation_leaves_only_an_empty_compatibility_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "usr"
            source.mkdir()
            (source / "one-program").write_text("only one software copy")
            destination = root / "System/Resources"
            destination.parent.mkdir()
            builder.relocate(root, "usr", destination)
            self.assertEqual(list(source.iterdir()), [])
            self.assertEqual((destination / "one-program").read_text(), "only one software copy")

    def test_nonempty_destination_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "usr").mkdir()
            destination = root / "resources"
            destination.mkdir()
            (destination / "keep").write_text("do not erase")
            with self.assertRaises(OSError):
                builder.relocate(root, "usr", destination)
            self.assertEqual((destination / "keep").read_text(), "do not erase")

    def test_compatibility_permissions_do_not_depend_on_umask(self):
        for mask in (0o022, 0o077):
            with self.subTest(umask=mask), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "var/tmp").mkdir(parents=True)
                (root / "usr").mkdir()
                previous = os.umask(mask)
                try:
                    builder.relocate(root, "var/tmp", root / "temporary")
                    builder.relocate(root, "usr", root / "resources")
                finally:
                    os.umask(previous)
                self.assertEqual(stat.S_IMODE((root / "var/tmp").stat().st_mode), 0o1777)
                self.assertEqual(stat.S_IMODE((root / "usr").stat().st_mode), 0o755)
                self.assertEqual(list((root / "var/tmp").iterdir()), [])

    def test_payload_measurement_uses_actual_contents(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            before = builder.payload_bytes(root)
            (root / "payload").write_bytes(b"x" * 10000)
            self.assertEqual(builder.payload_bytes(root) - before, 10000)
            (root / "compat").symlink_to("payload")
            self.assertGreater(builder.payload_bytes(root), before + 10000)

    def test_account_configuration_shared_by_d1_and_new_layout(self):
        for storage in (False, True):
            with self.subTest(storage=storage), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary) / "root"
                account = Path(temporary) / "state/accounts"
                for name in ("etc/pam.d", "etc/systemd/system/multi-user.target.wants",
                             "usr/bin", "usr/sbin"):
                    (root / name).mkdir(parents=True, exist_ok=True)
                values = {
                    "etc/passwd": "root:x:0:0::/root:/bin/sh\npolly:x:1000:1000::/home/polly:/bin/sh\n",
                    "etc/shadow": "root:!:20732:0:99999:7:::\npolly:!:20732:0:99999:7:::\n",
                    "etc/group": "shadow:x:42:\n",
                    "etc/nsswitch.conf": "shadow: files\n",
                    "etc/shells": "/bin/sh\n",
                    "etc/pam.d/common-password": "password required pam_unix.so\n",
                    "usr/bin/passwd": "fixture",
                    "usr/bin/passwd.distrib": "fixture",
                }
                for name, text in values.items():
                    (root / name).write_text(text)
                # Only chown requires root; this unit uses the actual builder with that one operation mocked.
                with patch.object(builder.legacy.os, "chown"):
                    builder.legacy.configure_accounts(root, account, "test-volume", builder.REPO, storage)
                config = json.loads((account / "config.json").read_text())
                self.assertEqual(config["schemaVersion"], 3 if storage else 2)
                self.assertFalse(config["initialized"])
                self.assertFalse(config["automaticLogin"])
                self.assertEqual(config["persistentUuid" if storage else "homeUuid"], "test-volume")
                service = (root / "etc/systemd/system/polly-accounts.service").read_text()
                self.assertIn("Requires=polly-storage.service" if storage else "RequiresMountsFor=/home", service)
                self.assertIn("shadow: extrausers files", (root / "etc/nsswitch.conf").read_text())
                self.assertFalse((account / "setup-complete").exists())

    def test_diagnostic_boot_is_explicit_and_rejects_bad_inputs(self):
        manifest = {"layout": "single-system-independent-recovery",
                    "storageContract": builder.layout.contract(builder.layout.new_volume_uuids())}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in ("vmlinuz", "initrd"):
                (directory / name).write_bytes(b"fixture")
            arguments = boot.diagnostic_kernel_arguments(manifest, directory)
            self.assertIn("-kernel", arguments)
            self.assertIn("systemd.journald.forward_to_console=yes", arguments[-1])
            self.assertIn("panic=0", arguments[-1])
            for layout in ("legacy", None):
                with self.subTest(layout=layout), self.assertRaises(ValueError):
                    boot.diagnostic_kernel_arguments(dict(manifest, layout=layout), directory)
            broken = json.loads(json.dumps(manifest))
            broken["storageContract"]["volumes"][1]["uuid"] = "invalid root=evil"
            with self.assertRaises(ValueError):
                boot.diagnostic_kernel_arguments(broken, directory)
            (directory / "initrd").write_bytes(b"")
            with self.assertRaises(ValueError):
                boot.diagnostic_kernel_arguments(manifest, directory)
            (directory / "initrd").unlink()
            (directory / "initrd").symlink_to("vmlinuz")
            with self.assertRaises(ValueError):
                boot.diagnostic_kernel_arguments(manifest, directory)


if __name__ == "__main__":
    unittest.main()
