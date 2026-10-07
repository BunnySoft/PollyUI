#!/usr/bin/env python3
"""Offline account transaction tests; synthetic credentials, no host accounts."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("account_migration",
    Path(__file__).resolve().parents[1] / "release/storage/migrate-accounts.py")
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)
accounts = importer.accounts
OLD_UUID = "10000000-0000-4000-8000-000000000001"
NEW_UUID = "10000000-0000-4000-8000-000000000003"
PASSWD = ("root:x:0:0:root:/root:/bin/bash\n"
          "polly:x:1000:1000:polly:/home/polly:/usr/bin/polly-installed-session\n")
SHADOW = "root:$6$synthetic$root:20000:0:99999:7:::\npolly:$6$synthetic$polly:20000:0:99999:7:::\n"


@unittest.skipUnless(os.geteuid() == 0, "disposable root SDK required")
class AccountMigration(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="polly-account-import-", dir="/run")
        self.root = Path(self.temporary.name)
        self.source = self.root / "old/accounts"
        self.source.mkdir(parents=True)
        self.source.chmod(0o755)
        (self.source / "etc").mkdir(mode=0o755)
        self.target_root = self.root / "system"
        (self.target_root / "etc").mkdir(parents=True)
        self.persistent = self.root / "persistent"
        (self.persistent / "SystemData").mkdir(parents=True)
        self.old_gid, self.new_gid = 42, 43
        for file, value in (("passwd", PASSWD), ("shadow", SHADOW),
                            ("group", "root:x:0:\npolly:x:1000:\nshadow:x:42:\n"),
                            ("nsswitch.conf", importer.NSS_POLICY)):
            accounts.atomic(self.source / "etc" / file, value, 0o640 if file == "shadow" else 0o644)
        os.chown(self.source / "etc/shadow", 0, self.old_gid)
        accounts.atomic(self.source / "config.json", json.dumps({
            "schemaVersion": 2, "homeUuid": OLD_UUID, "initialized": True, "automaticLogin": True}))
        accounts.atomic(self.source / "setup-complete", "1\n")
        accounts.atomic(self.target_root / "etc/passwd", PASSWD + "worker:x:110:110::/nonexistent:/usr/sbin/nologin\n")
        accounts.atomic(self.target_root / "etc/group", "root:x:0:\npolly:x:1000:\nshadow:x:43:\nworker:x:110:\n")
        layout = importer.migration.homes.layout
        self.manifest = layout.contract({"EFI": "1234-ABCD", "SYSTEM": "10000000-0000-4000-8000-000000000002",
                                         "PERSISTENT": NEW_UUID, "RECOVERY": "10000000-0000-4000-8000-000000000004"})
        accounts.atomic(self.target_root / "etc/polly-storage.json", json.dumps(self.manifest))
        self.mounts = patch.object(importer, "volume")
        self.readonly = patch.object(importer.migration, "readonly_source")
        self.mounts.start()
        self.readonly.start()

    def tearDown(self):
        self.mounts.stop()
        self.readonly.stop()
        self.temporary.cleanup()

    def migrate(self):
        return importer.migrate(self.source, self.target_root, self.persistent)

    def inventory(self, path, gid):
        return importer.inventory(path, gid)

    def test_password_bytes_initialization_and_login_policy_are_retained(self):
        before = self.inventory(self.source, self.old_gid)
        transaction = self.migrate()
        destination = self.persistent / "SystemData/Accounts"
        self.assertEqual(self.inventory(self.source, self.old_gid), before)
        self.assertEqual(self.inventory(transaction / "backup", self.old_gid), before)
        self.assertEqual(accounts.read(destination / "etc/shadow", secret=True), SHADOW)
        self.assertEqual((destination / "etc/shadow").stat().st_gid, self.new_gid)
        self.assertEqual((transaction / "backup/etc/shadow").stat().st_gid, self.old_gid)
        self.assertEqual(accounts.config(destination), {"schemaVersion": 3, "persistentUuid": NEW_UUID,
                                                       "initialized": True, "automaticLogin": True})
        self.assertTrue(accounts.completed(destination))
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o755)
        self.assertEqual((destination / "etc/passwd").read_text(), PASSWD)
        self.assertNotIn("worker", (destination / "etc/passwd").read_text())
        self.assertEqual(importer.status(transaction), {"schemaVersion": 1, "phase": "committed",
            "backupRetained": True, "backupVerified": True, "publicationVerified": True,
            "automaticResume": False, "credentialsDisclosed": False})
        self.assertNotIn("$6$", (transaction / "journal.json").read_text())
        self.assertEqual(stat.S_IMODE(transaction.stat().st_mode), 0o700)
        self.assertEqual((transaction / "journal.json").stat().st_mode & 0o777, 0o600)

    def test_authoritative_initialized_flag_derives_missing_marker_without_reopening_setup(self):
        (self.source / "setup-complete").unlink()
        self.migrate()
        self.assertTrue(accounts.completed(self.persistent / "SystemData/Accounts"))
        self.assertTrue((self.persistent / "SystemData/Accounts/setup-complete").is_file())

    def test_uninitialized_partial_setup_is_not_promoted_to_initialized(self):
        (self.source / "setup-complete").unlink()
        accounts.atomic(self.source / "config.json", json.dumps({
            "schemaVersion": 2, "homeUuid": OLD_UUID, "initialized": False, "automaticLogin": False}))
        accounts.atomic(self.source / "etc/shadow",
                        SHADOW.replace("$6$synthetic$polly", "!"), 0o640)
        os.chown(self.source / "etc/shadow", 0, self.old_gid)
        self.migrate()
        destination = self.persistent / "SystemData/Accounts"
        self.assertFalse(accounts.completed(destination))
        self.assertFalse((destination / "setup-complete").exists())
        self.assertEqual(accounts.passwords(destination, shadow_gid=self.new_gid)["polly"][1], "!")

    def test_locked_passwords_remain_locked(self):
        locked = SHADOW.replace("root:$6$", "root:!$6$")
        accounts.atomic(self.source / "etc/shadow", locked, 0o640)
        os.chown(self.source / "etc/shadow", 0, self.old_gid)
        self.migrate()
        self.assertEqual(accounts.read(self.persistent / "SystemData/Accounts/etc/shadow", secret=True), locked)

    def test_existing_role_authority_is_preserved_not_recreated(self):
        policy = '{"schemaVersion":1,"administratorUids":[1000]}\n'
        accounts.atomic(self.source / "roles.json", policy, 0o600)
        transaction = self.migrate()
        self.assertEqual(accounts.read(transaction / "backup/roles.json", secret=True), policy)
        destination = self.persistent / "SystemData/Accounts"
        self.assertEqual(accounts.read(destination / "roles.json", secret=True), policy)
        self.assertEqual(accounts.administrator_policy(destination)["administratorUids"], [1000])
        self.assertTrue(importer.status(transaction)["backupVerified"])

    def test_existing_target_even_blank_or_dangling_is_never_overwritten(self):
        destination = self.persistent / "SystemData/Accounts"
        destination.symlink_to("absent")
        with self.assertRaises(FileExistsError):
            self.migrate()
        destination.unlink()
        destination.mkdir()
        (destination / "keep").write_text("do not replace")
        with self.assertRaises(FileExistsError):
            self.migrate()
        self.assertEqual((destination / "keep").read_text(), "do not replace")
        self.assertEqual(list(destination.parent.glob(".accounts-migration-*")), [])

    def test_unknown_accounts_and_source_files_fail_before_transaction(self):
        file = self.source / "etc/passwd"
        file.write_text(PASSWD + "tester:x:1001:1001::/home/tester:/bin/sh\n")
        with self.assertRaisesRegex(ValueError, "Additional persistent"):
            self.migrate()
        file.write_text(PASSWD)
        (self.source / "unknown-credential").write_text("never discarded")
        with self.assertRaisesRegex(ValueError, "Unclassified"):
            self.migrate()
        self.assertEqual(list((self.persistent / "SystemData").iterdir()), [])

    def test_shadow_permission_group_empty_password_and_bad_aging_are_refused(self):
        file = self.source / "etc/shadow"
        for mode, gid, text in ((0o644, self.old_gid, SHADOW), (0o640, 44, SHADOW),
                                (0o640, self.old_gid, SHADOW.replace("$6$synthetic$polly", "")),
                                (0o640, self.old_gid, SHADOW.replace(":20000:", ":malformed:"))):
            accounts.atomic(file, text, mode)
            os.chown(file, 0, gid)
            with self.subTest(mode=mode, gid=gid, text_kind="synthetic"), self.assertRaises(ValueError):
                self.migrate()
            self.assertEqual(list((self.persistent / "SystemData").iterdir()), [])

    def test_source_setup_marker_inconsistency_and_autologin_before_setup_are_refused(self):
        settings = {"schemaVersion": 2, "homeUuid": OLD_UUID, "initialized": False, "automaticLogin": False}
        accounts.atomic(self.source / "config.json", json.dumps(settings))
        with self.assertRaisesRegex(ValueError, "disagrees"):
            self.migrate()
        (self.source / "setup-complete").unlink()
        settings["automaticLogin"] = True
        accounts.atomic(self.source / "config.json", json.dumps(settings))
        with self.assertRaisesRegex(ValueError, "Uninitialized"):
            self.migrate()

    def test_password_tool_remnants_are_backed_up_but_not_activated(self):
        accounts.atomic(self.source / ".state.lock", "", 0o600)
        accounts.atomic(self.source / "etc/shadow-", SHADOW, 0o640)
        os.chown(self.source / "etc/shadow-", 0, self.old_gid)
        (self.source / "usr").mkdir()
        os.chown(self.source / "usr", 0, 1000)
        (self.source / "dev").mkdir()
        (self.source / "lib").symlink_to("usr/lib")
        (self.source / "etc/pam.d").mkdir()
        accounts.atomic(self.source / "etc/login.defs", "", 0o600)
        transaction = self.migrate()
        self.assertTrue((transaction / "backup/etc/shadow-").exists())
        destination = self.persistent / "SystemData/Accounts"
        self.assertFalse((destination / "etc/shadow-").exists())
        self.assertFalse((destination / "usr").exists())
        self.assertFalse((destination / "lib").is_symlink())
        self.assertEqual((transaction / "backup/usr").stat().st_gid, 1000)

    def test_tool_group_cannot_be_used_on_account_authority(self):
        os.chown(self.source / "etc/passwd", 0, 1000)
        with self.assertRaisesRegex(ValueError, "unqualified group"):
            self.migrate()
        self.assertEqual(list((self.persistent / "SystemData").iterdir()), [])

    def test_enospc_backup_and_stage_failures_keep_original_authority(self):
        with patch.object(importer, "write_stage", side_effect=OSError(errno.ENOSPC, "fixture full")):
            with self.assertRaises(OSError):
                self.migrate()
        transaction, = (self.persistent / "SystemData").glob(".accounts-migration-*")
        self.assertEqual(importer.status(transaction)["phase"], "interrupted")
        self.assertTrue(importer.status(transaction)["backupVerified"])
        self.assertFalse((self.persistent / "SystemData/Accounts").exists())
        self.assertEqual(accounts.read(self.source / "etc/shadow", secret=True), SHADOW)

    def test_backup_enospc_leaves_an_interrupted_record_without_publication(self):
        with patch.object(importer.migration, "copy_records", side_effect=OSError(errno.ENOSPC, "fixture full")):
            with self.assertRaises(OSError):
                self.migrate()
        transaction, = (self.persistent / "SystemData").glob(".accounts-migration-*")
        self.assertEqual(importer.status(transaction)["phase"], "interrupted")
        self.assertFalse(importer.status(transaction)["backupVerified"])
        self.assertFalse((self.persistent / "SystemData/Accounts").exists())

    def test_target_proof_drift_is_rejected_with_private_backup_retained(self):
        original = importer.write_stage

        def drift(*args):
            original(*args)
            accounts.atomic(self.target_root / "etc/group",
                            "root:x:0:\npolly:x:1000:\nshadow:x:44:\nworker:x:110:\n")

        with patch.object(importer, "write_stage", side_effect=drift):
            with self.assertRaisesRegex(ValueError, "qualification changed"):
                self.migrate()
        transaction, = (self.persistent / "SystemData").glob(".accounts-migration-*")
        self.assertTrue(importer.status(transaction)["backupVerified"])
        self.assertFalse((self.persistent / "SystemData/Accounts").exists())

    def test_publication_race_and_post_rename_failure_do_not_reset_accounts(self):
        publish = importer.migration.publish

        def fail_after(stage, destination):
            publish(stage, destination)
            raise OSError(errno.EIO, "fixture interruption")

        with patch.object(importer.migration, "publish", side_effect=fail_after):
            with self.assertRaises(OSError):
                self.migrate()
        transaction, = (self.persistent / "SystemData").glob(".accounts-migration-*")
        state = importer.status(transaction)
        self.assertEqual(state["phase"], "interrupted")
        self.assertTrue(state["publicationVerified"])
        self.assertTrue(state["backupVerified"])
        with self.assertRaises(FileExistsError):
            self.migrate()

    def test_racing_destination_is_preserved(self):
        publish = importer.migration.publish

        def race(stage, destination):
            destination.mkdir()
            (destination / "keep").write_text("competing authority")
            publish(stage, destination)

        with patch.object(importer.migration, "publish", side_effect=race):
            with self.assertRaises(FileExistsError):
                self.migrate()
        self.assertEqual((self.persistent / "SystemData/Accounts/keep").read_text(), "competing authority")
        transaction, = (self.persistent / "SystemData").glob(".accounts-migration-*")
        self.assertFalse(importer.status(transaction)["publicationVerified"])
        self.assertTrue(importer.status(transaction)["backupVerified"])

    def test_target_drift_after_publication_is_an_explicit_interruption(self):
        publish = importer.migration.publish

        def drift(stage, destination):
            publish(stage, destination)
            accounts.atomic(self.target_root / "etc/passwd", PASSWD)

        with patch.object(importer.migration, "publish", side_effect=drift):
            with self.assertRaisesRegex(ValueError, "after account publication"):
                self.migrate()
        transaction, = (self.persistent / "SystemData").glob(".accounts-migration-*")
        self.assertEqual(importer.status(transaction)["phase"], "interrupted")
        self.assertTrue(importer.status(transaction)["publicationVerified"])
        self.assertTrue(importer.status(transaction)["backupVerified"])

    def test_uninitialized_private_marker_or_duplicate_configuration_is_rejected(self):
        (self.source / "config.json").write_text(
            '{"schemaVersion":2,"schemaVersion":2,"homeUuid":"' + OLD_UUID +
            '","initialized":true,"automaticLogin":false}')
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.migrate()

    def test_backup_corruption_is_an_explicit_failure(self):
        transaction = self.migrate()
        accounts.atomic(transaction / "backup/etc/shadow", SHADOW.replace("synthetic", "changed"), 0o640)
        os.chown(transaction / "backup/etc/shadow", 0, self.old_gid)
        with self.assertRaisesRegex(ValueError, "backup is missing or corrupted"):
            importer.status(transaction)

    def test_invalid_journal_and_shadow_membership_are_rejected(self):
        file = self.target_root / "etc/group"
        file.write_text(file.read_text().replace("shadow:x:43:", "shadow:x:43:polly"))
        with self.assertRaises(ValueError):
            self.migrate()
        file.write_text(file.read_text().replace("shadow:x:43:polly", "shadow:x:43:"))
        transaction = self.migrate()
        record = json.loads((transaction / "journal.json").read_text())
        for field, value in (("sourceSha256", "bad"), ("initialized", 1), ("targetProof", {}),
                              ("sourceHomeUuid", "wrong")):
            importer.migration.journal(transaction, {**record, field: value})
            with self.assertRaises(ValueError):
                importer.status(transaction)
        importer.migration.journal(transaction, record)
        self.assertTrue(importer.status(transaction)["backupVerified"])

    def test_mount_policy_checks_source_uuid_ro_backing_and_target_nosuid(self):
        self.mounts.stop()
        for record, readonly, persistent, accepted in (
                (OLD_UUID + " ext4 ro,nodev ro\n", True, False, True),
                (OLD_UUID + " ext4 ro,nodev rw\n", True, False, False),
                (NEW_UUID + " ext4 rw,nodev,nosuid rw\n", False, True, True),
                (NEW_UUID + " ext4 rw,nodev rw\n", False, True, False),
                (NEW_UUID + " ext4 rw rw\n", False, False, True),
                (NEW_UUID + " ext4 rw,nosuid rw\n", False, False, False),
                ("wrong ext4 ro ro\n", True, False, False)):
            with patch.object(importer.subprocess, "run", return_value=
                              importer.subprocess.CompletedProcess([], 0, record)):
                expected = OLD_UUID if readonly else NEW_UUID
                if accepted:
                    importer.volume(self.source, expected, readonly=readonly, persistent=persistent)
                else:
                    with self.assertRaises(ValueError):
                        importer.volume(self.source, expected, readonly=readonly, persistent=persistent)
        self.mounts.start()


if __name__ == "__main__":
    unittest.main()
