#!/usr/bin/env python3
"""Install/verify only the final Live layer's startup display, never account policy."""
import argparse
import json
import os
from pathlib import Path
import runpy
import stat
import subprocess


def files(source):
    mapping = json.loads((source / "desktop/release/debian/boot-files.json").read_text())
    generated = {
        "@generated-logo": runpy.run_path(str(source / "desktop/release/live/boot-assets.py"))["logo"](),
        "@live-theme": b"[Daemon]\nTheme=polly\nShowDelay=0\nDeviceTimeout=8\n",
        "@quiet-login": b"",
    }
    for target, original in mapping.items():
        data = generated[original] if original.startswith("@") else (source / original).read_bytes()
        yield target, original, data, 0o755 if target == "usr/lib/polly-live-splash" else 0o644


def check_packages(root):
    dependencies = json.loads((root / "usr/share/polly-live-boot-dependencies.json").read_text())
    for package, version in dependencies["packages"].items():
        actual = subprocess.check_output(["dpkg-query", "-W", "-f=${Version}", package],
                                         text=True, timeout=10)
        if actual != version:
            raise ValueError(f"Live boot dependency mismatch: {package}: {actual} != {version}")
    for plugin in dependencies["runtime"]:
        if not (root / "usr/lib/x86_64-linux-gnu/plymouth" / plugin).is_file():
            raise ValueError("Missing Plymouth runtime plugin: " + plugin)


def remove_old_getty(root, source):
    directory = root / "etc/systemd/system/getty@tty1.service.d"
    for name, original in (("polly.conf", "getty.conf"), ("live-boot.conf", "live-boot-getty.conf")):
        path = directory / name
        if path.exists() or path.is_symlink():
            if path.is_symlink() or path.read_bytes() != (source / "desktop/release/debian" / original).read_bytes():
                raise ValueError("Refusing to remove an unrecognized Live getty override: " + name)
            path.unlink()


def effective_getty(root):
    """Inspect the real template and lexically merged instance drop-ins."""
    unit = root / "usr/lib/systemd/system/getty@.service"
    dropins = {}
    for prefix in ("usr/lib", "run", "etc"):
        for name in ("getty@.service.d", "getty@tty1.service.d"):
            for path in (root / prefix / "systemd/system" / name).glob("*.conf"):
                dropins[path.name] = path
    values = {}
    for path in (unit, *(dropins[name] for name in sorted(dropins))):
        section = ""
        for line in path.read_text().splitlines():
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1]
            elif section == "Service" and "=" in line and not line.startswith(("#", ";")):
                key, value = line.split("=", 1)
                if key in ("ExecStart", "TTYVTDisallocate"):
                    if key == "ExecStart" and value and values.get(key):
                        raise ValueError("Multiple effective getty ExecStart commands")
                    values[key] = value
    expected = "-/sbin/agetty --autologin polly --noclear --noissue --skip-login %I linux"
    if values.get("ExecStart") != expected or values.get("TTYVTDisallocate") != "no":
        raise ValueError("Effective Live getty lost its quiet autologin contract: " + repr(values))
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["install", "verify"])
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    root = Path("/")
    if args.operation == "install":
        # The caller is building the final Live stage, not platform-base.
        if (root / "etc/polly-account-profile").read_text().strip() != "live":
            raise ValueError("Boot display installation requires the final Live profile")
        remove_old_getty(root, args.source)
        for target, _, data, mode in files(args.source):
            file = root / target
            file.parent.mkdir(parents=True, exist_ok=True)
            if file.is_symlink():
                raise ValueError("Refusing a linked boot display target: " + target)
            file.write_bytes(data)
            file.chmod(mode)
            os.chown(file, 0, 0)
        subprocess.run(["systemctl", "mask", "plymouth-start.service", "plymouth-quit.service",
                        "plymouth-quit-wait.service"], check=True, timeout=20)
        subprocess.run(["systemctl", "enable", "polly-live-splash.service", "polly-live-handoff.service"],
                       check=True, timeout=20)
    check_packages(root)
    effective_getty(root)
    for name in ("polly.conf", "live-boot.conf"):
        if (root / "etc/systemd/system/getty@tty1.service.d" / name).exists():
            raise ValueError("Obsolete Live getty override retained: " + name)
    for target, _, data, mode in files(args.source):
        file = root / target
        info = file.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid or info.st_gid or
                stat.S_IMODE(info.st_mode) != mode or file.read_bytes() != data):
            raise ValueError("Live boot file bytes/ownership/mode mismatch: " + target)
    for unit in ("plymouth-start", "plymouth-quit", "plymouth-quit-wait"):
        if (root / f"etc/systemd/system/{unit}.service").readlink() != Path("/dev/null"):
            raise ValueError("Unexpected distribution Plymouth startup/quit unit: " + unit)
    for target, unit in (("sysinit.target", "polly-live-splash.service"),
                         ("multi-user.target", "polly-live-handoff.service")):
        if (root / f"etc/systemd/system/{target}.wants/{unit}").resolve() != root / f"etc/systemd/system/{unit}":
            raise ValueError("Disabled Live boot display unit: " + unit)
    print("PASS: Live-only boot display source, package pins, plugins and modes")


if __name__ == "__main__":
    main()
