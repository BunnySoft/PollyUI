#!/usr/bin/env python3
"""Build a memory-only UEFI ISO from an exported Alpine runtime container."""
import argparse
import gzip
import hashlib
import io
import json
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import tempfile


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
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    version = (repo / "desktop/VERSION").read_text().strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+-alpha\.\d+", version):
        raise ValueError("Invalid Live development version")
    if len(args.source_revision) != 40 or any(c not in "0123456789abcdef" for c in args.source_revision):
        raise ValueError("Expected a full source revision")
    output = args.output.resolve()
    if output.exists():
        raise ValueError("Refusing to replace existing image output")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".polly-live-", dir=output.parent))
    try:
        image = staging / "iso"
        boot = image / "boot"
        boot.mkdir(parents=True)
        (image / "polly-live.marker").write_text(version + "\n")
        inode = 0
        files = 0
        total = 0

        with tarfile.open(args.export, "r:") as archive:
            kernel = archive.extractfile("boot/vmlinuz-lts")
            if kernel is None:
                raise ValueError("Export does not contain the Alpine hardware-capable LTS kernel")
            with (boot / "vmlinuz").open("wb") as target:
                shutil.copyfileobj(kernel, target)
            kernel.close()
            microcode = archive.extractfile("boot/intel-ucode.img")
            if microcode is None:
                raise ValueError("Export does not contain the Intel early microcode archive")
            with (boot / "intel-ucode.img").open("wb") as target:
                shutil.copyfileobj(microcode, target)
            microcode.close()
            packages = archive.extractfile("lib/apk/db/installed")
            if packages is None:
                raise ValueError("Export does not contain its APK inventory")
            inventory = []
            for record in packages.read().decode().split("\n\n"):
                fields = {}
                for line in record.splitlines():
                    if len(line) > 2 and line[1] == ":" and line[0] in "PVLU":
                        fields[line[0]] = line[2:]
                if "P" in fields:
                    inventory.append({"name": fields["P"], "version": fields.get("V"),
                                      "license": fields.get("L"), "url": fields.get("U")})
            packages.close()

            with (boot / "initramfs.gz").open("wb") as raw:
                with gzip.GzipFile(filename="", fileobj=raw, mode="wb", compresslevel=6, mtime=0) as cpio:
                    def entry(name, mode, uid=0, gid=0, size=0, data=None, major=0, minor=0):
                        nonlocal inode, files, total
                        inode += 1
                        encoded = name.encode() + b"\0"
                        fields = [inode, mode, uid, gid, 1, 0, size, 0, 0, major, minor, len(encoded), 0]
                        header = ("070701" + "".join(f"{value:08x}" for value in fields)).encode()
                        cpio.write(header + encoded)
                        cpio.write(b"\0" * (-(len(header) + len(encoded)) % 4))
                        if data is not None:
                            remaining = size
                            while remaining:
                                block = data.read(min(1024 * 1024, remaining))
                                if not block:
                                    raise ValueError("Truncated export entry: " + name)
                                cpio.write(block)
                                remaining -= len(block)
                        cpio.write(b"\0" * (-size % 4))
                        files += 1
                        total += size

                    for member in archive:
                        name = member.name.removeprefix("./").rstrip("/")
                        path = PurePosixPath(name)
                        if not name or name == ".":
                            continue
                        if path.is_absolute() or ".." in path.parts:
                            raise ValueError("Unsafe export path: " + name)
                        if path.parts[0] in {"boot", "dev", "proc", "sys", "run", "tmp"}:
                            continue
                        if name in {".dockerenv", "etc/machine-id", "var/lib/dbus/machine-id",
                                    "etc/hosts", "etc/resolv.conf"}:
                            continue
                        if member.isdir():
                            entry(name, stat.S_IFDIR | member.mode, member.uid, member.gid)
                        elif member.issym():
                            encoded = member.linkname.encode()
                            entry(name, stat.S_IFLNK | member.mode, member.uid, member.gid,
                                  len(encoded), io.BytesIO(encoded))
                        elif member.isfile() or member.islnk():
                            source = archive.extractfile(member)
                            if source is None:
                                raise ValueError("Unreadable export entry: " + name)
                            size = archive.getmember(member.linkname).size if member.islnk() else member.size
                            entry(name, stat.S_IFREG | member.mode, member.uid, member.gid, size, source)
                            source.close()
                        else:
                            raise ValueError("Unexpected export node: " + name)
                    entry("dev", stat.S_IFDIR | 0o755)
                    entry("dev/console", stat.S_IFCHR | 0o600, major=5, minor=1)
                    entry("dev/null", stat.S_IFCHR | 0o666, major=1, minor=3)
                    hosts = b"127.0.0.1 localhost polly-live\n::1 localhost\n"
                    entry("etc/hosts", stat.S_IFREG | 0o644, size=len(hosts), data=io.BytesIO(hosts))
                    entry("TRAILER!!!", 0)

        efi = staging / "BOOTX64.EFI"
        cfg = repo / "desktop/release/live/grub.cfg"
        run("grub-mkstandalone", "-O", "x86_64-efi", "--locales=", "--fonts=",
            "--modules=part_gpt part_msdos fat iso9660 normal linux search search_fs_file serial terminal",
            "-o", str(efi), "boot/grub/grub.cfg=" + str(cfg))
        fat = boot / "efiboot.img"
        with fat.open("wb") as target:
            target.truncate(16 * 1024 * 1024)
        run("mkfs.fat", str(fat))
        run("mmd", "-i", str(fat), "::/EFI", "::/EFI/BOOT")
        run("mcopy", "-i", str(fat), str(efi), "::/EFI/BOOT/BOOTX64.EFI")
        (image / "EFI/BOOT").mkdir(parents=True)
        shutil.copyfile(efi, image / "EFI/BOOT/BOOTX64.EFI")
        iso = staging / f"pollydesktop-{version}-x86_64-uefi-live.iso"
        build_log = staging / "image-build.log"
        with build_log.open("w") as log:
            subprocess.run(["xorriso", "-abort_on", "WARNING", "-as", "mkisofs", "-R", "-J", "-V", "POLLYLIVE",
                            "-e", "boot/efiboot.img", "-no-emul-boot", "-o", str(iso), str(image)],
                           check=True, timeout=180, stdout=log, stderr=subprocess.STDOUT)
        # Build only regular image files; never attach a loop device or open a physical disk.
        usb = staging / f"pollydesktop-{version}-x86_64-uefi-usb.img"
        payload = sum(file.stat().st_size for file in (efi, boot / "vmlinuz", boot / "intel-ucode.img", boot / "initramfs.gz"))
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
        for file in (boot / "vmlinuz", boot / "intel-ucode.img", boot / "initramfs.gz"):
            if file.stat().st_size >= 2 ** 32:
                raise ValueError("Boot payload exceeds FAT32 individual-file limit")
            run("mcopy", "-i", str(filesystem), str(file), "::/boot/")
        with usb.open("r+b") as target, filesystem.open("rb") as source:
            target.seek(1024 * 1024)
            shutil.copyfileobj(source, target, length=1024 * 1024)
        filesystem.unlink()
        run("sfdisk", "--verify", str(usb))
        manifest = {
            "version": version, "architecture": "x86_64", "firmware": "UEFI (unsigned)",
            "stage": "development-live-image", "sourceRevision": args.source_revision,
            "sourceDirty": args.source_dirty == "1", "runtimeImage": args.runtime_image,
            "root": "initramfs, memory only", "automaticLogin": "temporary uid 1000 polly",
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
                    repo / "desktop/release/Containerfile.live",
                    repo / "desktop/system/login.pam", repo / "desktop/system/polly-lock.pam",
                    repo / "desktop/system/elogind-polly.conf", repo / "desktop/system/iwd-main.conf",
                ]) if file.is_file()
            ],
            "limitations": ["No installer or block-device persistence", "No secure lock or protected login",
                            "Wired DHCP; Wi-Fi configured interactively in the memory-only guest", "Unsigned development boot chain",
                            "Physical hardware and third-party distribution compliance not qualified"],
        }
        (staging / "live-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        with (staging / "boot-layout.txt").open("w") as report:
            subprocess.run(["xorriso", "-indev", str(iso), "-report_el_torito", "plain"],
                           check=True, timeout=30, stdout=report, stderr=subprocess.STDOUT)
        sums = [f"{digest(file)}  {file.name}" for file in (iso, usb, staging / "live-manifest.json")]
        (staging / "SHA256SUMS").write_text("\n".join(sums) + "\n")
        shutil.rmtree(image)
        efi.unlink()
        staging.rename(output)
        print("Created memory-only UEFI ISO and USB image:", output / iso.name, output / usb.name)
    except BaseException:
        log = staging / "image-build.log"
        if log.exists():
            print(log.read_text()[-8000:])
        shutil.rmtree(staging)
        raise


if __name__ == "__main__":
    main()
