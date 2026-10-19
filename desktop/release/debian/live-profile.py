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
BASIC_MODPROBE = "etc/modprobe.d/polly-basic.conf"
SKUS = {"basic", "vm", "intel", "nvidia", "amd", "full"}


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
                 "packageGroups", "shared", "displayPolicies", "profiles"))
    if (type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1 or value["distribution"] != "debian13" or
            value["architecture"] != "x86_64" or value["defaultSku"] != "full"):
        raise ValueError("Unsupported hardware profile manifest")
    keys(value["packageGroups"], ("common", "stockKernel", "intelGraphics", "nvidiaGraphics", "amdGraphics", "physicalNetworkAudio"))
    packages = []
    for group in value["packageGroups"].values():
        strings(group, r"[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+:~_-]+)?")
        packages.extend(item.split("=")[0] for item in group)
    if len(set(packages)) != len(packages):
        raise ValueError("Duplicate package across hardware groups")
    strings(value["shared"])
    keys(value["displayPolicies"], ("native", "vm", "basic"))
    for name, policy in value["displayPolicies"].items():
        keys(policy, ("kind", "bootstrapModules", "blockedModules", "kernelArguments"))
        if policy["kind"] != {"native": "native-kms", "vm": "virtual-kms", "basic": "simpledrm-software"}[name]:
            raise ValueError("Invalid hardware display policy")
        strings(policy["bootstrapModules"], r"[a-z][a-z0-9_]*")
        for key, pattern in (("blockedModules", r"[a-z][a-z0-9_]*"),
                             ("kernelArguments", r"[a-z_.]+=[a-z0-9_,]+")):
            if policy[key] != []:
                strings(policy[key], pattern)
        if name == "basic":
            blocked = ",".join(policy["blockedModules"])
            if (not blocked or policy["bootstrapModules"] != ["simpledrm"] or
                    policy["kernelArguments"] != ["module_blacklist=" + blocked, "modprobe.blacklist=" + blocked]):
                raise ValueError("Basic must retain simpledrm and block competing native drivers")
        elif policy["blockedModules"] or policy["kernelArguments"]:
            raise ValueError("Native/VM display policy cannot acquire basic restrictions")
    keys(value["profiles"], SKUS)
    for name, profile in value["profiles"].items():
        keys(profile, ("packageGroups", "displayPolicy", "kernelPolicy", "requiredModules", "support"))
        if profile["displayPolicy"] != (name if name in ("basic", "vm") else "native"):
            raise ValueError("Profile/display policy mismatch")
        if (profile["kernelPolicy"] != ("basic-pack" if name == "basic" else "stock") or
                ("stockKernel" in profile["packageGroups"]) != (name != "basic")):
            raise ValueError("Profile/kernel package policy mismatch")
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
            "displayPolicy": value["displayPolicies"][selected["displayPolicy"]],
            "kernelPolicy": selected["kernelPolicy"],
            "support": selected["support"], "shared": value["shared"]}


def marker(sku, path=MANIFEST):
    selected = profile(sku, path)
    return (json.dumps({"schemaVersion": 1, "sku": sku,
                        "manifestSha256": selected["manifestSha256"]}, indent=2) + "\n").encode()


def modprobe_policy(sku, path=MANIFEST):
    if sku != "basic":
        return None
    return ("".join("blacklist " + name + "\n" for name in profile(sku, path)["displayPolicy"]["blockedModules"])).encode()


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
    if selected["kernelPolicy"] == "basic-pack":
        kernels = [name for name in installed if name.startswith("linux-image-")]
        if len(kernels) != 1 or not kernels[0].endswith("-polly-basic"):
            raise ValueError("basic requires exactly one verified dedicated kernel, not the stock kernel/meta")


def verify(root, sku=None, path=MANIFEST):
    explicit = sku is not None
    selected = profile(sku if explicit else "full", path)
    target, copy = root / MARKER, root / PROFILE_COPY
    present = target.exists() or target.is_symlink() or copy.exists() or copy.is_symlink()
    if explicit or present:
        regular(target, marker(selected["sku"], path))
        regular(copy, path.read_bytes())
        policy = modprobe_policy(selected["sku"], path)
        if policy is not None:
            regular(root / BASIC_MODPROBE, policy)
        elif (root / BASIC_MODPROBE).exists() or (root / BASIC_MODPROBE).is_symlink():
            raise ValueError("Basic modprobe policy cannot leak into another SKU")
    checked = selected
    if not explicit and not present:
        checked = {**selected, "requiredPackages": [spec for spec in selected["requiredPackages"]
                                                   if spec != "firmware-amd-graphics"]}
    verify_packages(packages(root), checked)
    if selected["kernelPolicy"] == "basic-pack":
        runpy.run_path(str(Path(__file__).with_name("basic-kernel.py")))["verify_root"](root)
    return selected


def verify_kernel(config, selected):
    options = dict(line.split("=", 1) for line in config.splitlines() if line.startswith("CONFIG_") and "=" in line)
    if selected["displayPolicy"]["kind"] == "simpledrm-software":
        if options.get("CONFIG_DRM_SIMPLEDRM") not in ("y", "m") or options.get("CONFIG_SYSFB_SIMPLEFB") != "y":
            raise ValueError("basic unsupported by target kernel: requires CONFIG_DRM_SIMPLEDRM=y/m and "
                             "CONFIG_SYSFB_SIMPLEFB=y. EFI/simplefb/Plymouth is not a DRM/KMS desktop; "
                             "use another SKU or a separately approved kernel route.")
        if options.get("CONFIG_FB_SIMPLE") in ("y", "m"):
            raise ValueError("basic dedicated kernel must disable CONFIG_FB_SIMPLE so simpledrm owns the GOP framebuffer")
        if options.get("CONFIG_MODULE_COMPRESS_ZSTD") == "y":
            raise ValueError("basic bootstrap supports uncompressed/XZ/gzip modules, not Zstd module compression")
        if any(options.get(name) not in (None, '""') for name in
               ("CONFIG_SYSTEM_TRUSTED_KEYS", "CONFIG_SYSTEM_REVOCATION_KEYS")):
            raise ValueError("basic unsigned-development kernel must clear distribution trust/revocation key paths")
        key = options.get("CONFIG_MODULE_SIG_KEY")
        if (options.get("CONFIG_MODULE_SIG") == "y" and
                (options.get("CONFIG_MODULE_SIG_ALL") != "y" or key != '"certs/signing_key.pem"')):
            raise ValueError("basic enabled module signing must sign all modules with the automatic build-local key")
        if (options.get("CONFIG_MODULE_SIG_FORCE") == "y" and options.get("CONFIG_MODULE_SIG") != "y"):
            raise ValueError("basic cannot force module signatures without consistent signing")
        if key is not None and key != '"certs/signing_key.pem"':
            raise ValueError("basic module signing must use only the build-local automatic certs/signing_key.pem")
        for option in ("CONFIG_DRM_I915", "CONFIG_DRM_XE", "CONFIG_DRM_NOUVEAU", "CONFIG_DRM_AMDGPU",
                       "CONFIG_DRM_RADEON", "CONFIG_DRM_VIRTIO_GPU", "CONFIG_DRM_HYPERV",
                       "CONFIG_DRM_VMWGFX", "CONFIG_DRM_QXL", "CONFIG_DRM_BOCHS",
                       "CONFIG_DRM_VBOXVIDEO", "CONFIG_DRM_AST", "CONFIG_DRM_MGAG200"):
            if options.get(option) == "y":
                raise ValueError("basic cannot blacklist a competing built-in KMS driver: " + option)
    return selected["displayPolicy"]


def grub_configuration(template, identity, sku=None):
    configuration = template.replace("@POLLY_MEDIA_ID@", identity)
    if sku is None:
        return configuration
    selected = profile(sku)
    if sku == "basic":
        configuration = re.sub(r'    menuentry "[^"]*" --class gpu --id polly-(?:gpu|intel) \{.*?\n    \}\n',
                               "", configuration, flags=re.S)
        configuration = configuration.replace("Start PollyDesktop Live (memory only)",
                                              "Start basic Live (simpledrm, CPU software only)")
        arguments = " ".join(selected["displayPolicy"]["kernelArguments"])
        configuration = configuration.replace("polly_start console=tty0", "polly_start console=tty0 " + arguments)
        if "polly.mode=gpu" in configuration or "nomodeset" in configuration:
            raise ValueError("basic GRUB cannot expose acceleration or disable simpledrm KMS")
    elif sku == "vm":
        configuration = re.sub(r'    menuentry "[^"]*" --class gpu --id polly-intel \{.*?\n    \}\n',
                               "", configuration, flags=re.S)
    elif sku in ("amd", "nvidia"):
        configuration = configuration.replace("Intel GPU (motherboard display)", sku.upper() + " GPU")
        configuration = configuration.replace("polly.gpu=intel", "polly.gpu=" + sku).replace("--id polly-intel", "--id polly-" + sku)
    return configuration


def clean_runtime(root, path=MANIFEST):
    installed = packages(root)
    forbidden = {pkg.split("=")[0] for name, group in load(path)["packageGroups"].items()
                 if name != "common" for pkg in group}
    payload = [root / "usr/lib/firmware", root / "usr/lib/modules"]
    if (any(name in forbidden or name.startswith("firmware-") for name in installed) or
            any(not file.is_dir() for directory in payload if directory.exists() for file in directory.rglob("*")) or
            any((root / name).exists() or (root / name).is_symlink()
                for name in (MARKER, PROFILE_COPY, BASIC_MODPROBE, "etc/polly-account-profile", "init")) or
            any(name.startswith("linux-image-") for name in installed) or
            any((root / "boot").glob("vmlinuz*"))):
        raise ValueError("SKU assembly requires a clean common runtime, not a full/platform/Live base")


def installed_input(root):
    target, copy = root / MARKER, root / PROFILE_COPY
    present = [path.exists() or path.is_symlink() for path in (target, copy)]
    basic_artifacts = any((root / name).exists() or (root / name).is_symlink()
                          for name in (BASIC_MODPROBE, "usr/share/polly-basic-kernel.json", "usr/share/polly-basic-kernel.config"))
    if any(present) or basic_artifacts:
        if not all(present):
            raise ValueError("Incomplete hardware profile artifacts; refusing legacy Install downgrade")
        regular(target)
        value = json.loads(target.read_bytes())
        if value.get("sku") != "full":
            raise ValueError("Install SKU filenames/manifests are not wired: reduced hardware platforms cannot "
                             "become unlabelled installed media. Use the full locked platform.")
        verify(root, "full")


def verify_legacy_export(archive, members):
    if any(name in members for name in (MARKER, PROFILE_COPY, BASIC_MODPROBE,
                                        "usr/share/polly-basic-kernel.json", "usr/share/polly-basic-kernel.config")):
        raise ValueError("Legacy initramfs accepts only historical unlabelled roots, not hardware profile artifacts")
    origin = members.get("usr/share/pollyui/runtime-origin.json")
    if origin is not None:
        if not origin.isfile() or origin.size > 1024 * 1024:
            raise ValueError("Invalid legacy runtime origin")
        with archive.extractfile(origin) as source:
            value = json.loads(source.read())
        if not isinstance(value, dict) or any(key in value for key in ("sku", "hardwareProfile", "nativeRuntime", "configuration")):
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
        if any(key in value for key in ("hardwareProfile", "nativeRuntime", "sizeReport", "configuration")):
            raise ValueError("Unlabelled hardware profile receipt")
        return None
    selected = profile(value["sku"])
    identity = {key: selected[key] for key in ("sku", "manifestSha256")}
    if (value.get("distribution") != "debian13" or value.get("hardwareProfile") != selected or
            not isinstance(value.get("root"), dict) or value["root"].get("hardwareProfile") != identity):
        raise ValueError("Root/boot hardware profile differs from source manifest")
    if (value["root"].get("displayPolicy") != selected["displayPolicy"] or
            value["root"].get("bootstrap", {}).get("graphicsModules") != selected["displayPolicy"]["bootstrapModules"] or
            value.get("grub", {}).get("kernelArguments") != selected["displayPolicy"]["kernelArguments"]):
        raise ValueError("Media/root/bootstrap/GRUB display policy differs from source")
    if value["sku"] == "basic":
        kernel = value.get("kernelInput")
        if not isinstance(kernel, dict) or value["root"].get("kernelInput") != kernel:
            raise ValueError("basic media/root missing exact dedicated kernel input")
        tools = runpy.run_path(str(Path(__file__).with_name("basic-kernel.py")))
        tools["check_manifest"]({key: item for key, item in kernel.items()
                                 if key not in ("packManifestSha256", "imageSha256")})
        if any(not re.fullmatch(r"[0-9a-f]{64}", kernel.get(key, "")) for key in ("packManifestSha256", "imageSha256")):
            raise ValueError("basic media missing kernel pack manifest identity")
    elif "kernelInput" in value or "kernelInput" in value["root"]:
        raise ValueError("Stock SKU cannot acquire an unrequested dedicated kernel")
    native = value.get("nativeRuntime", {})
    if (not re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", native.get("imageID", "")) or
            not re.fullmatch(r"[0-9a-f]{40}", native.get("sourceRevision", "")) or
            not re.fullmatch(r"[0-9a-f]{64}", native.get("manifestSha256", "")) or
            value.get("runtimeImage") != native["imageID"] or
            not re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", value.get("imageToolsID", ""))):
        raise ValueError("Missing immutable common native runtime/tools identity")
    configured = value.get("configuration")
    if (value["root"].get("configuration") != configured or value.get("sizeReport", {}).get("configuration") != configured):
        raise ValueError("Root/size configuration identity mismatch")
    label = ""
    if configured is not None:
        if (configured.get("schemaVersion") != 1 or
                not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", configured.get("name", "")) or
                not re.fullmatch(r"[0-9a-f]{64}", configured.get("planSha256", ""))):
            raise ValueError("Invalid configured media identity")
        label = "-" + configured["name"] + "-" + configured["planSha256"][:12]
    for key, suffix in (("iso", "uefi-live.iso"), ("usb", "uefi-usb.img")):
        if value.get(key, {}).get("name") != f"pollydesktop-{value['version']}-debian13-{value['sku']}{label}-x86_64-{suffix}":
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
    parser.add_argument("command", choices=["describe", "packages", "modules", "mark", "verify", "kernel", "clean-runtime", "installed-input"])
    parser.add_argument("--sku")
    parser.add_argument("--root", type=Path, default=Path("/"))
    parser.add_argument("--config", type=Path)
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
    elif args.command == "kernel":
        if args.config is None:
            parser.error("kernel requires --config")
        verify_kernel(args.config.read_text(), profile(args.sku))
    elif args.command == "mark":
        if any((args.root / name).exists() or (args.root / name).is_symlink() for name in (MARKER, PROFILE_COPY)):
            raise ValueError("Refusing to replace a hardware profile")
        for name, data in ((MARKER, marker(args.sku)), (PROFILE_COPY, MANIFEST.read_bytes())):
            target = args.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o644)
        policy = modprobe_policy(args.sku)
        if policy is not None:
            target = args.root / BASIC_MODPROBE
            if target.exists() or target.is_symlink():
                raise ValueError("Refusing to replace a basic modprobe policy")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(policy)
            target.chmod(0o644)
        verify(args.root, args.sku)
    else:
        verify(args.root, args.sku)


if __name__ == "__main__":
    main()
