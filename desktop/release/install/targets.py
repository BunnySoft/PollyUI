#!/usr/bin/env python3
"""T24.1/T24.2 read-only installation-target inventory and re-identification.

Python never opens block devices; lsblk may query their metadata read-only.
Nothing here mounts, partitions, formats or writes a device.
CLI: --fixture snapshot.json OR --enumerate --source /path/to/install/payload,
plus --measurements measurements.json. Enumeration is opt-in, Linux-only and
bounded. A fixture has {lsblk: {blockdevices: [...]}, sysfs: {major:minor: {...}},
context: {complete, root, boot, source, mounts, swaps, errors}}. Root/boot/source
and swaps are lists of kernel major:minor IDs; mounts have majorMinor/target.
Missing evidence remains visible and rejects eligibility, never a safe default.

Consumers use inventory(snapshot, measurements), selection(report, entryId),
then reidentify(selection, FRESH report) immediately before any hypothetical
write. A selection binds stable IDs, model, byte capacity, partitions, kernel
diskseq and the exact observed node/topology; renamed nodes require reselection.
It is NOT an authorization token. A future privileged writer must independently
collect trusted evidence, retain the explicit user-media confirmation gate,
acquire exclusive access, close races and check other mount namespaces/raw
openers. Public Live credentials, RM and model names never grant permission.

Currently only corroborated USB transport can pass the external-media floor;
non-USB external enclosures require an authoritative provenance policy later.
Known model-family exclusions are deliberately broader than the three listed
capacities: model text is a conservative deny floor, NOT a unique identity.
Overlay/non-block roots with unresolved ancestry fail closed. No UI, packaging,
shared test registration or writer is wired by this self-contained CLI.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time

MAX_BYTES = (1 << 63) - 1
MAX_OUTPUT = 2 * 1024 * 1024
MAX_NODES = 256
MAX_DEPTH = 16
MAX_TEXT = 4096
SCHEMA_VERSION = 1
LAYOUT = "single-system-independent-recovery"
LSBLK = ("/usr/bin/lsblk", "--json", "--bytes", "--paths", "--tree", "--all",
         "--output", "NAME,KNAME,PATH,TYPE,SIZE,MODEL,SERIAL,WWN,TRAN,RM,RO,MAJ:MIN,"
         "PKNAME,MOUNTPOINTS,FSTYPE,UUID,PARTUUID,START,LOG-SEC,PTTYPE")
MESSAGES = {
    "invalid-field": "Refresh enumeration; a required device field is missing or invalid.",
    "incomplete-sysfs": "Refresh kernel evidence; sysfs identity or topology is incomplete.",
    "conflicting-evidence": "lsblk and kernel evidence disagree; refresh, do not select this node.",
    "ambiguous-topology": "Resolve conflicting parents, holders or device aliases before selecting.",
    "missing-stable-id": "Obtain a real serial or WWN; a node name/model is not a stable identity.",
    "duplicate-stable-id": "Disconnect ambiguous devices or resolve duplicate serial/WWN evidence.",
    "protected-model": "This model family is explicitly excluded; do not install on it.",
    "not-physical-disk": "Only a complete whole physical disk may be an installation target.",
    "external-provenance-unknown": "Only corroborated USB media passes this policy; RM alone is insufficient.",
    "read-only": "The device is read-only and cannot be an installation target.",
    "mounted": "The disk or a descendant is mounted; this tool will not unmount it.",
    "in-use": "The disk has holders, slaves or active swap; this tool will not release it.",
    "active-root": "The disk backs the running root and must remain excluded.",
    "active-boot": "The disk backs current boot files and must remain excluded.",
    "active-source": "The disk backs installation input and must remain excluded.",
    "active-ancestry-unknown": "Resolve all running root/boot/source and active block ancestry first.",
    "incomplete-context": "Refresh trusted mount, swap and source evidence before selecting any disk.",
    "insufficient-capacity": "Use media large enough for the measured payload and explicit reserves.",
    "enumeration-changed": "Device evidence changed during enumeration; refresh and reselect.",
    "identity-missing": "The selected stable identity is absent; refresh rather than substituting a node.",
    "identity-changed": "Stable identity or clearing scope changed; refresh and explicitly reselect.",
    "observation-changed": "Node, topology or diskseq changed (possible hotplug); explicitly reselect.",
    "selection-invalid": "Recreate the selection from a trusted eligible inventory.",
}


def reason(code, detail=None):
    value = {"code": code, "message": MESSAGES[code]}
    if detail is not None:
        value["detail"] = detail
    return value


def _add(reasons, code, detail=None):
    item = reason(code, detail)
    if item not in reasons:
        reasons.append(item)


def _text(value, empty=False):
    if not isinstance(value, str) or len(value) > MAX_TEXT or \
            any(ord(char) < 32 for char in value):
        raise ValueError("Expected bounded text")
    value = value.strip()
    if not value and not empty:
        raise ValueError("Expected nonempty text")
    return value


def _integer(value, minimum=0, maximum=MAX_BYTES):
    if isinstance(value, str) and re.fullmatch(r"[0-9]{1,20}", value):
        value = int(value)
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("Expected bounded integer")
    return value


def _flag(value):
    if type(value) is bool:
        return value
    return bool(_integer(value, 0, 1))


def _major(value):
    value = _text(value)
    if not re.fullmatch(r"(0|[1-9][0-9]{0,6}):(0|[1-9][0-9]{0,6})", value):
        raise ValueError("Expected kernel major:minor")
    return value


def _node(value):
    value = _text(value)
    if not re.fullmatch(r"/dev/[A-Za-z0-9_.!+-]{1,128}", value):
        raise ValueError("Expected a direct kernel device node")
    return value


def _display_node(value):
    value = _text(value)
    if not re.fullmatch(r"/dev/(?:mapper/|md/)?[A-Za-z0-9_.!+:-]{1,128}", value):
        raise ValueError("Expected a bounded device display path")
    return value


def _kname(value):
    value = _text(value)
    return _node(value if value.startswith("/dev/") else "/dev/" + value)[5:]


def _stable(value, wwn=False):
    if value is None or value == "":
        return None
    value = _text(value)
    if value.casefold() in {"unknown", "none", "null", "n/a", "na", "not specified"}:
        return None
    if wwn:
        value = value.lower()
        if not re.fullmatch(r"(?:0x|eui\.|naa\.)?[0-9a-f]{8,64}", value):
            raise ValueError("Invalid WWN")
        value = re.sub(r"^(?:0x|eui\.|naa\.)", "", value)
    if re.fullmatch(r"[0 -]+", value):
        return None
    return value


def excluded_model(model):
    """Conservative alias/family floor, independent of capacity or serial."""
    if not isinstance(model, str):
        return False
    alias = re.sub(r"[^a-z0-9]", "", model.casefold())
    return ("990pro" in alias or "sdssdxps480g" in alias or "sn770" in alias)


def capacity_requirements(measurements):
    """Reuse the builder's measured EFI/SYSTEM/PERSISTENT/RECOVERY algorithm."""
    if not isinstance(measurements, dict) or set(measurements) != {"payloadBytes", "headroomMiB"}:
        raise ValueError("Expected measured payloadBytes and headroomMiB for all four volumes")
    spec = importlib.util.spec_from_file_location(
        "polly_target_layout", Path(__file__).resolve().parents[1] / "storage/layout.py")
    layout = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(layout)
    parts, size = layout.partition_plan(measurements["payloadBytes"], measurements["headroomMiB"])
    return {"layout": LAYOUT, "requiredBytes": size,
            "partitions": [{key: value for key, value in part.items() if key != "uuid"}
                           for part in parts]}


def _json(text):
    def constant(value):
        raise ValueError("Non-finite JSON number: " + value)

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON key: " + key)
            result[key] = value
        return result
    if len(text.encode("utf8")) > MAX_OUTPUT:
        raise ValueError("JSON exceeds bounded input limit")
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=constant)
    except (json.JSONDecodeError, RecursionError) as error:
        raise ValueError("Invalid bounded JSON") from error


def _flatten(lsblk):
    if not isinstance(lsblk, dict) or set(lsblk) != {"blockdevices"} or \
            not isinstance(lsblk["blockdevices"], list):
        raise ValueError("Expected lsblk JSON blockdevices")
    result = []

    def visit(items, parent, depth):
        if depth > MAX_DEPTH:
            raise ValueError("Device tree exceeds depth limit")
        for item in items:
            if len(result) >= MAX_NODES:
                raise ValueError("Device tree exceeds node limit")
            if not isinstance(item, dict):
                result.append(({"invalidEntry": item}, parent))
                continue
            raw = {key: value for key, value in item.items() if key != "children"}
            result.append((raw, parent))
            children = item.get("children", [])
            if not isinstance(children, list):
                raw["invalidChildren"] = True
            else:
                visit(children, item.get("maj:min"), depth + 1)
    visit(lsblk["blockdevices"], None, 0)
    return result


def _record(raw, index):
    issues, fields = [], {}
    validators = {
        "path": _display_node, "kname": _kname, "name": _display_node, "maj:min": _major,
        "type": _text, "size": lambda value: _integer(value, 1),
        "model": _text, "serial": _stable, "wwn": lambda value: _stable(value, True),
        "tran": _text, "rm": _flag, "ro": _flag,
        "log-sec": lambda value: _integer(value, 512, 65536),
    }
    for key, validate in validators.items():
        try:
            fields[key] = validate(raw.get(key))
        except ValueError:
            fields[key] = None
            # A partition may not have a model or transport of its own.
            if key not in {"model", "tran"} or raw.get("type") == "disk":
                _add(issues, "invalid-field", key)
    if fields["path"] and (fields["name"] != fields["path"] or
                          (fields["type"] in {"disk", "part"} and
                           fields["kname"] != fields["path"][5:])):
        _add(issues, "conflicting-evidence", "node aliases")
    if fields["log-sec"] and fields["log-sec"] & (fields["log-sec"] - 1):
        _add(issues, "invalid-field", "log-sec must be a power of two")
    for key in ("fstype", "uuid", "partuuid", "pttype"):
        try:
            fields[key] = None if raw.get(key) is None else _text(raw[key], empty=True)
        except ValueError:
            fields[key] = None
            _add(issues, "invalid-field", key)
    mounts = raw.get("mountpoints")
    if not isinstance(mounts, list) or len(mounts) > MAX_NODES:
        fields["mountpoints"] = []
        _add(issues, "invalid-field", "mountpoints")
    else:
        try:
            fields["mountpoints"] = sorted({_text(item) for item in mounts if item is not None})
        except ValueError:
            fields["mountpoints"] = []
            _add(issues, "invalid-field", "mountpoints")
    if raw.get("type") == "part":
        try:
            fields["start"] = _integer(raw.get("start"))
        except ValueError:
            fields["start"] = None
            _add(issues, "invalid-field", "start")
    else:
        fields["start"] = None
    if "invalidEntry" in raw or "invalidChildren" in raw:
        _add(issues, "invalid-field", "device tree entry")
    return {"entryId": "entry-" + str(index), "fields": fields, "raw": raw,
            "reasons": issues, "parents": set(), "kernel": None}


def _kernel(value, entry):
    fields = entry["fields"]
    if not isinstance(value, dict):
        _add(entry["reasons"], "incomplete-sysfs", fields["maj:min"])
        return
    try:
        path = _text(value.get("sysfsPath"))
        if not path.startswith("/sys/devices/") or ".." in path.split("/"):
            raise ValueError("Invalid sysfs path")
        kernel = {
            "sysfsPath": path, "dev": _major(value.get("dev")),
            "sizeSectors512": _integer(value.get("sizeSectors512"), 1, MAX_BYTES // 512),
            "logicalSectorBytes": _integer(value.get("logicalSectorBytes"), 512, 65536),
            "readOnly": _flag(value.get("readOnly")),
            "removable": _flag(value.get("removable")),
            "diskseq": _integer(value.get("diskseq"), 1),
            "partition": None if value.get("partition") is None else _integer(value["partition"], 1),
            "startSector512": None if value.get("startSector512") is None else
                _integer(value["startSector512"]),
            "parent": None if value.get("parent") is None else _major(value["parent"]),
        }
        for key in ("holders", "slaves", "partitions"):
            if not isinstance(value.get(key), list) or len(value[key]) > MAX_NODES:
                raise ValueError("Missing bounded " + key)
            kernel[key] = sorted({_major(item) for item in value[key]})
        if kernel["logicalSectorBytes"] & (kernel["logicalSectorBytes"] - 1):
            raise ValueError("Invalid sector size")
        entry["kernel"] = kernel
        expected = (kernel["dev"], kernel["sizeSectors512"] * 512,
                    kernel["logicalSectorBytes"], kernel["readOnly"], kernel["removable"])
        observed = (fields["maj:min"], fields["size"], fields["log-sec"], fields["ro"], fields["rm"])
        if expected != observed or path.rsplit("/", 1)[-1] != fields["kname"]:
            _add(entry["reasons"], "conflicting-evidence", "kernel geometry/node")
        if fields["size"] is not None and fields["log-sec"] is not None and \
                fields["size"] % fields["log-sec"]:
            _add(entry["reasons"], "conflicting-evidence", "unaligned byte capacity")
        if (fields["type"] == "part") != (kernel["partition"] is not None) or \
                (fields["type"] == "part" and (kernel["startSector512"] != fields["start"] or
                                             kernel["parent"] is None)):
            _add(entry["reasons"], "conflicting-evidence", "partition ancestry/offset")
    except ValueError as error:
        _add(entry["reasons"], "incomplete-sysfs", str(error))


def inventory(snapshot, measurements):
    """Return JSON-safe schemaVersion/capacity/devices/errors, never permission.

    devices includes non-targets/unknown entries, each with raw evidence, model,
    capacityBytes, identity, partitions, clearingScope, observation, eligible
    and actionable {code,message,detail?} reasons. Clearing scope is hypothetical
    whole-disk [0, capacityBytes), including the table and all current partitions.
    Unresolved topology disables all candidates instead of dropping evidence.
    """
    capacity = capacity_requirements(measurements)
    if not isinstance(snapshot, dict) or set(snapshot) != {"lsblk", "sysfs", "context"}:
        raise ValueError("Expected lsblk, sysfs and context snapshot")
    try:
        if len(json.dumps(snapshot, allow_nan=False).encode("utf8")) > MAX_OUTPUT:
            raise ValueError("Snapshot exceeds bounded input limit")
    except (TypeError, RecursionError) as error:
        raise ValueError("Expected a bounded JSON snapshot") from error
    if not isinstance(snapshot["sysfs"], dict) or len(snapshot["sysfs"]) > MAX_NODES:
        raise ValueError("Expected bounded sysfs evidence map")
    entries, by_dev, by_name, errors = [], {}, {}, []
    for index, (raw, tree_parent) in enumerate(_flatten(snapshot["lsblk"])):
        entry = _record(raw, index)
        entry["treeParent"] = tree_parent
        entries.append(entry)
        dev = entry["fields"]["maj:min"]
        if dev:
            by_dev.setdefault(dev, []).append(entry)
        name = entry["fields"]["kname"]
        if name:
            by_name.setdefault(name, set()).add(dev)
        _kernel(snapshot["sysfs"].get(dev), entry)
    # Repeated tree nodes are allowed only when their evidence is identical.
    for dev, aliases in by_dev.items():
        if any(item["fields"] != aliases[0]["fields"] or item["kernel"] != aliases[0]["kernel"]
               for item in aliases[1:]):
            _add(errors, "ambiguous-topology", "conflicting repeated " + dev)
        for item in aliases:
            parents = []
            if item["treeParent"] is not None:
                parents.append(item["treeParent"])
            if item["raw"].get("pkname") is not None:
                try:
                    names = by_name.get(_kname(item["raw"]["pkname"]), set())
                    if len(names) != 1 or None in names:
                        raise ValueError("Unresolved parent name")
                    parents.extend(names)
                except ValueError:
                    _add(errors, "ambiguous-topology", "pkname for " + dev)
            kernel = item["kernel"]
            if kernel:
                if kernel["parent"]:
                    parents.append(kernel["parent"])
                parents.extend(kernel["slaves"])
                if any(holder not in by_dev for holder in kernel["holders"]):
                    _add(errors, "ambiguous-topology", "unresolved holders for " + dev)
            for parent in parents:
                if not isinstance(parent, str) or parent not in by_dev or parent == dev:
                    _add(errors, "ambiguous-topology", "unresolved parent for " + dev)
                else:
                    item["parents"].add(parent)
            if item["fields"]["type"] == "part" and len(item["parents"]) != 1:
                _add(errors, "ambiguous-topology", "partition parents for " + dev)
        union = set().union(*(item["parents"] for item in aliases))
        for item in aliases:
            item["parents"] = union
    for dev, aliases in by_dev.items():
        kernel = aliases[0]["kernel"]
        if not kernel:
            continue
        parent = kernel["parent"]
        if parent in by_dev and by_dev[parent][0]["kernel"] and \
                kernel["sysfsPath"].rsplit("/", 1)[0] != by_dev[parent][0]["kernel"]["sysfsPath"]:
            _add(errors, "ambiguous-topology", "kernel parent path for " + dev)
        listed = {child for child, records in by_dev.items()
                  if records[0]["kernel"] and records[0]["kernel"]["parent"] == dev}
        if set(kernel["partitions"]) != listed:
            _add(errors, "ambiguous-topology", "incomplete kernel partition list for " + dev)
        for holder in kernel["holders"]:
            other = by_dev.get(holder, [{}])[0].get("kernel")
            if not other or dev not in other["slaves"]:
                _add(errors, "ambiguous-topology", "non-reciprocal holder for " + dev)
        for slave in kernel["slaves"]:
            other = by_dev.get(slave, [{}])[0].get("kernel")
            if not other or dev not in other["holders"]:
                _add(errors, "ambiguous-topology", "non-reciprocal slave for " + dev)
    if any(len(values) > 1 for values in by_name.values()) or any(
            item["fields"]["maj:min"] is None or item["kernel"] is None or item["reasons"]
            for item in entries):
        _add(errors, "ambiguous-topology", "incomplete or conflicting device inventory")

    resolved, depths = {}, {}

    def ancestors(dev, visiting=None):
        visiting = set() if visiting is None else visiting
        if dev in visiting or len(visiting) > MAX_DEPTH or dev not in by_dev:
            raise ValueError("Unresolved or cyclic block ancestry")
        if dev in resolved:
            return resolved[dev]
        result = {dev}
        for parent in by_dev[dev][0]["parents"]:
            result |= ancestors(parent, visiting | {dev})
        depth = 1 + max((depths[parent] for parent in by_dev[dev][0]["parents"]), default=0)
        if depth > MAX_DEPTH:
            raise ValueError("Block ancestry exceeds depth limit")
        resolved[dev], depths[dev] = result, depth
        return result

    ancestry = {}
    for dev in by_dev:
        try:
            ancestry[dev] = ancestors(dev)
        except ValueError:
            ancestry[dev] = {dev}
            _add(errors, "ambiguous-topology", "cycle/unresolved ancestry " + dev)
    context = snapshot["context"]
    active = {"root": set(), "boot": set(), "source": set(), "mounted": set(), "swap": set()}
    if not isinstance(context, dict) or context.get("complete") is not True:
        _add(errors, "incomplete-context")
    if isinstance(context, dict):
        context_errors = context.get("errors")
        if not isinstance(context_errors, list) or context_errors:
            detail = {"count": len(context_errors),
                      "examples": [error[:256] if isinstance(error, str) else "Invalid error entry"
                                   for error in context_errors[:3]]} if isinstance(context_errors, list) \
                else "Missing/invalid collector errors"
            _add(errors, "incomplete-context", detail)
            if isinstance(context.get("errors"), list) and any(
                    isinstance(error, str) and MESSAGES["enumeration-changed"] in error
                    for error in context["errors"]):
                _add(errors, "enumeration-changed")
        for category in ("root", "boot", "source", "swaps"):
            values = context.get(category)
            if not isinstance(values, list) or len(values) > MAX_NODES or \
                    (category != "swaps" and not values):
                _add(errors, "incomplete-context", category)
                continue
            for dev in values:
                try:
                    dev = _major(dev)
                    if dev not in ancestry:
                        raise ValueError("Unknown active block")
                    if any(not by_dev[ancestor][0]["parents"] and
                           by_dev[ancestor][0]["fields"]["type"] != "disk"
                           for ancestor in ancestry[dev]):
                        raise ValueError("Unresolved non-physical active backing")
                    active["swap" if category == "swaps" else category] |= ancestry[dev]
                except ValueError:
                    _add(errors, "active-ancestry-unknown", category)
        mounts = context.get("mounts")
        if not isinstance(mounts, list) or len(mounts) > MAX_NODES:
            _add(errors, "incomplete-context", "mounts")
        else:
            for mount in mounts:
                try:
                    dev = _major(mount["majorMinor"])
                    _text(mount["target"])
                    if dev in ancestry:
                        active["mounted"] |= ancestry[dev]
                        if any(not by_dev[ancestor][0]["parents"] and
                               by_dev[ancestor][0]["fields"]["type"] != "disk"
                               for ancestor in ancestry[dev]):
                            raise ValueError("Unresolved mounted backing")
                    elif not dev.startswith("0:"):
                        raise ValueError("Unknown mounted block")
                except (ValueError, KeyError, TypeError):
                    _add(errors, "active-ancestry-unknown", "mounts")
    for item in entries:
        dev = item["fields"]["maj:min"]
        if item["fields"]["mountpoints"] and dev in ancestry:
            active["mounted"] |= ancestry[dev]
    stable_owners = {}
    for dev, aliases in by_dev.items():
        fields = aliases[0]["fields"]
        if fields["type"] == "disk":
            for key in ("serial", "wwn"):
                if fields[key]:
                    identifier = fields[key].casefold() if key == "serial" else fields[key]
                    stable_owners.setdefault((key, identifier), set()).add(dev)
    devices = []
    for item in entries:
        fields, kernel = item["fields"], item["kernel"]
        dev, issues = fields["maj:min"], copy.deepcopy(item["reasons"])
        issues.extend(copy.deepcopy(errors))
        if fields["type"] != "disk" or item["parents"] or \
                (kernel and (kernel["partition"] is not None or kernel["slaves"])):
            _add(issues, "not-physical-disk")
        if not fields["serial"] and not fields["wwn"]:
            _add(issues, "missing-stable-id")
        for key in ("serial", "wwn"):
            identifier = fields[key].casefold() if key == "serial" and fields[key] else fields[key]
            if fields[key] and len(stable_owners.get((key, identifier), set())) > 1:
                _add(issues, "duplicate-stable-id", key)
        if excluded_model(fields["model"]):
            _add(issues, "protected-model", fields["model"])
        if fields["tran"] != "usb" or kernel is None or not re.search(
                r"/usb[0-9]+/", kernel["sysfsPath"]):
            _add(issues, "external-provenance-unknown")
        if fields["ro"]:
            _add(issues, "read-only")
        for category in ("root", "boot", "source"):
            if dev in active[category]:
                _add(issues, "active-" + category)
        if dev in active["mounted"]:
            _add(issues, "mounted")
        descendants = sorted(child for child in ancestry if dev in ancestry[child] and child != dev)
        related = [by_dev[child][0] for child in [dev, *descendants] if child in by_dev]
        if dev in active["swap"] or any(
                record["kernel"] and (record["kernel"]["holders"] or record["kernel"]["slaves"])
                for record in related):
            _add(issues, "in-use")
        partitions = []
        for record in related:
            f, k = record["fields"], record["kernel"]
            if f["type"] != "part":
                if f["maj:min"] != dev:
                    _add(issues, "ambiguous-topology", "non-partition descendant")
                continue
            part = {"path": f["path"], "majorMinor": f["maj:min"], "capacityBytes": f["size"],
                    "number": k["partition"] if k else None,
                    "startSector512": f["start"], "filesystem": f["fstype"],
                    "uuid": f["uuid"], "partuuid": f["partuuid"],
                    "mountpoints": f["mountpoints"]}
            partitions.append(part)
            if not k or not kernel or k["diskseq"] != kernel["diskseq"] or \
                    f["start"] is None or f["size"] is None or fields["size"] is None or \
                    f["start"] * 512 + f["size"] > fields["size"]:
                _add(issues, "conflicting-evidence", "partition bounds/diskseq")
        partitions.sort(key=lambda part: (part["startSector512"] or 0, part["majorMinor"] or ""))
        previous_end = 0
        for part in partitions:
            if part["startSector512"] is not None and part["capacityBytes"] is not None:
                start = part["startSector512"] * 512
                if start < previous_end:
                    _add(issues, "ambiguous-topology", "overlapping partitions")
                previous_end = start + part["capacityBytes"]
        if fields["size"] is not None and fields["size"] < capacity["requiredBytes"]:
            _add(issues, "insufficient-capacity", {"requiredBytes": capacity["requiredBytes"]})
        identity = {"serial": fields["serial"], "wwn": fields["wwn"], "model": fields["model"],
                    "capacityBytes": fields["size"], "logicalSectorBytes": fields["log-sec"]}
        clearing = {"kind": "hypothetical-whole-disk", "startByte": 0,
                    "endByteExclusive": fields["size"], "partitionTable": fields["pttype"],
                    "partitions": partitions, "performed": False}
        observation = {"path": fields["path"], "majorMinor": dev, "kname": fields["kname"],
                       "kernel": kernel, "parents": sorted(item["parents"]),
                       "descendants": descendants, "transport": fields["tran"]}
        devices.append({"entryId": item["entryId"], "deviceType": fields["type"], "model": fields["model"],
                        "capacityBytes": fields["size"], "removable": fields["rm"],
                        "identity": identity, "partitions": partitions, "clearingScope": clearing,
                        "observation": observation, "eligible": not issues, "reasons": issues,
                        "raw": copy.deepcopy(item["raw"])})
    return {"schemaVersion": SCHEMA_VERSION, "readOnly": True, "writeAuthorized": False,
            "capacity": capacity, "devices": devices, "errors": errors,
            "limitations": ["Eligibility is not permission to write.",
                            "No exclusive access or other mount-namespace/raw-opener proof.",
                            "No physical-media or destructive-installation acceptance."]}


def _fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    allow_nan=False).encode("utf8")).hexdigest()


def selection(report, entry_id):
    """Bind a trusted eligible observation; never choose by /dev name alone."""
    entries = [item for item in report["devices"] if item["entryId"] == entry_id]
    if len(entries) != 1 or not entries[0]["eligible"] or report["writeAuthorized"] is not False:
        raise ValueError("Selection requires one eligible read-only entry")
    entry = entries[0]
    value = {"schemaVersion": SCHEMA_VERSION, "identity": copy.deepcopy(entry["identity"]),
             "observation": copy.deepcopy(entry["observation"]),
             "clearingScope": copy.deepcopy(entry["clearingScope"]),
             "capacity": copy.deepcopy(report["capacity"]), "writeAuthorized": False}
    return {**value, "fingerprint": _fingerprint(value)}


def reidentify(selected, fresh_report):
    """Fail closed on removal, substitution, renumbering, hotplug or scope change.

    Success returns the newly observed entry, still writeAuthorized=False. The
    caller must collect the fresh report independently; fixture JSON is not an
    authority and no token from this module can authorize a writer.
    """
    failed = {"matches": False, "writeAuthorized": False, "device": None}
    keys = {"schemaVersion", "identity", "observation", "clearingScope",
            "capacity", "writeAuthorized", "fingerprint"}
    if not isinstance(selected, dict) or set(selected) != keys or \
            type(selected["schemaVersion"]) is not int or selected["schemaVersion"] != SCHEMA_VERSION or \
            selected["writeAuthorized"] is not False or \
            not isinstance(selected["identity"], dict):
        return {**failed, "reasons": [reason("selection-invalid")]}
    value = {key: value for key, value in selected.items() if key != "fingerprint"}
    if _fingerprint(value) != selected["fingerprint"] or not any(
            selected["identity"].get(key) for key in ("serial", "wwn")):
        return {**failed, "reasons": [reason("selection-invalid")]}
    identity = selected["identity"]
    candidates = [item for item in fresh_report["devices"] if item["deviceType"] == "disk" and any(
        identity.get(key) and identity[key] == item["identity"].get(key) for key in ("serial", "wwn"))]
    if len(candidates) != 1:
        return {**failed, "reasons": [reason("identity-missing" if not candidates else
                                          "duplicate-stable-id")]}
    entry = candidates[0]
    issues = copy.deepcopy(entry["reasons"])
    if entry["identity"] != identity or entry["clearingScope"] != selected["clearingScope"] or \
            fresh_report["capacity"] != selected["capacity"]:
        _add(issues, "identity-changed")
    if entry["observation"] != selected["observation"]:
        _add(issues, "observation-changed")
    if issues:
        return {**failed, "reasons": issues}
    return {"matches": True, "writeAuthorized": False, "device": copy.deepcopy(entry), "reasons": []}


def _read(path, limit=MAX_TEXT):
    with Path(path).open("rb") as file:
        data = file.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Read exceeds bounded input: " + str(path))
    return data.decode("utf8").strip()


def _command(args, deadline):
    """Capture standard output with one total deadline and a strict byte cap."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ValueError("Read-only enumeration timed out")
    with subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}) as process:
        output = bytearray()
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ValueError("Read-only enumeration timed out")
                    for key, _ in selector.select(min(remaining, 0.1)):
                        block = os.read(key.fileobj.fileno(), 65536)
                        if not block:
                            selector.unregister(key.fileobj)
                        else:
                            output.extend(block)
                            if len(output) > MAX_OUTPUT:
                                raise ValueError("Read-only command exceeded output limit")
            process.wait(timeout=max(0.001, deadline - time.monotonic()))
            if process.returncode:
                raise ValueError("Read-only command failed: " + args[0] + ": " +
                                 output[:MAX_TEXT].decode("utf8", errors="replace"))
        except (ValueError, subprocess.TimeoutExpired):
            process.kill()
            process.wait()
            raise
    return output.decode("utf8")


def _unescape(value):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), value)


def _collect_kernel(dev, deadline, sys_root=Path("/sys")):
    if time.monotonic() >= deadline:
        raise ValueError("Read-only enumeration timed out")
    sys_root = Path(sys_root).resolve(strict=True)
    path = (sys_root / "dev/block" / _major(dev)).resolve(strict=True)
    if not path.is_relative_to(sys_root / "devices"):
        raise ValueError("Kernel block mapping escapes sysfs")
    partition = _read(path / "partition") if (path / "partition").exists() else None
    parent = path.parent if partition is not None else path
    result = {"sysfsPath": "/sys/" + path.relative_to(sys_root).as_posix(), "dev": _read(path / "dev"),
              "sizeSectors512": _read(path / "size"),
              "logicalSectorBytes": _read(parent / "queue/logical_block_size"),
              "readOnly": _read(path / "ro"), "removable": _read(parent / "removable"),
              "diskseq": _read(parent / "diskseq"), "partition": partition,
              "startSector512": _read(path / "start") if partition is not None else None,
              "parent": _read(parent / "dev") if partition is not None else None}
    for key in ("holders", "slaves"):
        members = []
        for child in (path / key).iterdir():
            if len(members) >= MAX_NODES or time.monotonic() >= deadline:
                raise ValueError("Kernel topology exceeds bound")
            members.append(_read(child / "dev"))
        result[key] = sorted(members)
    result["partitions"] = []
    if partition is None:
        for index, child in enumerate(path.iterdir()):
            if index >= MAX_NODES or time.monotonic() >= deadline:
                raise ValueError("Kernel partition scan exceeds bound")
            if child.is_dir() and (child / "partition").exists():
                result["partitions"].append(_read(child / "dev"))
    result["partitions"].sort()
    return result


class _CollectorEvidence:
    """Fixed production evidence locations; tests inject a private evidence object."""

    def command(self, args, deadline):
        return _command(args, deadline)

    def kernel(self, dev, deadline):
        return _collect_kernel(dev, deadline)

    def resolve(self, path):
        return Path(path).resolve(strict=True)

    def exists(self, path):
        return Path(path).exists()

    def read(self, path, limit):
        return _read(path, limit)


def enumerate_readonly(source_paths, *, evidence=None, timeout=20):
    """Bounded Linux collector; only lsblk/findmnt and proc/sysfs text are read.

    Source paths must name ALL payload/input locations, supplied by the trusted
    loader, not inferred from removable flags or UI claims. Container/overlay
    roots with unknown physical backing are rejected, not treated as safe.
    """
    if sys.platform != "linux" or not isinstance(source_paths, list) or \
            not 1 <= len(source_paths) <= 16 or type(timeout) not in (int, float) or \
            not 0 < timeout <= 20:
        raise ValueError("Linux enumeration requires 1-16 explicit source paths")
    evidence = _CollectorEvidence() if evidence is None else evidence
    deadline = time.monotonic() + timeout
    before = _json(evidence.command(LSBLK, deadline))
    flat = _flatten(before)
    kernel, errors = {}, []
    for raw, _ in flat:
        dev = raw.get("maj:min")
        if isinstance(dev, str) and dev not in kernel:
            try:
                kernel[dev] = evidence.kernel(dev, deadline)
            except (OSError, ValueError) as error:
                errors.append(str(error))
    context = {"complete": True, "root": [], "boot": [], "source": [],
               "mounts": [], "swaps": [], "errors": errors}

    def backing(path):
        return _major(evidence.command(("/usr/bin/findmnt", "--noheadings", "--raw",
                                "--target", str(path), "--output", "MAJ:MIN"), deadline).strip())

    boot_paths = ["/boot"]
    if evidence.exists("/System/Boot"):
        boot_paths.append("/System/Boot")
    for category, paths in (("root", ["/"]), ("boot", boot_paths),
                            ("source", source_paths)):
        for path in paths:
            try:
                resolved = evidence.resolve(path)
                context[category].append(backing(resolved))
            except (OSError, ValueError) as error:
                errors.append(category + ": " + str(error))
    try:
        lines = evidence.read("/proc/self/mountinfo", MAX_OUTPUT).splitlines()
        if len(lines) > MAX_NODES:
            raise ValueError("Mount inventory exceeds bound")
        for line in lines:
            fields = line.split()
            if len(fields) < 10 or "-" not in fields:
                raise ValueError("Invalid mountinfo")
            context["mounts"].append({"majorMinor": _major(fields[2]), "target": _unescape(fields[4])})
        swaps = evidence.read("/proc/swaps", MAX_OUTPUT).splitlines()
        if not swaps or not swaps[0].startswith("Filename") or len(swaps) > MAX_NODES:
            raise ValueError("Invalid or excessive swap inventory")
        for line in swaps[1:]:
            fields = line.split()
            if len(fields) != 5:
                raise ValueError("Invalid swap record")
            path = _unescape(fields[0])
            devices = [raw["maj:min"] for raw, _ in flat if raw.get("path") == path]
            context["swaps"].append(devices[0] if len(devices) == 1 else backing(path))
    except (OSError, ValueError) as error:
        errors.append(str(error))
    # Catch changed lsblk geometry/IDs/mounts while collecting ancillary evidence.
    after = _json(evidence.command(LSBLK, deadline))
    if after != before:
        errors.append(MESSAGES["enumeration-changed"])
    for dev, original in kernel.items():
        try:
            if evidence.kernel(dev, deadline) != original:
                errors.append(MESSAGES["enumeration-changed"] + " " + dev)
        except (OSError, ValueError) as error:
            errors.append(str(error))
    context["complete"] = not errors
    return {"lsblk": before, "sysfs": kernel, "context": context}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--fixture", type=Path)
    mode.add_argument("--enumerate", action="store_true")
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--measurements", type=Path, required=True)
    parser.add_argument("--reidentify", type=Path, help="Read-only selection JSON; NOT a write permit")
    args = parser.parse_args()
    try:
        snapshot = _json(_read(args.fixture, MAX_OUTPUT)) if args.fixture else enumerate_readonly(args.source)
        report = inventory(snapshot, _json(_read(args.measurements, MAX_OUTPUT)))
        result = reidentify(_json(_read(args.reidentify, MAX_OUTPUT)), report) if args.reidentify else report
        print(json.dumps(result, sort_keys=True, allow_nan=False))
        return 0 if (result["matches"] if args.reidentify else not report["errors"]) else 2
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"schemaVersion": SCHEMA_VERSION, "readOnly": True,
                          "writeAuthorized": False, "error": str(error)}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
