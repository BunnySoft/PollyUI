"""Explicit, fingerprint-pinned metadata identity mapping; never changes account tables."""
import hashlib
import json
import re

SCHEMA_VERSION = 1


def number(value):
    if type(value) is not int or not 0 <= value <= 65535:
        raise ValueError("Invalid mapped identity number")
    return value


def database(text, kind):
    if kind not in ("passwd", "group"):
        raise ValueError("Unknown public identity database")
    records, identifiers = {}, set()
    count, position = (7, 2) if kind == "passwd" else (4, 2)
    for line in text.splitlines():
        fields = line.split(":")
        if len(fields) != count or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,63}", fields[0]) or \
                fields[1] not in ("", "x") or not re.fullmatch(r"0|[1-9][0-9]*", fields[position]):
            raise ValueError("Unsupported public identity database")
        identity = number(int(fields[position]))
        if fields[0] in records or identity in identifiers or (fields[0] == "root") != (identity == 0):
            raise ValueError("Ambiguous or conflicting public identity database")
        entry = {"id": identity}
        if kind == "passwd":
            if not re.fullmatch(r"0|[1-9][0-9]*", fields[3]):
                raise ValueError("Invalid public primary group")
            entry["gid"] = number(int(fields[3]))
        records[fields[0]] = entry
        identifiers.add(identity)
    if "root" not in records or (kind == "passwd" and records["root"]["gid"] != 0):
        raise ValueError("Missing fixed root identity")
    return records


def fingerprint(passwd, group):
    return {name: hashlib.sha256(text.encode("utf8")).hexdigest()
            for name, text in (("passwd", passwd), ("group", group))}


def validate_record(record, user):
    number(user["uid"])
    number(user["gid"])
    if not isinstance(record, dict) or set(record) != {"schemaVersion", "source", "target", "users", "groups"} or \
            type(record["schemaVersion"]) is not int or record["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError("Unsupported identity mapping schema")
    for side in ("source", "target"):
        proof = record[side]
        if not isinstance(proof, dict) or set(proof) != {"passwd", "group"} or any(
                not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
                for value in proof.values()):
            raise ValueError("Invalid identity mapping fingerprint")
    for collection, key, primary in (("users", "Uid", user["uid"]), ("groups", "Gid", user["gid"])):
        entries = record[collection]
        if not isinstance(entries, list) or len(entries) > 256:
            raise ValueError("Invalid identity mapping entries")
        names, sources, targets = set(), set(), set()
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"name", "role", "source" + key, "target" + key} or \
                    not isinstance(entry["name"], str) or \
                    not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,63}", entry["name"]) or \
                    entry["role"] not in ("user", "service"):
                raise ValueError("Invalid explicit identity mapping")
            source, target = number(entry["source" + key]), number(entry["target" + key])
            if entry["name"] in names or source in sources or target in targets or \
                    source in (0, primary) or target in (0, primary):
                raise ValueError("Identity mapping cannot replace root/current user or create aliases")
            if entry["role"] == "user":
                if source < 1000 or source != target or source == 65534:
                    raise ValueError("Persistent user identities must remain stable")
            elif not all(0 < value < 1000 or value == 65534 for value in (source, target)):
                raise ValueError("Service mapping cannot acquire a persistent user identity")
            names.add(entry["name"])
            sources.add(source)
            targets.add(target)
    return json.loads(json.dumps(record))


def load_record(text):
    def unique(entries):
        result = {}
        for key, value in entries:
            if key in result:
                raise ValueError("Ambiguous duplicate identity mapping field")
            result[key] = value
        return result

    return json.loads(text, object_pairs_hook=unique)


class IdentityMap:
    def __init__(self, record, user):
        self.record = validate_record(record, user)
        self.user = dict(user)
        self.uid_map = {entry["sourceUid"]: entry["targetUid"] for entry in self.record["users"]}
        self.gid_map = {entry["sourceGid"]: entry["targetGid"] for entry in self.record["groups"]}

    def allowed(self, kind, side):
        if kind not in ("uid", "gid") or side not in ("source", "target"):
            raise ValueError("Invalid identity mapping side")
        mappings = self.uid_map if kind == "uid" else self.gid_map
        values = mappings.keys() if side == "source" else mappings.values()
        return {0, self.user[kind], *values}

    def verify(self, source_passwd, source_group, target_passwd, target_group):
        source = {"passwd": database(source_passwd, "passwd"), "group": database(source_group, "group")}
        target = {"passwd": database(target_passwd, "passwd"), "group": database(target_group, "group")}
        if fingerprint(source_passwd, source_group) != self.record["source"] or \
                fingerprint(target_passwd, target_group) != self.record["target"]:
            raise ValueError("Identity mapping is stale or belongs to another source/target")
        for tables in (source, target):
            current = tables["passwd"].get(self.user["name"])
            current_group = tables["group"].get(self.user["name"])
            if current != {"id": self.user["uid"], "gid": self.user["gid"]} or \
                    current_group != {"id": self.user["gid"]}:
                raise ValueError("Requested persistent identity differs from the qualified account tables")
        source_groups = {entry["id"]: name for name, entry in source["group"].items()}
        for collection, table, key in (("users", "passwd", "Uid"), ("groups", "group", "Gid")):
            for entry in self.record[collection]:
                name = entry["name"]
                old, new = source[table].get(name), target[table].get(name)
                if old is None or new is None or old["id"] != entry["source" + key] or \
                        new["id"] != entry["target" + key]:
                    raise ValueError("Explicit mapping disagrees with qualified account tables")
                if table == "passwd":
                    gid = self.gid_map.get(old["gid"], old["gid"])
                    group_name = source_groups.get(old["gid"])
                    if new["gid"] != gid or \
                            (old["gid"] not in (0, self.user["gid"]) and old["gid"] not in self.gid_map) or \
                            target["group"].get(group_name) != {"id": gid} or \
                            (entry["role"] == "user" and old["gid"] != old["id"]):
                        raise ValueError("Mapped account primary group needs an explicit matching plan")
                elif entry["role"] == "user":
                    old_user, new_user = source["passwd"].get(name), target["passwd"].get(name)
                    if old_user != {"id": old["id"], "gid": old["id"]} or \
                            new_user != {"id": new["id"], "gid": new["id"]}:
                        raise ValueError("Persistent user group does not match its stable account")
        return self
