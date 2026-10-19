#!/usr/bin/env python3
"""Select a real primary simpledrm KMS node for basic; framebuffer-only is a visible failure."""
import argparse
import json
from pathlib import Path
import re
import runpy
import stat
import sys

HERE = Path(__file__).resolve().parent
PROFILES = runpy.run_path(str(HERE / "live-profile.py"))


def selection(root, mode, gpu):
    marker = root / PROFILES["MARKER"]
    PROFILES["regular"](marker)
    sku = json.loads(marker.read_bytes()).get("sku")
    selected = PROFILES["profile"](sku)
    PROFILES["regular"](marker, PROFILES["marker"](sku))
    PROFILES["regular"](root / PROFILES["PROFILE_COPY"], PROFILES["MANIFEST"].read_bytes())
    if selected["displayPolicy"]["kind"] != "simpledrm-software":
        return "native"
    PROFILES["regular"](root / PROFILES["BASIC_MODPROBE"], PROFILES["modprobe_policy"](sku))
    if mode == "gpu" or gpu != "auto":
        raise ValueError("basic is CPU software-only: GPU acceleration/vendor requests are refused; use a GPU SKU")
    cmdline = (root / "proc/cmdline").read_text().split()
    if "nomodeset" in cmdline or "video=simpledrm:off" in cmdline:
        raise ValueError("basic requires simpledrm KMS; nomodeset/video=simpledrm:off disables the required path")
    for argument in selected["displayPolicy"]["kernelArguments"]:
        if argument not in cmdline:
            raise ValueError("basic native-GPU exclusion policy missing from actual kernel command line")
    cards = [path for path in (root / "sys/class/drm").glob("card*") if re.fullmatch(r"card\d+", path.name)]
    if len(cards) != 1:
        raise ValueError("basic needs exactly one primary simpledrm KMS card; none/ambiguous or native takeover")
    card = cards[0]
    driver = card / "device/driver"
    if not driver.is_symlink() or driver.resolve().name != "simple-framebuffer":
        raise ValueError("basic DRM card is not the simpledrm simple-framebuffer platform driver; possible native takeover")
    module = driver / "module"
    if module.is_symlink() and module.resolve().name != "simpledrm":
        raise ValueError("basic DRM card belongs to another framebuffer module")
    device = root / "dev/dri" / card.name
    info = device.stat()
    if not stat.S_ISCHR(info.st_mode) or info.st_rdev != _device(card):
        raise ValueError("basic primary DRM node does not match its sysfs device")
    if not any(path.name.startswith(card.name + "-") and (path / "status").is_file() and
               (path / "status").read_text().strip() == "connected" and (path / "modes").read_text().strip()
               for path in (root / "sys/class/drm").iterdir()):
        raise ValueError("basic simpledrm has no connected KMS output/mode; framebuffer/Plymouth is not desktop success")
    return "/dev/dri/" + card.name


def _device(card):
    import os
    text = (card / "dev").read_text().strip()
    if not re.fullmatch(r"\d+:\d+", text):
        raise ValueError("Malformed sysfs DRM device identity")
    major, minor = map(int, text.split(":"))
    return os.makedev(major, minor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("baseline", "gpu", "console"), required=True)
    parser.add_argument("--gpu", required=True)
    args = parser.parse_args()
    try:
        print(selection(Path("/"), args.mode, args.gpu))
    except (ValueError, OSError) as error:
        print("Live display refused: " + str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
