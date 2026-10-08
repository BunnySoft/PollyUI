#!/usr/bin/env python3
"""Fixed unprivileged report endpoint. No arguments, stdin, writer or broker."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

ROOT = Path(__file__).absolute().parents[1]
MANIFEST = Path("/usr/share/pollyui/install-targets/source.json")
INPUT_ROOT = Path("/run/polly-install-source")
MAX_OUTPUT = 2 * 1024 * 1024
MAX_SAFE = (1 << 53) - 1


def trusted(path, directory=False):
    """Root-owned, non-writable, no symlink component, including ancestors."""
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Expected absolute deployment path")
    for component in [*reversed(path.parents), path]:
        info = component.lstat()
        last = component == path
        expected = stat.S_ISDIR if not last or directory else stat.S_ISREG
        if not expected(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("Untrusted deployment ownership/type/permissions: " + str(component))
    return info


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read(path, limit=MAX_OUTPUT):
    before = trusted(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        if stamp(os.fstat(file.fileno())) != stamp(before):
            raise ValueError("Deployment input replaced before read")
        data = file.read(limit + 1)
        if len(data) > limit or stamp(os.fstat(file.fileno())) != stamp(before):
            raise ValueError("Deployment input oversized or changed during read")
    if stamp(trusted(path)) != stamp(before):
        raise ValueError("Deployment input replaced after read")
    return data


def module(name, path):
    data = read(path)
    result = importlib.util.module_from_spec(importlib.util.spec_from_file_location(name, path))
    # Execute the already checked bytes, not a second mutable path lookup.
    exec(compile(data, str(path), "exec"), result.__dict__)
    return result


def exact(value, keys, label):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError("Invalid " + label + " fields")


def bounded(value, depth=0):
    if depth > 24:
        raise ValueError("Report exceeds JSON depth limit")
    if isinstance(value, str):
        if len(value) > 4096:
            raise ValueError("Report exceeds text limit")
    elif type(value) is int:
        if abs(value) > MAX_SAFE:
            raise ValueError("Report requires an unsupported exact-integer wire format")
    elif isinstance(value, (dict, list)):
        if len(value) > 2048:
            raise ValueError("Report exceeds collection limit")
        for key, item in value.items() if isinstance(value, dict) else enumerate(value):
            if isinstance(key, str):
                bounded(key, depth + 1)
            bounded(item, depth + 1)
    elif value is not None and type(value) is not bool:
        raise ValueError("Report contains unsupported JSON data")


def configuration(targets, payload):
    raw = read(MANIFEST)
    config = targets._json(raw.decode("utf8"))
    exact(config, ("schemaVersion", "kind", "sourceKind", "qualification", "description", "inputs",
                   "measurements", "payloadContractSha256"), "source metadata")
    if type(config["schemaVersion"]) is not int or config["schemaVersion"] != 1 or \
            config["kind"] != "polly-install-source" or \
            config["sourceKind"] != "downloaded" or \
            config["qualification"] != "deployment-owned-offline-inputs-v1":
        raise ValueError("Installation source is not qualified deployment-owned offline input")
    targets._text(config["description"])
    targets.capacity_requirements(config["measurements"])
    items = config["inputs"]
    if type(items) is not list or not 1 <= len(items) <= 15:
        raise ValueError("Expected 1-15 fixed staged source inputs")
    paths, stamps, total = [], {}, 0
    for item in items:
        exact(item, ("name", "bytes"), "staged input")
        name = targets._text(item["name"])
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name) or \
                name == "payload.json" or name in stamps:
            raise ValueError("Invalid or duplicate staged input name")
        path = INPUT_ROOT / name
        info = trusted(path)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        try:
            if stamp(os.fstat(fd)) != stamp(info):
                raise ValueError("Staged source input changed while checking ordinary-user readability")
        finally:
            os.close(fd)
        size = targets._integer(item["bytes"], 1, MAX_SAFE)
        if info.st_size != size:
            raise ValueError("Staged input size differs from qualified source metadata")
        total += size
        if total > MAX_SAFE:
            raise ValueError("Source size requires an unsupported exact-integer wire format")
        paths.append(str(path))
        stamps[name] = stamp(info)
    contract_path = INPUT_ROOT / "payload.json"
    contract_raw = read(contract_path, payload.MAX_JSON_BYTES)
    contract_sha = hashlib.sha256(contract_raw).hexdigest()
    if config["payloadContractSha256"] != contract_sha:
        raise ValueError("Payload contract differs from qualified source metadata")
    contract = payload.decode(contract_raw.decode("utf8"))
    for item in contract["capacity"]:
        if config["measurements"]["payloadBytes"][item["role"]] != item["payloadBytes"]:
            raise ValueError("Source measurement differs from current payload contract: " + item["role"])
    paths.append(str(contract_path))
    stamps["payload.json"] = stamp(trusted(contract_path))
    # Hashes identify changes in the root-qualified receipt; they are not authenticity.
    source_identity = hashlib.sha256(json.dumps(stamps, sort_keys=True).encode("ascii")).hexdigest()
    provenance = hashlib.sha256(raw).hexdigest() + "/" + contract_sha + "/" + source_identity
    description = targets._text(config["description"] + " [development-unsigned; deployment receipt " + provenance + "]")
    return config, paths, stamps, total, description


def acquire(*, evidence=None):
    if sys.platform != "linux" or os.getuid() == 0 or os.geteuid() != os.getuid() or \
            os.getegid() != os.getgid():
        raise ValueError("Read-only acquisition requires an ordinary non-setid Linux process")
    trusted(ROOT / "storage/layout.py")
    targets = module("polly_install_targets", ROOT / "install/targets.py")
    payload = module("polly_install_payload", ROOT / "maintenance/payload.py")
    config, paths, stamps, total, description = configuration(targets, payload)
    snapshot = targets.enumerate_readonly(paths, evidence=evidence, timeout=7)
    # Configuration and staged inputs must still describe the same acquisition.
    fresh, fresh_paths, fresh_stamps, fresh_total, fresh_description = configuration(targets, payload)
    if (fresh, fresh_paths, fresh_stamps, fresh_total, fresh_description) != \
            (config, paths, stamps, total, description):
        raise ValueError("Installation source changed during acquisition")
    report = targets.inventory(snapshot, config["measurements"])
    context = snapshot["context"]
    basis = sorted({entry["observation"]["majorMinor"] for entry in report["devices"]
                    if any(item["code"] == "active-source" for item in entry["reasons"])})
    exact_mapping = context["complete"] and not report["errors"] and bool(basis) and \
        all(any(entry["observation"]["majorMinor"] == dev and
                entry["observation"]["kernel"] is not None for entry in report["devices"])
            for dev in context["source"])
    reasons = [] if exact_mapping else [{
        "code": "source-mapping-unknown",
        "message": "Source/root/boot ancestry is incomplete or unsupported (including overlay/loop).",
    }]
    result = {"schemaVersion": 1, "readOnly": True, "writeAuthorized": False,
              "generation": "readonly-" + uuid.uuid4().hex, "report": report,
              "source": {"kind": "downloaded" if exact_mapping else "unknown", "description": description,
                         "downloadedBytes": total, "memoryLogicalBytes": None,
                         "exactSourceMapping": bool(exact_mapping),
                         "kernelBasis": basis, "reasons": reasons}}
    bounded(result)
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False)
    if len(encoded.encode("utf8")) + 1 > MAX_OUTPUT:
        raise ValueError("Read-only envelope exceeds output limit")
    return encoded


def main():
    try:
        if len(sys.argv) != 1 or not sys.flags.isolated or not sys.flags.no_site:
            raise ValueError("Fixed helper requires isolated no-site Python and no arguments")
        print(acquire())
        return 0
    except (OSError, ValueError, UnicodeError) as error:
        print("[install-targets] " + str(error)[:4096], file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
