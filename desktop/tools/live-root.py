#!/usr/bin/env python3
"""Private Debian Live root construction helpers. Never use host block devices."""
import gzip
import hashlib
import lzma
import os
from pathlib import Path, PurePosixPath
import re
import runpy
import shutil
import stat
import struct
import subprocess


ROOT_KIND = "squashfs-ram-overlay"
ROOT_PATH = "boot/root.squashfs"
MAX_BOOTSTRAP_BYTES = 64 * 1024 * 1024
DEVICES = {"dev/console": (5, 1, 0o600), "dev/null": (1, 3, 0o666)}
MODULES = (
    "loop", "squashfs", "overlay", "isofs", "vfat", "nls_cp437", "nls_ascii", "nls_utf8",
    "sr_mod", "sd_mod", "ahci", "ata_piix", "virtio_pci", "virtio_blk", "virtio_scsi",
    "hv_vmbus", "hv_storvsc", "xhci_pci", "ehci_pci", "ohci_pci", "uhci_hcd",
    "usb_storage", "uas", "usbhid", "hid_generic", "hid_hyperv", "hyperv_keyboard",
)
GRAPHICS_MODULES = ("hyperv_drm", "virtio_gpu")
PLYMOUTH_PLUGINS = (
    "script.so", "label-pango.so", "details.so", "text.so",
    "renderers/drm.so", "renderers/frame-buffer.so",
)
PLYMOUTH_DATA = (
    "usr/lib/polly-live-splash-control",
    "etc/plymouth/plymouthd.conf", "usr/share/plymouth/plymouthd.defaults",
    "usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    *(f"usr/share/plymouth/themes/{name}" for name in
      ("polly/polly.plymouth", "polly/polly.script", "polly/polly.png",
       "details/details.plymouth", "text/text.plymouth")),
)
APPLETS = (
    "sh", "cat", "chmod", "cp", "mkdir", "mount", "umount", "modprobe", "mdev",
    "sleep", "stat", "sha256sum", "losetup", "switch_root", "sync", "readlink", "tr", "timeout", "id", "rm",
)


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def safe_name(value):
    name = value.removeprefix("./").rstrip("/")
    if name == ".":
        return name
    if (not name or "\\" in name or any(ord(char) < 32 or ord(char) == 127 for char in name) or
            any(part in ("", ".", "..") for part in name.split("/")) or name.startswith("/")):
        raise ValueError("Unsafe export path: " + value)
    return name


def export_members(archive):
    members = {}
    for member in archive:
        name = safe_name(member.name)
        if name in members:
            raise ValueError("Duplicate export path: " + name)
        if not (member.isdir() or member.isfile() or member.issym() or member.islnk()):
            if name.split("/")[0] != "dev":
                raise ValueError("Unexpected export node: " + name)
        members[name] = member
    for name, member in members.items():
        for parent in PurePosixPath(name).parents:
            node = members.get(str(parent))
            if node is not None and not node.isdir():
                raise ValueError("Export path has a non-directory parent: " + name)
        if member.islnk():
            target = safe_name(member.linkname)
            if target not in members or not members[target].isfile():
                raise ValueError("Unsafe/non-regular export hardlink: " + name)
            original = members[target]
            if (member.mode, member.uid, member.gid) != (original.mode, original.uid, original.gid):
                raise ValueError("Conflicting hardlink metadata: " + name)
    return members


def excluded(name):
    return (name.split("/")[0] in {"boot", "dev", "proc", "sys", "run", "tmp"} or
            name in {".dockerenv", "etc/machine-id", "var/lib/dbus/machine-id",
                     "etc/hosts", "etc/hostname", "etc/resolv.conf"})


def extract_root(archive, root):
    members = export_members(archive)
    selected = {name: member for name, member in members.items() if name != "." and not excluded(name)}
    root.mkdir(mode=0o755)
    # Links are created last; archive paths can never traverse an archive symlink.
    for name, member in selected.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if member.isdir():
            path.mkdir(exist_ok=True)
        elif member.isfile():
            with archive.extractfile(member) as source, path.open("xb") as target:
                shutil.copyfileobj(source, target)
    for name, member in selected.items():
        if member.islnk():
            target = safe_name(member.linkname)
            if target not in selected:
                raise ValueError("Hardlink crosses excluded root namespace: " + name)
            os.link(root / target, root / name)
        elif member.issym():
            (root / name).symlink_to(member.linkname)
    for name, member in sorted(selected.items(), key=lambda item: item[0].count("/"), reverse=True):
        path = root / name
        os.chown(path, member.uid, member.gid, follow_symlinks=False)
        if not member.issym():
            path.chmod(member.mode)
        for key, value in member.pax_headers.items():
            if key.startswith("SCHILY.xattr."):
                os.setxattr(path, key[len("SCHILY.xattr."):], value.encode("utf-8", "surrogateescape"),
                            follow_symlinks=False)
            elif "xattr" in key.lower():
                raise ValueError("Unsupported export xattr encoding: " + key)
    for name in ("dev", "proc", "sys", "run", "tmp", "etc"):
        (root / name).mkdir(exist_ok=True)
    (root / "tmp").chmod(0o1777)
    (root / "etc/hosts").write_bytes(b"127.0.0.1 localhost polly-live\n::1 localhost\n")
    (root / "etc/hostname").write_bytes(b"polly-live\n")
    (root / "etc/resolv.conf").symlink_to("/run/polly-network/resolv.conf")
    root.chmod(0o755)
    return len(selected), sum(member.size for member in selected.values() if member.isfile())


def root_file(root, path):
    """Resolve absolute/relative export symlinks inside the export, not on the host."""
    pending = list(PurePosixPath(path).parts)
    if pending and pending[0] == "/":
        pending.pop(0)
    resolved = []
    links = 0
    while pending:
        part = pending.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            if not resolved:
                raise ValueError("Export link escapes root: " + str(path))
            resolved.pop()
            continue
        node = root.joinpath(*resolved, part)
        if node.is_symlink():
            links += 1
            if links > 40:
                raise ValueError("Export symlink loop: " + str(path))
            link = PurePosixPath(os.readlink(node))
            if link.is_absolute():
                resolved = []
            pending = [piece for piece in link.parts if piece != "/"] + pending
        else:
            resolved.append(part)
    return root.joinpath(*resolved)


def module_closure(root, kernel, graphics=GRAPHICS_MODULES):
    paths = set()
    for module in (*MODULES, *graphics):
        output = subprocess.check_output(
            ["modprobe", "--config", "/dev/null", "--dirname", str(root),
             "--set-version", kernel, "--show-depends", "--ignore-install", module],
            text=True, timeout=30)
        for line in output.splitlines():
            if line.startswith("builtin "):
                continue
            if not line.startswith("insmod ") or len(line.split()) != 2:
                raise ValueError("Unexpected module dependency: " + line)
            path = Path(line.split()[1])
            relative = path.relative_to(root)
            resolved = root_file(root, relative)
            if not resolved.is_file():
                raise ValueError("Missing kernel dependency: " + str(relative))
            paths.add(resolved)
    return sorted(paths)


def write_cpio(root, target):
    files = sorted(root.rglob("*"))
    if any((root / name).exists() or (root / name).is_symlink() for name in DEVICES):
        raise ValueError("Bootstrap device nodes must be synthesized only in newc")
    total = sum(path.lstat().st_size for path in files if path.is_file() and not path.is_symlink())
    if total > MAX_BOOTSTRAP_BYTES or any(path.name.endswith(".squashfs") for path in files):
        raise ValueError("Bootstrap must be <=64 MiB unpacked and contain no SquashFS root")
    with target.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as out:
        for inode, path in enumerate([root, *files, *DEVICES, None], 1):
            major = minor = 0
            if isinstance(path, str):
                name = path
                major, minor, permissions = DEVICES[name]
                mode = stat.S_IFCHR | permissions
                data = b""
            else:
                name = "TRAILER!!!" if path is None else "." if path == root else path.relative_to(root).as_posix()
                mode = 0 if path is None else path.lstat().st_mode
                data = (os.readlink(path).encode() if stat.S_ISLNK(mode) else
                        path.read_bytes() if stat.S_ISREG(mode) else b"")
            encoded = name.encode() + b"\0"
            fields = (inode, mode, 0, 0, 1, 0, len(data), 0, 0, major, minor, len(encoded), 0)
            header = ("070701" + "".join(f"{value:08x}" for value in fields)).encode()
            out.write(header + encoded + b"\0" * (-(110 + len(encoded)) % 4))
            out.write(data + b"\0" * (-len(data) % 4))
    return total


def copy_elf(program, bootstrap, destination):
    executable = Path(shutil.which(program) or ("/missing-" + program))
    target = bootstrap / destination
    shutil.copyfile(executable, target)
    target.chmod(0o755)
    output = subprocess.check_output(["ldd", str(executable)], text=True, timeout=10)
    libraries = []
    for line in output.splitlines():
        if "linux-vdso.so." in line:
            continue
        match = re.fullmatch(r"\s*(?:\S+ => )?(/\S+) \(0x[0-9a-f]+\)\s*", line)
        if not match:
            raise ValueError("Unresolved bootstrap ELF dependency: " + line)
        source = Path(match[1])
        target = bootstrap / source.relative_to("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(stat.S_IMODE(source.stat().st_mode))
        libraries.append({"path": source.as_posix(), "sha256": digest(source)})
    return {"path": executable.as_posix(), "sha256": digest(executable), "libraries": libraries}


def copy_root_elf(root, bootstrap, path, destination=None, copied=None):
    """Resolve DT_NEEDED from the exported root, never the build host's loader."""
    copied = {} if copied is None else copied
    source = root_file(root, path)
    destination = destination or path.lstrip("/")
    safe_name(destination)
    target = bootstrap / destination
    fingerprint = digest(source)
    if destination in copied:
        if copied[destination] != fingerprint:
            raise ValueError("Conflicting bootstrap ELF dependency: " + destination)
        return copied
    data = source.read_bytes()
    if data[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", data, 18)[0] != 62:
        raise ValueError("Expected exported x86-64 ELF: " + path)
    copied[destination] = fingerprint
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    target.chmod(stat.S_IMODE(source.stat().st_mode))
    headers = subprocess.check_output(["readelf", "-lW", str(source)], text=True, timeout=10)
    dynamic = subprocess.check_output(["readelf", "-dW", str(source)], text=True, timeout=10)
    if re.search(r"\((?:RPATH|RUNPATH)\)", dynamic):
        raise ValueError("Unexpected bootstrap ELF search path: " + path)
    interpreter = re.search(r"Requesting program interpreter: (/\S+)\]", headers)
    if interpreter:
        copy_root_elf(root, bootstrap, interpreter[1], copied=copied)
    for soname in re.findall(r"\(NEEDED\).*Shared library: \[([^]]+)\]", dynamic):
        if not re.fullmatch(r"[A-Za-z0-9+_.-]+", soname):
            raise ValueError("Invalid ELF dependency: " + soname)
        candidates = ["/usr/lib/x86_64-linux-gnu/" + soname, "/lib/x86_64-linux-gnu/" + soname]
        selected = next((candidate for candidate in candidates if root_file(root, candidate).is_file()), None)
        if selected is None:
            raise ValueError("Missing exported ELF dependency: " + soname)
        copy_root_elf(root, bootstrap, selected, "lib/x86_64-linux-gnu/" + soname, copied)
    return copied


def copy_plymouth(root, bootstrap, copied):
    for source, destination in (("/usr/bin/plymouth", "bin/plymouth"),
                                ("/usr/sbin/plymouthd", "bin/plymouthd"),
                                ("/usr/libexec/plymouth/plymouthd-fd-escrow",
                                 "usr/libexec/plymouth/plymouthd-fd-escrow")):
        copy_root_elf(root, bootstrap, source, destination, copied)
    for name in PLYMOUTH_PLUGINS:
        copy_root_elf(root, bootstrap, "/usr/lib/x86_64-linux-gnu/plymouth/" + name, copied=copied)
    for path in PLYMOUTH_DATA:
        target = bootstrap / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root_file(root, path), target)
    (bootstrap / "etc/fonts").mkdir()
    (bootstrap / "etc/fonts/fonts.conf").write_text(
        '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n'
        '<fontconfig><dir>/usr/share/fonts/truetype/dejavu</dir>'
        '<cachedir>/run/plymouth/fontconfig</cachedir></fontconfig>\n')
    (bootstrap / "etc/passwd").write_text("root:x:0:0:root:/root:/bin/sh\n")
    (bootstrap / "etc/nsswitch.conf").write_text("passwd: files\ngroup: files\n")
    (bootstrap / "etc/initrd-release").write_text("ID=polly-live-bootstrap\n")
    minimum = int(subprocess.check_output(
        ["chroot", str(root), "/usr/bin/python3", "-I", "-c",
         "import signal; print(int(signal.SIGRTMIN))"], text=True, timeout=10))
    if not 32 <= minimum <= 40:
        raise ValueError("Unexpected target libc SIGRTMIN")
    (bootstrap / "etc/polly-live-signals").write_text(
        f"POLLY_PLYMOUTH_PRINT_SIGNAL={minimum + 20}\nPOLLY_PLYMOUTH_STOP_SIGNAL={minimum + 21}\n")
    return sorted(copied)


def build_bootstrap(root, staging, boot, repo, kernel, config, identity, squashfs, sku=None):
    selected = hardware = kernel_input = None
    graphics = GRAPHICS_MODULES
    if sku is not None:
        profiles = runpy.run_path(str(repo / "desktop/release/debian/live-profile.py"))
        selected = profiles["verify"](root, sku)
        profiles["verify_kernel"](config, selected)
        graphics = tuple(selected["displayPolicy"]["bootstrapModules"])
        hardware = {key: selected[key] for key in ("sku", "manifestSha256")}
        if sku == "basic":
            kernel_input = runpy.run_path(str(repo / "desktop/release/debian/basic-kernel.py"))["verify_root"](root)
            if kernel != kernel_input["kernelRelease"] or hashlib.sha256(config.encode()).hexdigest() != kernel_input["configSha256"]:
                raise ValueError("Actual boot kernel/config differs from dedicated kernel pack")
    for option in ("CONFIG_DEVTMPFS", "CONFIG_TMPFS", "CONFIG_PROC_FS", "CONFIG_SYSFS",
                   "CONFIG_EFI_PARTITION", "CONFIG_MSDOS_PARTITION", "CONFIG_VT",
                   "CONFIG_VT_CONSOLE", "CONFIG_FB_EFI", "CONFIG_FRAMEBUFFER_CONSOLE"):
        if f"{option}=y" not in config.splitlines():
            raise ValueError("Live kernel needs built-in " + option)
    bootstrap = staging / "bootstrap"
    bootstrap.mkdir()
    for directory in ("bin", "etc", "lib", "dev", "proc", "sys", "run", "tmp", "newroot", "media"):
        (bootstrap / directory).mkdir()
    busybox = Path(shutil.which("busybox") or "/missing-busybox-static")
    data = busybox.read_bytes()
    if data[:6] != b"\x7fELF\x02\x01":
        raise ValueError("Bootstrap requires a static x86-64 BusyBox")
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phsize, phnum = struct.unpack_from("<HH", data, 54)
    if struct.unpack_from("<H", data, 18)[0] != 62 or any(
            struct.unpack_from("<I", data, phoff + i * phsize)[0] == 3 for i in range(phnum)):
        raise ValueError("BusyBox is not static x86-64")
    applets = subprocess.check_output([str(busybox), "--list"], text=True, timeout=10).splitlines()
    if set(APPLETS) - set(applets):
        raise ValueError("BusyBox omits required applets: " + repr(set(APPLETS) - set(applets)))
    shutil.copyfile(busybox, bootstrap / "bin/busybox")
    (bootstrap / "bin/busybox").chmod(0o755)
    for applet in APPLETS:
        (bootstrap / "bin" / applet).symlink_to("busybox")
    copied = copy_root_elf(root, bootstrap, "/usr/sbin/blkid", "bin/blkid")
    plymouth_files = copy_plymouth(root, bootstrap, copied)
    blkid = {"path": "/usr/sbin/blkid", "sha256": digest(root_file(root, "/usr/sbin/blkid"))}
    modules = module_closure(root, kernel, graphics)
    for path in modules:
        relative = path.relative_to(root)
        # Debian merged-/usr source is normalized to BusyBox's /lib/modules.
        name = relative.as_posix().removeprefix("usr/")
        output = bootstrap / name
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.suffix in (".xz", ".gz"):
            output = output.with_suffix("")
            opener = lzma.open if path.suffix == ".xz" else gzip.open
            with opener(path, "rb") as source, output.open("wb") as target:
                shutil.copyfileobj(source, target)
        elif output.suffix == ".ko":
            shutil.copyfile(path, output)
        else:
            raise ValueError("Unsupported module compression: " + str(relative))
        firmware = subprocess.check_output(["modinfo", "-F", "firmware", str(path)],
                                           text=True, timeout=10).splitlines()
        for name in firmware:
            safe_name(name)
            matches = sorted((root / "usr/lib/firmware").glob(name))
            if not matches:
                raise ValueError("Missing bootstrap firmware: " + name)
            for source in matches:
                target = bootstrap / "lib/firmware" / source.relative_to(root / "usr/lib/firmware")
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(root_file(root, source.relative_to(root)), target)
    module_dir = bootstrap / "lib/modules" / kernel
    for name in ("modules.builtin", "modules.builtin.modinfo", "modules.order"):
        shutil.copyfile(root_file(root, f"usr/lib/modules/{kernel}/{name}"), module_dir / name)
    subprocess.run(["depmod", "--basedir", str(bootstrap), kernel], check=True, timeout=30)
    shutil.copyfile(repo / "desktop/release/debian/live-bootstrap", bootstrap / "init")
    (bootstrap / "init").chmod(0o755)
    metadata = {"identity": identity, "sha256": digest(squashfs), "size": squashfs.stat().st_size}
    (bootstrap / "etc/polly-live-root").write_text(
        f"POLLY_MEDIA_ID={identity}\nPOLLY_ROOT_SHA256={metadata['sha256']}\n"
        f"POLLY_ROOT_BYTES={metadata['size']}\n")
    (bootstrap / "etc/polly-live-modules").write_text("\n".join(MODULES) + "\n")
    (bootstrap / "etc/polly-live-graphics-modules").write_text("\n".join(graphics) + "\n")
    if sku is not None:
        (bootstrap / "etc/polly-live-hardware").write_bytes(profiles["marker"](sku))
        if kernel_input is not None:
            (bootstrap / "etc/polly-live-kernel").write_bytes((root / "usr/share/polly-basic-kernel.json").read_bytes())
            (bootstrap / "etc/polly-live-graphics-required").write_bytes(b"simpledrm\n")
    inventory = []
    for path in sorted(bootstrap.rglob("*")):
        info = path.lstat()
        record = {"path": path.relative_to(bootstrap).as_posix(), "mode": info.st_mode}
        if path.is_symlink():
            record["link"] = os.readlink(path)
        elif path.is_file():
            record.update({"size": info.st_size, "sha256": digest(path)})
        inventory.append(record)
    for name, (major, minor, permissions) in DEVICES.items():
        inventory.append({"path": name, "mode": stat.S_IFCHR | permissions, "device": [major, minor]})
    total = write_cpio(bootstrap, boot / "initramfs.gz")
    result = {
        "kind": ROOT_KIND, "path": ROOT_PATH, "sha256": metadata["sha256"],
        "size": metadata["size"], "mediaIdentity": identity, "copyToRam": True,
        "writable": "tmpfs-overlay", "bootstrap": {
            "path": "boot/initramfs.gz", "sha256": digest(boot / "initramfs.gz"),
            "size": (boot / "initramfs.gz").stat().st_size, "uncompressedBytes": total,
            "kernelRelease": kernel, "modules": [path.relative_to(root).as_posix() for path in modules],
            "busyboxSha256": digest(busybox), "blkid": blkid,
            "plymouthFiles": plymouth_files, "plymouthMode": "early-single-daemon-legacy-vt-input",
            "files": inventory,
        },
    }
    if hardware is not None:
        result["hardwareProfile"] = hardware
        result["displayPolicy"] = selected["displayPolicy"]
        result["bootstrap"]["graphicsModules"] = list(graphics)
    if kernel_input is not None:
        result["kernelInput"] = kernel_input
    shutil.rmtree(bootstrap)
    return result
