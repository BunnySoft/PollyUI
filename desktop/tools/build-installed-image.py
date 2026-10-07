#!/usr/bin/env python3
"""Create a new regular GPT image; never mount or open a host block device."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import uuid

MIB = 1024 * 1024
GETTY_DROPIN = "etc/systemd/system/getty@tty1.service.d/zz-installed.conf"


def run(*args, **kwargs):
    subprocess.run(args, check=True, timeout=300, stdout=subprocess.DEVNULL, **kwargs)


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def export_members(archive):
    members, names, links = [], set(), set()
    total = 0
    for member in archive.getmembers():
        name = member.name.removeprefix("./").rstrip("/")
        if name in {"", "."}:
            continue
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or str(path) != name or name in names:
            raise ValueError("Unsafe or duplicate export path: " + name)
        names.add(name)
        if path.parts[0] in {"dev", "proc", "sys", "run", "tmp"} or name in {
            ".dockerenv", "etc/hosts", "etc/hostname", "etc/resolv.conf",
            "etc/machine-id", "var/lib/dbus/machine-id",
        }:
            continue
        if not (member.isdir() or member.isfile() or member.issym() or member.islnk()):
            raise ValueError("Unsupported export node: " + name)
        if not 0 <= member.uid <= 65535 or not 0 <= member.gid <= 65535:
            raise ValueError("Unsupported guest owner: " + name)
        if member.islnk():
            target = PurePosixPath(member.linkname)
            if target.is_absolute() or ".." in target.parts or str(target) != member.linkname:
                raise ValueError("Unsafe hard link: " + name)
        if member.issym():
            links.add(name)
        total += member.size
        if total > 4 * 1024 * MIB:
            raise ValueError("Export exceeds the 4 GiB development payload limit")
        members.append(member)
    for member in members:
        if any(str(parent) in links for parent in PurePosixPath(member.name).parents):
            raise ValueError("Export writes through a symbolic link: " + member.name)
        if member.islnk():
            target = archive.getmember(member.linkname)
            if not target.isfile() or target not in members:
                raise ValueError("Hard link does not reference an included regular file")
    return members


def layout(system_mib, data_mib):
    if not 3072 <= system_mib <= 16384 or not 2048 <= data_mib <= 32768:
        raise ValueError("System slots must be 3072-16384 MiB; data must be 2048-32768 MiB")
    parts = []
    start = 2048
    for name, size, kind in [("EFI", 256, "U"), ("A", system_mib, "L"),
                             ("B", system_mib, "L"), ("DATA", data_mib, "L")]:
        identifier = str(uuid.uuid4())
        if name == "EFI":
            serial = uuid.uuid4().hex[:8].upper()
            identifier = serial[:4] + "-" + serial[4:]
        parts.append({"name": name, "startSector": start, "sectors": size * 2048,
                      "sizeMiB": size, "type": kind, "uuid": identifier,
                      "filesystem": "FAT32" if name == "EFI" else "ext4"})
        start += size * 2048
    return parts, (start + 2048) * 512


def write(root, name, text, mode=0o644):
    path = root / name
    if not path.parent.resolve().is_relative_to(root.resolve()):
        raise ValueError("Configuration path escapes the guest root: " + name)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        path.unlink()
    path.write_text(text, encoding="utf8")
    path.chmod(mode)


def copy_partition(target, source, offset):
    target.seek(offset)
    with source.open("rb") as data:
        while block := data.read(MIB):
            if block.count(0) == len(block):
                target.seek(len(block), os.SEEK_CUR)
            else:
                target.write(block)


def account_templates(passwd, shadow):
    identities = [line for line in passwd.splitlines() if line.split(":")[0] in {"root", "polly"}]
    shadows = [line for line in shadow.splitlines() if line.split(":")[0] in {"root", "polly"}]
    if {line.split(":")[0] for line in identities} != {"root", "polly"} or \
            {line.split(":")[0] for line in shadows} != {"root", "polly"} or \
            len(identities) != 2 or len(shadows) != 2 or any(
                len(line.split(":")) != 9 or line.split(":")[1] not in {"!", "!!", "*", "!*"}
                for line in shadows):
        raise ValueError("Only locked, unconfigured account templates may enter an image")
    return identities, shadows


def build(args):
    repo = Path(__file__).resolve().parents[2]
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_revision):
        raise ValueError("Expected a full source revision")
    if not stat.S_ISREG(args.export.lstat().st_mode):
        raise ValueError("Input must be a regular container export, not a link or device")
    output = args.output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Refusing to replace existing image output")
    parts, image_bytes = layout(args.system_mib, args.data_mib)
    version = (repo / "desktop/VERSION").read_text().strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+-alpha\.\d+", version):
        raise ValueError("Invalid development version")
    with tempfile.TemporaryDirectory(prefix="polly-installed-") as temporary:
        stage = Path(temporary)
        root = stage / "root"
        root.mkdir()
        with tarfile.open(args.export, "r:") as archive:
            # All paths, link ancestors and node types are checked before preserving guest owners.
            archive.extractall(root, members=export_members(archive), filter="fully_trusted")
        for name in ["etc", "usr", "usr/lib", "home", "var", "var/lib", "boot", "etc/skel"]:
            path = root / name
            if not path.is_dir() or path.is_symlink():
                raise ValueError("Expected a real guest directory: " + name)
        for name in ["etc/passwd", "etc/shells", "usr/lib/os-release"]:
            path = root / name
            if not path.is_file() or path.is_symlink():
                raise ValueError("Expected a regular guest configuration: " + name)
        release = (root / "usr/lib/os-release").read_text()
        if not re.search(r"^ID=debian$", release, re.M) or "VERSION_CODENAME=trixie" not in release:
            raise ValueError("Expected a Debian trixie export")
        kernels = list((root / "boot").glob("vmlinuz-*"))
        if len(kernels) != 1:
            raise ValueError("Expected exactly one installed kernel")
        kernel = kernels[0]
        initrd = root / "boot" / kernel.name.replace("vmlinuz-", "initrd.img-")
        microcode = root / "boot/intel-ucode.img"
        for file in (kernel, initrd, microcode, root / "usr/share/polly-installed-packages.tsv"):
            if not file.is_file() or file.is_symlink() or not file.stat().st_size:
                raise ValueError("Missing installed boot input: " + str(file))
        inventory = [{"name": name, "version": package_version, "url": url}
                     for name, package_version, url in
                     (line.split("\t", 2) for line in (root / "usr/share/polly-installed-packages.tsv").read_text().splitlines())]
        data = stage / "data"
        data.mkdir()
        home = root / "home/polly"
        if not home.is_dir() or home.is_symlink():
            raise ValueError("Expected the development-user home")
        for file in home.iterdir():
            template = root / "etc/skel" / file.name
            if file.name not in {".bashrc", ".bash_logout", ".profile"} or file.is_symlink() or \
                    not file.is_file() or template.is_symlink() or not template.is_file() or \
                    file.read_bytes() != template.read_bytes():
                raise ValueError("Refusing to seed existing user data: " + file.name)
        shutil.move(str(home), data / "polly")
        documents = data / "polly/Documents"
        documents.mkdir(mode=0o700)
        os.chown(documents, 1000, 1000)
        (data / "polly").chmod(0o700)
        for name in ("dev", "proc", "sys", "run", "tmp"):
            (root / name).mkdir(exist_ok=True)
        (root / "tmp").chmod(0o1777)
        write(root, "etc/hostname", "polly-installed\n")
        write(root, "etc/hosts", "127.0.0.1 localhost polly-installed\n::1 localhost\n")
        write(root, "etc/machine-id", uuid.uuid4().hex + "\n")
        (root / "etc/resolv.conf").symlink_to("/run/polly-network/resolv.conf")
        write(root, "etc/polly-home-uuid", parts[3]["uuid"] + "\n")
        write(root, "usr/bin/polly-installed-session",
              (repo / "desktop/release/install/session").read_text(), 0o755)
        write(root, "usr/share/pollyui/desktop/shell/installed.mjs",
              (repo / "desktop/release/install/shell.mjs").read_text())
        passwd = (root / "etc/passwd").read_text()
        if not re.search(r"^polly:[^:]*:1000:1000:", passwd, re.M):
            raise ValueError("Unexpected development user identity")
        write(root, "etc/passwd", re.sub(r"^(polly:[^\n]*:)/[^:\n]+$", r"\1/usr/bin/polly-installed-session",
                                        passwd, flags=re.M))
        write(root, "etc/shells", (root / "etc/shells").read_text() + "/usr/bin/polly-installed-session\n")
        for name in ("usr/bin/passwd", "usr/bin/passwd.distrib",
                     "etc/group", "etc/shadow", "etc/nsswitch.conf"):
            if not (root / name).is_file() or (root / name).is_symlink():
                raise ValueError("Missing installed account input: " + name)
        shadow_group = [line.split(":")[2] for line in (root / "etc/group").read_text().splitlines()
                        if line.startswith("shadow:")]
        if len(shadow_group) != 1 or not shadow_group[0].isdigit():
            raise ValueError("Missing shadow helper group")
        account_root = data / ".polly-system/accounts"
        account_root.mkdir(parents=True)
        account_root.parent.chmod(0o700)
        account_root.chmod(0o755)
        account_etc = account_root / "etc"
        account_etc.mkdir(mode=0o755)
        identities, shadows = account_templates((root / "etc/passwd").read_text(),
                                                (root / "etc/shadow").read_text())
        write(account_root, "etc/passwd", "\n".join(identities) + "\n")
        write(account_root, "etc/shadow", "\n".join(shadows) + "\n", 0o640)
        os.chown(account_etc / "shadow", 0, int(shadow_group[0]))
        write(account_root, "etc/nsswitch.conf", "passwd: files\ngroup: files\nshadow: files\n")
        write(account_root, "etc/group", "root:x:0:\npolly:x:1000:\nshadow:x:" + shadow_group[0] + ":\n")
        write(account_root, "config.json", json.dumps({
            "schemaVersion": 2, "homeUuid": parts[3]["uuid"], "automaticLogin": False, "initialized": False,
        }, sort_keys=True) + "\n")
        write(root, "usr/sbin/polly-accounts",
              (repo / "desktop/release/install/accounts.py").read_text(), 0o755)
        nss = (root / "etc/nsswitch.conf").read_text()
        if not re.search(r"^shadow:\s+files\s*$", nss, re.M):
            raise ValueError("Unexpected base shadow NSS policy")
        write(root, "etc/nsswitch.conf", re.sub(r"^shadow:\s+files\s*$",
              "shadow: extrausers files", nss, flags=re.M))
        write(root, "etc/pam.d/common-auth",
              "#%PAM-1.0\n"
              "auth requisite pam_exec.so quiet seteuid /usr/sbin/polly-accounts check\n"
              "auth required pam_unix.so\n")
        write(root, "etc/pam.d/common-password",
              "password requisite pam_exec.so quiet seteuid /usr/sbin/polly-accounts password-scope\n" +
              (root / "etc/pam.d/common-password").read_text())
        write(root, "etc/pam.d/login",
              "#%PAM-1.0\n"
              "auth requisite pam_exec.so quiet seteuid /usr/sbin/polly-accounts check\n"
              "auth required pam_unix.so\n"
              "auth required pam_nologin.so\n"
              "account required pam_unix.so\n"
              "account required pam_nologin.so\n"
              "session required pam_loginuid.so\n"
              "session optional pam_keyinit.so force revoke\n"
              "session required pam_systemd.so\n")
        write(root, "etc/systemd/system/polly-accounts.service",
              "[Unit]\nRequiresMountsFor=/home\nWants=polly-installed-serial.service\n"
              "After=local-fs.target polly-installed-serial.service\n"
              "Before=systemd-user-sessions.service getty@tty1.service polly-firstboot.service\n"
              "[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/sbin/polly-accounts prepare\n"
              "[Install]\nWantedBy=multi-user.target\n")
        write(root, "etc/systemd/system/polly-firstboot.service",
              "[Unit]\nRequires=polly-accounts.service\nAfter=polly-accounts.service\n"
              "Before=getty@tty1.service\n"
              "[Service]\nType=oneshot\nRemainAfterExit=yes\n"
              "ExecStart=/usr/sbin/polly-accounts setup\n"
              "StandardInput=tty-force\nStandardOutput=tty\nStandardError=tty\n"
              "TTYPath=/dev/tty1\nTTYReset=yes\nTTYVHangup=yes\nTimeoutStartSec=infinity\n")
        (root / "etc/systemd/system/multi-user.target.wants/polly-accounts.service").symlink_to(
            "../polly-accounts.service")
        write(root, GETTY_DROPIN,
              "[Unit]\nRequiresMountsFor=/home/polly\n"
              "Requires=polly-accounts.service polly-firstboot.service\n"
              "After=polly-accounts.service polly-firstboot.service\n"
              "[Service]\nExecStart=\nExecStart=/usr/sbin/polly-accounts getty %I\n")
        serial_getty = root / "etc/systemd/system/serial-getty@ttyS0.service"
        if serial_getty.exists() or serial_getty.is_symlink():
            raise ValueError("Unexpected preexisting installed serial console policy")
        serial_getty.symlink_to("/dev/null")
        write(root, "usr/bin/polly-installed-serial",
              "#!/bin/sh\nset -eu\nmkdir -p /run/systemd/journald.conf.d\n"
              "printf '[Journal]\\nForwardToConsole=yes\\nTTYPath=/dev/ttyS0\\n' "
              "> /run/systemd/journald.conf.d/polly-serial.conf\nsystemctl restart systemd-journald\n", 0o755)
        write(root, "etc/systemd/system/polly-installed-serial.service",
              "[Unit]\nConditionKernelCommandLine=polly.serial=1\nBefore=getty@tty1.service\n"
              "[Service]\nType=oneshot\nExecStart=/usr/bin/polly-installed-serial\n"
              "[Install]\nWantedBy=multi-user.target\n")
        (root / "etc/systemd/system/multi-user.target.wants/polly-installed-serial.service").symlink_to(
            "../polly-installed-serial.service")
        # iwd profiles stay volatile; the shared home is not a shared system /var.
        (root / "var/lib/iwd").mkdir(parents=True, exist_ok=True)
        if any((root / "var/lib/iwd").iterdir()):
            raise ValueError("Refusing to include existing Wi-Fi profiles")
        fixture_files = []
        if args.verification_fixture:
            for name, mode in [("persistent-verify", 0o755), ("persistent-storage.mjs", 0o644),
                               ("account-auth-fixture.py", 0o644),
                               ("persistent-poweroff", 0o755)]:
                source = repo / "desktop/tests" / name
                fixture_files.append(source)
                write(root, "usr/share/pollyui/desktop/tests/" + name, source.read_text(), mode)
            write(root, "etc/systemd/system/polly-account-fixture.service",
                  "[Unit]\nConditionKernelCommandLine=polly.verify-persistence=1\n"
                  "Requires=polly-accounts.service\nAfter=polly-accounts.service\nBefore=polly-firstboot.service\n"
                  "[Service]\nType=oneshot\nRemainAfterExit=yes\nTimeoutStartSec=180\n"
                  "ExecStart=/usr/bin/python3 -I /usr/share/pollyui/desktop/tests/account-auth-fixture.py --guest\n")
            write(root, "etc/systemd/system/polly-firstboot.service.d/verification.conf",
                  "[Unit]\nRequires=polly-account-fixture.service\nAfter=polly-account-fixture.service\n")
            write(root, "etc/systemd/system/polly-persistence-test.service",
                  "[Unit]\nConditionKernelCommandLine=polly.verify-persistence=1\nAfter=getty@tty1.service\n"
                  "[Service]\nType=oneshot\nTimeoutStartSec=240\n"
                  "ExecStart=/usr/share/pollyui/desktop/tests/persistent-poweroff\n"
                  "[Install]\nWantedBy=multi-user.target\n")
            enabled = root / "etc/systemd/system/multi-user.target.wants/polly-persistence-test.service"
            enabled.symlink_to("../polly-persistence-test.service")
        filesystems = []
        for part in parts[1:3]:
            write(root, "etc/polly-system-slot", part["name"] + "\n")
            write(root, "etc/fstab",
                  f"UUID={part['uuid']} / ext4 defaults 0 1\n"
                  f"UUID={parts[3]['uuid']} /home ext4 nodev,nosuid 0 2\n"
                  "tmpfs /tmp tmpfs mode=1777,nodev,nosuid 0 0\n"
                  "tmpfs /var/lib/iwd tmpfs mode=0700,nodev,nosuid 0 0\n")
            fs = stage / (part["name"] + ".ext4")
            with fs.open("xb") as destination:
                destination.truncate(part["sizeMiB"] * MIB)
            run("mkfs.ext4", "-q", "-F", "-U", part["uuid"], "-L", "POLLYSYS" + part["name"],
                "-m", "0", "-d", str(root), str(fs))
            run("e2fsck", "-fn", str(fs))
            filesystems.append(fs)
        data_fs = stage / "DATA.ext4"
        with data_fs.open("xb") as destination:
            destination.truncate(parts[3]["sizeMiB"] * MIB)
        run("mkfs.ext4", "-q", "-F", "-U", parts[3]["uuid"], "-L", "POLLYDATA",
            "-m", "0", "-d", str(data), str(data_fs))
        run("e2fsck", "-fn", str(data_fs))
        cfg = stage / "grub.cfg"
        entries = ["set timeout=10", "set default=0", "serial --unit=0 --speed=115200",
                   "terminal_output console serial"]
        for slot, mode, serial in [(0, "baseline", False), (1, "baseline", False),
                                   (0, "gpu", False), (0, "console", False),
                                   (0, "baseline", True), (1, "baseline", True)]:
            part = parts[slot + 1]
            title = f"PollyDesktop installed {part['name']} - " + ("serial VM baseline" if serial else mode)
            options = f"root=UUID={part['uuid']} ro rootwait console=tty0 polly.mode={mode}"
            if serial:
                options += " console=ttyS0,115200 polly.serial=1"
                if args.verification_fixture:
                    options += " polly.verify-persistence=1"
            entries += [f'menuentry "{title}" {{',
                        f" search --no-floppy --fs-uuid --set=root {part['uuid']}",
                        f" linux /boot/{kernel.name} {options}",
                        f" initrd /boot/intel-ucode.img /boot/{initrd.name}", "}"]
        cfg.write_text("\n".join(entries) + "\n")
        efi = stage / "BOOTX64.EFI"
        run("grub-mkstandalone", "-O", "x86_64-efi", "--locales=", "--fonts=",
            "--modules=part_gpt fat ext2 normal linux search search_fs_uuid serial terminal",
            "-o", str(efi), "boot/grub/grub.cfg=" + str(cfg))
        esp = stage / "EFI.fat"
        with esp.open("xb") as destination:
            destination.truncate(256 * MIB)
        run("mkfs.fat", "-F", "32", "-i", parts[0]["uuid"].replace("-", ""), "-n", "POLLYEFI", str(esp))
        run("mmd", "-i", str(esp), "::/EFI", "::/EFI/BOOT")
        run("mcopy", "-i", str(esp), str(efi), "::/EFI/BOOT/BOOTX64.EFI")
        image = stage / f"pollydesktop-{version}-debian13-x86_64-installed.img"
        with image.open("xb") as destination:
            destination.truncate(image_bytes)
        table = "label: gpt\nunit: sectors\n\n" + "".join(
            f"start={p['startSector']},size={p['sectors']},type={p['type']},name=POLLY{p['name']}\n" for p in parts)
        run("sfdisk", str(image), input=table, text=True)
        with image.open("r+b") as destination:
            for part, fs in zip(parts, [esp, *filesystems, data_fs]):
                copy_partition(destination, fs, part["startSector"] * 512)
        run("sfdisk", "--verify", str(image))
        manifest = {
            "schemaVersion": 1, "stage": "development-installed-image", "version": version,
            "distribution": "debian13", "sourceRevision": args.source_revision,
            "sourceDirty": args.source_dirty == "1", "baseImage": args.base_image,
            "exportSha256": digest(args.export), "architecture": "x86_64", "firmware": "UEFI (unsigned)",
            "image": {"name": image.name, "size": image_bytes, "sha256": digest(image)},
            "partitions": parts, "packages": sorted(inventory, key=lambda p: p["name"]),
            "verificationFixture": args.verification_fixture,
            "automaticLogin": "disabled by default; root-configured, once per boot only",
            "accountSetup": "local interactive polly/root passwords; PAM/NSS; no image passwords",
            "accountStateSchemaVersion": 2,
            "persistence": ["/home (settings, managed application objects/registration, AppData, documents)",
                            "/home/.polly-system/accounts (root-managed account configuration/passwords)"],
            "slotState": ["/etc", "/var including dpkg database"], "volatile": ["/run", "/tmp", "/var/lib/iwd"],
            "buildInputs": [{"path": str(p.relative_to(repo)), "sha256": digest(p)} for p in [
                Path(__file__).resolve(), repo / "desktop/tools/build-installed.sh",
                repo / "desktop/release/debian/Containerfile.install",
                repo / "desktop/release/debian/Containerfile.live",
                repo / "desktop/release/install/session", repo / "desktop/release/install/shell.mjs",
                repo / "desktop/release/install/accounts.py", repo / "desktop/release/install/passwd-proxy.c",
                *fixture_files,
            ]],
            "limitations": ["Virtual-disk development candidate, not a physical-disk installer",
                            "Two identical initial system slots, not implemented system update/rollback",
                            "Console setup/login only; integrated GUI login, lock and administration pending",
                            "No encryption, signing or persistent Wi-Fi credential store",
                            "No automatic mounting of other disks; no swap; no online automatic updates"],
        }
        manifest_path = stage / "installed-manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        sums = stage / "SHA256SUMS"
        sums.write_text("".join(f"{digest(p)}  {p.name}\n" for p in [image, manifest_path]))
        output.parent.mkdir(parents=True, exist_ok=True)
        output.mkdir()
        try:
            for source in [image, manifest_path, sums, cfg]:
                with (output / source.name).open("xb") as destination:
                    copy_partition(destination, source, 0)
                    destination.truncate(source.stat().st_size)
        except BaseException:
            shutil.rmtree(output)
            raise
        print("Created regular installed-development image:", output / image.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-dirty", required=True, choices=["0", "1"])
    parser.add_argument("--base-image", required=True)
    parser.add_argument("--system-mib", type=int, default=3072)
    parser.add_argument("--data-mib", type=int, default=2048)
    parser.add_argument("--verification-fixture", action="store_true")
    build(parser.parse_args())


if __name__ == "__main__":
    main()
