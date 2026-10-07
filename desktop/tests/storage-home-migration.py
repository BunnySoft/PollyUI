#!/usr/bin/env python3
"""Disposable offline importer tests; real read-only mounts have a separate fixture."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("migration",
    Path(__file__).resolve().parents[1] / "release/storage/migrate-home.py")
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
spec = importlib.util.spec_from_file_location("identity_tests",
    Path(__file__).resolve().with_name("storage-identities.py"))
identity_tests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity_tests)


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
                    "schemaVersion": 4, "phase": "committed", "publicationVerified": True,
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
                    os.link(source / "Documents/document.txt", self.root / "outside-link")
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
                outside = self.root / "outside-link"
                if outside.exists():
                    outside.unlink()

    def test_writable_source_and_mutating_backup_are_rejected(self):
        source, user = self.source()
        self.readonly.stop()
        with self.assertRaisesRegex(ValueError, "read-only filesystem"):
            migration.migrate(source, self.users, user)
        self.readonly.start()
        original = migration.copy_records

        def corrupt_backup(*args, **kwargs):
            original(*args, **kwargs)
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
        self.assertFalse(migration.status(transaction)["publicationVerified"])
        self.assertTrue(migration.status(transaction)["backupVerified"])

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
            "schemaVersion": 4, "phase": "interrupted", "publicationVerified": True,
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

    def test_internal_hard_links_survive_xdg_normalization_and_private_backup(self):
        source, user = self.source()
        original = source / ".config/editor/settings.json"
        os.link(original, source / "Documents/linked-settings.json")
        os.link(original, source / ".local/state/polly/linked-settings.json")
        before = migration.inventory(source, user)
        transaction = migration.migrate(source, self.users, user)
        backup = transaction / "backup"
        destination = self.users / "1000"
        paths = ("Settings/editor/settings.json", "Documents/linked-settings.json",
                 "AppState/polly/linked-settings.json")
        info = (destination / paths[0]).stat()
        self.assertEqual(info.st_nlink, 3)
        self.assertTrue(all((destination / name).stat().st_ino == info.st_ino for name in paths))
        self.assertNotEqual(info.st_ino, original.stat().st_ino)
        self.assertEqual(migration.inventory(backup, user), before)
        self.assertEqual((backup / ".config/editor/settings.json").stat().st_nlink, 3)
        self.assertTrue(migration.status(transaction)["backupVerified"])

    def test_old_unlinked_schema_remains_inspectable(self):
        source, user = self.source()
        transaction = migration.migrate(source, self.users, user)
        record = json.loads((transaction / "journal.json").read_text())
        record["schemaVersion"] = 1
        migration.journal(transaction, record)
        state = migration.status(transaction)
        self.assertEqual(state["schemaVersion"], 1)
        self.assertTrue(state["publicationVerified"])
        self.assertTrue(state["backupVerified"])

    def test_old_hard_link_schema_remains_inspectable(self):
        source, user = self.source()
        os.link(source / "Documents/document.txt", source / "Documents/linked.txt")
        transaction = migration.migrate(source, self.users, user)
        record = json.loads((transaction / "journal.json").read_text())
        record["schemaVersion"] = 2
        migration.journal(transaction, record)
        self.assertEqual(migration.status(transaction)["schemaVersion"], 2)
        self.assertTrue(migration.status(transaction)["backupVerified"])

    def acl(self, permissions):
        return struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in (
            (1, 6, 0xffffffff), (2, permissions, 0), (4, 0, 0xffffffff),
            (16, 4, 0xffffffff), (32, 0, 0xffffffff)))

    def test_known_root_ownership_and_posix_acl_are_preserved_not_reassigned(self):
        source, user = self.source()
        file = source / "Documents/document.txt"
        os.chown(file, 0, 0)
        acl = self.acl(4)
        os.setxattr(file, "system.posix_acl_access", acl)
        before = migration.inventory(source, user)
        transaction = migration.migrate(source, self.users, user)
        for root in (transaction / "backup", self.users / "1000"):
            copied = root / "Documents/document.txt"
            self.assertEqual((copied.stat().st_uid, copied.stat().st_gid), (0, 0))
            self.assertEqual(os.getxattr(copied, "system.posix_acl_access"), acl)
        self.assertEqual(migration.inventory(transaction / "backup", user), before)
        self.assertTrue(migration.status(transaction)["backupVerified"])

    def test_unknown_acl_identity_is_rejected_before_transaction(self):
        source, user = self.source()
        acl = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in (
            (1, 6, 0xffffffff), (2, 4, 1001), (4, 0, 0xffffffff),
            (16, 4, 0xffffffff), (32, 0, 0xffffffff)))
        os.setxattr(source / "Documents/document.txt", "system.posix_acl_access", acl)
        with self.assertRaisesRegex(ValueError, "explicit service/user mapping"):
            migration.migrate(source, self.users, user)
        self.assertEqual(list(self.users.iterdir()), [])
        for invalid in (b"", struct.pack("<I", 9), self.acl(8)):
            with self.assertRaises(ValueError):
                migration.validate_acl(invalid, user)

    def test_home_identity_cannot_be_substituted_by_known_root_owner(self):
        source, user = self.source()
        os.chown(source, 0, 0)
        with self.assertRaisesRegex(ValueError, "real private directory"):
            migration.migrate(source, self.users, user)
        self.assertEqual(list(self.users.iterdir()), [])

    def test_default_directory_acl_survives_normalization(self):
        source, user = self.source()
        value = self.acl(4)
        os.setxattr(source / ".config", "system.posix_acl_default", value)
        transaction = migration.migrate(source, self.users, user)
        self.assertEqual(os.getxattr(self.users / "1000/Settings", "system.posix_acl_default"), value)
        self.assertEqual(os.getxattr(transaction / "backup/.config", "system.posix_acl_default"), value)
        self.assertTrue(migration.status(transaction)["backupVerified"])

    def qualified_inputs(self, *, reordered=False):
        source_etc, target_etc = self.legacy / "etc", self.users.parent / "target-etc"
        source_etc.mkdir()
        target_etc.mkdir()
        source_passwd, source_group = identity_tests.SOURCE_PASSWD, identity_tests.SOURCE_GROUP
        target_passwd, target_group = identity_tests.TARGET_PASSWD, identity_tests.TARGET_GROUP
        record = identity_tests.plan()
        if reordered:
            source_passwd += "other:x:111:111:service:/nonexistent:/usr/sbin/nologin\n"
            source_group += "other:x:111:\n"
            target_passwd += "other:x:109:109:service:/nonexistent:/usr/sbin/nologin\n"
            target_group += "other:x:109:\n"
            record["users"].append({"name": "other", "role": "service", "sourceUid": 111, "targetUid": 109})
            record["groups"].append({"name": "other", "role": "service", "sourceGid": 111, "targetGid": 109})
        for directory, passwd, group in ((source_etc, source_passwd, source_group),
                                          (target_etc, target_passwd, target_group)):
            (directory / "passwd").write_text(passwd)
            (directory / "group").write_text(group)
        record["source"] = migration.identity_module.fingerprint(source_passwd, source_group)
        record["target"] = migration.identity_module.fingerprint(target_passwd, target_group)
        plan = self.users.parent / "identity-map.json"
        plan.write_text(json.dumps(record))
        plan.chmod(0o600)
        return {"identity_map": plan, "source_etc": source_etc, "target_etc": target_etc}

    def service_data(self, source):
        file = source / "Documents/service-data"
        file.write_text("qualified service metadata")
        file.chmod(0o600)
        os.chown(file, 110, 110)
        return file

    def service_acl(self):
        return struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in (
            (1, 6, 0xffffffff), (2, 4, 110), (2, 2, 111), (2, 4, 1001),
            (4, 0, 0xffffffff), (8, 4, 110), (8, 2, 111),
            (16, 6, 0xffffffff), (32, 0, 0xffffffff)))

    def test_explicit_identities_rebase_files_and_acls_but_not_private_backup(self):
        source, user = self.source()
        inputs = self.qualified_inputs(reordered=True)
        file = self.service_data(source)
        acl = self.service_acl()
        os.setxattr(file, "system.posix_acl_access", acl)
        os.setxattr(source / ".config", "system.posix_acl_default", acl)
        peer = source / "Documents/peer-data"
        peer.write_text("stable peer owner")
        os.chown(peer, 1001, 1001)
        peer.chmod(0o600)
        mapper = migration.identity_module.IdentityMap(
            json.loads(inputs["identity_map"].read_text()), user)
        before = migration.inventory(source, user, identities=mapper)
        transaction = migration.migrate(source, self.users, user, **inputs)
        destination = self.users / "1000"
        copied = destination / "Documents/service-data"
        self.assertEqual((copied.stat().st_uid, copied.stat().st_gid), (112, 112))
        self.assertEqual((destination / "Documents/peer-data").stat().st_uid, 1001)
        mapped = migration.mapped_acl(acl, mapper)
        self.assertEqual(os.getxattr(copied, "system.posix_acl_access"), mapped)
        self.assertEqual(os.getxattr(destination / "Settings", "system.posix_acl_default"), mapped)
        entries = [struct.unpack_from("<HHI", mapped, offset) for offset in range(4, len(mapped), 8)]
        self.assertEqual([(uid, mode) for tag, mode, uid in entries if tag == 2],
                         [(109, 2), (112, 4), (1001, 4)])
        self.assertEqual([(gid, mode) for tag, mode, gid in entries if tag == 8], [(109, 2), (112, 4)])
        self.assertEqual(migration.inventory(transaction / "backup", user, identities=mapper), before)
        self.assertEqual(migration.inventory(source, user, identities=mapper), before)
        # Status uses the sealed private record, not a later or unavailable source mount.
        inputs["identity_map"].unlink()
        (inputs["source_etc"] / "passwd").unlink()
        self.assertTrue(migration.status(transaction)["publicationVerified"])
        self.assertTrue(migration.status(transaction)["backupVerified"])

    def test_unqualified_mapping_and_stale_target_are_rejected_before_writes(self):
        source, user = self.source()
        self.service_data(source)
        inputs = self.qualified_inputs()
        with self.assertRaisesRegex(ValueError, "both qualified"):
            migration.migrate(source, self.users, user, identity_map=inputs["identity_map"])
        with self.assertRaisesRegex(ValueError, "foreign UID/GID"):
            migration.migrate(source, self.users, user)
        inputs["identity_map"].chmod(0o644)
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            migration.migrate(source, self.users, user, **inputs)
        inputs["identity_map"].chmod(0o600)
        target = inputs["target_etc"] / "passwd"
        target.write_text(target.read_text().replace("worker:x:112:112:", "worker:x:113:112:"))
        with self.assertRaisesRegex(ValueError, "stale"):
            migration.migrate(source, self.users, user, **inputs)
        self.assertEqual(list(self.users.iterdir()), [])

    def test_identity_proof_drift_after_backup_retains_original_before_publication(self):
        source, user = self.source()
        self.service_data(source)
        inputs = self.qualified_inputs()
        original = migration.copy_records

        def drift(*args, **kwargs):
            original(*args, **kwargs)
            if args[1].name == "backup":
                target = inputs["target_etc"] / "group"
                target.write_text(target.read_text().replace("worker:x:112:", "worker:x:113:"))

        with patch.object(migration, "copy_records", side_effect=drift):
            with self.assertRaisesRegex(ValueError, "stale"):
                migration.migrate(source, self.users, user, **inputs)
        self.assertFalse((self.users / "1000").exists())
        transaction, = self.users.glob(".migration-*")
        self.assertTrue(migration.status(transaction)["backupVerified"])
        self.assertEqual(migration.status(transaction)["phase"], "interrupted")
        self.assertEqual((transaction / "backup/Documents/service-data").stat().st_uid, 110)

    def test_identity_proof_drift_after_publication_is_not_silent_success_or_rollback(self):
        source, user = self.source()
        inputs = self.qualified_inputs()
        original = migration.publish

        def drift(stage, destination):
            original(stage, destination)
            inputs["identity_map"].write_text("{}")

        with patch.object(migration, "publish", side_effect=drift):
            with self.assertRaisesRegex(ValueError, "changed during"):
                migration.migrate(source, self.users, user, **inputs)
        transaction, = self.users.glob(".migration-*")
        state = migration.status(transaction)
        self.assertEqual(state["phase"], "interrupted")
        self.assertTrue(state["publicationVerified"])
        self.assertTrue(state["backupVerified"])
        self.assertTrue((self.users / "1000").is_dir())

    def test_public_identity_inputs_are_root_trusted_regular_files_and_exact_bytes(self):
        inputs = self.qualified_inputs()
        file = inputs["target_etc"] / "passwd"
        raw = file.read_bytes().replace(b"\n", b"\r\n")
        file.write_bytes(raw)
        import hashlib
        self.assertEqual(migration.identity_module.fingerprint(migration.public_file(file), "")["passwd"],
                         hashlib.sha256(raw).hexdigest())
        file.chmod(0o666)
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            migration.public_file(file)
        file.unlink()
        file.symlink_to(inputs["source_etc"] / "passwd")
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            migration.public_file(file)

    def test_legacy_schema_three_acls_remain_inspectable_but_cannot_contain_mapping(self):
        source, user = self.source()
        os.setxattr(source / "Documents/document.txt", "system.posix_acl_access", self.acl(4))
        transaction = migration.migrate(source, self.users, user)
        record = json.loads((transaction / "journal.json").read_text())
        record["schemaVersion"] = 3
        migration.journal(transaction, record)
        self.assertTrue(migration.status(transaction)["publicationVerified"])
        self.assertTrue(migration.status(transaction)["backupVerified"])
        record["identities"] = identity_tests.plan()
        migration.journal(transaction, record)
        with self.assertRaisesRegex(ValueError, "schema v4"):
            migration.status(transaction)


if __name__ == "__main__":
    unittest.main()
