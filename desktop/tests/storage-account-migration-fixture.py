#!/usr/bin/env python3
"""Real private account import/PAM in a disposable container, not ext4 boot evidence."""
import argparse
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from unittest.mock import patch


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or not Path("/run/.containerenv").exists():
        raise RuntimeError("Account migration fixture requires a disposable root container")
    importer = load("account_import", args.repo / "desktop/release/storage/migrate-accounts.py")
    auth = load("account_auth", args.repo / "desktop/tests/account-auth-fixture.py")
    accounts = importer.accounts
    subprocess.run(["mount", "--make-rprivate", "/"], check=True, timeout=10)
    passwd = Path("/etc/passwd")
    accounts.atomic(passwd, re.sub(r"^(polly:[^\n]*:)/[^:\n]+$",
                    r"\1/usr/bin/polly-installed-session", passwd.read_text(), flags=re.M))
    shells = Path("/etc/shells")
    accounts.atomic(shells, shells.read_text() + "/usr/bin/polly-installed-session\n")
    runtime = auth.seed_container(args.repo)
    first, latest, root_first, root_latest = [auth.password() for _ in range(4)]
    auth.success(["/usr/sbin/polly-accounts", "setup"], [first, first, root_first, root_first])
    auth.success(["/usr/bin/passwd"], [first, latest, latest], 1000)
    auth.success(["/usr/bin/passwd", "root"], [root_latest, root_latest])
    auth.success(["/usr/sbin/polly-accounts", "autologin", "on"])
    source = runtime.DATA
    old_gid = accounts.grp.getgrnam("shadow").gr_gid
    before = importer.inventory(source, old_gid)
    for target in (Path("/var/lib/extrausers"), runtime.ROOT):
        subprocess.run(["umount", str(target)], check=True, timeout=10)
    subprocess.run(["mount", "-o", "remount,ro", "/home"], check=True, timeout=10)
    try:
        with ExitStack() as resources:
            temporary = resources.enter_context(tempfile.TemporaryDirectory(
                prefix="polly-account-offline-", dir="/run"))
            root = Path(temporary)
            root.chmod(0o755)
            system, persistent = root / "system", root / "persistent"
            for path in (system, persistent):
                path.mkdir()
                subprocess.run(["mount", "-t", "tmpfs", "-o", "mode=755,nodev,nosuid",
                                "tmpfs", str(path)], check=True, timeout=10)
                resources.callback(subprocess.run, ["umount", str(path)], check=True, timeout=10)
            (system / "etc").mkdir()
            (persistent / "SystemData").mkdir()
            passwd_text = passwd.read_text()
            group_text = Path("/etc/group").read_text()
            used = {int(line.split(":")[2]) for line in group_text.splitlines()}
            new_gid = next(value for value in range(500, 1000) if value not in used)
            target_group = re.sub(r"^shadow:x:[0-9]+:", "shadow:x:" + str(new_gid) + ":",
                                  group_text, flags=re.M)
            volumes = {"EFI": "1234-ABCD", "SYSTEM": "10000000-0000-4000-8000-000000000002",
                       "PERSISTENT": "10000000-0000-4000-8000-000000000003",
                       "RECOVERY": "10000000-0000-4000-8000-000000000004"}
            for name, text in (("passwd", passwd_text), ("group", target_group),
                               ("polly-storage.json", json.dumps(importer.migration.homes.layout.contract(volumes)))):
                accounts.atomic(system / "etc" / name, text)

            def fixture_volume(path, expected, *, readonly, persistent=False):
                record = subprocess.run(["findmnt", "-rn", "-T", str(path), "-o",
                                         "FSTYPE,VFS-OPTIONS,FS-OPTIONS"],
                                        check=True, capture_output=True, text=True, timeout=10).stdout.split()
                wanted = "ro" if readonly else "rw"
                if len(record) != 3 or record[0] != "tmpfs" or \
                        any(wanted not in flags.split(",") for flags in record[1:]) or \
                        (persistent and not {"nodev", "nosuid"}.issubset(record[1].split(","))):
                    raise RuntimeError("Fixture volume did not have the required actual mount policy")
                if not expected:
                    raise RuntimeError("Fixture qualification omitted the expected UUID")

            # Only UUID/ext4 is adapted for tmpfs; source readonly and transaction checks stay real.
            with patch.object(importer, "volume", side_effect=fixture_volume):
                transaction = importer.migrate(source, system, persistent)
            result = importer.status(transaction)
            if not all(result[key] for key in ("backupVerified", "publicationVerified")) or \
                    result["phase"] != "committed":
                raise RuntimeError("Private account publication and backup did not verify")
            destination = persistent / "SystemData/Accounts"
            if accounts.read(source / "etc/shadow", secret=True) != \
                    accounts.read(destination / "etc/shadow", secret=True) or \
                    (destination / "etc/shadow").stat().st_gid != new_gid:
                raise RuntimeError("Private credential bytes or explicit target shadow group changed")
            if importer.inventory(source, old_gid) != before or \
                    importer.inventory(transaction / "backup", old_gid) != before:
                raise RuntimeError("Original account authority or private backup changed")
            entry = root / "polly-migrate-accounts"
            entry.symlink_to(args.repo / "desktop/release/storage/migrate-accounts.py")
            inspected = subprocess.run([sys.executable, "-I", "-B", str(entry), "status",
                "--transaction", str(transaction)], check=True, capture_output=True, text=True, timeout=10)
            if json.loads(inspected.stdout) != result or "$" in inspected.stdout:
                raise RuntimeError("Migration CLI disclosed credentials or disagreed with private status")
            denied = subprocess.run([sys.executable, "-I", "-B", str(entry), "status",
                "--transaction", str(transaction)], user=1000, group=1000, extra_groups=[],
                capture_output=True, text=True, timeout=10)
            if denied.returncode == 0 or "POLLY_ACCOUNT_MIGRATION_FAILED" not in denied.stderr:
                raise RuntimeError("Ordinary user obtained private account migration access")
            production = subprocess.run([sys.executable, "-I", "-B", str(entry), "import",
                "--source", str(source), "--target-root", str(system), "--persistent", str(persistent)],
                capture_output=True, text=True, timeout=10)
            if production.returncode == 0:
                raise RuntimeError("Production account import accepted tmpfs instead of qualified ext4")
            accounts.atomic(Path("/etc/group"), target_group)
            accounts.bind(destination, runtime.ROOT)
            resources.callback(subprocess.run, ["umount", str(runtime.ROOT)], check=True, timeout=10)
            accounts.bind(destination / "etc", Path("/var/lib/extrausers"))
            resources.callback(subprocess.run, ["umount", "/var/lib/extrausers"], check=True, timeout=10)
            accounts.atomic(runtime.RUNTIME / "ready", volumes["PERSISTENT"] + "\n", 0o600)
            accounts.atomic(runtime.RUNTIME / "automatic-login", "on\n", 0o600)
            # Fixture-only volume discovery: actual bind/config/ready/NSS/PAM/password guards remain.
            code = (args.repo / "desktop/release/install/accounts.py").read_text()
            adapter = ("\ndef backing_store():\n"
                       "    return (Path(" + repr(str(destination)) + "), Path(" + repr(str(persistent)) +
                       "), " + repr(volumes["PERSISTENT"]) + ", 3)\n\n")
            accounts.atomic(Path("/usr/sbin/polly-accounts"),
                            code.replace('if __name__ == "__main__":', adapter + 'if __name__ == "__main__":'), 0o755)
            auth.success(["/usr/sbin/polly-accounts", "check"])
            auth.success(["/usr/sbin/polly-accounts", "setup"])
            auth.root_su(root_first, False)
            auth.root_su(root_latest)

            def polly_login(token, expected):
                result, output = auth.interactive(
                    ["/usr/bin/su", "polly", "-s", "/bin/sh", "-c", "/usr/bin/id -u"], [token], 1000)
                accepted = result == 0 and re.search(rb"(?:^|[\r\n])1000(?:[\r\n]|$)", output) is not None
                if accepted != expected:
                    raise RuntimeError("Migrated user PAM password acceptance changed")

            polly_login(first, False)
            polly_login(latest, True)
            changed = auth.password()
            auth.success(["/usr/bin/passwd"], [latest, changed, changed], 1000)
            polly_login(latest, False)
            polly_login(changed, True)
            denied = subprocess.run(["/usr/bin/getent", "shadow", "polly"], user=1000, group=1000,
                extra_groups=[], capture_output=True, text=True, timeout=10)
            if "$6$" in denied.stdout or "$y$" in denied.stdout:
                raise RuntimeError("Ordinary user read imported private password records")
            if not accounts.config(destination)["automaticLogin"] or not accounts.completed(destination) or \
                    importer.inventory(source, old_gid) != before or \
                    not importer.status(transaction)["backupVerified"]:
                raise RuntimeError("Post-migration password management lost policy or modified original backup")
            print("PASS: real readonly private account import; shadow group rebase; latest PAM/su passwords "
                  "retained and old passwords refused; standard passwd updates the new authority; "
                  "setup/autologin retained; source/backup/private credential isolation")
            print("LIMIT: tmpfs fixture adapts only volume discovery; no ext4 UUID/durability, full storage "
                  "boot, second-user lifecycle or migrated-image acceptance")
    finally:
        subprocess.run(["umount", "/home"], check=True, timeout=10)


if __name__ == "__main__":
    main()
