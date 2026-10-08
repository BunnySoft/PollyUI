#!/usr/bin/env python3
"""Private ordinary Files input/MIME producer; uses only the shared native driver."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import signal
import stat
import struct
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("driver", type=Path)
    parser.add_argument("runtime", type=Path)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    if (os.getuid(), os.geteuid(), os.getgid(), os.getegid()) != (1000, 1000, 1000, 1000):
        raise PermissionError("Files native acceptance requires actual ordinary UID/GID1000")
    if not args.driver.is_absolute() or not args.runtime.is_absolute() or not args.evidence.is_absolute():
        raise ValueError("Driver, rebuilt engine and private evidence must be absolute")
    repo = Path(__file__).resolve().parents[2]
    evidence = args.evidence
    evidence.mkdir(parents=True, exist_ok=False)
    root = Path(tempfile.mkdtemp(prefix="polly-files-window-"))
    for name in ("Documents", "Downloads", "Desktop", "config", "data", "data/applications",
                 "state", "cache", "share", "evidence"):
        (root / name).mkdir(parents=True, exist_ok=True, mode=0o700)
    for directory in (root, root / "evidence"):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (1000, 1000, 0o700):
            raise PermissionError("Private fixture HOME/evidence must be real UID/GID1000 mode0700 directories")
    (root / "fixture-marker.txt").write_text("POLLY-FILES-PRIVATE-WINDOW-V1\n")
    document = root / "literal %u; \u4e2d\u6587.txt"
    document.write_text("Synthetic private Files MIME content.\n", encoding="utf8")
    for index in range(96):
        (root / f"row-{index:03}.txt").write_text("Synthetic bounded list row.\n")
    helper = root / "mime-helper.py"
    helper.write_text(
        "import json, os, pathlib, sys\n"
        "if os.getuid() != 1000 or len(sys.argv) != 2: raise RuntimeError('Invalid fixture dispatch')\n"
        "target = pathlib.Path(sys.argv[1])\n"
        "with pathlib.Path(__file__).with_name('mime-result.json').open('x') as out:\n"
        " json.dump({'uid': os.getuid(), 'argv': sys.argv[1:], 'cwd': os.getcwd(), "
        "'text': target.read_text(encoding='utf8')}, out)\n")
    (root / "data/applications/files-fixture.desktop").write_text(
        "[Desktop Entry]\nType=Application\nName=Private Files document consumer\n"
        f"Exec=/usr/bin/python3 -I -B {helper} %F\nMimeType=text/plain;\nTerminal=false\n")
    (root / "config/mimeapps.list").write_text(
        "[Default Applications]\ntext/plain=files-fixture.desktop;\n")
    environment = dict(os.environ, HOME=str(root), XDG_CONFIG_HOME=str(root / "config"),
                       XDG_DATA_HOME=str(root / "data"), XDG_STATE_HOME=str(root / "state"),
                       XDG_CACHE_HOME=str(root / "cache"), XDG_DATA_DIRS=str(root / "share"),
                       PU_RENDERER="raster")
    command = ["sh", str(repo / "desktop/tests/runtime-client.sh"), str(args.driver), str(args.runtime),
               str(repo / "desktop/tests/files-window-shell.mjs"), "files-window", "initial"]
    (evidence / "inputs.json").write_text(json.dumps({
        "uid": os.getuid(), "root": str(root), "command": command, "cwd": str(repo),
        "driverSha256": hashlib.sha256(args.driver.read_bytes()).hexdigest(),
        "runtimeSha256": hashlib.sha256(args.runtime.read_bytes()).hexdigest(),
        "syntheticMetadataOnly": True, "hostEnumeration": False,
    }, indent=2) + "\n")
    with (evidence / "native.log").open("wb") as log:
        process = subprocess.Popen(command, cwd=repo, env=environment, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            process.wait(timeout=150)
        except subprocess.TimeoutExpired as error:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            raise RuntimeError("Files native fixture timed out; original private evidence retained") from error
    text = (evidence / "native.log").read_text(errors="replace")
    if process.returncode or "FILES_WINDOW_FAIL:" in text or "FILES_WINDOW_SUPERVISOR_FAIL:" in text:
        raise RuntimeError("Actual Files native fixture failed; original private evidence retained")
    for marker in ("FILES_WINDOW_DRIVE_PASS:", "FILES_WINDOW_CLOSE_PASS:", "FILES_WINDOW_SUPERVISOR_PASS:"):
        if marker not in text:
            raise RuntimeError("Missing actual Files action/normal-close receipt: " + marker)
    receipt = json.loads((root / "mime-result.json").read_text())
    if receipt != {"uid": 1000, "argv": [str(document)], "cwd": str(repo), "text": document.read_text()}:
        raise RuntimeError("Actual MIME helper argv/cwd/ordinary UID/read content differs from the fixture")
    (evidence / "mime-result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    receipt_bytes = (root / "files-window-result.json").read_bytes()
    result = json.loads(receipt_bytes)
    stages = ["home-browser", "scrolled-list", "new-folder", "rename-edit", "renamed-folder", "before-wm-close"]
    if [capture["stage"] for capture in result["captures"]] != stages:
        raise RuntimeError("Native Files capture order is not the fixed six-stage contract")
    images = []
    for capture in result["captures"]:
        path = root / "evidence" / ("files-" + capture["stage"] + ".png")
        info = path.lstat()
        if capture["path"] != str(path) or capture["kind"] != "presented-app-buffer" or \
                not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid) != (1000, 1000) or \
                info.st_size != capture["bytes"]:
            raise RuntimeError("Native Files capture path/kind/owner/bytes changed")
        data = path.read_bytes()
        if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR" or len(data) < 24:
            raise RuntimeError("Native Files capture lacks a PNG header")
        width, height = struct.unpack(">II", data[16:24])
        if not width or not height:
            raise RuntimeError("Native Files capture has invalid dimensions")
        with (evidence / path.name).open("xb") as destination:
            destination.write(data)
        images.append({**capture, "sha256": hashlib.sha256(data).hexdigest(), "width": width, "height": height})
    (evidence / "files-window-result.json").write_bytes(receipt_bytes)
    (evidence / "captures.json").write_text(json.dumps(images, indent=2) + "\n")
    print("PASS: actual UID1000 Files pointer/wheel/keyboard/WM-close and separate MIME helper read receipt")


if __name__ == "__main__":
    main()
