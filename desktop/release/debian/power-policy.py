#!/usr/bin/env python3
"""Read-only qualification of approved Debian power resources in an assembly root."""
import argparse
import configparser
import json
from pathlib import Path
import stat
import xml.etree.ElementTree as ET

RESOURCES = (
    ("00-polly-power.rules", "etc/polkit-1/rules.d/00-polly-power.rules"),
    ("live-power.conf", "etc/dbus-1/system.d/polly-live-power.conf"),
    ("power-dependencies.json", "usr/share/pollyui/power-dependencies.json"),
)


def trusted(root, name, mode):
    path = root / name
    directory = root
    for component in Path(name).parent.parts:
        directory /= component
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("Untrusted power resource directory: " + name)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or \
            stat.S_IMODE(info.st_mode) != mode or info.st_nlink != 1:
        raise ValueError("Untrusted power resource owner/type/mode: " + name)
    return path


def qualify(root, repo, inventory_name):
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError("Power qualification requires a trusted private assembly root")
    source = repo / "desktop/release/debian"
    for name, destination in RESOURCES:
        path = trusted(root, destination, 0o644)
        if path.read_bytes() != (source / name).read_bytes().replace(b"\r\n", b"\n"):
            raise ValueError("Power resource differs from its approved source: " + destination)
    contract = json.loads((source / "power-dependencies.json").read_text())
    profile = trusted(root, "etc/polly-account-profile", 0o644).read_text()
    if profile not in ("live\n", "installed\n", "template\n"):
        raise ValueError("Power resources require the Debian Live/installed factory profile")
    identities = [line.split(":") for line in trusted(root, "etc/passwd", 0o644).read_text().splitlines()]
    polly = [item for item in identities if item[0] == contract["account"]]
    if len(polly) != 1 or len(polly[0]) != 7 or polly[0][2] != str(contract["uid"]) or \
            any(item[0] != "polly" and len(item) == 7 and item[2] == "1000" for item in identities):
        raise ValueError("Power policy account must resolve uniquely to ordinary polly UID1000")
    daemon_users = [item for item in identities if item[0] == "polkitd"]
    if len(daemon_users) != 1 or len(daemon_users[0]) != 7 or not daemon_users[0][2].isdigit() or \
            not 1 <= int(daemon_users[0][2]) <= 999 or \
            any(item != daemon_users[0] and len(item) == 7 and item[2] == daemon_users[0][2] for item in identities):
        raise ValueError("Standard polkitd requires its own non-root system identity")
    packages = {}
    for line in trusted(root, inventory_name, 0o644).read_text().splitlines():
        fields = line.split("\t", 2)
        if len(fields) != 3 or not fields[0] or not fields[1]:
            raise ValueError("Invalid power dependency inventory")
        name = fields[0].removesuffix(":amd64")
        if name in packages:
            raise ValueError("Duplicate power dependency inventory package: " + name)
        packages[name] = fields[1]
    for package in contract["newPackages"]:
        if packages.get(package["name"]) != package["version"]:
            raise ValueError("Missing exact power dependency: " + package["name"])
    for name in contract["requiredPackages"]:
        if name not in packages:
            raise ValueError("Missing standard power runtime dependency: " + name)
    executor = root / "usr/bin/pkexec"
    if any(name in packages for name in contract["excludedPackages"]) or executor.exists() or executor.is_symlink():
        raise ValueError("The basic power profile does not install pkexec or compatibility authorization packages")
    trusted(root, "usr/lib/polkit-1/polkitd", 0o755)
    unit = configparser.ConfigParser(interpolation=None)
    unit.read_string(trusted(root, "usr/lib/systemd/system/polkit.service", 0o644).read_text())
    activation = configparser.ConfigParser(interpolation=None)
    activation.read_string(trusted(root,
        "usr/share/dbus-1/system-services/org.freedesktop.PolicyKit1.service", 0o644).read_text())
    if unit.get("Service", "BusName", fallback="") != "org.freedesktop.PolicyKit1" or \
            unit.get("Service", "Type", fallback="") != "notify-reload" or \
            unit.get("Service", "User", fallback="") != "polkitd" or \
            unit.get("Service", "ExecStart", fallback="") != "/usr/lib/polkit-1/polkitd --no-debug --log-level=notice" or \
            activation.get("D-BUS Service", "Name", fallback="") != "org.freedesktop.PolicyKit1" or \
            activation.get("D-BUS Service", "SystemdService", fallback="") != "polkit.service":
        raise ValueError("Missing standard polkit D-Bus/systemd activation")
    for name in ("etc/systemd/system/polkit.service",
                 "etc/dbus-1/system-services/org.freedesktop.PolicyKit1.service"):
        override = root / name
        if override.exists() or override.is_symlink():
            raise ValueError("A custom or masked polkit activation is outside this profile: " + name)
    dropins = root / "etc/systemd/system/polkit.service.d"
    if dropins.exists() or dropins.is_symlink():
        raise ValueError("Custom polkit service drop-ins are outside this profile")
    policy = trusted(root, "usr/share/polkit-1/actions/org.freedesktop.login1.policy", 0o644)
    actions = {item.attrib.get("id") for item in ET.fromstring(policy.read_bytes()).findall("action")}
    if not set(contract["allowedActions"]).issubset(actions):
        raise ValueError("The deployed logind action catalog lacks the approved basic power actions")
    for directory in ("etc/polkit-1/rules.d", "usr/share/polkit-1/rules.d"):
        path = root / directory
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("Untrusted polkit rule directory: " + directory)
        for rule in path.glob("*.rules"):
            if rule.name <= "00-polly-power.rules" and rule.name != "00-polly-power.rules":
                raise ValueError("An earlier authorization rule could bypass the basic power boundary: " + rule.name)
            if rule.name == "00-polly-power.rules" and directory != "etc/polkit-1/rules.d":
                raise ValueError("A second power authorization rule is not part of this profile")
    return contract


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("repo", type=Path)
    parser.add_argument("inventory")
    args = parser.parse_args()
    if args.inventory not in ("usr/share/polly-live-packages.tsv", "usr/share/polly-installed-packages.tsv"):
        parser.error("expected the recorded Live or installed package inventory")
    qualify(args.root, args.repo, args.inventory)
    print("PASS: approved basic logind/polkit power resources and exact dependency inventory; no daemon or action run")
