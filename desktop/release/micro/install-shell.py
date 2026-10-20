#!/usr/bin/env python3
"""Stage the musl Shell runtime, or report the resulting Micro Shell ISO."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


REPO = Path("/repo")
WORK = Path("/work")
MODULE_IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\./(?:desktop|gui|sysrt)/[^'"]+)['"]""")


def run(*command):
    return subprocess.check_output(command, text=True).strip()


def copy(source, destination):
    source = Path(source)
    if not source.is_file():
        raise ValueError("Missing runtime input: " + str(source))
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        destination.unlink()
    shutil.copyfile(source, destination)
    shutil.copymode(source, destination)


def validate_modules(resources):
    for source in resources.rglob("*.mjs"):
        for name in MODULE_IMPORT.findall(source.read_text()):
            if not (resources / name).is_file():
                raise ValueError(f"Missing Shell module {name}, imported by {source.relative_to(resources)}")


def complete_modules(resources):
    pending = list(resources.rglob("*.mjs"))
    visited = set()
    while pending:
        source = pending.pop()
        if source in visited:
            continue
        visited.add(source)
        for name in MODULE_IMPORT.findall(source.read_text()):
            relative = Path(name)
            if ".." in relative.parts:
                raise ValueError("Non-rooted Shell module import: " + name)
            target = resources / relative
            if not target.is_file():
                copy(REPO / relative, target)
            pending.append(target)


def read_boot_modules(file):
    modules = [line.strip() for line in file.read_text().splitlines()
               if line.strip() and not line.lstrip().startswith("#")]
    if not modules or any(not re.fullmatch(r"[a-z0-9_]+", name) for name in modules):
        raise ValueError("Invalid Micro boot module list")
    if len(set(modules)) != len(modules):
        raise ValueError("Duplicate Micro boot module")
    return modules


def shell_product():
    product = os.environ.get("MICRO_PRODUCT", "micro")
    if product not in ("micro", "mini"):
        raise ValueError("Unknown Alpine Shell product: " + product)
    return product


def stage(root, release):
    root = root.resolve(strict=True)
    product = shell_product()
    subprocess.run([
        "cmake", "--install", str(WORK / "ui"), "--prefix", "/usr", "--component", "PollyDesktop",
    ], check=True, env={**os.environ, "DESTDIR": str(root)})
    objects = [
        (WORK / "ui/pollyui", root / "usr/bin/pollyui"),
        (WORK / "ui/desktop/pollywm", root / "usr/bin/pollywm"),
        (WORK / "ui/polly-app", root / "usr/bin/polly-app"),
        (WORK / "ui/pollyui-app-launcher", root / "usr/bin/pollyui-app-launcher"),
        (Path(shutil.which("dbus-daemon")), root / "usr/bin/dbus-daemon"),
        (Path(shutil.which("udevd")), root / "sbin/udevd"),
        (Path(shutil.which("udevadm")), root / "sbin/udevadm"),
        (Path(shutil.which("modprobe")), root / "sbin/modprobe"),
        (Path(shutil.which("foot")), root / "usr/bin/foot"),
        (Path(shutil.which("file")), root / "usr/bin/file"),
        (Path(shutil.which("seatd")), root / "usr/bin/seatd"),
    ]
    for source, destination in objects:
        dependencies = run("lddtree", "-l", str(source)).splitlines()
        for name in dependencies:
            library = Path(name)
            if not library.is_absolute() or not library.is_file():
                raise ValueError("Unresolved runtime library: " + name)
            if any(token in library.name for token in ("libgbm", "libEGL", "libGLES", "libLLVM")):
                raise ValueError("GPU library leaked into CPU Shell: " + name)
            if library == source:
                continue
            if library.is_relative_to(WORK / "prefix"):
                relative = (Path("usr/lib/pollyui/libSDL3.so.0") if library.name.startswith("libSDL3")
                            else Path("usr/local/lib") / library.name)
            else:
                relative = library.relative_to("/")
            copy(library, root / relative)
        copy(source, destination)
        subprocess.run(["patchelf", "--remove-rpath", str(destination)], check=True)
        subprocess.run(["strip", "--strip-unneeded", str(destination)], check=True)
    for name in ("libc.so", "libc.musl-x86_64.so.1"):
        link = root / "lib" / name
        if not link.exists():
            link.symlink_to("ld-musl-x86_64.so.1")

    module_list = REPO / "desktop/release/micro/shell-modules"
    for module in read_boot_modules(module_list):
        for line in run("modprobe", "-S", release, "--show-depends", module).splitlines():
            if line.startswith("insmod "):
                source = Path(line.split()[1])
                copy(source, root / source.relative_to("/"))
    copy(module_list, root / "etc/micro-modules")
    (root / "etc/polly-product").write_text(product + "\n")
    subprocess.run(["depmod", "-b", str(root), release], check=True)
    for source in ("/etc/udev", "/lib/udev", "/usr/lib/udev"):
        if Path(source).is_dir():
            shutil.copytree(source, root / source.lstrip("/"), dirs_exist_ok=True)
    shutil.copytree("/usr/share/libinput", root / "usr/share/libinput", dirs_exist_ok=True)
    for source in ("/lib/udev", "/usr/lib/udev"):
        for file in Path(source).glob("*"):
            if file.is_file() and file.read_bytes()[:4] == b"\x7fELF":
                for name in run("lddtree", "-l", str(file)).splitlines():
                    library = Path(name)
                    if not library.is_absolute() or not library.is_file():
                        raise ValueError("Unresolved udev helper dependency: " + name)
                    copy(library, root / library.relative_to("/"))

    resources = root / "usr/share/pollyui"
    copy(REPO / "desktop/release/micro/shell.mjs", resources / "desktop/release/micro/shell.mjs")
    complete_modules(resources)
    validate_modules(resources)
    subprocess.run([
        "python3", str(REPO / "sysrt/tools/generate-files-abi.py"),
        "--output", str(resources / "sysrt/bindings/generated/files-linux-x86_64.mjs"),
    ], check=True)

    for name in ("DejaVuSans.ttf", "DejaVuSansMono.ttf"):
        fonts = list(Path("/usr/share/fonts").rglob(name))
        if len(fonts) != 1:
            raise ValueError("Expected one basic font: " + name)
        copy(fonts[0], root / "usr/share/fonts/dejavu" / name)
    shutil.copytree("/etc/fonts", root / "etc/fonts", dirs_exist_ok=True)
    shutil.copytree("/usr/share/X11/xkb", root / "usr/share/X11/xkb", dirs_exist_ok=True)
    for name in ("compose.dir", "locale.alias", "locale.dir"):
        copy(Path("/usr/share/X11/locale") / name, root / "usr/share/X11/locale" / name)
    shutil.copytree("/usr/share/X11/locale/en_US.UTF-8",
                    root / "usr/share/X11/locale/en_US.UTF-8", dirs_exist_ok=True)
    shutil.copytree("/usr/share/icu", root / "usr/share/icu", dirs_exist_ok=True)
    shutil.copytree("/usr/share/terminfo", root / "usr/share/terminfo", dirs_exist_ok=True)
    for source in Path("/usr/share").glob("misc/magic*"):
        if source.is_file():
            copy(source, root / source.relative_to("/"))
    foot_config = root / "etc/xdg/foot/foot.ini"
    foot_config.parent.mkdir(parents=True, exist_ok=True)
    foot_config.write_text("[main]\nfont=DejaVu Sans Mono:size=11\n")
    shutil.copytree("/usr/share/dbus-1", root / "usr/share/dbus-1", dirs_exist_ok=True)
    for source in ("/etc/dbus-1",):
        shutil.copytree(source, root / source.lstrip("/"), dirs_exist_ok=True)
    copy(WORK / "skia/LICENSE", root / "usr/share/licenses/pollyui/skia/LICENSE")
    copy(WORK / "sdl/LICENSE.txt", root / "usr/share/licenses/pollyui/sdl/LICENSE.txt")
    for source, destination in (
        ("LICENSE", "LICENSE"),
        ("desktop/LICENSE.wlroots", "wlroots/LICENSE"),
        ("third_party/quickjs/LICENSE", "quickjs/LICENSE"),
        ("third_party/yoga/LICENSE", "yoga/LICENSE"),
    ):
        copy(REPO / source, root / "usr/share/licenses/pollyui" / destination)
    brand = "Polly Mini" if product == "mini" else "Polly Micro"
    (root / "etc/passwd").write_text("root:x:0:0:Root:/root:/bin/sh\n"
                                    f"polly:x:1000:1000:{brand}:/home/polly:/bin/sh\n")
    copy("/etc/group", root / "etc/group")
    with (root / "etc/group").open("a") as group:
        group.write("polly:x:1000:\n")
    home = root / "home/polly"
    home.mkdir(parents=True, mode=0o700)
    os.chown(home, 1000, 1000)
    (home / "Welcome.txt").write_text(f"Welcome to {brand}.\nThis Live session does not persist changes.\n")
    os.chown(home / "Welcome.txt", 1000, 1000)
    copy(REPO / "desktop/release/micro/shell-session", root / "usr/bin/micro-session")
    (root / "usr/bin/micro-session").chmod(0o755)
    (root / "etc/machine-id").write_text("f687df905d7e4d58a44443ed4cfcc2dc\n")
    for applet in ("chmod", "ln", "logger", "mknod", "readlink", "id", "pwd", "dirname", "basename",
                   "echo", "printf", "clear", "env", "uname", "ps", "top", "vi",
                   "cp", "mv", "rm", "touch", "rmdir", "date", "head", "tail",
                   "grep", "sed", "find", "wc", "su", "chown"):
        (root / "bin" / applet).symlink_to("busybox")


def report(image, release):
    root = WORK / "initroot"
    product = shell_product()
    components = {}
    for file in root.rglob("*"):
        if file.is_file() and not file.is_symlink():
            group = ("modules" if "lib/modules/" in str(file.relative_to(root)) else
                     "shell-resources" if file.is_relative_to(root / "usr/share/pollyui") else
                     "fonts" if file.is_relative_to(root / "usr/share/fonts") else
                     "other-runtime")
            components[group] = components.get(group, 0) + file.stat().st_size
    revision = run("git", "-c", "safe.directory=/repo", "-C", "/repo", "rev-parse", "HEAD")
    dirty = bool(run("git", "-c", "safe.directory=/repo", "-C", "/repo",
                     "status", "--porcelain", "--untracked-files=normal"))
    with image.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    result = {
        "schemaVersion": 1, "sku": "mini" if product == "mini" else "micro-shell",
        "product": product, "prototype": True,
        "sourceRevision": revision, "sourceDirty": dirty, "kernelRelease": release,
        "distribution": "alpine3.24", "libc": "musl",
        "shell": "pollyui", "compositor": "pollywm", "renderer": "pixman",
        "decorator": "pollyui-windowless",
        "sessionUid": 1000, "seat": "seatd", "authentication": "not-provided",
        "applications": ["Files", "Settings", "Processes", "File Text", "Foot"],
        "displayPaths": ["uefi-gop-simpledrm", "virtio-gpu"],
        "bootModules": read_boot_modules(root / "etc/micro-modules"),
        "chineseFonts": False, "inputMethod": False,
        "isoBytes": image.stat().st_size, "isoSha256": digest,
        "kernelBytes": (WORK / "vmlinuz").stat().st_size,
        "initramfsBytes": (WORK / "initramfs.gz").stat().st_size,
        "uncompressedComponents": components,
        "bootValidation": "not-run",
    }
    image.with_suffix(".json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--report":
        report(Path(sys.argv[2]), sys.argv[3])
    elif len(sys.argv) == 3:
        stage(Path(sys.argv[1]), sys.argv[2])
    else:
        raise SystemExit("Usage: install-shell.py ROOT KERNEL | --report ISO KERNEL")
