#!/usr/bin/python3 -I
"""Explicit offline HOME import; source and private backup are never removed."""
import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

spec = importlib.util.spec_from_file_location("polly_migration_homes",
                                            Path(__file__).resolve().with_name("homes.py"))
homes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(homes)
SCHEMA_VERSION = 1


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def trusted_path(path, *, private=False):
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("An absolute, non-traversing path is required")
    for ancestor in (*reversed(path.parents), path):
        info = ancestor.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or \
                stat.S_IMODE(info.st_mode) & 0o022:
            raise ValueError("Migration parents must be real root-owned, non-writable directories")
    if private and stat.S_IMODE(path.stat().st_mode) != 0o700:
        raise ValueError("Migration transaction directory must be private")


def readonly_source(source):
    mounted = subprocess.run(["findmnt", "-rn", "-T", str(source), "-o", "VFS-OPTIONS,FS-OPTIONS"],
                             check=True, capture_output=True, text=True, timeout=10)
    options = mounted.stdout.split()
    if len(options) != 2 or any("ro" not in value.split(",") for value in options):
        raise ValueError("Source HOME must be an offline read-only filesystem, not just a bind view")
    targets = subprocess.run(["findmnt", "-rn", "-o", "TARGET"], check=True,
                             capture_output=True, text=True, timeout=10)
    for target in targets.stdout.splitlines():
        # findmnt's raw output escapes characters that could split mount records.
        decoded = target
        for escaped, literal in (("\\x20", " "), ("\\x09", "\t"),
                                 ("\\x0a", "\n"), ("\\x5c", "\\")):
            decoded = decoded.replace(escaped, literal)
        if Path(decoded).is_relative_to(source) and Path(decoded) != source:
            raise ValueError("Nested mounts in source HOME require explicit classification")


def digest_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        with os.fdopen(os.dup(fd), "rb") as source:
            digest = hashlib.file_digest(source, "sha256")
    finally:
        os.close(fd)
    return digest.hexdigest()


def attributes(path):
    values = {}
    for name in os.listxattr(path, follow_symlinks=False):
        if not name.startswith("user."):
            raise ValueError("ACL/security attributes require an explicit migration adapter")
        values[name] = os.getxattr(path, name, follow_symlinks=False)
    return values


def inventory(root, user):
    records = {}
    device = root.lstat().st_dev

    def visit(path):
        info = path.lstat()
        if info.st_dev != device or (info.st_uid, info.st_gid) != (user["uid"], user["gid"]):
            raise ValueError("Cross-device or foreign UID/GID home data requires explicit migration")
        mode = stat.S_IMODE(info.st_mode)
        if mode & (stat.S_ISUID | stat.S_ISGID):
            raise ValueError("Privileged home data requires explicit migration")
        entry = {"uid": info.st_uid, "gid": info.st_gid, "mode": mode,
                 "mtimeNs": info.st_mtime_ns,
                 "xattrs": {name: hashlib.sha256(value).hexdigest()
                           for name, value in sorted(attributes(path).items())}}
        if stat.S_ISDIR(info.st_mode):
            entry["type"] = "directory"
        elif stat.S_ISREG(info.st_mode):
            if info.st_nlink != 1:
                raise ValueError("Hard-linked home data requires explicit migration")
            entry.update(type="file", size=info.st_size, sha256=digest_file(path))
        elif stat.S_ISLNK(info.st_mode):
            entry.update(type="symlink", target=os.readlink(path))
        else:
            raise ValueError("Special home files require explicit migration")
        records[path.relative_to(root).as_posix()] = entry
        if entry["type"] == "directory":
            for child in sorted(path.iterdir()):
                visit(child)

    visit(root)
    return records


def checksum(records):
    return hashlib.sha256(json.dumps(records, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=True).encode()).hexdigest()


def mapping(records):
    skipped, replacements, destinations = set(), {}, set()
    for legacy, target in homes.layout.COMPATIBILITY_LINKS.items():
        product = target.removeprefix("../")
        old, new = records.get(legacy), records.get(product)
        if new is not None and new["type"] != "directory":
            raise ValueError("Product XDG path is not a directory")
        if old is None:
            continue
        if old["type"] == "symlink" and old["target"] == target and new is not None:
            skipped.add(legacy)
        elif old["type"] != "directory" or new is not None:
            raise ValueError("Conflicting legacy/product XDG paths; explicit resolution required")
        else:
            replacements[legacy] = product
    if ".local" in records and records[".local"]["type"] != "directory":
        raise ValueError("Legacy .local must be a real directory")
    for name in homes.layout.USER_DIRECTORIES:
        if name in records and records[name]["type"] != "directory":
            raise ValueError("User product path is not a directory")
    result = {}
    for name in records:
        if name in skipped:
            continue
        destination = name
        for old, new in replacements.items():
            if name == old or name.startswith(old + "/"):
                destination = new + name[len(old):]
                break
        if destination in destinations:
            raise ValueError("Two source paths map to the same destination")
        result[name] = destination
        destinations.add(destination)
    return result


def metadata(source, destination, entry):
    os.chown(destination, entry["uid"], entry["gid"], follow_symlinks=False)
    if entry["type"] != "symlink":
        destination.chmod(entry["mode"])
    for name, value in attributes(source).items():
        os.setxattr(destination, name, value, follow_symlinks=False)
    os.utime(destination, ns=(entry["mtimeNs"], entry["mtimeNs"]), follow_symlinks=False)


def copy_records(source, destination, records, paths):
    for name, target in paths.items():
        entry, original, output = records[name], source / name, destination / target
        if entry["type"] == "directory":
            if not output.exists():
                output.mkdir(mode=0o700)
            if not stat.S_ISDIR(output.lstat().st_mode):
                raise ValueError("Staging directory conflict")
        elif entry["type"] == "symlink":
            output.symlink_to(entry["target"])
            metadata(original, output, entry)
        else:
            read_fd = os.open(original, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                write_fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                                   os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
                try:
                    with os.fdopen(os.dup(read_fd), "rb") as incoming, \
                            os.fdopen(os.dup(write_fd), "wb") as outgoing:
                        while block := incoming.read(1024 * 1024):
                            outgoing.write(block)
                        outgoing.flush()
                    metadata(original, output, entry)
                    os.fsync(write_fd)
                finally:
                    os.close(write_fd)
            finally:
                os.close(read_fd)
    for name, target in sorted(paths.items(), key=lambda item: item[1].count("/"), reverse=True):
        if records[name]["type"] == "directory":
            metadata(source / name, destination / target, records[name])


def sync_tree(root):
    directories = []
    for directory, _, files in os.walk(root, followlinks=False):
        directory = Path(directory)
        directories.append(directory)
        for name in files:
            path = directory / name
            if path.is_symlink():
                continue
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    for directory in reversed(directories):
        sync_directory(directory)


def journal(transaction, record):
    temporary = transaction / (".journal-" + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                 os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, "w", encoding="utf8", newline="\n") as output:
        json.dump(record, output, sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, transaction / "journal.json")
    sync_directory(transaction)


def publish(source, destination):
    library = ctypes.CDLL(None, use_errno=True)
    if not hasattr(library, "renameat2"):
        raise RuntimeError("Atomic no-replace publication is unavailable")
    rename = library.renameat2
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    # RENAME_NOREPLACE protects against another root transaction publishing the same UID.
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number), str(destination))


def migrate(source, users, user):
    if os.geteuid() != 0:
        raise PermissionError("Offline home migration requires root authorization")
    if not isinstance(user, dict):
        raise ValueError("Invalid migration identity")
    homes.layout.validate_users([*(
        identity for identity in homes.layout.DEFAULT_USERS if identity["uid"] != user.get("uid")), user])
    trusted_path(source.parent)
    trusted_path(users)
    if source.is_relative_to(users) or users.is_relative_to(source):
        raise ValueError("Source and destination trees must be disjoint")
    info = source.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("Source HOME must be a real private directory")
    readonly_source(source)
    records = inventory(source, user)
    paths = mapping(records)
    destination = users / str(user["uid"])
    if destination.exists() or destination.is_symlink():
        raise FileExistsError("Destination UID already exists; no overwrite or implicit merge")
    transaction = users / (".migration-" + uuid.uuid4().hex)
    transaction.mkdir(mode=0o700)
    transaction.chmod(0o700)
    sync_directory(users)
    record = {"schemaVersion": SCHEMA_VERSION, "user": dict(user), "source": str(source),
              "destination": str(destination), "sourceSha256": checksum(records), "phase": "planned"}
    journal(transaction, record)
    try:
        backup = transaction / "backup"
        backup.mkdir(mode=0o700)
        copy_records(source, backup, records, {name: name for name in records})
        sync_tree(backup)
        if inventory(backup, user) != records or inventory(source, user) != records:
            raise ValueError("Source/backup verification failed")
        record["phase"] = "backed-up"
        journal(transaction, record)
        stage = transaction / "home"
        stage.mkdir(mode=0o700)
        stage.chmod(0o700)
        os.chown(stage, user["uid"], user["gid"])
        homes.initialize(stage, user, user_dirs=False)
        copy_records(backup, stage, records, paths)
        staged = inventory(stage, user)
        if any(staged.get(target) != records[name] for name, target in paths.items()):
            raise ValueError("Normalized home verification failed")
        config = stage / "Settings/user-dirs.dirs"
        if not config.exists() and not config.is_symlink():
            homes.seed_user_dirs(stage, user)
        sync_tree(stage)
        record.update(phase="verified", destinationSha256=checksum(inventory(stage, user)))
        journal(transaction, record)
        if inventory(source, user) != records:
            raise ValueError("Source changed before publication")
        record["phase"] = "committing"
        journal(transaction, record)
        publish(stage, destination)
        sync_directory(users)
        sync_directory(transaction)
        if checksum(inventory(destination, user)) != record["destinationSha256"]:
            raise ValueError("Published home verification failed; retain transaction for diagnosis")
        record["phase"] = "committed"
        journal(transaction, record)
    except (OSError, ValueError, RuntimeError) as error:
        record.update(failedPhase=record["phase"], phase="interrupted", errorType=type(error).__name__)
        journal(transaction, record)
        raise
    return transaction


def status(transaction):
    if os.geteuid() != 0:
        raise PermissionError("Migration inspection requires root authorization")
    trusted_path(transaction, private=True)
    path = transaction / "journal.json"
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or \
            stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > 65536:
        raise ValueError("Invalid private migration journal")
    record = json.loads(path.read_text())
    if not isinstance(record, dict) or type(record.get("schemaVersion")) is not int or \
            record["schemaVersion"] != SCHEMA_VERSION or record.get("phase") not in {
                "planned", "backed-up", "verified", "committing", "committed", "interrupted"}:
        raise ValueError("Unsupported migration journal")
    user = record["user"]
    if not isinstance(user, dict):
        raise ValueError("Invalid journal user identity")
    homes.layout.validate_users([*(
        identity for identity in homes.layout.DEFAULT_USERS if identity["uid"] != user.get("uid")), user])
    destination = Path(record["destination"])
    if destination != transaction.parent / str(record["user"]["uid"]):
        raise ValueError("Migration destination escaped its transaction")
    published = destination.exists() and "destinationSha256" in record and \
        checksum(inventory(destination, record["user"])) == record["destinationSha256"]
    backup = transaction / "backup"
    backup_retained = backup.exists() and stat.S_ISDIR(backup.lstat().st_mode)
    backed_up = record.get("failedPhase", record["phase"]) in {
        "backed-up", "verified", "committing", "committed"}
    backup_verified = backed_up and backup_retained and \
        checksum(inventory(backup, user)) == record["sourceSha256"]
    if backed_up and not backup_verified:
        raise ValueError("Required migration backup is missing or corrupted")
    return {"schemaVersion": SCHEMA_VERSION, "phase": record["phase"],
            "publicationVerified": published, "backupRetained": backup_retained,
            "backupVerified": backup_verified,
            "automaticResume": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import")
    importer.add_argument("--source", type=Path, required=True)
    importer.add_argument("--users", type=Path, required=True)
    importer.add_argument("--name", required=True)
    importer.add_argument("--uid", type=int, required=True)
    importer.add_argument("--gid", type=int, required=True)
    inspector = commands.add_parser("status")
    inspector.add_argument("--transaction", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "import":
            transaction = migrate(args.source, args.users,
                                  {"name": args.name, "uid": args.uid, "gid": args.gid})
            print(json.dumps({"transaction": str(transaction), **status(transaction)}, sort_keys=True))
        else:
            print(json.dumps(status(args.transaction), sort_keys=True))
    except (OSError, ValueError, RuntimeError, KeyError, AttributeError) as error:
        print("POLLY_HOME_MIGRATION_FAILED: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
