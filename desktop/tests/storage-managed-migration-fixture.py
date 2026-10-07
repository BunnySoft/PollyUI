#!/usr/bin/env python3
"""Migrate actual per-user managed app data with cached binaries, no VM or rebuild."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("manager", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or not Path("/run/.containerenv").exists():
        raise RuntimeError("Managed migration fixture requires an isolated root container")
    if not args.manager.is_file() or not os.access(args.manager, os.X_OK) or \
            not os.access(args.manager.with_name("pollyui"), os.X_OK):
        raise RuntimeError("Cached native manager/runtime are missing; no implicit rebuild")
    if args.report and (args.report.exists() or args.report.is_symlink()):
        raise RuntimeError("Refusing to overwrite managed migration evidence")
    spec = importlib.util.spec_from_file_location("migration_tests",
        args.repo / "desktop/tests/storage-home-migration.py")
    tests = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tests)
    migration = tests.migration
    subprocess.run(["mount", "--make-rprivate", "/"], check=True, timeout=10)
    with tempfile.TemporaryDirectory(prefix="polly-managed-import-", dir="/run") as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        legacy, users, compatible = root / "legacy", root / "Users", root / "home"
        for directory in (legacy, users, compatible):
            directory.mkdir(mode=0o755)
        subprocess.run(["mount", "-t", "tmpfs", "-o", "mode=755,nodev,nosuid",
                        "tmpfs", str(legacy)], check=True, timeout=10)
        bound = []
        try:
            factory = tests.Migration()
            factory.legacy = legacy
            sources = [factory.source(uid, name) for uid, name in ((1000, "polly"), (1001, "tester"))]
            manifest = {"schemaVersion": 1, "id": "org.example.persistence", "name": "Migration probe",
                        "version": "1.0.0", "target": {"os": "linux", "architecture": "x86_64", "libc": "glibc"},
                        "launch": {"kind": "pollyui", "entry": "main.mjs", "arguments": ["appdata"]},
                        "data": {"layout": "pollyui", "schema": 1}}
            script = (args.repo / "desktop/tests/persistent-storage.mjs").read_text()

            def environment(home, product):
                names = migration.homes.layout.XDG_DIRECTORIES if product else {
                    "XDG_CONFIG_HOME": ".config", "XDG_DATA_HOME": ".local/share",
                    "XDG_STATE_HOME": ".local/state", "XDG_CACHE_HOME": ".cache"}
                env = dict(os.environ, HOME=str(home), SDL_VIDEODRIVER="dummy",
                           SDL_RENDER_DRIVER="software", PU_RENDERER="raster")
                env.update({key: str(home / name) for key, name in names.items()})
                return env

            def run(user, env, *arguments):
                result = subprocess.run([str(args.manager), *map(str, arguments)],
                    env=env, user=user["uid"], group=user["gid"], extra_groups=[],
                    capture_output=True, text=True, timeout=30)
                output = result.stdout + result.stderr
                if result.returncode != 0 or any(marker in output for marker in
                        ("Uncaught", "FAIL:", "AddressSanitizer", "runtime error:")):
                    raise RuntimeError("Ordinary managed app probe failed:\n" + output)
                return result.stdout

            records = {}
            for source, user in sources:
                package = root / (user["name"] + ".app")
                package.mkdir(mode=0o700)
                (package / "manifest.json").write_text(json.dumps(manifest))
                (package / "main.mjs").write_text(script)
                for file in package.iterdir():
                    file.chmod(0o600)
                    os.chown(file, user["uid"], user["gid"])
                os.chown(package, user["uid"], user["gid"])
                env = environment(source, False)
                installed = run(user, env, "install", package).split()
                if len(installed) != 2 or len(installed[1]) != 64:
                    raise RuntimeError("Manager did not report the installed content digest")
                digest = installed[1]
                if "POLLY_APPDATA_PASS 1" not in run(user, env, "run", manifest["id"], digest):
                    raise RuntimeError("Legacy managed app did not create its independent data")
                inventory = migration.inventory(source, user)
                records[user["uid"]] = (digest, inventory)
            subprocess.run(["mount", "-o", "remount,ro", str(legacy)], check=True, timeout=10)
            for source, user in sources:
                transaction = migration.migrate(source, users, user)
                if not migration.status(transaction)["publicationVerified"]:
                    raise RuntimeError("Actual managed home import did not verify")
                home = compatible / user["name"]
                home.mkdir()
                subprocess.run(["mount", "--bind", str(users / str(user["uid"])), str(home)],
                               check=True, timeout=10)
                bound.append(home)
                if not os.path.samestat(home.stat(), (users / str(user["uid"])).stat()):
                    raise RuntimeError("Migrated managed app HOME is not the stable UID home")
                env = environment(home, True)
                registered = json.loads(run(user, env, "list"))
                digest, before = records[user["uid"]]
                if len(registered) != 1 or registered[0]["current"]["digest"] != digest or \
                        registered[0]["current"]["manifest"]["id"] != manifest["id"]:
                    raise RuntimeError("Per-user imported app identity or code digest changed")
                if "POLLY_APPDATA_PASS 2" not in run(user, env, "run", manifest["id"], digest):
                    raise RuntimeError("Actual managed app data was reset or mixed across users")
                if migration.inventory(source, user) != before or \
                        migration.inventory(transaction / "backup", user) != before:
                    raise RuntimeError("Managed app launch changed the source or private backup")
                print(f"PASS: UID {user['uid']} managed app identity/code unchanged; "
                      "localStorage continues 1->2 after HOME/XDG migration", flush=True)
            if (root / "Apps").exists() or (root / "SystemData/Apps").exists():
                raise RuntimeError("Private data import unexpectedly registered shared apps")
            if args.report:
                report = {
                    "schemaVersion": 1, "migrationSchemaVersion": migration.SCHEMA_VERSION,
                    "fixture": "readonly-tmpfs-cached-native-managed-app",
                    "ordinaryUserUids": [1000, 1001], "appId": manifest["id"],
                    "perUserLaunchCounts": {"before": 1, "after": 2},
                    "sourceAndPrivateBackupUnchanged": True,
                    "compatibilityHomeBindsVerified": True, "sharedRegistryCreated": False,
                    "nativeManagerSha256": migration.digest_file(args.manager),
                    "nativeRuntimeSha256": migration.digest_file(args.manager.with_name("pollyui")),
                    "sourceSha256": {name: migration.digest_file(args.repo / name) for name in (
                        "desktop/release/storage/layout.py", "desktop/release/storage/homes.py",
                        "desktop/release/storage/migrate-home.py",
                        "desktop/tests/storage-managed-migration-fixture.py",
                        "desktop/tests/persistent-storage.mjs")},
                    "limits": ["No account/password migration or second-user PAM acceptance",
                               "No migrated image cold boot or ext4 power-loss durability",
                               "No shared-app authorization/registry migration",
                               "Cached native binaries; no compile or image build"] }
                with args.report.open("x", encoding="utf8", newline="\n") as output:
                    os.fchmod(output.fileno(), 0o600)
                    json.dump(report, output, indent=2, sort_keys=True)
                    output.write("\n")
                    output.flush()
                    os.fsync(output.fileno())
                migration.sync_directory(args.report.parent)
        finally:
            for home in reversed(bound):
                subprocess.run(["umount", str(home)], check=True, timeout=10)
            subprocess.run(["umount", str(legacy)], check=True, timeout=10)


if __name__ == "__main__":
    main()
