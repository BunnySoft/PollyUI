#!/usr/bin/env python3
"""Root-container fresh assembly fixtures; no image, mounts, iwd or credentials."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch


class FreshNetworkAssembly(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="polly-storage-network-")
        self.addCleanup(temporary.cleanup)
        self.stage = Path(temporary.name)
        self.root, self.persistent = self.stage / "root", self.stage / "persistent"
        for path in (self.root, self.persistent):
            path.mkdir(mode=0o755)
        for name in ("etc/pam.d", "etc/skel", "etc/systemd/system/multi-user.target.wants",
                     "etc/systemd/system/iwd.service.d", "usr/bin", "usr/sbin",
                     "usr/lib/polly-network", "usr/share/base-files", "boot", "root",
                     "home/polly", "var/lib/dpkg", "var/lib/apt", "var/log", "var/cache", "var/tmp"):
            (self.root / name).mkdir(mode=0o755, parents=True, exist_ok=True)
        records = {
            "etc/passwd": "root:x:0:0:root:/root:/bin/sh\npolly:x:1000:1000:fixture:/home/polly:/bin/sh\n",
            "etc/shadow": "root:!:20000:0:99999:7:::\npolly:!:20000:0:99999:7:::\n",
            "etc/group": "root:x:0:\npolly:x:1000:\nshadow:x:42:\n",
            "etc/polly-account-profile": "installed\n",
            "etc/nsswitch.conf": "shadow: files\n",
            "etc/shells": "/bin/sh\n",
            "etc/pam.d/common-password": "password required pam_unix.so\n",
            "usr/bin/passwd": "synthetic factory executable placeholder\n",
            "usr/bin/passwd.distrib": "synthetic factory executable placeholder\n",
        }
        for name, text in records.items():
            path = self.root / name
            path.write_text(text)
            path.chmod(0o640 if name == "etc/shadow" else 0o644)
        spec = importlib.util.spec_from_file_location("greeter_image_fixture",
            Path(__file__).with_name("greeter-image-fixture.py"))
        greeter_fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(greeter_fixture)
        greeter_fixture.seed(self.root, builder.legacy, REPO)
        os.chown(self.root / "etc/shadow", 0, 42)
        for source, target, mode in (
                ("state.py", "usr/lib/polly-network/state.py", 0o755),
                ("iwd-state.conf", "etc/systemd/system/iwd.service.d/polly-state.conf", 0o644)):
            path = self.root / target
            path.write_bytes((REPO / "desktop/release/network" / source).read_bytes().replace(b"\r\n", b"\n"))
            path.chmod(mode)
        self.identifiers = builder.layout.new_volume_uuids()
        self.network = self.persistent / "SystemData/Network"

    def prepare(self, **kwargs):
        return builder.prepare_root(self.root, self.persistent, self.identifiers,
                                    assembly_root=kwargs.get("assembly_root", self.stage))

    def test_default_builder_initializes_only_after_accounts_and_manifest_before_relocation(self):
        initialize = builder.network.initialize_empty

        def observe(path, identifier, storage, accounts, *, assembly_root, image_root):
            self.assertEqual(path, self.network)
            self.assertEqual(identifier, self.identifiers["PERSISTENT"])
            self.assertIs(storage, builder.storage)
            self.assertIs(accounts, builder.accounts)
            self.assertEqual(assembly_root, self.stage)
            self.assertEqual(image_root, self.root)
            self.assertTrue((self.root / "usr/bin/passwd").is_file())
            self.assertTrue((self.root / "boot").is_dir())
            self.assertFalse((self.root / "System/Resources").exists())
            config = json.loads((self.persistent / "SystemData/Accounts/config.json").read_text())
            self.assertEqual(config["schemaVersion"], 3)
            self.assertFalse(config["initialized"])
            self.assertFalse(config["automaticLogin"])
            manifest = json.loads((self.root / "etc/polly-storage.json").read_text())
            self.assertEqual(manifest, builder.layout.contract(self.identifiers))
            return initialize(path, identifier, storage, accounts,
                              assembly_root=assembly_root, image_root=image_root)

        with patch.object(builder.network, "initialize_empty", side_effect=observe) as call:
            contract = self.prepare()
        call.assert_called_once()
        self.assertEqual(contract, builder.layout.contract(self.identifiers))
        value, profiles = builder.network.NetworkState(
            builder.storage, builder.accounts, self.stage).snapshot(
                self.network, self.identifiers["PERSISTENT"])
        self.assertEqual(profiles, {})
        self.assertEqual(value["persistentUuid"], self.identifiers["PERSISTENT"])
        self.assertEqual(stat.S_IMODE((self.network / "state.json").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.network.stat().st_mode), 0o700)
        self.assertEqual(list((self.root / "usr").iterdir()), [])
        self.assertTrue((self.root / "System/Resources/lib/polly-network/state.py").is_file())
        self.assertEqual(list((self.root / "var/lib/iwd").iterdir()), [])
        self.assertIn("tmpfs /var/lib/iwd tmpfs mode=0700,nodev,nosuid",
                      (self.root / "etc/fstab").read_text())

    def test_explicit_common_assembly_boundary_is_required(self):
        with self.assertRaises(ValueError):
            self.prepare(assembly_root=self.root)
        self.assertFalse((self.network / "state.json").exists())
        with self.assertRaises(TypeError):
            builder.prepare_root(self.root, self.persistent, self.identifiers)

    def test_untrusted_network_overlay_fails_before_account_or_user_relocation(self):
        helper = self.root / "usr/lib/polly-network/state.py"
        original = helper.read_bytes()
        for mode, contents in ((0o777, original), (0o755, b"stale source\n")):
            with self.subTest(mode=mode, contentsMatch=contents == original):
                helper.chmod(mode)
                helper.write_bytes(contents)
                with self.assertRaises(ValueError):
                    self.prepare()
                self.assertFalse((self.persistent / "Users/1000").exists())
                self.assertFalse((self.network / "state.json").exists())
        helper.write_bytes(original)
        helper.chmod(0o755)
        helper.unlink()
        with self.assertRaises(FileNotFoundError):
            self.prepare()

    def test_wrong_factory_profile_does_not_initialize_network(self):
        (self.root / "etc/polly-account-profile").write_text("live\n")
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse((self.network / "state.json").exists())

    def test_configured_factory_credentials_are_not_reset_or_imported(self):
        path = self.root / "etc/shadow"
        value = path.read_text().replace("root:!", "root:$6$SyntheticOnly$NotARealHash")
        path.write_text(value)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(path.read_text(), value)
        self.assertFalse((self.network / "state.json").exists())

    def test_existing_home_content_remains_ineligible_for_fresh_assembly(self):
        file = self.root / "home/polly/private-document"
        file.write_text("synthetic private home fixture")
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(file.read_text(), "synthetic private home fixture")
        self.assertFalse((self.network / "state.json").exists())

    def test_existing_network_working_credentials_are_not_imported(self):
        path = self.root / "var/lib/iwd"
        path.mkdir(mode=0o700)
        (path / "Synthetic.psk").write_text("synthetic refusal fixture; not a real password")
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertTrue((path / "Synthetic.psk").is_file())
        self.assertFalse((self.network / "state.json").exists())

    def test_existing_private_network_state_is_not_repaired(self):
        self.network.mkdir(mode=0o700, parents=True)
        sentinel = self.network / "state.json"
        sentinel.write_text("existing synthetic invalid state")
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(sentinel.read_text(), "existing synthetic invalid state")

    def test_existing_private_account_state_is_not_reinitialized(self):
        account = self.persistent / "SystemData/Accounts"
        (account / "etc").mkdir(parents=True)
        sentinel = account / "config.json"
        sentinel.write_text('{"initialized":true,"syntheticExistingState":true}\n')
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual(sentinel.read_text(), '{"initialized":true,"syntheticExistingState":true}\n')
        self.assertFalse((self.network / "state.json").exists())

    def test_linked_iwd_working_tree_is_not_scanned_or_imported(self):
        external = self.stage / "external-iwd"
        external.mkdir(mode=0o700)
        sentinel = external / "Synthetic.psk"
        sentinel.write_text("synthetic external fixture")
        (self.root / "var/lib/iwd").symlink_to(external)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(sentinel.read_text(), "synthetic external fixture")
        self.assertFalse((self.network / "state.json").exists())

    def test_shadow_group_is_qualified_from_the_image_not_the_host(self):
        (self.root / "etc/group").write_text("root:x:0:\npolly:x:1000:\nshadow:x:43:\n")
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual((self.root / "etc/shadow").stat().st_gid, 42)
        self.assertFalse((self.network / "state.json").exists())

    def test_network_sources_and_initializer_are_in_current_build_provenance(self):
        paths = {path.relative_to(REPO).as_posix() for path in builder.build_inputs() if path.is_file()}
        self.assertTrue({
            "desktop/release/network/state.py", "desktop/release/network/iwd-state.conf",
            "desktop/release/storage/storage.py", "desktop/release/storage/layout.py",
            "desktop/release/install/accounts.py", "desktop/tools/build-storage-image.py",
            "desktop/release/debian/Containerfile.storage",
        }.issubset(paths))
        recipe = (REPO / "desktop/release/debian/Containerfile.storage").read_text()
        self.assertIn("COPY release/network/state.py /usr/lib/polly-network/state.py", recipe)
        self.assertIn("COPY release/network/iwd-state.conf /etc/systemd/system/iwd.service.d/polly-state.conf", recipe)
        self.assertIn("chown 0:0 /usr/lib/polly-network/state.py", recipe)
        self.assertIn("/usr/sbin/polly-accounts /usr/lib/polly-network/state.py", recipe)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    args = parser.parse_args()
    if os.getuid() != 0 or os.geteuid() != 0 or not Path("/run/.containerenv").exists():
        raise RuntimeError("Fresh Network assembly fixtures require an isolated root container")
    REPO = args.repo.resolve()
    spec = importlib.util.spec_from_file_location(
        "network_image_builder", REPO / "desktop/tools/build-storage-image.py")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    unittest.main(argv=[sys.argv[0]], verbosity=2)
