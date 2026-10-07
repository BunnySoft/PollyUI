#!/usr/bin/python3 -I
"""Root-only offline account import; preserves credentials, never resets setup."""
import argparse
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import sys
import uuid


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


migration = load("polly_account_migration_io", Path(__file__).resolve().with_name("migrate-home.py"))
source_tool = Path(__file__).resolve().parents[1] / "install/accounts.py"
accounts = load("polly_account_state", source_tool if source_tool.is_file() else Path("/usr/sbin/polly-accounts"))
identities = migration.identity_module
SCHEMA_VERSION = 1
AUTHORITY_FILES = {"config.json", "etc/passwd", "etc/shadow", "etc/group", "etc/nsswitch.conf"}
OPTIONAL_FILES = {"setup-complete", ".state.lock", "etc/.pwd.lock", "etc/passwd-",
                  "etc/shadow-", "etc/group-", "etc/login.defs", "roles.json"}
EMPTY_DIRECTORIES = {"usr", "dev", "lib", "lib64", "bin", "sbin", "etc/pam.d"}
TOOL_LINKS = {"lib": "usr/lib", "lib64": "usr/lib64", "bin": "usr/bin", "sbin": "usr/sbin"}
NSS_POLICY = "passwd: files\ngroup: files\nshadow: files\n"


class AccountMetadata:
    def __init__(self, shadow_gid):
        self.shadow_gid = shadow_gid

    def allowed(self, kind, side):
        if kind not in {"uid", "gid"} or side not in {"source", "target"}:
            raise ValueError("Invalid account metadata selector")
        return {0} if kind == "uid" else {0, 1000, self.shadow_gid}


def inventory(root, gid):
    return migration.inventory(root, {"uid": 0, "gid": gid}, identities=AccountMetadata(gid))


def volume(path, expected, *, readonly, persistent=False):
    record = subprocess.run(["findmnt", "-rn", "-T", str(path), "-o",
                             "UUID,FSTYPE,VFS-OPTIONS,FS-OPTIONS"],
                            check=True, capture_output=True, text=True, timeout=10).stdout.split()
    flag = "ro" if readonly else "rw"
    if len(record) != 4 or record[:2] != [expected, "ext4"] or \
            any(flag not in item.split(",") for item in record[2:]) or \
            (persistent and not {"nodev", "nosuid"}.issubset(record[2].split(","))) or \
            (not readonly and not persistent and
             {"nosuid", "noexec"}.intersection(record[2].split(","))):
        raise ValueError("Account migration requires the matching offline ext4 volume and mount policy")


def shadow_group(text, *, persistent=False):
    table = identities.database(text, "group")
    if table.get("polly") != {"id": 1000} or "shadow" not in table or \
            not 0 < table["shadow"]["id"] < 1000:
        raise ValueError("Account migration requires fixed root/polly and a qualified shadow group")
    if (persistent and set(table) != {"root", "polly", "shadow"}) or any(
            line.split(":")[3] for line in text.splitlines()
            if line.split(":")[0] in {"root", "polly", "shadow"}):
        raise ValueError("Persistent group authority has unsupported identities or memberships")
    return table["shadow"]["id"]


def public_accounts(text, *, persistent=False):
    table = identities.database(text, "passwd")
    accounts.identities(text)
    if persistent and set(table) != {"root", "polly"}:
        raise ValueError("Additional persistent accounts need an explicit account migration adapter")
    selected = {}
    for line in text.splitlines():
        fields = line.split(":")
        if fields[0] not in {"root", "polly"}:
            continue
        name = fields[0]
        expected_home = "/root" if name == "root" else "/home/polly"
        allowed_shells = {"/bin/bash", "/bin/sh"} if name == "root" else {"/usr/bin/polly-installed-session"}
        if fields[5] != expected_home or fields[6] not in allowed_shells:
            raise ValueError("Unsupported managed account HOME or login shell")
        selected[name] = line
    return selected["root"] + "\n" + selected["polly"] + "\n"


def qualified_target(root, persistent):
    migration.trusted_path(root)
    migration.trusted_path(persistent)
    manifest_text = migration.public_file(root / "etc/polly-storage.json")
    contract = migration.homes.layout.validate(identities.load_record(manifest_text))
    if contract["users"] != list(migration.homes.layout.DEFAULT_USERS):
        raise ValueError("Additional persistent users require account lifecycle support")
    target_uuid = next(item["uuid"] for item in contract["volumes"] if item["role"] == "PERSISTENT")
    system_uuid = next(item["uuid"] for item in contract["volumes"] if item["role"] == "SYSTEM")
    volume(root, system_uuid, readonly=False)
    volume(persistent, target_uuid, readonly=False, persistent=True)
    passwd = migration.public_file(root / "etc/passwd")
    group = migration.public_file(root / "etc/group")
    if (root / "etc").stat().st_dev != root.stat().st_dev:
        raise ValueError("Target account qualification is on another system filesystem")
    selected = public_accounts(passwd)
    gid = shadow_group(group)
    system_data = persistent / "SystemData"
    migration.trusted_path(system_data)
    if system_data.stat().st_dev != persistent.stat().st_dev:
        raise ValueError("Target SystemData is on a different filesystem")
    return {"persistentUuid": target_uuid, "shadowGid": gid, "passwd": selected,
            "group": "root:x:0:\npolly:x:1000:\nshadow:x:" + str(gid) + ":\n",
            "proof": {"manifest": migration.hashlib.sha256(manifest_text.encode()).hexdigest(),
                      **identities.fingerprint(passwd, group)}}


def source_snapshot(source):
    migration.trusted_path(source)
    migration.trusted_path(source / "etc")
    migration.readonly_source(source)
    settings = accounts.parse_config(json.dumps(identities.load_record(
        migration.public_file(source / "config.json"))))
    if settings["schemaVersion"] != 2:
        raise ValueError("Only historical account schema v2 is supported as a migration source")
    volume(source, settings["homeUuid"], readonly=True)
    public_accounts(migration.public_file(source / "etc/passwd"), persistent=True)
    gid = shadow_group(migration.public_file(source / "etc/group"), persistent=True)
    records = accounts.passwords(source, shadow_gid=gid)
    for fields in records.values():
        token = fields[1]
        if not re.fullmatch(r"(?:!\*|!!?|\*|!?\$(?:y|6)\$[^\s:]{1,500})", token) or \
                any(not re.fullmatch(r"(?:|-1|[0-9]{1,10})", field) for field in fields[2:8]) or fields[8]:
            raise ValueError("Unsupported private password record; credentials withheld")
    initialized = accounts.completed(source)
    if (source / "roles.json").exists() or (source / "roles.json").is_symlink():
        accounts.administrator_policy(source)
    if settings["automaticLogin"] and not initialized:
        raise ValueError("Uninitialized accounts cannot request automatic login")
    required = {".", "etc", *AUTHORITY_FILES}
    seen = set()

    def inspect(path):
        name = path.relative_to(source).as_posix()
        info = path.lstat()
        seen.add(name)
        if len(seen) > 40 or info.st_dev != source.stat().st_dev or info.st_uid != 0 or \
                info.st_gid not in {0, 1000, gid} or \
                (not stat.S_ISLNK(info.st_mode) and stat.S_IMODE(info.st_mode) & 0o022) or \
                info.st_mode & (stat.S_ISUID | stat.S_ISGID) or \
                os.listxattr(path, follow_symlinks=False):
            raise ValueError("Unsupported or unsafe private account migration metadata")
        if name in {".", "etc"}:
            if not stat.S_ISDIR(info.st_mode) or info.st_gid != 0:
                raise ValueError("Account authority must use real root-owned directories")
            for child in sorted(path.iterdir()):
                inspect(child)
        elif name in EMPTY_DIRECTORIES and stat.S_ISDIR(info.st_mode):
            if any(path.iterdir()):
                raise ValueError("Live password-tool mounts or unclassified account data remain")
        elif name in TOOL_LINKS and stat.S_ISLNK(info.st_mode):
            if os.readlink(path) != TOOL_LINKS[name] or info.st_nlink != 1:
                raise ValueError("Unsupported password-tool compatibility link")
        elif name in AUTHORITY_FILES | OPTIONAL_FILES:
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 16384:
                raise ValueError("Unsupported private account migration file")
            if name in {"etc/shadow", "etc/shadow-"} and info.st_mode & 0o007:
                raise ValueError("Private password records are world-accessible")
            if name in AUTHORITY_FILES | {"setup-complete", "roles.json"} and \
                    info.st_gid != (gid if name == "etc/shadow" else 0):
                raise ValueError("Account authority has an unqualified group identity")
            if name == ".state.lock" and stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError("Invalid account state lock metadata")
            if name in {".state.lock", "etc/.pwd.lock", "etc/login.defs"} and info.st_size:
                raise ValueError("Unclassified password-tool state")
        else:
            raise ValueError("Unclassified account state requires an explicit adapter")

    inspect(source)
    if not required.issubset(seen) or accounts.read(source / "etc/nsswitch.conf") != NSS_POLICY:
        raise ValueError("Incomplete account authority or unsupported private NSS policy")
    return settings, gid, inventory(source, gid)


def write_stage(stage, backup, settings, target):
    stage.chmod(0o755)
    (stage / "etc").mkdir(mode=0o755)
    converted = {"schemaVersion": 3, "persistentUuid": target["persistentUuid"],
                 "initialized": settings["initialized"], "automaticLogin": settings["automaticLogin"]}
    accounts.atomic(stage / "config.json", json.dumps(converted, sort_keys=True) + "\n")
    for name, text in (("passwd", target["passwd"]), ("group", target["group"]), ("nsswitch.conf", NSS_POLICY)):
        accounts.atomic(stage / "etc" / name, text)
    accounts.atomic(stage / "etc/shadow", accounts.read(backup / "etc/shadow", secret=True), 0o640)
    os.chown(stage / "etc/shadow", 0, target["shadowGid"])
    if (backup / "roles.json").exists():
        accounts.atomic(stage / "roles.json", accounts.read(backup / "roles.json", secret=True), 0o600)
        accounts.administrator_policy(stage)
    if settings["initialized"]:
        accounts.atomic(stage / "setup-complete", "1\n")
    accounts.state_volume(accounts.config(stage), target["persistentUuid"], 3)
    if accounts.read(stage / "etc/shadow", secret=True) != accounts.read(backup / "etc/shadow", secret=True) or \
            accounts.completed(stage) != settings["initialized"]:
        raise ValueError("Private credential or initialization preservation failed")
    accounts.passwords(stage, shadow_gid=target["shadowGid"])
    migration.sync_tree(stage)


def migrate(source, target_root, persistent):
    if os.geteuid() != 0:
        raise PermissionError("Offline account migration requires root authorization")
    target = qualified_target(target_root, persistent)
    if source.is_relative_to(persistent) or persistent.is_relative_to(source) or \
            source.is_relative_to(target_root) or target_root.is_relative_to(source):
        raise ValueError("Source and target account/system trees must be disjoint")
    settings, source_gid, before = source_snapshot(source)
    destination = persistent / "SystemData/Accounts"
    if destination.exists() or destination.is_symlink():
        raise FileExistsError("Target Accounts already exists; no replacement, reset or implicit merge")
    transaction = destination.parent / (".accounts-migration-" + uuid.uuid4().hex)
    transaction.mkdir(mode=0o700)
    transaction.chmod(0o700)
    migration.sync_directory(transaction.parent)
    record = {"schemaVersion": SCHEMA_VERSION, "phase": "planned", "sourceShadowGid": source_gid,
              "targetShadowGid": target["shadowGid"], "sourceSha256": migration.checksum(before),
              "targetProof": target["proof"], "sourceHomeUuid": settings["homeUuid"],
              "persistentUuid": target["persistentUuid"], "initialized": settings["initialized"],
              "automaticLogin": settings["automaticLogin"]}
    migration.journal(transaction, record)
    try:
        backup = transaction / "backup"
        backup.mkdir(mode=0o700)
        migration.copy_records(source, backup, before, {name: name for name in before})
        migration.sync_tree(backup)
        if inventory(backup, source_gid) != before or \
                source_snapshot(source) != (settings, source_gid, before):
            raise ValueError("Original private account backup verification failed")
        record["phase"] = "backed-up"
        migration.journal(transaction, record)
        stage = transaction / "accounts"
        stage.mkdir(mode=0o700)
        write_stage(stage, backup, settings, target)
        record.update(phase="verified", destinationSha256=migration.checksum(
            inventory(stage, target["shadowGid"])))
        migration.journal(transaction, record)
        if qualified_target(target_root, persistent) != target or \
                source_snapshot(source) != (settings, source_gid, before):
            raise ValueError("Account source or target qualification changed before publication")
        record["phase"] = "committing"
        migration.journal(transaction, record)
        migration.publish(stage, destination)
        migration.sync_directory(transaction.parent)
        migration.sync_directory(transaction)
        if qualified_target(target_root, persistent) != target:
            raise ValueError("Target qualification changed after account publication; transaction retained")
        if migration.checksum(inventory(destination, target["shadowGid"])) != record["destinationSha256"]:
            raise ValueError("Published private account verification failed")
        record["phase"] = "committed"
        migration.journal(transaction, record)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        record.update(failedPhase=record["phase"], phase="interrupted", errorType=type(error).__name__)
        migration.journal(transaction, record)
        raise
    return transaction


def status(transaction):
    if os.geteuid() != 0:
        raise PermissionError("Account migration inspection requires root authorization")
    migration.trusted_path(transaction, private=True)
    record = identities.load_record(migration.public_file(transaction / "journal.json", private=True))
    required = {"schemaVersion", "phase", "sourceShadowGid", "targetShadowGid", "sourceSha256",
                "targetProof", "sourceHomeUuid", "persistentUuid", "initialized", "automaticLogin"}
    optional = {"destinationSha256", "failedPhase", "errorType"}
    if not isinstance(record, dict) or type(record.get("schemaVersion")) is not int or \
            not required.issubset(record) or not set(record).issubset(required | optional) or \
            record["schemaVersion"] != SCHEMA_VERSION or record.get("phase") not in {
                "planned", "backed-up", "verified", "committing", "committed", "interrupted"} or \
            any(type(record.get(key)) is not int or not 0 < record[key] < 1000
                for key in ("sourceShadowGid", "targetShadowGid")):
        raise ValueError("Unsupported private account migration journal")
    for name in ("sourceSha256", "destinationSha256"):
        if name in record and (not isinstance(record[name], str) or not re.fullmatch(r"[0-9a-f]{64}", record[name])):
            raise ValueError("Invalid private account transaction checksum")
    if not isinstance(record["targetProof"], dict) or set(record["targetProof"]) != {"manifest", "passwd", "group"} or \
            any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
                for value in record["targetProof"].values()):
        raise ValueError("Invalid private account target qualification")
    accounts.parse_config(json.dumps({"schemaVersion": 2, "homeUuid": record["sourceHomeUuid"],
        "initialized": record["initialized"], "automaticLogin": record["automaticLogin"]}))
    accounts.parse_config(json.dumps({"schemaVersion": 3, "persistentUuid": record["persistentUuid"],
        "initialized": record["initialized"], "automaticLogin": record["automaticLogin"]}))
    if (record["automaticLogin"] and not record["initialized"]) or \
            (record["phase"] == "interrupted" and record.get("failedPhase") not in
             {"planned", "backed-up", "verified", "committing", "committed"}) or \
            (record.get("failedPhase", record["phase"]) in {"verified", "committing", "committed"}
             and "destinationSha256" not in record):
        raise ValueError("Invalid private account transaction phase")
    backup, destination = transaction / "backup", transaction.parent / "Accounts"
    backed_up = record.get("failedPhase", record["phase"]) in {
        "backed-up", "verified", "committing", "committed"}
    retained = backup.exists() and stat.S_ISDIR(backup.lstat().st_mode)
    verified = backed_up and retained and migration.checksum(
        inventory(backup, record["sourceShadowGid"])) == record["sourceSha256"]
    if backed_up and not verified:
        raise ValueError("Private account backup is missing or corrupted")
    published = destination.exists() and "destinationSha256" in record and migration.checksum(
        inventory(destination, record["targetShadowGid"])) == record["destinationSha256"]
    return {"schemaVersion": SCHEMA_VERSION, "phase": record["phase"], "backupRetained": retained,
            "backupVerified": verified, "publicationVerified": published,
            "automaticResume": False, "credentialsDisclosed": False}


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import")
    importer.add_argument("--source", type=Path, required=True)
    importer.add_argument("--target-root", type=Path, required=True)
    importer.add_argument("--persistent", type=Path, required=True)
    inspector = commands.add_parser("status")
    inspector.add_argument("--transaction", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "import":
            transaction = migrate(args.source, args.target_root, args.persistent)
            print(json.dumps({"transaction": str(transaction), **status(transaction)}, sort_keys=True))
        else:
            print(json.dumps(status(args.transaction), sort_keys=True))
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError):
        # Inputs may contain credentials: never echo parser errors or exception text.
        print("POLLY_ACCOUNT_MIGRATION_FAILED: input, qualification or transaction failure; "
              "credentials withheld; retain source and any private transaction for inspection", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
