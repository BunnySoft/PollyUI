"""Versioned single-system storage contract shared by image construction and boot checks."""
import copy
import re
import uuid

SCHEMA_VERSION = 1
MIB = 1024 * 1024
MANIFEST_PATH = "/etc/polly-storage.json"
PERSISTENT_MOUNT = "/run/polly-storage/persistent"
VOLUME_ROLES = ("EFI", "SYSTEM", "PERSISTENT", "RECOVERY")
DEFAULT_USERS = ({"name": "root", "uid": 0, "gid": 0},
                 {"name": "polly", "uid": 1000, "gid": 1000})

# Unknown service state must be classified explicitly rather than sharing all /var/lib.
STATE_DIRECTORIES = (
    ("SystemData", 0o755),
    ("SystemData/Library", 0o755),
    ("SystemData/Library/Dpkg", 0o755),
    ("SystemData/Library/Apt", 0o755),
    ("SystemData/Accounts", 0o755),
    ("SystemData/Apps", 0o755),
    ("SystemData/Apps/Registry", 0o755),
    ("SystemData/Apps/Permissions", 0o700),
    ("SystemData/Settings", 0o755),
    ("SystemData/Machine", 0o700),
    ("SystemData/Network", 0o700),
    ("SystemData/Credentials", 0o700),
    ("SystemData/Setup", 0o700),
    ("SystemData/Updates", 0o700),
    ("SystemData/Logs", 0o755),
    ("SystemData/Cache", 0o755),
    ("SystemData/Temporary", 0o1777),
    ("Apps", 0o755),
    ("Apps/Packages", 0o755),
    ("Users", 0o755),
)
USER_DIRECTORIES = ("Documents", "Desktop", "Downloads", "Settings", "AppData", "AppState", "Cache")
XDG_DIRECTORIES = {
    "XDG_CONFIG_HOME": "Settings", "XDG_DATA_HOME": "AppData",
    "XDG_STATE_HOME": "AppState", "XDG_CACHE_HOME": "Cache",
}
COMPATIBILITY_LINKS = {
    ".config": "Settings", ".local/share": "../AppData",
    ".local/state": "../AppState", ".cache": "Cache",
}
RESTORE_RULES = (
    {"id": "system", "policy": "restore-matched-set",
     "paths": ["/System", "/etc (version-related configuration)",
               "/SystemData/Library/Dpkg", "/SystemData/Library/Apt"]},
    {"id": "identity", "policy": "retain-latest",
     "paths": ["/SystemData/Accounts", "/SystemData/Machine", "/SystemData/Setup"]},
    {"id": "service", "policy": "retain-compatible-or-reject",
     "paths": ["/SystemData/Settings", "/SystemData/Network", "/SystemData/Credentials"]},
    {"id": "applications", "policy": "independent-application-transaction",
     "paths": ["/Apps", "/SystemData/Apps"]},
    {"id": "users", "policy": "preserve-unless-explicit-data-migration",
     "paths": ["/Users"]},
    {"id": "rebuildable", "policy": "explicit-cleanup-only",
     "paths": ["/SystemData/Cache", "/SystemData/Temporary", "/Users/<UserId>/Cache"]},
    {"id": "diagnostics", "policy": "preserve-bounded-private-records",
     "paths": ["/SystemData/Logs", "/SystemData/Updates"]},
)


def _integer(value, minimum, maximum, label):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("Invalid " + label)
    return value


def validate_users(users):
    if not isinstance(users, (list, tuple)) or not 2 <= len(users) <= 256:
        raise ValueError("Expected root and at least one ordinary user")
    names, uids, result = set(), set(), []
    for user in users:
        if not isinstance(user, dict) or set(user) != {"name", "uid", "gid"}:
            raise ValueError("Invalid persistent user identity")
        name, uid, gid = user["name"], user["uid"], user["gid"]
        if not isinstance(name, str) or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", name):
            raise ValueError("Unsupported login name")
        _integer(uid, 0, 65535, "user UID")
        _integer(gid, 0, 65535, "user GID")
        if uid in uids or name in names or (uid == 0) != (name == "root") or \
                (uid != 0 and uid < 1000) or gid != uid:
            raise ValueError("Conflicting persistent user identity")
        names.add(name)
        uids.add(uid)
        result.append(dict(user))
    if not {0, 1000}.issubset(uids):
        raise ValueError("Missing root or primary administrator identity")
    return sorted(result, key=lambda user: user["uid"])


def mappings(users):
    users = validate_users(users)
    result = [
        {"volume": "SYSTEM", "source": "System/Resources", "target": "/usr", "phase": "initramfs"},
        {"volume": "SYSTEM", "source": "System/Boot", "target": "/boot", "phase": "system"},
        {"volume": "PERSISTENT", "source": "SystemData", "target": "/SystemData", "phase": "system"},
        {"volume": "PERSISTENT", "source": "Apps", "target": "/Apps", "phase": "system"},
        {"volume": "PERSISTENT", "source": "Users", "target": "/Users", "phase": "system"},
        {"volume": "PERSISTENT", "source": "SystemData/Library/Dpkg",
         "target": "/var/lib/dpkg", "phase": "system"},
        {"volume": "PERSISTENT", "source": "SystemData/Library/Apt",
         "target": "/var/lib/apt", "phase": "system"},
        {"volume": "PERSISTENT", "source": "SystemData/Logs", "target": "/var/log", "phase": "system"},
        {"volume": "PERSISTENT", "source": "SystemData/Cache", "target": "/var/cache", "phase": "system"},
        {"volume": "PERSISTENT", "source": "SystemData/Temporary", "target": "/var/tmp", "phase": "system"},
        {"volume": "PERSISTENT", "source": "SystemData/Accounts",
         "target": "/var/lib/polly-accounts", "phase": "accounts"},
        {"volume": "PERSISTENT", "source": "SystemData/Accounts/etc",
         "target": "/var/lib/extrausers", "phase": "accounts"},
    ]
    for user in users:
        result.append({"volume": "PERSISTENT", "source": "Users/" + str(user["uid"]),
                       "target": "/root" if user["uid"] == 0 else "/home/" + user["name"],
                       "phase": "system"})
    return result


def contract(volumes, users=DEFAULT_USERS):
    if not isinstance(volumes, dict) or set(volumes) != set(VOLUME_ROLES):
        raise ValueError("Expected exactly EFI/SYSTEM/PERSISTENT/RECOVERY identities")
    identifiers = []
    for role in VOLUME_ROLES:
        value = volumes[role]
        expression = r"[0-9A-F]{4}-[0-9A-F]{4}" if role == "EFI" else \
            r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
        if not isinstance(value, str) or not re.fullmatch(expression, value):
            raise ValueError("Invalid " + role + " filesystem identity")
        identifiers.append(value)
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("Filesystem identities must be distinct")
    users = validate_users(users)
    return {
        "schemaVersion": SCHEMA_VERSION, "layout": "single-system-independent-recovery",
        "volumes": [{"role": role, "uuid": volumes[role],
                     "filesystem": "FAT32" if role == "EFI" else "ext4"}
                    for role in VOLUME_ROLES],
        "persistentMount": PERSISTENT_MOUNT,
        "mappings": mappings(users),
        "users": users,
        "directories": [{"path": path, "mode": mode, "uid": 0, "gid": 0}
                        for path, mode in STATE_DIRECTORIES],
        "xdg": dict(XDG_DIRECTORIES),
        "compatibilityLinks": dict(COMPATIBILITY_LINKS),
        "restoreRules": [copy.deepcopy(rule) for rule in RESTORE_RULES],
    }


def _same_types_and_values(value, expected):
    if type(value) is not type(expected):
        return False
    if isinstance(value, dict):
        return set(value) == set(expected) and all(
            _same_types_and_values(value[key], expected[key]) for key in expected)
    if isinstance(value, list):
        return len(value) == len(expected) and all(
            _same_types_and_values(item, other) for item, other in zip(value, expected))
    return value == expected


def validate(value):
    if not isinstance(value, dict) or type(value.get("schemaVersion")) is not int or \
            value["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError("Unsupported storage layout schema")
    volumes = value.get("volumes")
    if not isinstance(volumes, list) or len(volumes) != len(VOLUME_ROLES) or any(
            not isinstance(volume, dict) or set(volume) != {"role", "uuid", "filesystem"}
            for volume in volumes):
        raise ValueError("Invalid storage volume records")
    if [volume["role"] for volume in volumes] != list(VOLUME_ROLES):
        raise ValueError("Missing, duplicate or reordered storage volume")
    expected = contract({volume["role"]: volume["uuid"] for volume in volumes}, value.get("users"))
    if not _same_types_and_values(value, expected):
        raise ValueError("Storage paths, ownership or restore contract changed without a schema change")
    return copy.deepcopy(expected)


def new_volume_uuids():
    serial = uuid.uuid4().hex[:8].upper()
    return {"EFI": serial[:4] + "-" + serial[4:],
            **{role: str(uuid.uuid4()) for role in VOLUME_ROLES if role != "EFI"}}


def partition_plan(payload_bytes, headroom_mib, identifiers=None):
    """Size each filesystem from measured payload plus explicit reserved capacity."""
    if not isinstance(payload_bytes, dict) or set(payload_bytes) != set(VOLUME_ROLES) or \
            not isinstance(headroom_mib, dict) or set(headroom_mib) != set(VOLUME_ROLES):
        raise ValueError("All four payload measurements and reserves are required")
    identifiers = new_volume_uuids() if identifiers is None else identifiers
    contract(identifiers)
    parts, start = [], 2048
    for role in VOLUME_ROLES:
        payload = _integer(payload_bytes[role], 1, 64 * 1024 * MIB, "measured " + role + " payload")
        reserve = _integer(headroom_mib[role], 16, 64 * 1024, role + " reserve MiB")
        measured = (payload + MIB - 1) // MIB
        overhead = max(16, (measured + 9) // 10)
        size = measured + overhead + reserve
        _integer(size, 33, 128 * 1024, role + " filesystem MiB")
        parts.append({"name": role, "startSector": start, "sectors": size * 2048,
                      "sizeMiB": size, "payloadBytes": payload,
                      "filesystemOverheadMiB": overhead, "reserveMiB": reserve,
                      "type": "U" if role == "EFI" else "L", "uuid": identifiers[role],
                      "filesystem": "FAT32" if role == "EFI" else "ext4"})
        start += size * 2048
    return parts, (start + 2048) * 512
