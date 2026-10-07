#!/usr/bin/env python3
"""T07.1 internal, development-unsigned SYSTEM/package-state snapshot contract.

Version 1 binds ALL of the supplied SYSTEM tree (not just /usr), and ONLY the
classified Dpkg/Apt trees in PERSISTENT. Linux regular trees, symlink targets,
internal hardlink groups, mode/uid/gid/mtime and every readable xattr are hashed.
Special nodes, external hardlinks, nested devices and uninspectable metadata fail.
This is a logical-tree identity, not an archive/copy format or filesystem image.

Package qualification: every TSV name/version/homepage matches a stable dpkg
status record (installed or residual config-files); every installed package has
an info/*.list and all its /usr and /boot entries exist in the bound snapshot.
Regular files in that scope must match info/*.md5sums, respecting explicit dpkg
diversions. Whole database and runtime trees are independently SHA256-pinned.
No claim is made that modified conffiles/unowned overlays equal vendor .deb bytes,
dependencies/ABI work, or the snapshot boots. Capture needs an independently
qualified, offline source; checksums (including dpkg's legacy MD5) are NOT
authentication and re-sealing corrupted inputs cannot repair them.

preflight is read-only, requires explicit available capacity and current data
schemas, and never discovers devices, invokes apt, migrates or replaces anything.
None means explicitly absent data; an empty acceptsSchemas means no compatibility
is qualified. Callers must establish offline/quiescent inputs independently.
Concurrent changes detected during inspection fail, but this is not a lock.
See PAYLOAD-CONTRACT.md for the wire shape and consumer boundaries.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys

spec = importlib.util.spec_from_file_location(
    "payload_storage_layout", Path(__file__).resolve().parents[1] / "storage/layout.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)

SCHEMA_VERSION = 1
MAX_JSON_BYTES = 1024 * 1024
MAX_RECORD_BYTES = 64 * layout.MIB
MAX_NODES = 250000
MAX_BYTES = 64 * 1024 * layout.MIB
MAX_SCHEMA = 1000000
DISTRIBUTION = {"id": "debian", "version": "13", "codename": "trixie"}
MATERIALS = (("system", "SYSTEM", "."), ("dpkg", "PERSISTENT", "SystemData/Library/Dpkg"),
             ("apt", "PERSISTENT", "SystemData/Library/Apt"))
DATA_POLICIES = (
    ("accounts", "retain-latest"),
    ("applications", "independent-application-transaction"),
    ("services", "retain-compatible-or-reject"),
    ("users", "preserve-unless-explicit-data-migration"),
)
INVENTORY_PATH = "System/Resources/share/polly-installed-packages.tsv"
STATUS_PATH = "SystemData/Library/Dpkg/status"
QUALIFICATION = "status-tuples+usr-boot-lists-md5sums-diversions+full-tree-sha256-v1"
VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-alpha\.(?:0|[1-9][0-9]*))?"
PACKAGE = r"[a-z0-9][a-z0-9+.-]+"
PACKAGE_VERSION = r"(?:[0-9]+:)?[0-9][A-Za-z0-9.+:~\-]*"
ARCHITECTURE = r"[a-z0-9][a-z0-9-]{0,31}"


def _exact(value, keys, label):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError("Invalid " + label + " fields")


def _integer(value, minimum, maximum, label):
    return layout._integer(value, minimum, maximum, label)


def _text(value, expression, label, maximum=256):
    if type(value) is not str or len(value) > maximum or not re.fullmatch(expression, value):
        raise ValueError("Invalid " + label)
    return value


def _equal(value, expected, label):
    if not layout._same_types_and_values(value, expected):
        raise ValueError("Unsupported " + label)


def _sha(value):
    return _text(value, r"[0-9a-f]{64}", "SHA256", 64)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def checksum(value):
    return hashlib.sha256(_canonical(value).encode("ascii")).hexdigest()


def validate(value):
    """Validate the exact bounded v1 shape; never reinterpret older manifests."""
    _exact(value, ("schemaVersion", "kind", "version", "distribution", "architecture",
                   "storageSchemaVersion", "trust", "materials", "packageProof",
                   "capacity", "compatibility"), "payload contract")
    for key, expected in (("schemaVersion", SCHEMA_VERSION), ("kind", "polly-system-payload"),
                          ("distribution", DISTRIBUTION), ("architecture", "amd64"),
                          ("storageSchemaVersion", layout.SCHEMA_VERSION),
                          ("trust", "development-unsigned")):
        _equal(value[key], expected, key)
    _text(value["version"], VERSION, "payload version", 64)
    materials = value["materials"]
    if type(materials) is not list or len(materials) != len(MATERIALS):
        raise ValueError("Expected complete system/dpkg/apt materials")
    for item, (identifier, role, path) in zip(materials, MATERIALS):
        _exact(item, ("id", "role", "path", "inventorySha256", "nodes", "contentBytes",
                      "measuredBytes"), "material")
        for key, expected in (("id", identifier), ("role", role), ("path", path)):
            _equal(item[key], expected, "material " + key)
        _sha(item["inventorySha256"])
        _integer(item["nodes"], 1, MAX_NODES, "node count")
        _integer(item["contentBytes"], 0, MAX_BYTES, "content bytes")
        _integer(item["measuredBytes"], 4096, MAX_BYTES, "measured bytes")
        if item["measuredBytes"] < item["contentBytes"]:
            raise ValueError("Material measurement is smaller than its content")
    proof = value["packageProof"]
    _exact(proof, ("qualification", "inventory", "status", "packagesSha256",
                   "records", "installedRecords", "runtimePaths", "runtimeFileChecksums",
                   "diversions"), "package proof")
    _equal(proof["qualification"], QUALIFICATION, "package qualification")
    for key, path in (("inventory", INVENTORY_PATH), ("status", STATUS_PATH)):
        item = proof[key]
        _exact(item, ("path", "bytes", "sha256"), "package material")
        _equal(item["path"], path, "package material path")
        _integer(item["bytes"], 1, MAX_RECORD_BYTES, "package material bytes")
        _sha(item["sha256"])
    _sha(proof["packagesSha256"])
    _integer(proof["records"], 1, MAX_NODES, "package records")
    _integer(proof["installedRecords"], 1, proof["records"], "installed records")
    _integer(proof["runtimePaths"], 1, MAX_NODES, "qualified runtime paths")
    _integer(proof["runtimeFileChecksums"], 1, MAX_NODES, "qualified runtime file checksums")
    _integer(proof["diversions"], 0, MAX_NODES, "qualified diversions")
    if proof["runtimeFileChecksums"] > proof["runtimePaths"]:
        raise ValueError("More runtime checksums than qualified paths")
    capacities = value["capacity"]
    if type(capacities) is not list or len(capacities) != 2:
        raise ValueError("Expected SYSTEM and package-state capacity")
    for item, role in zip(capacities, ("SYSTEM", "PERSISTENT")):
        _exact(item, ("role", "payloadBytes", "overheadBytes", "reserveBytes",
                      "minimumBytes"), "capacity")
        _equal(item["role"], role, "capacity role")
        measured = sum(material["measuredBytes"] for material in materials if material["role"] == role)
        _equal(item["payloadBytes"], measured, "measured capacity")
        for key in ("overheadBytes", "reserveBytes"):
            _integer(item[key], 16 * layout.MIB, MAX_BYTES, key)
        _integer(item["minimumBytes"], 1, 128 * 1024 * layout.MIB, "minimum capacity")
        _equal(item["minimumBytes"], measured + item["overheadBytes"] + item["reserveBytes"],
               "capacity arithmetic")
    compatibility = value["compatibility"]
    if type(compatibility) is not list or len(compatibility) != len(DATA_POLICIES):
        raise ValueError("Expected all data compatibility declarations")
    for item, (identifier, policy) in zip(compatibility, DATA_POLICIES):
        _exact(item, ("id", "policy", "acceptsSchemas"), "data compatibility")
        _equal(item["id"], identifier, "data identity")
        _equal(item["policy"], policy, "data preservation policy")
        schemas = item["acceptsSchemas"]
        if type(schemas) is not list or len(schemas) > 256:
            raise ValueError("Invalid compatible schemas")
        for schema in schemas:
            _integer(schema, 1, MAX_SCHEMA, "compatible schema")
        if schemas != sorted(set(schemas)):
            raise ValueError("Duplicate or unordered compatible schemas")
    return copy.deepcopy(value)


def encode(value):
    text = _canonical(validate(value)) + "\n"
    if len(text) > MAX_JSON_BYTES:
        raise ValueError("Payload contract exceeds size limit")
    return text


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def _constant(value):
    raise ValueError("Non-finite JSON number")


def decode(text):
    if type(text) is not str or len(text.encode("utf8")) > MAX_JSON_BYTES:
        raise ValueError("Payload contract exceeds size limit")
    try:
        value = json.loads(text, object_pairs_hook=_pairs, parse_constant=_constant)
    except (json.JSONDecodeError, RecursionError) as error:
        raise ValueError("Malformed payload JSON") from error
    return validate(value)


def _stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)


def _real_path(path, directory=True):
    path = Path(path).absolute()
    if ".." in path.parts:
        raise ValueError("Traversing material path")
    for parent in reversed(path.parents):
        if not stat.S_ISDIR(parent.lstat().st_mode):
            raise ValueError("Material ancestors must be real directories")
    mode = path.lstat().st_mode
    if not (stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)):
        raise ValueError("Expected a real material " + ("directory" if directory else "file"))
    return path


def _read(path, maximum=MAX_RECORD_BYTES):
    """Read a bounded regular file without following its final link."""
    path = _real_path(path, directory=False)
    before = path.lstat()
    if before.st_size > maximum:
        raise ValueError("Material exceeds size limit")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(descriptor, "rb") as source:
        if _stamp(os.fstat(source.fileno())) != _stamp(before):
            raise ValueError("Material changed before inspection")
        data = source.read(maximum + 1)
        if len(data) > maximum or _stamp(os.fstat(source.fileno())) != _stamp(before):
            raise ValueError("Material changed during inspection")
    if _stamp(path.lstat()) != _stamp(before):
        raise ValueError("Material changed after inspection")
    return data


def inventory(root):
    """Return a complete deterministic Linux logical-tree inventory and measurement."""
    if not hasattr(os, "listxattr") or not hasattr(os, "O_NOFOLLOW"):
        raise ValueError("Linux no-follow/xattr inspection is required")
    root = _real_path(root)
    device = root.lstat().st_dev
    records, links = {}, {}
    content, measured = 0, 0

    def visit(path, depth=0):
        nonlocal content, measured
        if depth > 128:
            raise ValueError("Material exceeds directory depth limit")
        before = path.lstat()
        if before.st_dev != device or getattr(before, "st_flags", 0):
            raise ValueError("Cross-device or unsupported flagged material")
        if len(records) >= MAX_NODES:
            raise ValueError("Material exceeds node limit")
        values = os.listxattr(path, follow_symlinks=False)
        if len(values) > 256:
            raise ValueError("Material exceeds xattr count limit")
        attrs = {}
        for name in sorted(values):
            data = os.getxattr(path, name, follow_symlinks=False)
            if len(data) > layout.MIB:
                raise ValueError("Material exceeds xattr size limit")
            measured += len(name.encode("utf8")) + len(data)
            if measured > MAX_BYTES:
                raise ValueError("Material exceeds byte limit")
            attrs[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        entry = {"mode": stat.S_IMODE(before.st_mode), "uid": before.st_uid,
                 "gid": before.st_gid, "mtimeNs": before.st_mtime_ns, "xattrs": attrs}
        name = path.relative_to(root).as_posix()
        if stat.S_ISDIR(before.st_mode):
            entry["type"] = "directory"
            measured += 4096
        elif stat.S_ISREG(before.st_mode):
            key = (before.st_dev, before.st_ino)
            group = links.setdefault(key, {"count": before.st_nlink, "paths": []})
            if group["count"] != before.st_nlink:
                raise ValueError("Material hardlinks changed during inspection")
            if not group["paths"]:
                content += before.st_size
                measured += before.st_size
                group["stamp"] = _stamp(before)
            elif group["stamp"] != _stamp(before):
                raise ValueError("Material hardlink metadata changed during inspection")
            group["paths"].append(name)
            if content > MAX_BYTES or measured > MAX_BYTES:
                raise ValueError("Material exceeds byte limit")
            if "hashes" not in group:
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
                with os.fdopen(descriptor, "rb") as source:
                    if _stamp(os.fstat(source.fileno())) != _stamp(before):
                        raise ValueError("Material changed before hashing")
                    sha, md5 = hashlib.sha256(), hashlib.md5()
                    while block := source.read(layout.MIB):
                        sha.update(block)
                        md5.update(block)
                    if _stamp(os.fstat(source.fileno())) != _stamp(before):
                        raise ValueError("Material changed during hashing")
                group["hashes"] = {"sha256": sha.hexdigest(), "md5": md5.hexdigest()}
            entry.update(type="file", bytes=before.st_size, **group["hashes"])
        elif stat.S_ISLNK(before.st_mode):
            if before.st_nlink != 1:
                raise ValueError("Hardlinked symlinks are not qualified")
            entry.update(type="symlink", target=os.readlink(path))
            measured += before.st_size + 4096
        else:
            raise ValueError("Unsupported special material node")
        if measured > MAX_BYTES:
            raise ValueError("Material exceeds byte limit")
        records[name] = entry
        if entry["type"] == "directory":
            for child in sorted(path.iterdir()):
                visit(child, depth + 1)
        if _stamp(path.lstat()) != _stamp(before):
            raise ValueError("Material changed during inventory")

    visit(root)
    for group in links.values():
        if group["count"] != len(group["paths"]):
            raise ValueError("Hardlink escapes the qualified material tree")
        if group["count"] > 1:
            for name in group["paths"]:
                records[name]["hardlink"] = min(group["paths"])
    return records, content, measured


def _status(raw, architecture):
    try:
        text = raw.decode("utf8")
    except UnicodeDecodeError as error:
        raise ValueError("Invalid dpkg status encoding") from error
    if "\r" in text or "\x00" in text:
        raise ValueError("Invalid dpkg status characters")
    records, fields, previous = {}, {}, None

    def finish():
        if not fields:
            return
        if not {"Package", "Version", "Architecture", "Status"}.issubset(fields):
            raise ValueError("Incomplete package status")
        name = _text(fields["Package"], PACKAGE, "package name")
        version = _text(fields["Version"], PACKAGE_VERSION, "package version")
        arch = _text(fields["Architecture"], ARCHITECTURE, "package architecture")
        if arch not in (architecture, "all"):
            raise ValueError("Foreign package architecture")
        state = fields["Status"]
        if state not in ("install ok installed", "deinstall ok config-files", "purge ok config-files"):
            raise ValueError("Unqualified or unfinished package state")
        multi = fields.get("Multi-Arch", "no")
        if multi not in ("no", "same", "foreign", "allowed") or (multi == "same" and arch == "all"):
            raise ValueError("Invalid Multi-Arch record")
        identifier = name + (":" + arch if multi == "same" else "")
        if identifier in records:
            raise ValueError("Duplicate package status identity")
        records[identifier] = {"name": name, "version": version, "architecture": arch,
                               "status": state, "homepage": fields.get("Homepage", "")}
        if len(records) > MAX_NODES:
            raise ValueError("Too many package records")

    for line in [*text.splitlines(), ""]:
        if not line:
            finish()
            fields, previous = {}, None
        elif line[0] in " \t":
            if previous is None:
                raise ValueError("Orphan package continuation")
            if previous in {"Package", "Version", "Architecture", "Status", "Multi-Arch", "Homepage"}:
                raise ValueError("Multiline package identity field")
        else:
            key, separator, value = line.partition(":")
            if not separator or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*", key) or key in fields:
                raise ValueError("Malformed or duplicate package status field")
            fields[key], previous = value.lstrip(" "), key
    if not records:
        raise ValueError("Empty package database")
    return records


def _tsv(raw):
    try:
        text = raw.decode("utf8")
    except UnicodeDecodeError as error:
        raise ValueError("Invalid package inventory encoding") from error
    if "\r" in text or "\x00" in text:
        raise ValueError("Invalid package inventory characters")
    result = {}
    for line in text.splitlines():
        fields = line.split("\t")
        if len(fields) != 3:
            raise ValueError("Expected exact name/version/homepage TSV")
        identifier, version, homepage = fields
        _text(identifier, PACKAGE + r"(?::" + ARCHITECTURE + r")?", "inventory identity")
        _text(version, PACKAGE_VERSION, "inventory version")
        if len(homepage) > 4096 or identifier in result:
            raise ValueError("Duplicate or oversized package inventory record")
        result[identifier] = (version, homepage)
        if len(result) > MAX_NODES:
            raise ValueError("Too many inventory records")
    if not result:
        raise ValueError("Empty package inventory")
    return result


def _guest_node(name, trees):
    """Resolve guest link ancestors against inventory, never against host paths."""
    pending = name.strip("/").split("/")
    resolved, followed = [], 0
    while pending:
        part = pending.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            if not resolved:
                raise ValueError("Guest link traverses above root")
            resolved.pop()
            continue
        resolved.append(part)
        guest = "/".join(resolved)
        identifier, relative = "system", guest
        for prefix, material in (("usr", "system"), ("boot", "system"),
                                 ("var/lib/dpkg", "dpkg"), ("var/lib/apt", "apt")):
            if guest == prefix or guest.startswith(prefix + "/"):
                suffix = guest[len(prefix):].lstrip("/")
                identifier = material
                relative = {"usr": "System/Resources", "boot": "System/Boot"}.get(prefix, "")
                relative = "/".join(filter(None, (relative, suffix))) or "."
                break
        entry = trees[identifier].get(relative)
        if entry is None:
            raise ValueError("Missing qualified package runtime path: /" + guest)
        if pending and entry["type"] == "symlink":
            followed += 1
            if followed > 40:
                raise ValueError("Package runtime symlink loop")
            resolved.pop()
            target = entry["target"]
            if target.startswith("/"):
                resolved = []
            pending = target.split("/") + pending
        elif pending and entry["type"] != "directory":
            raise ValueError("Package runtime path has a non-directory ancestor")
    return entry


def _guest_path(path):
    pure = PurePosixPath(path)
    if not path.startswith("/") or path.startswith("//") or str(pure) != path or ".." in pure.parts or \
            "\x00" in path or "\r" in path:
        raise ValueError("Malformed package path")
    return path


def _runtime_path(path):
    return path == "/usr" or path.startswith("/usr/") or \
        path == "/boot" or path.startswith("/boot/")


def _metadata_text(persistent, trees, name):
    record = trees["dpkg"].get(name)
    if record is None:
        return None
    if record["type"] != "file":
        raise ValueError("Package metadata must be regular: " + name)
    data = _read(persistent / "SystemData/Library/Dpkg" / name)
    if hashlib.sha256(data).hexdigest() != record["sha256"]:
        raise ValueError("Package metadata changed during inspection")
    try:
        return data.decode("utf8")
    except UnicodeDecodeError as error:
        raise ValueError("Invalid package metadata encoding") from error


def _diversions(persistent, trees, packages):
    text = _metadata_text(persistent, trees, "diversions")
    if text is None:
        return {}
    lines = text.splitlines()
    if len(lines) % 3 or len(lines) > MAX_NODES * 3:
        raise ValueError("Malformed package diversions")
    result, destinations = {}, set()
    owners = set(packages) | {item["name"] for item in packages.values()}
    for offset in range(0, len(lines), 3):
        source, target, owner = lines[offset:offset + 3]
        _guest_path(source)
        _guest_path(target)
        if source == target or source in result or target in destinations or \
                (owner != ":" and owner not in owners):
            raise ValueError("Duplicate or unqualified diversion")
        result[source] = (target, owner)
        destinations.add(target)
    if set(result) & destinations:
        raise ValueError("Chained package diversions are not qualified")
    return result


def _package_proof(system, persistent, trees, architecture):
    paths = {"inventory": (system / INVENTORY_PATH, INVENTORY_PATH),
             "status": (persistent / STATUS_PATH, STATUS_PATH)}
    raw = {key: _read(path) for key, (path, _) in paths.items()}
    packages, listed = _status(raw["status"], architecture), _tsv(raw["inventory"])
    if not any(item["architecture"] == architecture for item in packages.values()):
        raise ValueError("Missing native-architecture package records")
    if set(packages) != set(listed) or any(
            listed[key] != (item["version"], item["homepage"]) for key, item in packages.items()):
        raise ValueError("Package inventory does not match dpkg database")
    diversions = _diversions(persistent, trees, packages)
    qualified, verified, installed = set(), set(), 0
    for identifier, item in sorted(packages.items()):
        if item["status"] != "install ok installed":
            continue
        installed += 1
        filename = "info/" + identifier + ".list"
        text = _metadata_text(persistent, trees, filename)
        if text is None:
            raise ValueError("Missing installed package file list: " + identifier)
        lines = text.splitlines()
        listed_paths = set(lines)
        if not lines or len(lines) > MAX_NODES or len(lines) != len(listed_paths):
            raise ValueError("Empty, duplicate or oversized package file list")
        checksums = {}
        text = _metadata_text(persistent, trees, "info/" + identifier + ".md5sums")
        for line in text.splitlines() if text is not None else ():
            match = re.fullmatch(r"([0-9a-f]{32})  (.+)", line)
            if match is None:
                raise ValueError("Malformed package MD5 checksum record")
            checksum_value, relative = match.groups()
            path = _guest_path("/" + relative)
            if path in checksums or path not in listed_paths or len(checksums) >= MAX_NODES:
                raise ValueError("Duplicate, unlisted or oversized package checksum")
            checksums[path] = checksum_value
        for path in lines:
            if path == "/.":
                continue
            _guest_path(path)
            if _runtime_path(path):
                target, owner = diversions.get(path, (path, identifier))
                actual = target if owner not in (identifier, item["name"]) else path
                node = _guest_node(actual, trees)
                qualified.add(path)
                if len(qualified) > MAX_NODES:
                    raise ValueError("Too many qualified runtime paths")
                if node["type"] == "file":
                    if path not in checksums or node["md5"] != checksums[path]:
                        raise ValueError("Missing or mismatched package runtime checksum: " + path)
                    verified.add(path)
                elif path in checksums:
                    raise ValueError("Checksummed package runtime is not a regular file: " + path)
    if not installed or not qualified or not verified:
        raise ValueError("No installed runtime records are qualified")
    return {"qualification": QUALIFICATION,
            **{key: {"path": relative, "bytes": len(raw[key]),
                     "sha256": hashlib.sha256(raw[key]).hexdigest()}
               for key, (_, relative) in paths.items()},
            "packagesSha256": checksum(packages), "records": len(packages),
            "installedRecords": installed, "runtimePaths": len(qualified),
            "runtimeFileChecksums": len(verified), "diversions": len(diversions)}


def _payload_layout(system, records):
    for path in ("System", "System/Resources", "System/Boot", "usr", "boot",
                 "System/Resources/bin", "System/Resources/sbin",
                 "System/Resources/lib", "System/Resources/share"):
        if records.get(path, {}).get("type") != "directory":
            raise ValueError("Incomplete single-system payload layout")
    if any(name.startswith(("usr/", "boot/", "SystemData/", "Apps/", "Users/", "Recovery/",
                            "var/lib/dpkg/", "var/lib/apt/", "root/"))
           or (name.startswith("home/") and record["type"] != "directory")
           for name, record in records.items()):
        raise ValueError("Duplicated software, recovery or unclassified persistent data in SYSTEM")
    release = _read(system / "System/Resources/lib/os-release", 65536).decode("utf8")
    fields = {}
    for line in release.splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, item = line.partition("=")
        if not separator or key in fields:
            raise ValueError("Malformed or duplicate distribution record")
        fields[key] = item[1:-1] if len(item) >= 2 and item[0] == item[-1] == '"' else item
    if any(fields.get(key) != expected for key, expected in
           (("ID", "debian"), ("VERSION_ID", "13"), ("VERSION_CODENAME", "trixie"))):
        raise ValueError("Distribution material does not match Debian 13/trixie")
    storage = json.loads(_read(system / layout.MANIFEST_PATH.lstrip("/"), MAX_JSON_BYTES),
                         object_pairs_hook=_pairs, parse_constant=_constant)
    layout.validate(storage)
    kernels = [name.removeprefix("System/Boot/vmlinuz-") for name in records
               if name.startswith("System/Boot/vmlinuz-")]
    if not kernels:
        raise ValueError("Missing kernel material")
    for kernel in kernels:
        _text(kernel, r"[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}", "kernel identity", 128)
        for name in ("vmlinuz-" + kernel, "initrd.img-" + kernel, "intel-ucode.img"):
            record = records.get("System/Boot/" + name, {})
            if record.get("type") != "file" or not record.get("bytes"):
                raise ValueError("Missing matching boot material: " + name)
        if records.get("System/Resources/lib/modules/" + kernel, {}).get("type") != "directory":
            raise ValueError("Missing matching kernel module tree")


def _inspect(system, persistent, architecture):
    system, persistent = _real_path(system), _real_path(persistent)
    if system == persistent or system.is_relative_to(persistent) or persistent.is_relative_to(system):
        raise ValueError("SYSTEM and PERSISTENT inputs must be independent trees")
    trees, materials = {}, []
    for identifier, role, relative in MATERIALS:
        root = system if role == "SYSTEM" else persistent / relative
        records, content, measured = inventory(root)
        trees[identifier] = records
        materials.append({"id": identifier, "role": role, "path": relative,
                          "inventorySha256": checksum(records), "nodes": len(records),
                          "contentBytes": content, "measuredBytes": measured})
    _payload_layout(system, trees["system"])
    proof = _package_proof(system, persistent, trees, architecture)
    for identifier, role, relative in MATERIALS:
        records, _, _ = inventory(system if role == "SYSTEM" else persistent / relative)
        expected = next(item["inventorySha256"] for item in materials if item["id"] == identifier)
        if checksum(records) != expected:
            raise ValueError("Payload changed during proof inspection")
    return materials, proof


def capture(system, persistent, *, version, overhead_bytes, reserve_bytes, accepts_schemas):
    """Capture a qualified candidate; no files are written and no source is authenticated."""
    _text(version, VERSION, "payload version", 64)
    for values in (overhead_bytes, reserve_bytes):
        _exact(values, ("SYSTEM", "PERSISTENT"), "capacity inputs")
        for amount in values.values():
            _integer(amount, 16 * layout.MIB, MAX_BYTES, "capacity input")
    _exact(accepts_schemas, (key for key, _ in DATA_POLICIES), "compatibility inputs")
    declarations = [{"id": key, "policy": policy, "acceptsSchemas": accepts_schemas[key]}
                    for key, policy in DATA_POLICIES]
    # Validate declarations before touching any potentially large input trees.
    for item in declarations:
        schemas = item["acceptsSchemas"]
        if type(schemas) is not list or len(schemas) > 256:
            raise ValueError("Invalid compatible schemas")
        for schema in schemas:
            _integer(schema, 1, MAX_SCHEMA, "compatible schema")
        if schemas != sorted(set(schemas)):
            raise ValueError("Duplicate or unordered compatible schemas")
    materials, proof = _inspect(system, persistent, "amd64")
    capacity = []
    for role in ("SYSTEM", "PERSISTENT"):
        measured = sum(item["measuredBytes"] for item in materials if item["role"] == role)
        capacity.append({"role": role, "payloadBytes": measured,
                         "overheadBytes": overhead_bytes[role], "reserveBytes": reserve_bytes[role],
                         "minimumBytes": measured + overhead_bytes[role] + reserve_bytes[role]})
    return validate({"schemaVersion": SCHEMA_VERSION, "kind": "polly-system-payload",
                     "version": version, "distribution": dict(DISTRIBUTION), "architecture": "amd64",
                     "storageSchemaVersion": layout.SCHEMA_VERSION, "trust": "development-unsigned",
                     "materials": materials, "packageProof": proof, "capacity": capacity,
                     "compatibility": declarations})


def preflight(value, system, persistent, *, expected_version, distribution, architecture,
              available_bytes, current_schemas):
    """Validate ALL supplied material, capacity and compatibility; return deterministic evidence."""
    value = validate(value)
    _equal(value["version"], expected_version, "expected payload version")
    _equal(value["distribution"], distribution, "expected distribution")
    _equal(value["architecture"], architecture, "expected architecture")
    _exact(available_bytes, ("SYSTEM", "PERSISTENT"), "available capacity")
    for item in value["capacity"]:
        available = _integer(available_bytes[item["role"]], 0, 128 * 1024 * layout.MIB,
                             "available bytes")
        if available < item["minimumBytes"]:
            raise ValueError("Insufficient " + item["role"] + " capacity including overhead/reserve")
    _exact(current_schemas, (key for key, _ in DATA_POLICIES), "current data schemas")
    for declaration in value["compatibility"]:
        schema = current_schemas[declaration["id"]]
        if schema is not None:
            _integer(schema, 1, MAX_SCHEMA, "current data schema")
            if schema not in declaration["acceptsSchemas"]:
                raise ValueError("Unqualified data compatibility: " + declaration["id"])
    materials, proof = _inspect(system, persistent, architecture)
    if materials != value["materials"] or proof != value["packageProof"]:
        raise ValueError("Payload/package-state material identity mismatch")
    return {"schemaVersion": 1, "kind": "polly-system-payload-preflight",
            "contractSha256": hashlib.sha256(encode(value).encode("ascii")).hexdigest(),
            "version": value["version"], "architecture": architecture,
            "qualification": QUALIFICATION, "materialIds": [item["id"] for item in materials],
            "packageRecords": proof["records"], "installedRecords": proof["installedRecords"],
            "runtimePaths": proof["runtimePaths"], "runtimeFileChecksums": proof["runtimeFileChecksums"],
            "diversions": proof["diversions"], "dataSchemas": copy.deepcopy(current_schemas),
            "availableBytes": copy.deepcopy(available_bytes), "readOnly": True,
            "authenticated": False, "bootVerified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("contract", type=Path)
    parser.add_argument("system", type=Path)
    parser.add_argument("persistent", type=Path)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--distribution", required=True, choices=("debian13",))
    parser.add_argument("--architecture", required=True, choices=("amd64",))
    parser.add_argument("--available-system-bytes", type=int, required=True)
    parser.add_argument("--available-persistent-bytes", type=int, required=True)
    parser.add_argument("--current-schemas", type=Path, required=True,
                        help="Exact accounts/applications/services/users int-or-null JSON")
    args = parser.parse_args()
    try:
        value = decode(_read(args.contract, MAX_JSON_BYTES).decode("utf8"))
        schemas = json.loads(_read(args.current_schemas, MAX_JSON_BYTES).decode("utf8"),
                             object_pairs_hook=_pairs, parse_constant=_constant)
        result = preflight(value, args.system, args.persistent,
                           expected_version=args.expected_version, distribution=DISTRIBUTION,
                           architecture=args.architecture,
                           available_bytes={"SYSTEM": args.available_system_bytes,
                                            "PERSISTENT": args.available_persistent_bytes},
                           current_schemas=schemas)
    except (OSError, ValueError, RecursionError) as error:
        print("Payload preflight refused: " + str(error), file=sys.stderr)
        return 1
    print(_canonical(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
