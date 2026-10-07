#!/usr/bin/python3 -I
"""Root-only iwd clean-stop checkpoints, not a connection/polkit API.

See desktop/NETWORK-STATE.md for iwd 3.8 storage/parser assumptions. iwd owns
credentials in volatile /var/lib/iwd; only qualified .open/.psk bytes cross this
boundary. Installed startup never initializes or imports an empty template.
"""
import argparse
import ctypes
import errno
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import syslog
import uuid

SCHEMA = 1
PROFILE_LIMIT = 65536
PROFILE_COUNT = 256
RESERVE = 1024 * 1024
STATE = "/SystemData/Network"
IWD = "/var/lib/iwd"
RUNTIME = "/run/polly-network-state"


def deployment():
    """Bootstrap trust before importing either privileged helper."""
    expected = Path("/usr/lib/polly-network/state.py")
    if Path(__file__).absolute() != expected:
        raise ValueError("Network lifecycle helper is not at its fixed deployment path")
    for name in ("/", "/usr", "/usr/lib", "/usr/lib/polly-network",
                 "/usr/lib/polly-storage", "/usr/sbin", "/usr/bin", "/usr/libexec"):
        info = Path(name).lstat()
        if not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid) != (0, 0) or \
                info.st_mode & 0o022:
            raise ValueError("Unsafe network helper deployment ancestor")
    for name, mode in ((str(expected), 0o755), ("/usr/lib/polly-storage/storage.py", 0o755),
                       ("/usr/lib/polly-storage/layout.py", 0o644),
                       ("/usr/sbin/polly-accounts", 0o755),
                       ("/usr/bin/systemctl", 0o755), ("/usr/bin/findmnt", 0o755),
                       ("/usr/libexec/iwd", 0o755)):
        info = Path(name).lstat()
        if not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid, info.st_nlink,
                stat.S_IMODE(info.st_mode)) != (0, 0, 1, mode):
            raise ValueError("Unsafe network helper deployment program")


def no_new_privileges():
    # systemd's '+' bypasses its NoNewPrivileges sandbox gate, so restore this
    # process-local protection before invoking only the fixed non-setuid tools.
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong,
                          ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot restrict network helper privilege gains")


def module(name, path):
    spec = importlib.util.spec_from_loader(name, importlib.machinery.SourceFileLoader(name, str(path)))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate network state field")
        result[key] = value
    return result


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"


def profile_name(name):
    """Match iwd storage_network_ssid_from_path; no SSID appears in diagnostics."""
    if not isinstance(name, str) or "." not in name:
        raise ValueError("Unsupported network state entry")
    ssid, suffix = name.rsplit(".", 1)
    if suffix not in ("open", "psk"):
        raise ValueError("Unsupported network profile class")
    if ssid.startswith("="):
        if not re.fullmatch(r"=(?:[0-9a-f]{2}){1,32}", ssid):
            raise ValueError("Invalid encoded network profile name")
        try:
            decoded = bytes.fromhex(ssid[1:]).decode("utf8")
        except UnicodeDecodeError as error:
            raise ValueError("Invalid encoded network profile name") from error
        if "\0" in decoded:
            raise ValueError("Invalid encoded network profile name")
    elif not re.fullmatch(r"[A-Za-z0-9 _-]{1,32}", ssid):
        raise ValueError("Invalid network profile name")
    return name


def profile_text(contents):
    """Bound opaque iwd/ell text; intentionally do not reinterpret credentials."""
    if len(contents) > PROFILE_LIMIT or b"\0" in contents:
        raise ValueError("Invalid network profile encoding or size")
    try:
        return contents.decode("utf8")
    except UnicodeDecodeError as error:
        raise ValueError("Invalid network profile encoding or size") from error


def identities(profiles):
    if len(profiles) > PROFILE_COUNT:
        raise ValueError("Too many network profiles")
    seen = set()
    for name in profiles:
        profile_name(name)
        ssid, suffix = name.rsplit(".", 1)
        key = (bytes.fromhex(ssid[1:]) if ssid.startswith("=") else ssid.encode("ascii"), suffix)
        if key in seen:
            raise ValueError("Ambiguous duplicate network profile identity")
        seen.add(key)


class NetworkState:
    def __init__(self, storage, accounts, root=Path("/")):
        self.root = root
        self.storage_module = storage
        self.accounts = accounts
        self.runtime = self.path(RUNTIME)
        self.iwd = self.path(IWD)
        self.network = self.path(STATE)

    def path(self, name):
        return self.root / name.lstrip("/")

    def trusted(self, path, directory=True, mode=0o700, gid=0):
        info = self.storage_module.Storage.trusted(
            self, path, directory=directory, uid=0, gid=gid, mode=mode)
        if not directory and info.st_nlink != 1:
            raise ValueError("Linked network state is not authoritative")
        return info

    def read(self, path, limit=PROFILE_LIMIT, mode=0o600, gid=0):
        self.trusted(path, directory=False, mode=mode, gid=gid)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid, info.st_nlink,
                    stat.S_IMODE(info.st_mode)) != (0, gid, 1, mode) or \
                    info.st_dev != path.parent.stat().st_dev:
                raise ValueError("Unsafe network state record")
            with os.fdopen(descriptor, "rb", closefd=False) as source:
                contents = source.read(limit + 1)
        finally:
            os.close(descriptor)
        if len(contents) > limit:
            raise ValueError("Network state exceeds its size limit")
        return contents

    def record(self, path, limit=131072):
        return json.loads(self.read(path, limit), object_pairs_hook=unique)

    def profile(self):
        contents = self.read(self.path("/etc/polly-account-profile"), 16, mode=0o644)
        if contents not in (b"live\n", b"installed\n"):
            raise ValueError("Network service requires a final Live or installed profile")
        mode = contents[:-1].decode("ascii")
        guard = self.path("/usr/lib/polly-account-profile-check")
        self.trusted(guard, directory=False, mode=0o755)
        result = subprocess.run([str(guard), mode], capture_output=True, timeout=10,
                                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"})
        if result.returncode:
            raise ValueError("Trusted account profile guard refused network startup")
        contents = self.read(self.path("/etc/iwd/main.conf"), PROFILE_LIMIT, mode=0o644)
        profile_text(contents)
        return mode

    def stopped(self):
        result = subprocess.run(["/usr/bin/systemctl", "show", "iwd.service",
                                 "--property=MainPID", "--value"],
                                capture_output=True, text=True, timeout=10)
        if result.returncode or result.stdout.strip() != "0":
            raise ValueError("Network checkpoint requires a stopped iwd main process")

    def volatile(self, live=False):
        if live:
            record = self.storage_module.command(
                "/usr/bin/findmnt", "-rn", "-M", str(self.root), "-o", "FSTYPE,OPTIONS").split()
            if len(record) != 2 or record[0] not in ("tmpfs", "ramfs", "rootfs") or \
                    "rw" not in record[1].split(","):
                raise ValueError("Live network state requires a memory-only root")
            if not self.iwd.exists() and not self.iwd.is_symlink():
                self.trusted(self.iwd.parent, mode=0o755)
                self.iwd.mkdir(mode=0o700)
        else:
            record = self.storage_module.command(
                "/usr/bin/findmnt", "-rn", "-M", str(self.iwd), "-o", "FSTYPE,OPTIONS").split()
            if len(record) != 2 or record[0] != "tmpfs" or \
                    not {"rw", "nodev", "nosuid"}.issubset(record[1].split(",")):
                raise ValueError("Installed iwd working state requires its private tmpfs")
        self.trusted(self.iwd)

    def memory_runtime(self, mode):
        run = self.path("/run")
        self.trusted(run, mode=0o755)
        self.trusted(self.runtime)
        flags = {"rw", "nodev", "nosuid"} if mode == "installed" else {"rw"}
        for option, path in (("-M", run), ("-T", self.runtime)):
            record = self.storage_module.command(
                "/usr/bin/findmnt", "-rn", option, str(path), "-o", "FSTYPE,OPTIONS").split()
            if len(record) != 2 or record[0] != "tmpfs" or \
                    not flags.issubset(record[1].split(",")):
                raise ValueError("Network handoff requires writable private RAM runtime")
        if self.runtime.stat().st_dev != run.stat().st_dev:
            raise ValueError("Network handoff runtime is not on the run tmpfs")

    def writable(self, path, required):
        info = os.statvfs(path)
        if info.f_flag & os.ST_RDONLY:
            raise OSError(errno.EROFS, "Network state is read-only")
        if info.f_bavail * info.f_frsize < required + RESERVE or info.f_favail < PROFILE_COUNT + 8:
            raise OSError(errno.ENOSPC, "Network checkpoint reserve is unavailable")

    def authority(self):
        storage = self.storage_module.Storage(self.root)
        storage.check()
        self.trusted(self.network)
        source = storage.persistent / "SystemData/Network"
        self.trusted(source)
        if not os.path.samestat(source.stat(), self.network.stat()):
            raise ValueError("Network authority is not the required persistent mapping")
        self.writable(self.network, 0)
        value, profiles = self.snapshot(self.network, storage.volumes["PERSISTENT"])
        return storage, value, profiles

    def snapshot(self, network, persistent_uuid):
        self.trusted(network)
        value = self.record(network / "state.json")
        if not isinstance(value, dict) or set(value) != {
                "schemaVersion", "persistentUuid", "generation", "profiles"} or \
                type(value["schemaVersion"]) is not int or value["schemaVersion"] != SCHEMA or \
                value["persistentUuid"] != persistent_uuid or \
                not isinstance(value["generation"], str) or \
                not re.fullmatch(r"Snapshot[0-9a-f]{32}", value["generation"]) or \
                not isinstance(value["profiles"], dict) or len(value["profiles"]) > PROFILE_COUNT:
            raise ValueError("Incompatible network snapshot identity, schema or index")
        directory = network / value["generation"]
        self.trusted(directory)
        if directory.stat().st_dev != network.stat().st_dev or \
                set(os.listdir(directory)) != set(value["profiles"]):
            raise ValueError("Network snapshot contains missing or unclassified state")
        identities(value["profiles"])
        profiles = {}
        for name, digest in value["profiles"].items():
            profile_name(name)
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("Invalid network profile digest")
            contents = self.read(directory / name)
            profile_text(contents)
            if hashlib.sha256(contents).hexdigest() != digest:
                raise ValueError("Network profile integrity check failed")
            profiles[name] = contents
        return value, profiles

    def working(self):
        self.trusted(self.iwd)
        entries = os.listdir(self.iwd)
        if len(entries) > PROFILE_COUNT + 2:
            raise ValueError("Too many network state entries")
        profiles = {}
        for name in entries:
            path = self.iwd / name
            if name == "hotspot":
                self.trusted(path)
                if any(path.iterdir()):
                    raise ValueError("Hotspot persistence is not supported")
            elif name == ".known_network.freq":
                self.read(path)
            else:
                profile_name(name)
                profiles[name] = self.read(path)
                profile_text(profiles[name])
        identities(profiles)
        return profiles

    def lease(self, invocation):
        value = self.record(self.runtime / "lease.json", 1024)
        if not isinstance(value, dict) or set(value) != {
                "schemaVersion", "persistentUuid", "generation", "invocationId"} or \
                type(value["schemaVersion"]) is not int or value["schemaVersion"] != SCHEMA or \
                value["invocationId"] != invocation:
            raise ValueError("Missing or mismatched network service handoff")
        return value

    def sync(self, path):
        self.trusted(path)
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def publish(self, network, persistent_uuid, profiles):
        self.trusted(network)
        identities(profiles)
        for contents in profiles.values():
            profile_text(contents)
        self.writable(network, sum(map(len, profiles.values())) + 131072)
        generation = "Snapshot" + uuid.uuid4().hex
        directory = network / generation
        directory.mkdir(mode=0o700)
        index = {}
        for name, contents in profiles.items():
            profile_name(name)
            self.accounts.atomic(directory / name, profile_text(contents), mode=0o600)
            self.trusted(directory / name, directory=False, mode=0o600)
            index[name] = hashlib.sha256(contents).hexdigest()
        self.sync(directory)
        self.sync(network)
        value = {"schemaVersion": SCHEMA, "persistentUuid": persistent_uuid,
                 "generation": generation, "profiles": index}
        self.accounts.atomic(network / "state.json", encode(value), mode=0o600)
        self.snapshot(network, persistent_uuid)
        return value

    def load(self, invocation, mode):
        self.stopped()
        self.volatile(live=mode == "live")
        if mode == "live":
            return {"schemaVersion": SCHEMA, "mode": mode, "operation": "load",
                    "persistent": False, "checkpoint": "not-applicable"}
        storage, value, profiles = self.authority()
        lease = self.runtime / "lease.json"
        if lease.exists() or lease.is_symlink():
            raise ValueError("Uncommitted iwd working state requires explicit recovery")
        working = self.working()
        if working and working != profiles:
            raise ValueError("Refusing to import or replace a second network state tree")
        self.writable(self.iwd, sum(map(len, profiles.values())))
        for name, contents in profiles.items():
            self.accounts.atomic(self.iwd / name, profile_text(contents), mode=0o600)
        self.sync(self.iwd)
        self.accounts.atomic(lease, encode({
            "schemaVersion": SCHEMA, "persistentUuid": storage.volumes["PERSISTENT"],
            "generation": value["generation"], "invocationId": invocation}), mode=0o600)
        return {"schemaVersion": SCHEMA, "mode": mode, "operation": "load",
                "persistent": True, "checkpoint": "loaded", "profileCount": len(profiles)}

    def save(self, invocation, service_result, mode):
        self.stopped()
        self.volatile(live=mode == "live")
        if mode == "live":
            return {"schemaVersion": SCHEMA, "mode": mode, "operation": "save",
                    "persistent": False, "checkpoint": "not-applicable"}
        if service_result != "success":
            raise ValueError("Unclean iwd termination cannot commit network state")
        storage, value, _ = self.authority()
        lease = self.lease(invocation)
        if lease["persistentUuid"] != storage.volumes["PERSISTENT"] or \
                lease["generation"] != value["generation"]:
            raise ValueError("Network authority changed during the service invocation")
        profiles = self.working()
        self.publish(self.network, storage.volumes["PERSISTENT"], profiles)
        return {"schemaVersion": SCHEMA, "mode": mode, "operation": "save",
                "persistent": True, "checkpoint": "committed", "profileCount": len(profiles)}

    def run(self, operation, invocation, service_result=""):
        if os.getuid() != 0 or os.geteuid() != 0:
            raise PermissionError("Network state lifecycle requires the real local root caller")
        if operation not in ("load", "save") or \
                not isinstance(invocation, str) or not re.fullmatch(r"[0-9a-f]{32}", invocation):
            raise ValueError("Invalid network service operation or invocation")
        self.trusted(self.runtime)
        mode = self.profile()
        self.memory_runtime(mode)
        with self.accounts.state_lock(root=self.runtime, timeout=0):
            self.trusted(self.runtime / ".state.lock", directory=False, mode=0o600)
            result = self.load(invocation, mode) if operation == "load" else \
                self.save(invocation, service_result, mode)
        if operation == "save" and result["persistent"]:
            # The durable commit, read-back and lock close have all completed.
            # RAM guard release is last: no fallible checkpoint work follows it.
            (self.runtime / "lease.json").unlink()
        return result


def initialize_empty(network, persistent_uuid, storage, accounts, assembly_root, *, image_root):
    """Fresh-image assembly API only: refuses any existing state; no runtime CLI."""
    if os.getuid() != 0 or os.geteuid() != 0:
        raise PermissionError("Fresh network state requires root image assembly")
    if not isinstance(persistent_uuid, str) or not re.fullmatch(
            r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", persistent_uuid):
        raise ValueError("Invalid fresh persistent volume identity")
    state = NetworkState(storage, accounts, root=assembly_root)
    state.trusted(network)
    if any(network.iterdir()):
        raise ValueError("Fresh network state must be empty; migration is unavailable")
    state.trusted(image_root, mode=0o755)
    if state.read(image_root / "etc/polly-account-profile", 16, mode=0o644) != b"installed\n":
        raise ValueError("Fresh network state requires the final installed image profile")
    accounts.identities(state.read(image_root / "etc/passwd", mode=0o644).decode("utf8"))
    groups = state.read(image_root / "etc/group", mode=0o644).decode("utf8").splitlines()
    shadow_groups = [line.split(":") for line in groups if line.split(":")[0] == "shadow"]
    if len(shadow_groups) != 1 or len(shadow_groups[0]) != 4 or \
            not shadow_groups[0][2].isdigit() or not 0 <= int(shadow_groups[0][2]) <= 65535:
        raise ValueError("Fresh image shadow group is unavailable")
    shadow = image_root / "etc/shadow"
    mode = stat.S_IMODE(shadow.lstat().st_mode)
    if mode not in (0o600, 0o640):
        raise ValueError("Unsafe fresh image shadow permissions")
    contents = state.read(shadow, mode=mode, gid=int(shadow_groups[0][2])).decode("utf8")
    selected = "\n".join(line for line in contents.splitlines()
                         if line.split(":")[0] in {"root", "polly"}) + "\n"
    if any(record[1] not in {"!", "!!", "*", "!*"}
           for record in accounts.password_records(selected).values()):
        raise ValueError("Fresh network state refuses configured image credentials")
    return state.publish(network, persistent_uuid, {})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("load", "save"))
    args = parser.parse_args()
    try:
        if os.getuid() != 0 or os.geteuid() != 0:
            raise PermissionError(errno.EPERM, "Network lifecycle requires the real local root caller")
        deployment()
        no_new_privileges()
        sys.dont_write_bytecode = True
        storage = module("network_storage", Path("/usr/lib/polly-storage/storage.py"))
        accounts = module("network_accounts", Path("/usr/sbin/polly-accounts"))
        result = NetworkState(storage, accounts).run(
            args.operation, os.environ.get("INVOCATION_ID", ""), os.environ.get("SERVICE_RESULT", ""))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Underlying parsers/OS exceptions can include profile names or contents.
        code = {errno.ENOSPC: "no-space", errno.EROFS: "read-only", errno.ENOENT: "missing-state",
                errno.EACCES: "permission", errno.EPERM: "permission", errno.ELOOP: "unsafe-link"
                }.get(getattr(error, "errno", None), "state-or-service-invalid")
        message = "POLLY_NETWORK_STATE_FAILED: " + encode({
            "schemaVersion": SCHEMA, "operation": args.operation, "status": "refused",
            "error": code, "checkpoint": "not-confirmed"}).strip()
        syslog.syslog(syslog.LOG_ERR, message)
        print(message, file=sys.stderr, flush=True)
        return 1
    print(encode(result), end="", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
