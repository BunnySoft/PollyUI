#!/usr/bin/env python3
"""Build the fixed compositor ABI without mixing Debian testing packages."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request

here = Path(__file__).resolve().parent
sources = json.loads((here / "sources.json").read_text())
for name in ("wlr-protocols", "wlroots"):
    entry = sources[name]
    archive = Path("/opt") / entry["archive"]
    with urllib.request.urlopen(entry["url"], timeout=60) as response, archive.open("wb") as output:
        while block := response.read(1024 * 1024):
            output.write(block)
    with archive.open("rb") as downloaded:
        if hashlib.file_digest(downloaded, "sha512").hexdigest() != entry["sha512"]:
            raise ValueError("Source checksum mismatch: " + name)
    with tarfile.open(archive) as contents:
        contents.extractall("/opt", filter="data")
    directory = Path("/opt") / (name + "-" + entry["version"])
    if name == "wlr-protocols":
        subprocess.run(["make", "install", "PREFIX=/usr/local"], cwd=directory, check=True)
    else:
        subprocess.run(["meson", "setup", str(directory / "build"), str(directory),
                        "--prefix=/opt/pollyui-wlroots", "--libdir=lib", "--buildtype=release",
                        "--wrap-mode=nofallback", "-Dexamples=false", "-Dxwayland=disabled",
                        "-Dbackends=drm,libinput", "-Drenderers=gles2", "-Dsession=enabled",
                        "-Dcolor-management=enabled"], check=True)
        subprocess.run(["meson", "compile", "-C", str(directory / "build"), "-j", "2"], check=True)
        subprocess.run(["meson", "install", "-C", str(directory / "build")], check=True)
