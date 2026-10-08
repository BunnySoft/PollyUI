#!/usr/bin/env python3
"""In-memory/small-directory assembly tests; no mkfs, export, disk image or VM."""
import importlib.util
import base64
import json
import os
from pathlib import Path
import stat
import shlex
import tempfile
import unittest
import zlib
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("storage_image",
    Path(__file__).resolve().parents[1] / "tools/build-storage-image.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
spec = importlib.util.spec_from_file_location("greeter_image_fixture",
    Path(__file__).with_name("greeter-image-fixture.py"))
greeter_fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(greeter_fixture)
spec = importlib.util.spec_from_file_location("persistent_boot",
    Path(__file__).with_name("persistent-boot.py"))
boot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot)
spec = importlib.util.spec_from_file_location("account_auth_fixture",
    Path(__file__).with_name("account-auth-fixture.py"))
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)


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
                greeter_fixture.seed(root, builder.legacy, builder.REPO)
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
                self.assertEqual(os.readlink(root / "etc/systemd/system/default.target"),
                                 "/usr/lib/systemd/system/graphical.target")
                self.assertNotIn("polly-firstboot", (root / builder.legacy.GETTY_DROPIN).read_text())
                self.assertEqual(builder.boot_config("fixture", "vmlinuz", "initrd").count(
                    "systemd.unit=polly-console.target"), 1)

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

    def test_console_acceptance_keeps_uefi_and_normal_authentication(self):
        manifest = {"storageContract": builder.layout.contract(builder.layout.new_volume_uuids())}
        identifier = boot.system_uuid(manifest)
        config = builder.boot_config(identifier, "vmlinuz-test", "initrd.img-test")
        commands = boot.console_boot_commands(manifest, config)
        self.assertEqual(commands[-1], "boot")
        self.assertIn("polly.mode=console", commands[1])
        self.assertIn("panic=0", commands[1])
        self.assertIn("/System/Boot/intel-ucode.img /System/Boot/initrd.img-test", commands[2])
        self.assertNotIn("init=/", " ".join(commands))
        self.assertNotIn("polly.verify-persistence", " ".join(commands))
        for broken in ("", config.replace(identifier, "10000000-0000-4000-8000-000000000001"),
                       config.replace("/System/Boot/vmlinuz-test", "/unsafe/kernel")):
            with self.subTest(config=broken), self.assertRaises(ValueError):
                boot.console_boot_commands(manifest, broken)

    def test_console_payload_is_chunked_and_contains_no_password_arguments(self):
        commands = boot.console_fixture_commands(1)
        encoded = "".join(shlex.split(command)[2] for command in commands[1:-1])
        self.assertEqual(zlib.decompress(base64.b64decode(encoded)),
                         boot.console_fixture_source())
        self.assertNotIn(b"def seed_container", boot.console_fixture_source())
        self.assertTrue(all(len(command) < 2048 for command in commands))
        self.assertIn("'console','1','first'", commands[-1])
        self.assertIn("'console','2','retained'", boot.console_fixture_commands(2)[-1])
        for command in commands:
            boot.key_chords(command)
        self.assertEqual(boot.key_chords("aA=+\n"), [
            ["a"], ["shift", "a"], ["equal"], ["shift", "equal"], ["ret"]])
        with self.assertRaises(ValueError):
            boot.key_chords("\x00")

    def test_console_secret_prompt_follows_echo_disable_and_restores_terminal(self):
        terminal = Mock()
        terminal.fileno.return_value = 123
        terminal.readline.return_value = "x" * 28 + "\n"
        original = [0, 0, 0, auth.termios.ECHO | auth.termios.ECHONL | auth.termios.ICANON, 0, 0, []]
        with patch.object(auth.sys, "stdin", terminal), \
                patch.object(auth.os, "isatty", return_value=True), \
                patch.object(auth.termios, "tcgetattr", return_value=original), \
                patch.object(auth.termios, "tcsetattr") as attributes, \
                patch.object(auth, "console_message") as message:
            def confirm(message):
                quiet = attributes.call_args.args[2]
                self.assertFalse(quiet[3] & (auth.termios.ECHO | auth.termios.ECHONL))
                self.assertNotIn("x" * 28, message)
            message.side_effect = confirm
            self.assertEqual(auth.console_password(0, 1), "x" * 28)
            self.assertEqual(attributes.call_args.args[2], original)
            terminal.readline.assert_called_once_with(256)
            terminal.readline.return_value = "invalid\n"
            with self.assertRaisesRegex(RuntimeError, "input withheld"):
                auth.console_password(1, 1)
            self.assertEqual(attributes.call_args.args[2], original)
        with patch.object(auth.sys, "stdin", terminal), \
                patch.object(auth.os, "isatty", return_value=False), \
                patch.object(auth, "console_message") as message:
            with self.assertRaises(RuntimeError):
                auth.console_password(0, 1)
            message.assert_not_called()


if __name__ == "__main__":
    unittest.main()
