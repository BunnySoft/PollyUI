#!/usr/bin/env python3
"""Disposable offline importer tests; real read-only mounts have a separate fixture."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("migration",
    Path(__file__).resolve().parents[1] / "release/storage/migrate-home.py")
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


@unittest.skipUnless(os.geteuid() == 0, "disposable root SDK required")
class Migration(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="polly-home-migration-", dir="/run")
        self.root = Path(self.temporary.name)
        self.users = self.root / "Users"
        self.users.mkdir(mode=0o755)
        self.legacy = self.root / "legacy"
        self.legacy.mkdir(mode=0o755)
        self.readonly = patch.object(migration, "readonly_source")
        self.readonly.start()

    def tearDown(self):
        self.readonly.stop()
        self.temporary.cleanup()

    def source(self, uid=1000, name="polly"):
        home = self.legacy / name
        home.mkdir(mode=0o700)
        user = {"name": name, "uid": uid, "gid": uid}
        for path, text in {
            ".config/editor/settings.json": '{"theme":"dark","user":' + str(uid) + "}",
            ".local/share/polly/app/org.polly.sample/identity.json": '{"appId":"org.polly.sample"}',
            ".local/state/polly/session": "state-" + str(uid),
            ".cache/polly/cache": "cache-" + str(uid),
            "Documents/document.txt": "document-" + str(uid),
            ".local/bin/custom": "not a globally registered app",
            ".profile": "user profile",
        }.items():
            destination = home / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(text)
        (home / "Documents/external-link").symlink_to("/does-not-exist/user-link")
        for directory, children, files in os.walk(home):
            for target in [Path(directory), *(Path(directory) / entry for entry in (*children, *files))]:
                os.chown(target, uid, uid, follow_symlinks=False)
                if not target.is_symlink():
                    target.chmod(0o700 if target.is_dir() else 0o600)
        return home, user

    def test_root_and_two_users_preserve_source_backup_data_and_app_id(self):
        for uid, name in ((0, "root"), (1000, "polly"), (1001, "tester")):
            with self.subTest(uid=uid):
                home, user = self.source(uid, name)
                before = migration.inventory(home, user)
                transaction = migration.migrate(home, self.users, user)
                destination = self.users / str(uid)
                self.assertEqual(migration.inventory(home, user), before)
                self.assertEqual(migration.inventory(transaction / "backup", user), before)
                for old, new in migration.mapping(before).items():
                    if before[old]["type"] == "file":
                        self.assertEqual((home / old).read_bytes(), (destination / new).read_bytes())
                    self.assertEqual((destination / new).lstat().st_uid, uid)
                self.assertEqual(os.readlink(destination / ".config"), "Settings")
                self.assertEqual(os.readlink(destination / ".local/share"), "../AppData")
                self.assertTrue((destination / "Settings/user-dirs.dirs").is_file())
                self.assertEqual(stat.S_IMODE(transaction.stat().st_mode), 0o700)
                self.assertEqual((transaction / "journal.json").stat().st_mode & 0o777, 0o600)
                self.assertEqual(migration.status(transaction), {
                    "schemaVersion": 1, "phase": "committed", "publicationVerified": True,
                    "backupRetained": True, "backupVerified": True, "automaticResume": False})
        self.assertFalse((self.users / "SystemData").exists())

    def test_existing_user_dirs_and_user_attributes_are_preserved(self):
        source, user = self.source()
        config = source / ".config/user-dirs.dirs"
        config.write_text('XDG_DOCUMENTS_DIR="$HOME/Custom Documents"\n')
        os.chown(config, 1000, 1000)
        os.setxattr(source / "Documents/document.txt", "user.polly-test", b"private metadata")
        migration.migrate(source, self.users, user)
        self.assertEqual((self.users / "1000/Settings/user-dirs.dirs").read_text(), config.read_text())
        self.assertEqual(os.getxattr(self.users / "1000/Documents/document.txt", "user.polly-test"),
                         b"private metadata")

    def test_canonical_links_are_not_treated_as_conflicts(self):
        source, user = self.source()
        (source / ".config").rename(source / "Settings")
        (source / ".config").symlink_to("Settings")
        os.lchown(source / ".config", 1000, 1000)
        migration.migrate(source, self.users, user)
        self.assertTrue((self.users / "1000/Settings/editor/settings.json").is_file())

    def test_conflicts_existing_destination_and_special_data_reject_before_write(self):
        for kind in ("xdg", "destination", "dangling-destination", "fifo",
                     "foreign-owner", "hard-link", "privileged", "wrong-uid"):
            with self.subTest(kind=kind):
                source, user = self.source()
                if kind == "xdg":
                    (source / "Settings").mkdir()
                    os.chown(source / "Settings", 1000, 1000)
                elif kind == "destination":
                    (self.users / "1000").mkdir()
                elif kind == "dangling-destination":
                    (self.users / "1000").symlink_to("missing")
                elif kind == "fifo":
                    os.mkfifo(source / "pipe")
                    os.chown(source / "pipe", 1000, 1000)
                elif kind == "foreign-owner":
                    os.chown(source / "Documents/document.txt", 1001, 1001)
                elif kind == "hard-link":
                    os.link(source / "Documents/document.txt", source / "another-link")
                elif kind == "privileged":
                    (source / ".local/bin/custom").chmod(0o4700)
                else:
                    user["uid"] = True
                with self.assertRaises((ValueError, FileExistsError)):
                    migration.migrate(source, self.users, user)
                self.assertEqual(list(self.users.glob(".migration-*")), [])
                self.assertTrue((source / "Documents/document.txt").is_file())
                # Only this explicitly created disposable fixture is removed.
                import shutil
                shutil.rmtree(source)
                destination = self.users / "1000"
                if destination.is_symlink():
                    destination.unlink()
                elif destination.exists():
                    destination.rmdir()

    def test_writable_source_and_mutating_backup_are_rejected(self):
        source, user = self.source()
        self.readonly.stop()
        with self.assertRaisesRegex(ValueError, "read-only filesystem"):
            migration.migrate(source, self.users, user)
        self.readonly.start()
        original = migration.copy_records

        def corrupt_backup(*args):
            original(*args)
            if args[1].name == "backup":
                (args[1] / "Documents/document.txt").write_text("corrupted")

        with patch.object(migration, "copy_records", side_effect=corrupt_backup):
            with self.assertRaisesRegex(ValueError, "backup verification"):
                migration.migrate(source, self.users, user)
        self.assertFalse((self.users / "1000").exists())
        transaction, = self.users.glob(".migration-*")
        self.assertEqual(migration.status(transaction)["phase"], "interrupted")

    def test_enospc_copy_interruption_retains_source_and_journal(self):
        source, user = self.source()
        before = migration.inventory(source, user)
        with patch.object(migration, "copy_records", side_effect=OSError(errno.ENOSPC, "fixture full")):
            with self.assertRaises(OSError):
                migration.migrate(source, self.users, user)
        self.assertEqual(migration.inventory(source, user), before)
        self.assertFalse((self.users / "1000").exists())
        transaction, = self.users.glob(".migration-*")
        record = json.loads((transaction / "journal.json").read_text())
        self.assertEqual((record["phase"], record["failedPhase"]), ("interrupted", "planned"))

    def test_atomic_publication_never_replaces_a_racing_destination(self):
        source, user = self.source()
        publish = migration.publish

        def race(stage, destination):
            destination.mkdir(mode=0o700)
            (destination / "keep").write_text("another committed home")
            publish(stage, destination)

        with patch.object(migration, "publish", side_effect=race):
            with self.assertRaises(FileExistsError):
                migration.migrate(source, self.users, user)
        self.assertEqual((self.users / "1000/keep").read_text(), "another committed home")
        transaction, = self.users.glob(".migration-*")
        self.assertTrue((transaction / "home").is_dir())
        self.assertEqual(json.loads((transaction / "journal.json").read_text())["phase"], "interrupted")
        with self.assertRaisesRegex(ValueError, "foreign UID/GID"):
            migration.status(transaction)

    def test_interruption_after_rename_is_reported_not_rolled_back(self):
        source, user = self.source()
        publish = migration.publish

        def interrupt(stage, destination):
            publish(stage, destination)
            raise OSError(errno.EIO, "fixture power loss after rename")

        with patch.object(migration, "publish", side_effect=interrupt):
            with self.assertRaises(OSError):
                migration.migrate(source, self.users, user)
        transaction, = self.users.glob(".migration-*")
        self.assertEqual(migration.status(transaction), {
            "schemaVersion": 1, "phase": "interrupted", "publicationVerified": True,
            "backupRetained": True, "backupVerified": True, "automaticResume": False})
        with self.assertRaises(FileExistsError):
            migration.migrate(source, self.users, user)

    def test_directory_sync_failure_after_publication_is_explicit(self):
        source, user = self.source()
        sync = migration.sync_directory

        def fail_users_after_publish(path):
            if path == self.users and (self.users / "1000").exists():
                raise OSError(errno.EIO, "fixture directory sync failure")
            sync(path)

        with patch.object(migration, "sync_directory", side_effect=fail_users_after_publish):
            with self.assertRaises(OSError):
                migration.migrate(source, self.users, user)
        transaction, = self.users.glob(".migration-*")
        state = migration.status(transaction)
        self.assertEqual(state["phase"], "interrupted")
        self.assertTrue(state["publicationVerified"])
        self.assertTrue(state["backupVerified"])

    def test_backup_tampering_is_not_a_success_shaped_status(self):
        source, user = self.source()
        transaction = migration.migrate(source, self.users, user)
        (transaction / "backup/Documents/document.txt").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "backup is missing or corrupted"):
            migration.status(transaction)


if __name__ == "__main__":
    unittest.main()
