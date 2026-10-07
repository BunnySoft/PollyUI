#!/usr/bin/env python3
"""Assemble a fresh single-system regular image; recovery boot remains explicitly unavailable."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tarfile
import tempfile
import uuid


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


REPO = Path(__file__).resolve().parents[2]
legacy = load("installed_image", Path(__file__).with_name("build-installed-image.py"))
layout = load("storage_layout", REPO / "desktop/release/storage/layout.py")
homes = load("storage_homes", REPO / "desktop/release/storage/homes.py")
MIB = layout.MIB


def payload_bytes(root):
    total = 0
    for directory, children, files in os.walk(root, followlinks=False):
        total += 4096
        for name in [*children, *files]:
            info = (Path(directory) / name).lstat()
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
            elif stat.S_ISLNK(info.st_mode):
                total += info.st_size + 4096
            elif not stat.S_ISDIR(info.st_mode):
                raise ValueError("Unsupported payload node")
    return max(1, total)


def relocate(root, source, destination):
    origin = root / source
    if not origin.is_dir() or origin.is_symlink():
        raise ValueError("Expected a real source tree: " + source)
    if destination.exists():
        destination.rmdir()
    shutil.move(str(origin), destination)
    mode = 0o1777 if source == "var/tmp" else 0o755
    origin.mkdir(mode=mode)
    origin.chmod(mode)


def seed_users(root, persistent):
    for user in layout.DEFAULT_USERS:
        source = root / ("root" if user["uid"] == 0 else "home/" + user["name"])
        if not source.is_dir() or source.is_symlink():
            raise ValueError("Missing fresh account home")
        for file in source.iterdir():
            if user["uid"] == 0 and file.name == ".ssh" and file.is_dir() and \
                    not file.is_symlink() and not any(file.iterdir()):
                continue
            if file.name not in {".bashrc", ".bash_logout", ".profile"} or \
                    not file.is_file() or file.is_symlink():
                raise ValueError("Refusing existing user content in a fresh image: " + str(file))
            template = root / ("usr/share/base-files/dot" + file.name if user["uid"] == 0
                               else "etc/skel/" + file.name)
            if not template.is_file() or template.is_symlink() or file.read_bytes() != template.read_bytes():
                raise ValueError("User home does not match the fresh system template")
        destination = persistent / "Users" / str(user["uid"])
        relocate(root, str(source.relative_to(root)), destination)
        destination.chmod(0o700)
        os.chown(destination, user["uid"], user["gid"])
        homes.initialize(destination, user)


def prepare_root(root, persistent, identifiers):
    for directory in layout.STATE_DIRECTORIES:
        path = persistent / directory[0]
        path.mkdir(mode=directory[1], parents=True, exist_ok=True)
        path.chmod(directory[1])
    seed_users(root, persistent)
    for mapping in layout.mappings(layout.DEFAULT_USERS):
        if mapping["source"] in {"SystemData/Library/Dpkg", "SystemData/Library/Apt",
                                "SystemData/Logs", "SystemData/Cache", "SystemData/Temporary"}:
            relocate(root, mapping["target"].lstrip("/"), persistent / mapping["source"])
    for path, mode in layout.STATE_DIRECTORIES:
        (persistent / path).chmod(mode)
    for name in ("dev", "proc", "sys", "run", "tmp"):
        (root / name).mkdir(exist_ok=True)
    (root / "tmp").chmod(0o1777)
    legacy.write(root, "etc/hostname", "polly-installed\n")
    legacy.write(root, "etc/hosts", "127.0.0.1 localhost polly-installed\n::1 localhost\n")
    legacy.write(root, "etc/machine-id", uuid.uuid4().hex + "\n")
    (root / "etc/resolv.conf").symlink_to("/run/polly-network/resolv.conf")
    legacy.configure_accounts(root, persistent / "SystemData/Accounts",
                              identifiers["PERSISTENT"], REPO, storage=True)
    contract = layout.contract(identifiers)
    legacy.write(root, layout.MANIFEST_PATH.lstrip("/"), json.dumps(contract, indent=2) + "\n")
    for mapping in contract["mappings"]:
        if mapping["volume"] == "PERSISTENT":
            (root / mapping["target"].lstrip("/")).mkdir(mode=0o755, parents=True, exist_ok=True)
    (root / "run/polly-storage/persistent").mkdir(mode=0o755, parents=True)
    (root / "System").mkdir()
    relocate(root, "boot", root / "System/Boot")
    (root / "System/Boot/efi").mkdir(mode=0o755, exist_ok=True)
    relocate(root, "usr", root / "System/Resources")
    (root / "Recovery").mkdir(mode=0o755)
    (root / "var/lib/iwd").mkdir(mode=0o700, parents=True, exist_ok=True)
    if any((root / "var/lib/iwd").iterdir()):
        raise ValueError("Refusing existing network credentials")
    legacy.write(root, "etc/fstab",
        f"UUID={identifiers['SYSTEM']} / ext4 defaults 0 1\n"
        f"UUID={identifiers['PERSISTENT']} {layout.PERSISTENT_MOUNT} ext4 nodev,nosuid 0 2\n"
        f"UUID={identifiers['EFI']} /System/Boot/efi vfat umask=0022 0 2\n"
        f"UUID={identifiers['RECOVERY']} /Recovery ext4 ro,nodev,nosuid,noexec 0 2\n"
        "tmpfs /tmp tmpfs mode=1777,nodev,nosuid 0 0\n"
        "tmpfs /var/lib/iwd tmpfs mode=0700,nodev,nosuid 0 0\n")
    return contract


def boot_config(identifier, kernel, initrd):
    entries = ["set timeout=10", "set default=0", "serial --unit=0 --speed=115200",
               "terminal_output console serial"]
    for mode, serial in (("baseline", False), ("gpu", False), ("console", False), ("baseline", True)):
        title = "serial VM baseline" if serial else mode
        options = f"root=UUID={identifier} ro rootwait panic=0 console=tty0 polly.mode={mode}"
        if serial:
            options += " console=ttyS0,115200 polly.serial=1"
        entries += [f'menuentry "PollyDesktop single system - {title}" {{',
                    f" search --no-floppy --fs-uuid --set=root {identifier}",
                    f" linux /System/Boot/{kernel} {options}",
                    f" initrd /System/Boot/intel-ucode.img /System/Boot/{initrd}", "}"]
    return "\n".join(entries) + "\n"


def build(args):
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_revision):
        raise ValueError("Expected a full source revision")
    if not stat.S_ISREG(args.export.lstat().st_mode):
        raise ValueError("Export must be a regular file")
    output = args.output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Refusing to overwrite image output")
    with tempfile.TemporaryDirectory(prefix="polly-storage-image-") as temporary:
        stage = Path(temporary)
        root, persistent, recovery = (stage / name for name in ("root", "persistent", "recovery"))
        for directory in (root, persistent, recovery):
            directory.mkdir(mode=0o755)
        with tarfile.open(args.export, "r:") as archive:
            archive.extractall(root, members=legacy.export_members(archive), filter="fully_trusted")
        release = (root / "usr/lib/os-release").read_text()
        if not re.search(r"^ID=debian$", release, re.M) or "VERSION_CODENAME=trixie" not in release:
            raise ValueError("Expected a Debian trixie export")
        kernels = list((root / "boot").glob("vmlinuz-*"))
        if len(kernels) != 1:
            raise ValueError("Expected exactly one kernel")
        kernel = kernels[0].name
        initrd = kernel.replace("vmlinuz-", "initrd.img-")
        for name in (kernel, initrd, "intel-ucode.img"):
            file = root / "boot" / name
            if not file.is_file() or file.is_symlink() or not file.stat().st_size:
                raise ValueError("Missing boot input: " + name)
        for name in ("usr/lib/polly-storage/storage.py", "usr/sbin/polly-accounts",
                     "etc/initramfs-tools/scripts/local-bottom/polly-storage-usr"):
            if not (root / name).is_file() or (root / name).is_symlink():
                raise ValueError("Export does not contain the storage overlay: " + name)
        inventory = (root / "usr/share/polly-installed-packages.tsv").read_text()
        identifiers = layout.new_volume_uuids()
        contract = prepare_root(root, persistent, identifiers)
        version = (REPO / "desktop/VERSION").read_text().strip()
        if not re.fullmatch(r"\d+\.\d+\.\d+-alpha\.\d+", version):
            raise ValueError("Invalid development version")
        cfg = stage / "grub.cfg"
        cfg.write_text(boot_config(identifiers["SYSTEM"], kernel, initrd))
        efi = stage / "BOOTX64.EFI"
        legacy.run("grub-mkstandalone", "-O", "x86_64-efi", "--locales=", "--fonts=",
                   "--modules=part_gpt fat ext2 normal linux search search_fs_uuid serial terminal",
                   "-o", str(efi), "boot/grub/grub.cfg=" + str(cfg))
        recovery_manifest = {"schemaVersion": 1, "stage": "reserved-not-bootable",
                             "recoveryBootReady": False,
                             "reason": "Independent authenticated recovery is pending M10; no fallback shell"}
        legacy.write(recovery, "Manifest.json", json.dumps(recovery_manifest, indent=2) + "\n")
        measured = {"EFI": efi.stat().st_size + 8192, "SYSTEM": payload_bytes(root),
                    "PERSISTENT": payload_bytes(persistent), "RECOVERY": payload_bytes(recovery)}
        reserves = {"EFI": 64, "SYSTEM": args.system_reserve_mib,
                    "PERSISTENT": args.persistent_reserve_mib, "RECOVERY": 64}
        parts, size = layout.partition_plan(measured, reserves, identifiers)
        filesystems = []
        for part in parts:
            filesystem = stage / (part["name"] + ".fs")
            with filesystem.open("xb") as file:
                file.truncate(part["sizeMiB"] * MIB)
            if part["name"] == "EFI":
                legacy.run("mkfs.fat", "-F", "32", "-i", part["uuid"].replace("-", ""),
                           "-n", "POLLYEFI", str(filesystem))
                legacy.run("mmd", "-i", str(filesystem), "::/EFI", "::/EFI/BOOT")
                legacy.run("mcopy", "-i", str(filesystem), str(efi), "::/EFI/BOOT/BOOTX64.EFI")
            else:
                tree = {"SYSTEM": root, "PERSISTENT": persistent, "RECOVERY": recovery}[part["name"]]
                legacy.run("mkfs.ext4", "-q", "-F", "-U", part["uuid"], "-L", "POLLY" + part["name"],
                           "-m", "0", "-d", str(tree), str(filesystem))
                legacy.run("e2fsck", "-fn", str(filesystem))
            filesystems.append(filesystem)
        image = stage / f"pollydesktop-{version}-debian13-x86_64-single-system.img"
        with image.open("xb") as file:
            file.truncate(size)
        table = "label: gpt\nunit: sectors\n\n" + "".join(
            f"start={part['startSector']},size={part['sectors']},type={part['type']},name=POLLY{part['name']}\n"
            for part in parts)
        legacy.run("sfdisk", str(image), input=table, text=True)
        with image.open("r+b") as destination:
            for part, filesystem in zip(parts, filesystems):
                legacy.copy_partition(destination, filesystem, part["startSector"] * 512)
        legacy.run("sfdisk", "--verify", str(image))
        inputs = [Path(__file__).resolve(), Path(__file__).with_name("build-storage.sh"),
                  Path(__file__).with_name("build-installed-image.py"),
                  *sorted((REPO / "desktop/release/storage").iterdir()),
                  REPO / "desktop/release/debian/Containerfile.storage",
                  REPO / "desktop/release/debian/Containerfile.install",
                  REPO / "desktop/release/debian/Containerfile.live",
                  REPO / "desktop/release/debian/account-profile",
                  REPO / "desktop/release/debian/profile-check",
                  REPO / "desktop/release/install/accounts.py", REPO / "desktop/release/install/passwd-proxy.c",
                  REPO / "desktop/release/install/roles.py",
                  REPO / "desktop/release/install/session", REPO / "desktop/release/install/shell.mjs"]
        manifest = {
            "schemaVersion": 1, "stage": "development-single-system-normal-boot",
            "version": version, "architecture": "x86_64", "distribution": "debian13",
            "sourceRevision": args.source_revision, "sourceDirty": args.source_dirty == "1",
            "baseImage": args.base_image, "exportSha256": legacy.digest(args.export),
            "image": {"name": image.name, "size": size, "sha256": legacy.digest(image)},
            "layout": contract["layout"], "storageContract": contract, "partitions": parts,
            "packages": [{"name": fields[0], "version": fields[1], "url": fields[2]}
                         for line in inventory.splitlines() if (fields := line.split("\t", 2))],
            "verificationFixture": False, "serialMenuIndex": 3,
            "accountSetup": "local interactive polly/root passwords; no image passwords",
            "accountStateSchemaVersion": 3, "recoveryBootReady": False,
            "buildInputs": [{"path": str(path.relative_to(REPO)), "sha256": legacy.digest(path)}
                            for path in inputs if path.is_file()],
            "limitations": ["Ordinary boot candidate, not a physical installer",
                            "Recovery partition is reserved, NOT a bootable recovery system",
                            "GUI login/lock/administration, multi-user migration and package maintenance pending"],
        }
        manifest_path = stage / "installed-manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        sums = stage / "SHA256SUMS"
        sums.write_text("".join(f"{legacy.digest(path)}  {path.name}\n" for path in (image, manifest_path)))
        output.parent.mkdir(parents=True, exist_ok=True)
        output.mkdir()
        for source in (image, manifest_path, sums, cfg):
            with (output / source.name).open("xb") as destination:
                legacy.copy_partition(destination, source, 0)
                destination.truncate(source.stat().st_size)
        print("Created regular single-system normal-boot candidate:", output / image.name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-dirty", choices=("0", "1"), required=True)
    parser.add_argument("--base-image", required=True)
    parser.add_argument("--system-reserve-mib", type=int, default=512)
    parser.add_argument("--persistent-reserve-mib", type=int, default=1024)
    build(parser.parse_args())
