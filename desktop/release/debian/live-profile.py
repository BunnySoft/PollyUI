#!/usr/bin/env python3
"""Source-owned hardware SKU package/marker contract, separate from account profiles."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import runpy
import stat

MANIFEST = Path(__file__).with_name("live-profiles.json")
MARKER = "etc/polly-hardware-profile.json"
PROFILE_COPY = "usr/share/polly-live-profiles.json"
SKUS = {"full", "vm", "intel", "nvidia"}


def keys(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError("Invalid hardware profile manifest fields")


def strings(value, pattern=None):
    if (not isinstance(value, list) or not value or
            any(not isinstance(item, str) or not item or
                pattern and not re.fullmatch(pattern, item) for item in value) or
            len(set(value)) != len(value)):
        raise ValueError("Invalid/duplicate hardware profile list")


def load(path=MANIFEST):
    value = json.loads(path.read_bytes())
    keys(value, ("schemaVersion", "distribution", "architecture", "defaultSku",
                 "packageGroups", "shared", "profiles"))
    if (type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1 or value["distribution"] != "debian13" or
            value["architecture"] != "x86_64" or value["defaultSku"] != "full"):
        raise ValueError("Unsupported hardware profile manifest")
    keys(value["packageGroups"], ("common", "intelGraphics", "nvidiaGraphics", "physicalNetworkAudio"))
    packages = []
    for group in value["packageGroups"].values():
        strings(group, r"[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+:~_-]+)?")
        packages.extend(item.split("=")[0] for item in group)
    if len(set(packages)) != len(packages):
        raise ValueError("Duplicate package across hardware groups")
    strings(value["shared"])
    keys(value["profiles"], SKUS)
    for profile in value["profiles"].values():
        keys(profile, ("packageGroups", "requiredModules", "support"))
        strings(profile["packageGroups"])
        strings(profile["requiredModules"], r"[a-z][a-z0-9_]*")
        strings(profile["support"])
        if ("common" not in profile["packageGroups"] or
                set(profile["packageGroups"]) - value["packageGroups"].keys()):
            raise ValueError("Unknown/missing hardware package group")
    return value


def select(text):
    if not isinstance(text, str) or not text:
        raise ValueError("Empty hardware SKU selection")
    result = text.split(",")
    if len(set(result)) != len(result) or any(item not in SKUS for item in result):
        raise ValueError("Unknown, empty or duplicate hardware SKU")
    return result


def profile(sku, path=MANIFEST):
    if select(sku) != [sku]:
        raise ValueError("Expected exactly one hardware SKU")
    value = load(path)
    selected = value["profiles"][sku]
    required = [pkg for name in selected["packageGroups"] for pkg in value["packageGroups"][name]]
    forbidden = [pkg.split("=")[0] for name, group in value["packageGroups"].items()
                 if name not in selected["packageGroups"] for pkg in group]
    return {"sku": sku, "manifestSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "requiredPackages": required, "forbiddenPackages": forbidden,
            "requiredModules": selected["requiredModules"],
            "support": selected["support"], "shared": value["shared"]}


def marker(sku, path=MANIFEST):
    selected = profile(sku, path)
    return (json.dumps({"schemaVersion": 1, "sku": sku,
                        "manifestSha256": selected["manifestSha256"]}, indent=2) + "\n").encode()


def regular(path, expected=None):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid or info.st_gid or
            stat.S_IMODE(info.st_mode) != 0o644 or info.st_nlink != 1 or
            expected is not None and path.read_bytes() != expected):
        raise ValueError("Hardware profile metadata/source mismatch: " + str(path))


def packages(root):
    result = {}
    for paragraph in (root / "var/lib/dpkg/status").read_text().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in paragraph.splitlines()
                      if ": " in line and not line.startswith((" ", "\t")))
        if fields.get("Status") != "install ok installed":
            continue
        name = fields["Package"]
        if name in result:
            raise ValueError("Duplicate installed package: " + name)
        size = fields.get("Installed-Size", "")
        if not re.fullmatch(r"\d+", size):
            raise ValueError("Invalid dpkg installed size: " + name)
        result[name] = {"version": fields["Version"], "architecture": fields["Architecture"],
                        "installedSizeBytes": int(size) * 1024}
    if not result:
        raise ValueError("No installed Debian packages")
    return result


def verify_packages(installed, selected):
    allowed = {spec.split("=")[0] for spec in selected["requiredPackages"]}
    for spec in selected["requiredPackages"]:
        name, _, version = spec.partition("=")
        if name not in installed or version and installed[name]["version"] != version:
            raise ValueError("Missing/wrong hardware profile package: " + spec)
    for name in selected["forbiddenPackages"]:
        if name in installed:
            raise ValueError("Forbidden hardware profile package: " + name)
    if any(name.startswith("firmware-") and name not in allowed for name in installed):
        raise ValueError("Undeclared hardware firmware package")


def verify(root, sku=None, path=MANIFEST):
    explicit = sku is not None
    selected = profile(sku if explicit else "full", path)
    target, copy = root / MARKER, root / PROFILE_COPY
    if explicit or target.exists() or target.is_symlink() or copy.exists() or copy.is_symlink():
        regular(target, marker(selected["sku"], path))
        regular(copy, path.read_bytes())
    verify_packages(packages(root), selected)
    return selected


def clean_runtime(root, path=MANIFEST):
    installed = packages(root)
    forbidden = {pkg.split("=")[0] for name, group in load(path)["packageGroups"].items()
                 if name != "common" for pkg in group}
    payload = [root / "usr/lib/firmware", root / "usr/lib/modules"]
    if (any(name in forbidden or name.startswith("firmware-") for name in installed) or
            any(not file.is_dir() for directory in payload if directory.exists() for file in directory.rglob("*")) or
            any((root / name).exists() or (root / name).is_symlink()
                for name in (MARKER, PROFILE_COPY, "etc/polly-account-profile", "init")) or
            any(name.startswith("linux-image-") for name in installed) or
            any((root / "boot").glob("vmlinuz*"))):
        raise ValueError("SKU assembly requires a clean common runtime, not a full/platform/Live base")


def installed_input(root):
    target, copy = root / MARKER, root / PROFILE_COPY
    present = [path.exists() or path.is_symlink() for path in (target, copy)]
    if any(present):
        if not all(present):
            raise ValueError("Incomplete hardware profile artifacts; refusing legacy Install downgrade")
        regular(target)
        value = json.loads(target.read_bytes())
        if value.get("sku") != "full":
            raise ValueError("Install SKU filenames/manifests are not wired: reduced hardware platforms cannot "
                             "become unlabelled installed media. Use the full locked platform.")
        verify(root, "full")


def verify_legacy_export(archive, members):
    if any(name in members for name in (MARKER, PROFILE_COPY)):
        raise ValueError("Legacy initramfs accepts only historical unlabelled roots, not hardware profile artifacts")
    origin = members.get("usr/share/pollyui/runtime-origin.json")
    if origin is not None:
        if not origin.isfile() or origin.size > 1024 * 1024:
            raise ValueError("Invalid legacy runtime origin")
        with archive.extractfile(origin) as source:
            value = json.loads(source.read())
        if not isinstance(value, dict) or any(key in value for key in ("sku", "hardwareProfile", "nativeRuntime")):
            raise ValueError("Legacy initramfs cannot contain a hardware SKU runtime origin")


def size_report(root, sku, repo):
    selected = verify(root, sku)
    installed = packages(root)
    resolver = runpy.run_path(str(repo / "desktop/tools/live-root.py"))["root_file"]
    records = []
    for name, item in sorted(installed.items()):
        lists = [root / f"var/lib/dpkg/info/{name}:{item['architecture']}.list",
                 root / f"var/lib/dpkg/info/{name}.list"]
        listing = next((file for file in lists if file.is_file() and not file.is_symlink()), None)
        if listing is None:
            raise ValueError("Missing actual package file list: " + name)
        total = 0
        seen = set()
        for line in listing.read_text().splitlines():
            if not line.startswith("/") or "\0" in line:
                raise ValueError("Invalid package file list: " + name)
            file = resolver(root, str(PurePosixPath(line).parent)) / PurePosixPath(line).name
            if file in seen:
                continue
            seen.add(file)
            if file.exists() and not file.is_symlink() and file.is_file():
                total += file.stat().st_size
        records.append({"name": name, **item, "regularFileBytes": total})
    return {"schemaVersion": 1, "sku": sku, "manifestSha256": selected["manifestSha256"],
            "packages": records,
            "limits": ["dpkg Installed-Size is package metadata, not compressed ISO bytes.",
                       "regularFileBytes measures package-listed regular files in the actual assembled root; "
                       "shared ownership can overlap and generated/unowned files are not attributed.",
                       "The payload root excludes /boot; boot kernel/microcode are separate media files.",
                       "Complete shared kernel/Mesa/Vulkan/LLVM/native runtime remains; no predicted ISO savings."]}


def validate_media(value):
    if "sku" not in value:
        if any(key in value for key in ("hardwareProfile", "nativeRuntime", "sizeReport")):
            raise ValueError("Unlabelled hardware profile receipt")
        return None
    selected = profile(value["sku"])
    identity = {key: selected[key] for key in ("sku", "manifestSha256")}
    if (value.get("distribution") != "debian13" or value.get("hardwareProfile") != selected or
            not isinstance(value.get("root"), dict) or value["root"].get("hardwareProfile") != identity):
        raise ValueError("Root/boot hardware profile differs from source manifest")
    native = value.get("nativeRuntime", {})
    if (not re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", native.get("imageID", "")) or
            not re.fullmatch(r"[0-9a-f]{40}", native.get("sourceRevision", "")) or
            not re.fullmatch(r"[0-9a-f]{64}", native.get("manifestSha256", "")) or
            value.get("runtimeImage") != native["imageID"] or
            not re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", value.get("imageToolsID", ""))):
        raise ValueError("Missing immutable common native runtime/tools identity")
    for key, suffix in (("iso", "uefi-live.iso"), ("usb", "uefi-usb.img")):
        if value.get(key, {}).get("name") != f"pollydesktop-{value['version']}-debian13-{value['sku']}-x86_64-{suffix}":
            raise ValueError("Media filename does not match hardware SKU")
    report = value.get("sizeReport", {})
    if (report.get("sku") != value["sku"] or report.get("manifestSha256") != selected["manifestSha256"] or
            not isinstance(report.get("packages"), list) or not report["packages"]):
        raise ValueError("Missing actual hardware package size report")
    installed = {}
    for item in report["packages"]:
        if (not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", item.get("name", "")) or
                item["name"] in installed or not isinstance(item.get("version"), str) or not item["version"] or
                any(type(item.get(key)) is not int or item[key] < 0
                    for key in ("installedSizeBytes", "regularFileBytes"))):
            raise ValueError("Invalid hardware package size record")
        installed[item["name"]] = item
    verify_packages(installed, selected)
    inventory = {item["name"].removesuffix(":amd64"): item["version"] for item in value["packages"]}
    if (len(value["packages"]) != len(installed) or
            inventory != {name: item["version"] for name, item in installed.items()}):
        raise ValueError("Hardware size report differs from media package inventory")
    root, boot = value["root"], value["root"]["bootstrap"]
    expected = {"isoBytes": value["iso"]["size"], "usbBytes": value["usb"]["size"],
                "rootBytes": root["size"], "rootUncompressedBytes": value["uncompressedPayloadBytes"],
                "bootstrapBytes": boot["size"], "bootstrapUncompressedBytes": boot["uncompressedBytes"]}
    if report.get("media") != expected:
        raise ValueError("Hardware size report differs from actual media totals")
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["describe", "packages", "modules", "mark", "verify", "clean-runtime", "installed-input"])
    parser.add_argument("--sku")
    parser.add_argument("--root", type=Path, default=Path("/"))
    args = parser.parse_args()
    if args.command == "clean-runtime":
        clean_runtime(args.root)
    elif args.command == "installed-input":
        installed_input(args.root)
    elif args.command == "describe":
        print(json.dumps({"profile": profile(args.sku), "marker": marker(args.sku).decode()}))
    elif args.command == "packages":
        print(" ".join(profile(args.sku)["requiredPackages"]))
    elif args.command == "modules":
        print(" ".join(profile(args.sku)["requiredModules"]))
    elif args.command == "mark":
        if any((args.root / name).exists() or (args.root / name).is_symlink() for name in (MARKER, PROFILE_COPY)):
            raise ValueError("Refusing to replace a hardware profile")
        for name, data in ((MARKER, marker(args.sku)), (PROFILE_COPY, MANIFEST.read_bytes())):
            target = args.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o644)
        verify(args.root, args.sku)
    else:
        verify(args.root, args.sku)


if __name__ == "__main__":
    main()
