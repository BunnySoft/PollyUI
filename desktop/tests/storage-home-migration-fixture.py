#!/usr/bin/env python3
"""Real read-only tmpfs import and numeric-UID isolation; no host devices."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or not Path("/run/.containerenv").exists():
        raise RuntimeError("Home migration fixture requires an isolated root container")
    spec = importlib.util.spec_from_file_location("migration_tests",
        args.repo / "desktop/tests/storage-home-migration.py")
    tests = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tests)
    migration = tests.migration
    subprocess.run(["mount", "--make-rprivate", "/"], check=True, timeout=10)
    with tempfile.TemporaryDirectory(prefix="polly-home-offline-", dir="/run") as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        legacy, users = root / "legacy", root / "Users"
        legacy.mkdir()
        users.mkdir()
        subprocess.run(["mount", "-t", "tmpfs", "-o", "mode=755,nodev,nosuid",
                        "tmpfs", str(legacy)], check=True, timeout=10)
        try:
            factory = tests.Migration()
            factory.legacy = legacy
            factory.users = users
            sources = [factory.source(uid, name)
                       for uid, name in ((0, "root"), (1000, "polly"), (1001, "tester"))]
            qualified = factory.qualified_inputs(reordered=True)
            service = factory.service_data(sources[1][0])
            os.setxattr(service, "system.posix_acl_access", factory.service_acl())
            for source, _ in sources:
                os.link(source / ".config/editor/settings.json", source / "Documents/linked-settings.json")
                access = factory.acl(4)
                os.setxattr(source / "Documents/document.txt", "system.posix_acl_access", access)
                os.setxattr(source / ".config", "system.posix_acl_default", access)
                protected = source / "Documents/root-private"
                protected.write_text("root-owned data is not reassigned to the ordinary user")
                protected.chmod(0o600)
            os.setxattr(sources[1][0] / ".local/state/polly", "system.posix_acl_default", factory.service_acl())
            # A read-only bind over a writable superblock is deliberately insufficient.
            view = root / "view"
            view.mkdir()
            subprocess.run(["mount", "--bind", str(legacy), str(view)], check=True, timeout=10)
            subprocess.run(["mount", "-o", "remount,bind,ro", str(view)], check=True, timeout=10)
            try:
                try:
                    migration.migrate(view / "polly", users, sources[1][1])
                except ValueError as error:
                    if "read-only filesystem" not in str(error):
                        raise
                else:
                    raise RuntimeError("Read-only bind accepted a mutable backing filesystem")
            finally:
                subprocess.run(["umount", str(view)], check=True, timeout=10)
            subprocess.run(["mount", "-o", "remount,ro", str(legacy)], check=True, timeout=10)
            transactions = {}
            entry = root / "polly-migrate-home"
            entry.symlink_to(args.repo / "desktop/release/storage/migrate-home.py")
            inspected = subprocess.run([sys.executable, "-I", "-B", str(entry), "identities",
                "--source-etc", str(qualified["source_etc"]), "--target-etc", str(qualified["target_etc"])],
                check=True, capture_output=True, text=True, timeout=10)
            proof = json.loads(inspected.stdout)
            plan = json.loads(qualified["identity_map"].read_text())
            if proof != {"schemaVersion": 1, "source": plan["source"], "target": plan["target"],
                         "automaticMapping": False}:
                raise RuntimeError("Read-only qualification did not report the exact public input proofs")
            for source, user in sources:
                if user["uid"] == 1001:
                    imported = subprocess.run([sys.executable, "-I", "-B",
                        str(entry), "import",
                        "--source", str(source), "--users", str(users), "--name", user["name"],
                        "--uid", str(user["uid"]), "--gid", str(user["gid"])],
                        check=True, capture_output=True, text=True, timeout=20)
                    transaction = Path(json.loads(imported.stdout)["transaction"])
                elif user["uid"] == 1000:
                    imported = subprocess.run([sys.executable, "-I", "-B", str(entry), "import",
                        "--source", str(source), "--users", str(users), "--name", user["name"],
                        "--uid", str(user["uid"]), "--gid", str(user["gid"]),
                        "--identity-map", str(qualified["identity_map"]),
                        "--source-etc", str(qualified["source_etc"]),
                        "--target-etc", str(qualified["target_etc"])],
                        check=True, capture_output=True, text=True, timeout=20)
                    transaction = Path(json.loads(imported.stdout)["transaction"])
                    mapper = migration.identity_module.IdentityMap(plan, user)
                    copied, saved = users / "1000/Documents/service-data", transaction / "backup/Documents/service-data"
                    if (copied.stat().st_uid, copied.stat().st_gid) != (112, 112) or \
                            (saved.stat().st_uid, saved.stat().st_gid) != (110, 110) or \
                            os.getxattr(copied, "system.posix_acl_access") != migration.mapped_acl(
                                factory.service_acl(), mapper) or \
                            os.getxattr(saved, "system.posix_acl_access") != factory.service_acl():
                        raise RuntimeError("Qualified service ownership/ACL rebase changed the original backup")
                    if os.getxattr(users / "1000/AppState/polly", "system.posix_acl_default") != \
                            migration.mapped_acl(factory.service_acl(), mapper) or \
                            os.getxattr(transaction / "backup/.local/state/polly", "system.posix_acl_default") != \
                            factory.service_acl():
                        raise RuntimeError("Qualified default ACL rebase changed the original backup")
                else:
                    transaction = migration.migrate(source, users, user)
                result = migration.status(transaction)
                if result["phase"] != "committed" or not result["publicationVerified"] or \
                        not result["backupVerified"]:
                    raise RuntimeError("Real offline import did not verify publication and backup")
                transactions[user["uid"]] = transaction
            child = r'''
import os
from pathlib import Path
import sys
home, other, private = map(Path, sys.argv[1:])
uid = os.getuid()
if home.stat().st_uid != uid:
    raise RuntimeError("Imported home changed stable UID")
if uid == 1000:
    service = home / "Documents/service-data"
    if service.stat().st_uid != 112 or service.stat().st_gid != 112:
        raise RuntimeError("Qualified service ownership was not rebased")
    try:
        service.read_text()
    except PermissionError:
        pass
    else:
        raise RuntimeError("Qualified service data was reassigned to the ordinary user")
if (home / "Documents/document.txt").read_text() != "document-" + str(uid):
    raise RuntimeError("Imported document belongs to another user")
if not os.path.samestat((home / "Settings/editor/settings.json").stat(),
                       (home / "Documents/linked-settings.json").stat()):
    raise RuntimeError("Imported settings/document hard-link relationship was lost")
try:
    (home / "Documents/root-private").read_text()
except PermissionError:
    pass
else:
    raise RuntimeError("Root-owned home data was reassigned or made readable")
if not os.getxattr(home / "Documents/document.txt", "system.posix_acl_access"):
    raise RuntimeError("Imported document POSIX ACL was lost")
if not os.getxattr(home / "Settings", "system.posix_acl_default"):
    raise RuntimeError("Normalized settings directory default ACL was lost")
for name in ("Settings", "AppData", "AppState", "Cache", "Documents"):
    (home / name / "post-import").write_text("ordinary UID " + str(uid))
if not os.path.samestat((home / ".config").stat(), (home / "Settings").stat()):
    raise RuntimeError("Imported legacy alias does not use the product directory")
for path in (other, home.parent / "0", private):
    try:
        list(path.iterdir())
    except PermissionError:
        pass
    else:
        raise RuntimeError("Imported HOME or migration backup leaked across UIDs")
'''
            for uid, other in ((1000, 1001), (1001, 1000)):
                subprocess.run([sys.executable, "-I", "-B", "-c", child,
                                str(users / str(uid)), str(users / str(other)),
                                str(transactions[uid])],
                               user=uid, group=uid, extra_groups=[], check=True, timeout=10)
            rejected = subprocess.run([sys.executable, "-I", "-B",
                str(args.repo / "desktop/release/storage/migrate-home.py"), "status",
                "--transaction", str(transactions[1000])],
                user=1000, group=1000, extra_groups=[], capture_output=True, text=True, timeout=10)
            if rejected.returncode == 0 or "requires root authorization" not in rejected.stderr:
                raise RuntimeError("Ordinary caller obtained privileged migration inspection")
            denied = subprocess.run([sys.executable, "-I", "-B",
                str(args.repo / "desktop/release/storage/migrate-home.py"), "import",
                "--source", str(sources[1][0]), "--users", str(users), "--name", "polly",
                "--uid", "1000", "--gid", "1000"],
                user=1000, group=1000, extra_groups=[], capture_output=True, text=True, timeout=10)
            if denied.returncode == 0 or "requires root authorization" not in denied.stderr:
                raise RuntimeError("Ordinary caller obtained privileged migration writes")
            denied = subprocess.run([sys.executable, "-I", "-B", str(entry), "identities",
                "--source-etc", str(qualified["source_etc"]), "--target-etc", str(qualified["target_etc"])],
                user=1000, group=1000, extra_groups=[], capture_output=True, text=True, timeout=10)
            if denied.returncode == 0 or "requires root authorization" not in denied.stderr:
                raise RuntimeError("Ordinary caller obtained privileged identity qualification")
            print("PASS: read-only filesystem import, mutable-bind refusal, root/two-UID data "
                  "and private backup isolation; qualified service ownership/ACL rebase")
        finally:
            subprocess.run(["umount", str(legacy)], check=True, timeout=10)


if __name__ == "__main__":
    main()
