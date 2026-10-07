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
import struct
import subprocess
import sys
import uuid

spec = importlib.util.spec_from_file_location("polly_migration_homes",
                                            Path(__file__).resolve().with_name("homes.py"))
homes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(homes)
spec = importlib.util.spec_from_file_location("polly_migration_identities",
                                            Path(__file__).resolve().with_name("identities.py"))
identity_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity_module)
SCHEMA_VERSION = 4
ACL_ATTRIBUTES = {"system.posix_acl_access", "system.posix_acl_default"}
ACL_USER_OBJ, ACL_USER, ACL_GROUP_OBJ, ACL_GROUP, ACL_MASK, ACL_OTHER = 1, 2, 4, 8, 16, 32


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
        raise ValueError("Source inputs must be an offline read-only filesystem, not just a bind view")
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
        if not name.startswith("user.") and name not in ACL_ATTRIBUTES:
            raise ValueError("Security/unknown attributes require an explicit migration adapter")
        values[name] = os.getxattr(path, name, follow_symlinks=False)
    return values


def validate_acl(value, user, *, identities=None, side="source"):
    if len(value) < 28 or (len(value) - 4) % 8 or struct.unpack_from("<I", value)[0] != 2:
        raise ValueError("Invalid POSIX ACL format")
    required, named, mask = set(), set(), False
    for offset in range(4, len(value), 8):
        tag, permissions, identity = struct.unpack_from("<HHI", value, offset)
        if permissions > 7:
            raise ValueError("Invalid POSIX ACL permissions")
        if tag in (ACL_USER_OBJ, ACL_GROUP_OBJ, ACL_OTHER):
            if tag in required or identity != 0xffffffff:
                raise ValueError("Invalid POSIX ACL base entry")
            required.add(tag)
        elif tag == ACL_MASK:
            if mask or identity != 0xffffffff:
                raise ValueError("Invalid POSIX ACL mask")
            mask = True
        elif tag in (ACL_USER, ACL_GROUP):
            kind = "uid" if tag == ACL_USER else "gid"
            allowed = identities.allowed(kind, side) if identities else {0, user[kind]}
            if identity not in allowed or (tag, identity) in named:
                raise ValueError("POSIX ACL identity requires explicit service/user mapping")
            named.add((tag, identity))
        else:
            raise ValueError("Unknown POSIX ACL tag")
    if required != {ACL_USER_OBJ, ACL_GROUP_OBJ, ACL_OTHER} or (named and not mask):
        raise ValueError("Incomplete POSIX ACL")


def mapped_acl(value, identities):
    validate_acl(value, identities.user, identities=identities)
    entries = []
    order = {ACL_USER_OBJ: 0, ACL_USER: 1, ACL_GROUP_OBJ: 2,
             ACL_GROUP: 3, ACL_MASK: 4, ACL_OTHER: 5}
    for offset in range(4, len(value), 8):
        tag, permissions, identity = struct.unpack_from("<HHI", value, offset)
        if tag == ACL_USER:
            identity = identities.uid_map.get(identity, identity)
        elif tag == ACL_GROUP:
            identity = identities.gid_map.get(identity, identity)
        entries.append((tag, permissions, identity))
    entries.sort(key=lambda entry: (order[entry[0]], entry[2]))
    return struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in entries)


def inventory(root, user, *, schema=SCHEMA_VERSION, identities=None, side="source"):
    if type(schema) is not int or schema not in (1, 2, 3, SCHEMA_VERSION) or \
            (identities is not None and schema < 4):
        raise ValueError("Unsupported home inventory schema")
    records, links = {}, {}
    device = root.lstat().st_dev

    def visit(path):
        info = path.lstat()
        owners, groups = {user["uid"]}, {user["gid"]}
        if schema >= 3:
            owners.add(0)
            groups.add(0)
        if identities:
            owners, groups = identities.allowed("uid", side), identities.allowed("gid", side)
        if info.st_dev != device or info.st_uid not in owners or info.st_gid not in groups:
            raise ValueError("Cross-device or foreign UID/GID home data requires explicit migration")
        mode = stat.S_IMODE(info.st_mode)
        if mode & (stat.S_ISUID | stat.S_ISGID):
            raise ValueError("Privileged home data requires explicit migration")
        values = attributes(path)
        for name, value in values.items():
            if name in ACL_ATTRIBUTES:
                if schema < 3:
                    raise ValueError("Legacy migration schema does not support POSIX ACLs")
                validate_acl(value, user, identities=identities, side=side)
        entry = {"uid": info.st_uid, "gid": info.st_gid, "mode": mode,
                 "mtimeNs": info.st_mtime_ns,
                 "xattrs": {name: hashlib.sha256(value).hexdigest()
                           for name, value in sorted(values.items())}}
        if stat.S_ISDIR(info.st_mode):
            entry["type"] = "directory"
        elif stat.S_ISREG(info.st_mode):
            if schema == 1 and info.st_nlink != 1:
                raise ValueError("Legacy migration schema does not support hard links")
            key = (info.st_dev, info.st_ino)
            group = links.setdefault(key, {"count": info.st_nlink, "paths": []})
            if group["count"] != info.st_nlink:
                raise ValueError("Home hard links changed during inspection")
            group["paths"].append(path.relative_to(root).as_posix())
            entry.update(type="file", size=info.st_size, sha256=digest_file(path))
        elif stat.S_ISLNK(info.st_mode):
            if info.st_nlink != 1:
                raise ValueError("Hard-linked symbolic links require explicit migration")
            entry.update(type="symlink", target=os.readlink(path))
        else:
            raise ValueError("Special home files require explicit migration")
        records[path.relative_to(root).as_posix()] = entry
        if entry["type"] == "directory":
            for child in sorted(path.iterdir()):
                visit(child)

    visit(root)
    for group in links.values():
        if group["count"] != len(group["paths"]):
            raise ValueError("Hard links outside the source HOME require explicit migration")
        if group["count"] > 1:
            canonical = min(group["paths"])
            for name in group["paths"]:
                records[name]["hardlink"] = canonical
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


def metadata(source, destination, entry, identities=None):
    uid = identities.uid_map.get(entry["uid"], entry["uid"]) if identities else entry["uid"]
    gid = identities.gid_map.get(entry["gid"], entry["gid"]) if identities else entry["gid"]
    os.chown(destination, uid, gid, follow_symlinks=False)
    if entry["type"] != "symlink":
        destination.chmod(entry["mode"])
    for name, value in attributes(source).items():
        if identities and name in ACL_ATTRIBUTES:
            value = mapped_acl(value, identities)
        os.setxattr(destination, name, value, follow_symlinks=False)
    os.utime(destination, ns=(entry["mtimeNs"], entry["mtimeNs"]), follow_symlinks=False)


def normalized_records(records, paths, *, source=None, identities=None):
    normalized, groups = {}, {}
    for name, target in paths.items():
        entry = {**records[name], "xattrs": dict(records[name]["xattrs"])}
        if identities:
            entry["uid"] = identities.uid_map.get(entry["uid"], entry["uid"])
            entry["gid"] = identities.gid_map.get(entry["gid"], entry["gid"])
            for attribute, value in attributes(source / name).items():
                if attribute in ACL_ATTRIBUTES:
                    entry["xattrs"][attribute] = hashlib.sha256(mapped_acl(value, identities)).hexdigest()
        normalized[target] = entry
        if "hardlink" in entry:
            groups.setdefault(entry["hardlink"], []).append(target)
    for names in groups.values():
        canonical = min(names)
        for name in names:
            normalized[name]["hardlink"] = canonical
    return normalized


def copy_records(source, destination, records, paths, *, identities=None):
    copied_links = {}
    for name, target in paths.items():
        entry, original, output = records[name], source / name, destination / target
        if entry["type"] == "directory":
            if not output.exists():
                output.mkdir(mode=0o700)
            if not stat.S_ISDIR(output.lstat().st_mode):
                raise ValueError("Staging directory conflict")
        elif entry["type"] == "symlink":
            output.symlink_to(entry["target"])
            metadata(original, output, entry, identities)
        elif entry.get("hardlink") in copied_links:
            os.link(copied_links[entry["hardlink"]], output, follow_symlinks=False)
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
                    metadata(original, output, entry, identities)
                    os.fsync(write_fd)
                finally:
                    os.close(write_fd)
            finally:
                os.close(read_fd)
            if "hardlink" in entry:
                copied_links[entry["hardlink"]] = output
    for name, target in sorted(paths.items(), key=lambda item: item[1].count("/"), reverse=True):
        if records[name]["type"] == "directory":
            metadata(source / name, destination / target, records[name], identities)


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


def public_file(path, *, private=False):
    trusted_path(path.parent)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or \
            stat.S_IMODE(info.st_mode) & 0o022 or info.st_size > 256 * 1024 or \
            (private and stat.S_IMODE(info.st_mode) != 0o600):
        raise ValueError("Unsafe or oversized identity mapping input")
    return path.read_bytes().decode("utf8")


def identity_inputs(source_etc, target_etc):
    readonly_source(source_etc)
    return (public_file(source_etc / "passwd"), public_file(source_etc / "group"),
            public_file(target_etc / "passwd"), public_file(target_etc / "group"))


def migrate(source, users, user, *, identity_map=None, source_etc=None, target_etc=None):
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
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or \
            (info.st_uid, info.st_gid) != (user["uid"], user["gid"]):
        raise ValueError("Source HOME must be a real private directory")
    readonly_source(source)
    identities = None
    plan_text = None
    if any(value is not None for value in (identity_map, source_etc, target_etc)):
        if any(value is None for value in (identity_map, source_etc, target_etc)):
            raise ValueError("Explicit mapping requires both qualified source and target account tables")
        plan_text = public_file(identity_map, private=True)
        identities = identity_module.IdentityMap(identity_module.load_record(plan_text), user)
        identities.verify(*identity_inputs(source_etc, target_etc))

    def check_identities():
        if identities:
            if public_file(identity_map, private=True) != plan_text:
                raise ValueError("Explicit identity mapping changed during migration")
            identities.verify(*identity_inputs(source_etc, target_etc))

    records = inventory(source, user, identities=identities)
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
    if identities:
        record["identities"] = identities.record
    journal(transaction, record)
    try:
        backup = transaction / "backup"
        backup.mkdir(mode=0o700)
        copy_records(source, backup, records, {name: name for name in records})
        sync_tree(backup)
        if inventory(backup, user, identities=identities) != records or \
                inventory(source, user, identities=identities) != records:
            raise ValueError("Source/backup verification failed")
        record["phase"] = "backed-up"
        journal(transaction, record)
        check_identities()
        stage = transaction / "home"
        stage.mkdir(mode=0o700)
        stage.chmod(0o700)
        os.chown(stage, user["uid"], user["gid"])
        homes.initialize(stage, user, user_dirs=False)
        copy_records(backup, stage, records, paths, identities=identities)
        staged = inventory(stage, user, identities=identities, side="target")
        expected = normalized_records(records, paths, source=backup, identities=identities)
        if any(staged.get(target) != entry for target, entry in expected.items()):
            raise ValueError("Normalized home verification failed")
        config = stage / "Settings/user-dirs.dirs"
        if not config.exists() and not config.is_symlink():
            homes.seed_user_dirs(stage, user)
        sync_tree(stage)
        record.update(phase="verified", destinationSha256=checksum(
            inventory(stage, user, identities=identities, side="target")))
        journal(transaction, record)
        if inventory(source, user, identities=identities) != records:
            raise ValueError("Source changed before publication")
        check_identities()
        record["phase"] = "committing"
        journal(transaction, record)
        publish(stage, destination)
        sync_directory(users)
        sync_directory(transaction)
        check_identities()
        if checksum(inventory(destination, user, identities=identities, side="target")) != record["destinationSha256"]:
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
            stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > 256 * 1024:
        raise ValueError("Invalid private migration journal")
    record = identity_module.load_record(path.read_text())
    if not isinstance(record, dict) or type(record.get("schemaVersion")) is not int or \
            record["schemaVersion"] not in (1, 2, 3, SCHEMA_VERSION) or record.get("phase") not in {
                "planned", "backed-up", "verified", "committing", "committed", "interrupted"}:
        raise ValueError("Unsupported migration journal")
    user = record["user"]
    if not isinstance(user, dict):
        raise ValueError("Invalid journal user identity")
    homes.layout.validate_users([*(
        identity for identity in homes.layout.DEFAULT_USERS if identity["uid"] != user.get("uid")), user])
    identities = None
    if "identities" in record:
        if record["schemaVersion"] != 4:
            raise ValueError("Identity mappings require migration schema v4")
        identities = identity_module.IdentityMap(record["identities"], user)
    destination = Path(record["destination"])
    if destination != transaction.parent / str(record["user"]["uid"]):
        raise ValueError("Migration destination escaped its transaction")
    published = destination.exists() and "destinationSha256" in record and \
        checksum(inventory(destination, record["user"], schema=record["schemaVersion"],
                           identities=identities, side="target")) == record["destinationSha256"]
    backup = transaction / "backup"
    backup_retained = backup.exists() and stat.S_ISDIR(backup.lstat().st_mode)
    backed_up = record.get("failedPhase", record["phase"]) in {
        "backed-up", "verified", "committing", "committed"}
    backup_verified = backed_up and backup_retained and \
        checksum(inventory(backup, user, schema=record["schemaVersion"],
                           identities=identities)) == record["sourceSha256"]
    if backed_up and not backup_verified:
        raise ValueError("Required migration backup is missing or corrupted")
    return {"schemaVersion": record["schemaVersion"], "phase": record["phase"],
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
    importer.add_argument("--identity-map", type=Path)
    importer.add_argument("--source-etc", type=Path)
    importer.add_argument("--target-etc", type=Path)
    qualified = commands.add_parser("identities")
    qualified.add_argument("--source-etc", type=Path, required=True)
    qualified.add_argument("--target-etc", type=Path, required=True)
    inspector = commands.add_parser("status")
    inspector.add_argument("--transaction", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "import":
            transaction = migrate(args.source, args.users,
                                  {"name": args.name, "uid": args.uid, "gid": args.gid},
                                  identity_map=args.identity_map, source_etc=args.source_etc,
                                  target_etc=args.target_etc)
            print(json.dumps({"transaction": str(transaction), **status(transaction)}, sort_keys=True))
        elif args.command == "identities":
            if os.geteuid() != 0:
                raise PermissionError("Identity qualification requires root authorization")
            old_passwd, old_group, new_passwd, new_group = identity_inputs(args.source_etc, args.target_etc)
            for text, kind in ((old_passwd, "passwd"), (old_group, "group"),
                               (new_passwd, "passwd"), (new_group, "group")):
                identity_module.database(text, kind)
            print(json.dumps({"schemaVersion": 1, "source": identity_module.fingerprint(old_passwd, old_group),
                              "target": identity_module.fingerprint(new_passwd, new_group),
                              "automaticMapping": False}, sort_keys=True))
        else:
            print(json.dumps(status(args.transaction), sort_keys=True))
    except (OSError, ValueError, RuntimeError, KeyError, AttributeError) as error:
        print("POLLY_HOME_MIGRATION_FAILED: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
