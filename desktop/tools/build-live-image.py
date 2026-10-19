#!/usr/bin/env python3
"""Build memory-only UEFI media from an exported Alpine or Debian runtime."""
import argparse
import gzip
import hashlib
import json
import re
import runpy
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
import tempfile
import uuid


def run(*args):
    subprocess.run(args, check=True, timeout=180, stdout=subprocess.DEVNULL)


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("export", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-dirty", choices=["0", "1"], required=True)
    parser.add_argument("--runtime-image", required=True)
    parser.add_argument("--distribution", choices=["alpine3.24", "debian13"], default="alpine3.24")
    parser.add_argument("--sku", help="Explicit source-owned Debian hardware SKU (legacy omission remains supported)")
    parser.add_argument("--legacy-initramfs", action="store_true",
                        help="Explicit historical full-root initramfs; never an automatic fallback")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    version = (repo / "desktop/VERSION").read_text().strip()
    debian = args.distribution == "debian13"
    compressed_root = debian and not args.legacy_initramfs
    profiles = runpy.run_path(str(repo / "desktop/release/debian/live-profile.py"))
    selected = profiles["profile"](args.sku) if args.sku is not None else None
    if selected and not compressed_root:
        raise ValueError("Hardware SKU media requires the Debian compressed RAM-root layout")
    root_tools = runpy.run_path(str(repo / "desktop/tools/live-root.py"))
    image_name = f"pollydesktop-{version}" + ("-debian13" if debian else "")
    if selected:
        image_name += "-" + args.sku
    if not re.fullmatch(r"\d+\.\d+\.\d+-alpha\.\d+", version):
        raise ValueError("Invalid Live development version")
    if len(args.source_revision) != 40 or any(c not in "0123456789abcdef" for c in args.source_revision):
        raise ValueError("Expected a full source revision")
    output = args.output.resolve()
    if output.exists():
        raise ValueError("Refusing to replace existing image output")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="polly-live-build-"))
    publication = None
    try:
        image = staging / "iso"
        boot = image / "boot"
        boot.mkdir(parents=True)
        (image / "polly-live.marker").write_text(version + "\n")
        root_layout = "initramfs, memory only"
        media_id = uuid.uuid4().hex
        files = 0
        total = 0
        hardware_sizes = None
        origin = None

        with tarfile.open(args.export, "r:") as archive:
            if debian and args.legacy_initramfs:
                profiles["verify_legacy_export"](archive, root_tools["export_members"](archive))
            kernel_name = "boot/vmlinuz-lts"
            if debian:
                with archive.extractfile("usr/lib/os-release") as release:
                    if "ID=debian" not in release.read().decode():
                        raise ValueError("Debian image export has an unexpected distribution")
                kernels = [member.name for member in archive.getmembers()
                           if member.isfile() and member.name.startswith("boot/vmlinuz-")]
                if len(kernels) != 1:
                    raise ValueError("Expected exactly one installed Debian kernel")
                kernel_name = kernels[0]
            kernel = archive.extractfile(kernel_name)
            if kernel is None:
                raise ValueError("Export does not contain its hardware-capable kernel")
            with (boot / "vmlinuz").open("wb") as target:
                shutil.copyfileobj(kernel, target)
            kernel.close()
            microcode = archive.extractfile("boot/intel-ucode.img")
            if microcode is None:
                raise ValueError("Export does not contain the Intel early microcode archive")
            with (boot / "intel-ucode.img").open("wb") as target:
                shutil.copyfileobj(microcode, target)
            microcode.close()
            packages = archive.extractfile("usr/share/polly-live-packages.tsv" if debian else "lib/apk/db/installed")
            if packages is None:
                raise ValueError("Export does not contain its package inventory")
            inventory = []
            package_data = packages.read().decode()
            if debian:
                for record in package_data.splitlines():
                    name, package_version, homepage = record.split("\t", 2)
                    inventory.append({"name": name, "version": package_version, "url": homepage,
                                      "license": "See Debian /usr/share/doc package copyright files"})
            for record in ([] if debian else package_data.split("\n\n")):
                fields = {}
                for line in record.splitlines():
                    if len(line) > 2 and line[1] == ":" and line[0] in "PVLU":
                        fields[line[0]] = line[2:]
                if "P" in fields:
                    inventory.append({"name": fields["P"], "version": fields.get("V"),
                                      "license": fields.get("L"), "url": fields.get("U")})
            packages.close()
            if debian:
                # New Debian media must not silently reuse a pre-startup-UX base.
                boot_install = runpy.run_path(str(repo / "desktop/release/debian/boot-install.py"))
                for target, _, expected, mode in boot_install["files"](repo):
                    member = archive.getmember(target)
                    with archive.extractfile(member) as source:
                        if (not member.isfile() or member.uid or member.gid or member.mode != mode or
                                source.read() != expected):
                            raise ValueError("Live startup payload differs from source: " + target)
                pins = json.loads((repo / "desktop/release/debian/boot-dependencies.json").read_text())
                versions = {item["name"]: item["version"] for item in inventory}
                for package, pinned in pins["packages"].items():
                    if versions.get(package, versions.get(package + ":amd64")) != pinned:
                        raise ValueError("Live startup package pin mismatch: " + package)

            if compressed_root:
                with archive.extractfile("init") as source:
                    if source.read() != (repo / "desktop/release/live/init").read_bytes():
                        raise ValueError("Compressed RAM root needs this source's mount-preserving /init")
                root = staging / "root"
                files, total = root_tools["extract_root"](archive, root)
                profiles["verify"](root, args.sku)
                if selected:
                    hardware_sizes = profiles["size_report"](root, args.sku, repo)
                    origin = json.loads((root / "usr/share/pollyui/runtime-origin.json").read_bytes())
                    if (origin.get("sku") != args.sku or origin.get("hardwareProfile") != selected or
                            origin.get("nativeRuntime", {}).get("imageID") != args.runtime_image or
                            origin["nativeRuntime"].get("sourceRevision") != origin.get("runtimeSourceRevision") or
                            origin["nativeRuntime"].get("manifestSha256") != origin.get("runtimeManifestSha256") or
                            origin.get("mediaProducerRevision") != args.source_revision):
                        raise ValueError("Assembled runtime origin does not match requested hardware SKU/source")
                squashfs = boot / "root.squashfs"
                subprocess.run(["mksquashfs", str(root), str(squashfs), "-noappend",
                                "-comp", "gzip", "-processors", "1", "-no-progress", "-quiet"],
                               check=True, timeout=600)
                release = kernel_name.removeprefix("boot/vmlinuz-")
                with archive.extractfile("boot/config-" + release) as source:
                    config = source.read().decode()
                root_layout = root_tools["build_bootstrap"](
                    root, staging, boot, repo, release, config, media_id, squashfs, args.sku)
                (image / "polly").mkdir()
                (image / "polly" / (media_id + ".marker")).write_text(root_layout["sha256"] + "\n")
                shutil.rmtree(root)
            else:
                files, total = write_legacy_initramfs(archive, boot, debian)

        # The source is a template; fingerprint the actual embedded configuration too.
        cfg_source = repo / ("desktop/release/debian/live-grub.cfg" if debian else "desktop/release/live/grub.cfg")
        cfg = staging / "grub.cfg"
        configuration = cfg_source.read_text()
        if debian:
            configuration = profiles["grub_configuration"](configuration, media_id, args.sku)
            if not compressed_root:
                configuration = configuration.replace(
                    "polly_prepare_media", "polly_legacy_media")
                start = configuration.index("function polly_legacy_media {")
                end = configuration.index('\nmenuentry ', start)
                configuration = (configuration[:start] +
                                 "function polly_legacy_media {\n"
                                 "    search --no-floppy --file --set=root /polly-live.marker\n}\n" +
                                 configuration[end:])
                configuration = configuration.replace(
                    " polly.media_uuid=$polly_media_uuid polly.media_id=" + media_id, "")
        cfg.write_text(configuration)
        if debian:
            run("grub-script-check", str(cfg))
        grub_receipt = {"templateSha256": digest(cfg_source), "embeddedSha256": digest(cfg)}
        if selected:
            grub_receipt["kernelArguments"] = selected["displayPolicy"]["kernelArguments"]

        efi = staging / "BOOTX64.EFI"
        resources = []
        if debian:
            assets = runpy.run_path(str(repo / "desktop/release/live/boot-assets.py"))
            resources = assets["write_theme"](staging / "grub-theme")
            resources.append("boot/grub/themes/polly/theme.txt=" + str(repo / "desktop/release/live/grub-theme.txt"))
        run("grub-mkstandalone", "-O", "x86_64-efi", "--locales=", "--fonts=unicode" if debian else "--fonts=",
            "--modules=part_gpt part_msdos fat iso9660 normal linux search search_fs_file serial terminal probe halt" +
            (" all_video efi_gop gfxterm gfxmenu gfxterm_background png font" if debian else ""),
            "-o", str(efi), "boot/grub/grub.cfg=" + str(cfg), *resources)
        fat = boot / "efiboot.img"
        with fat.open("wb") as target:
            target.truncate(16 * 1024 * 1024)
        run("mkfs.fat", str(fat))
        run("mmd", "-i", str(fat), "::/EFI", "::/EFI/BOOT")
        run("mcopy", "-i", str(fat), str(efi), "::/EFI/BOOT/BOOTX64.EFI")
        (image / "EFI/BOOT").mkdir(parents=True)
        shutil.copyfile(efi, image / "EFI/BOOT/BOOTX64.EFI")
        iso = staging / f"{image_name}-x86_64-uefi-live.iso"
        build_log = staging / "image-build.log"
        with build_log.open("w") as log:
            subprocess.run(["xorriso", "-abort_on", "WARNING", "-as", "mkisofs", "-R", "-J", "-V", "POLLYLIVE",
                            "-e", "boot/efiboot.img", "-no-emul-boot", "-o", str(iso), str(image)],
                           check=True, timeout=180, stdout=log, stderr=subprocess.STDOUT)
        # Build only regular image files; never attach a loop device or open a physical disk.
        usb = staging / f"{image_name}-x86_64-uefi-usb.img"
        boot_files = [boot / name for name in ("vmlinuz", "intel-ucode.img", "initramfs.gz")]
        if compressed_root:
            boot_files.append(boot / "root.squashfs")
        payload = sum(file.stat().st_size for file in (efi, *boot_files))
        partition_mib = max(128, (payload + 64 * 1024 * 1024 + 1024 * 1024 - 1) // (1024 * 1024))
        sectors = partition_mib * 2048
        with usb.open("wb") as target:
            target.truncate((partition_mib + 2) * 1024 * 1024)
        subprocess.run(["sfdisk", str(usb)], input=f"label: gpt\nunit: sectors\n\nstart=2048,size={sectors},type=U\n",
                       text=True, check=True, timeout=30, stdout=subprocess.DEVNULL)
        filesystem = staging / "usb-fat.img"
        with filesystem.open("wb") as target:
            target.truncate(partition_mib * 1024 * 1024)
        run("mkfs.fat", "-F", "32", "-n", "POLLYLIVE", str(filesystem))
        run("mmd", "-i", str(filesystem), "::/EFI", "::/EFI/BOOT", "::/boot")
        run("mcopy", "-i", str(filesystem), str(efi), "::/EFI/BOOT/BOOTX64.EFI")
        run("mcopy", "-i", str(filesystem), str(image / "polly-live.marker"), "::/")
        if compressed_root:
            run("mmd", "-i", str(filesystem), "::/polly")
            run("mcopy", "-i", str(filesystem), str(image / "polly" / (media_id + ".marker")), "::/polly/")
        for file in boot_files:
            if file.stat().st_size >= 2 ** 32:
                raise ValueError("Boot payload exceeds FAT32 individual-file limit")
            run("mcopy", "-i", str(filesystem), str(file), "::/boot/")
        with usb.open("r+b") as target, filesystem.open("rb") as source:
            target.seek(1024 * 1024)
            shutil.copyfileobj(source, target, length=1024 * 1024)
        filesystem.unlink()
        run("sfdisk", "--verify", str(usb))
        manifest = {
            "schemaVersion": 2 if compressed_root else 1,
            "version": version, "architecture": "x86_64", "firmware": "UEFI (unsigned)",
            "distribution": args.distribution, "kernel": kernel_name,
            "stage": "development-live-image", "sourceRevision": args.source_revision,
            "sourceDirty": args.source_dirty == "1", "runtimeImage": args.runtime_image,
            "root": root_layout, "grub": grub_receipt,
            "bootFiles": [{"path": "boot/" + file.name, "sha256": digest(file), "size": file.stat().st_size}
                          for file in boot_files],
            "imageToolPackages": subprocess.check_output(
                ["dpkg-query", "-W", "-f=${binary:Package}=${Version}\\n",
                 "busybox-static", "squashfs-tools", "kmod", "xz-utils", "util-linux", "binutils"],
                text=True, timeout=10).splitlines() if compressed_root else [],
            "automaticLogin": "temporary uid 1000 polly",
            "minimumGuestMemoryMiB": 4096, "files": files, "uncompressedPayloadBytes": total,
            "iso": {"name": iso.name, "sha256": digest(iso), "size": iso.stat().st_size},
            "usb": {"name": usb.name, "sha256": digest(usb), "size": usb.stat().st_size,
                    "layout": "GPT with one FAT32 EFI System Partition; no persistence"},
            "hardwareTarget": "i7-13700K / B760-G / UHD770 + RTX4070Ti + RTX4060Ti / I226-V / AX211",
            "packages": sorted(inventory, key=lambda item: item["name"]),
            "buildInputs": [
                {"path": str(file.relative_to(repo)), "sha256": digest(file)}
                for file in sorted([
                    *(repo / "desktop/release/live").iterdir(),
                    repo / "desktop/tools/build-live-image.py", repo / "desktop/tools/build-live.sh",
                    repo / "desktop/tools/live-root.py",
                    repo / "tools/build.sh",
                    *([repo / ("desktop/tools/" + name) for name in (
                        "build-live-skus.mjs", "live-profiles.mjs", "retain-live-inputs.py",
                        "verify-live-runtime.py", "offline-live-overlay.py")] if debian else []),
                    repo / "desktop/release/Containerfile.live",
                    repo / "desktop/system/login.pam", repo / "desktop/system/polly-lock.pam",
                    repo / "desktop/system/elogind-polly.conf", repo / "desktop/system/iwd-main.conf",
                    *((repo / "desktop/release/debian").iterdir() if debian else []),
                ]) if file.is_file()
            ],
            "limitations": ["No installer or block-device persistence", "No secure lock or protected login",
                            "Wired DHCP; Wi-Fi configured interactively in the memory-only guest", "Unsigned development boot chain",
                            "Physical hardware and third-party distribution compliance not qualified"],
        }
        if selected:
            hardware_sizes["media"] = {
                "isoBytes": iso.stat().st_size, "usbBytes": usb.stat().st_size,
                "rootBytes": root_layout["size"], "rootUncompressedBytes": total,
                "bootstrapBytes": root_layout["bootstrap"]["size"],
                "bootstrapUncompressedBytes": root_layout["bootstrap"]["uncompressedBytes"],
            }
            manifest.update({"sku": args.sku, "hardwareProfile": selected,
                             "nativeRuntime": origin["nativeRuntime"], "imageToolsID": origin["imageToolsID"],
                             "sizeReport": hardware_sizes, "hardwareTarget": selected["support"]})
            if args.sku == "basic":
                if origin.get("kernelInput") != root_layout.get("kernelInput"):
                    raise ValueError("basic root/boot kernel input differs from actual origin")
                if digest(boot / "vmlinuz") != origin["kernelInput"]["imageSha256"]:
                    raise ValueError("Actual media kernel bytes differ from verified input .deb")
                manifest["kernelInput"] = origin["kernelInput"]
            profiles["validate_media"](manifest)
        (staging / "live-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        with (staging / "boot-layout.txt").open("w") as report:
            subprocess.run(["xorriso", "-indev", str(iso), "-report_el_torito", "plain"],
                           check=True, timeout=30, stdout=report, stderr=subprocess.STDOUT)
        sums = [f"{digest(file)}  {file.name}" for file in (iso, usb, staging / "live-manifest.json", cfg)]
        (staging / "SHA256SUMS").write_text("\n".join(sums) + "\n")
        shutil.rmtree(image)
        efi.unlink()
        if debian:
            shutil.rmtree(staging / "grub-theme")
        publication = Path(tempfile.mkdtemp(prefix=".polly-live-", dir=output.parent))
        for file in staging.iterdir():
            if not file.is_file():
                raise ValueError("Unexpected final image artifact: " + file.name)
            shutil.copyfile(file, publication / file.name)
        publication.rename(output)
        publication = None
        shutil.rmtree(staging)
        print("Created memory-only UEFI ISO and USB image:", output / iso.name, output / usb.name)
    except BaseException:
        log = staging / "image-build.log"
        if log.exists():
            print(log.read_text()[-8000:])
        shutil.rmtree(staging)
        if publication is not None:
            shutil.rmtree(publication)
        raise


def write_legacy_initramfs(archive, boot, debian):
    inode = files = total = 0
    with (boot / "initramfs.gz").open("wb") as raw, gzip.GzipFile(
            filename="", fileobj=raw, mode="wb", compresslevel=6, mtime=0) as cpio:
        def entry(name, mode, uid=0, gid=0, data=b"", major=0, minor=0):
            nonlocal inode, files, total
            inode += 1
            encoded = name.encode() + b"\0"
            fields = [inode, mode, uid, gid, 1, 0, len(data), 0, 0, major, minor, len(encoded), 0]
            header = ("070701" + "".join(f"{value:08x}" for value in fields)).encode()
            cpio.write(header + encoded + b"\0" * (-(110 + len(encoded)) % 4))
            cpio.write(data + b"\0" * (-len(data) % 4))
            files += 1
            total += len(data)

        helpers = runpy.run_path(str(Path(__file__).with_name("live-root.py")))
        members = helpers["export_members"](archive)
        entry(".", stat.S_IFDIR | 0o755)
        for name, member in members.items():
            if name == "." or helpers["excluded"](name):
                continue
            if member.isdir():
                entry(name, stat.S_IFDIR | member.mode, member.uid, member.gid)
            elif member.issym():
                entry(name, stat.S_IFLNK | member.mode, member.uid, member.gid, member.linkname.encode())
            elif member.isfile() or member.islnk():
                with archive.extractfile(member) as source:
                    entry(name, stat.S_IFREG | member.mode, member.uid, member.gid, source.read())
            else:
                raise ValueError("Unexpected export node: " + name)
        entry("dev", stat.S_IFDIR | 0o755)
        entry("dev/console", stat.S_IFCHR | 0o600, major=5, minor=1)
        entry("dev/null", stat.S_IFCHR | 0o666, major=1, minor=3)
        entry("etc/hosts", stat.S_IFREG | 0o644, data=b"127.0.0.1 localhost polly-live\n::1 localhost\n")
        entry("etc/hostname", stat.S_IFREG | 0o644, data=b"polly-live\n")
        resolver = b"/run/polly-network/resolv.conf" if debian else b"# Populated by guest-only DHCP or iwd/openresolv in memory.\n"
        entry("etc/resolv.conf", (stat.S_IFLNK | 0o777) if debian else (stat.S_IFREG | 0o644), data=resolver)
        entry("TRAILER!!!", 0)
    return files, total


if __name__ == "__main__":
    main()
