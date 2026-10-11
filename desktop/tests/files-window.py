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
import shutil
import sys
import time

STAGES = {
    "browser": ["home-browser", "empty-folder", "scrolled-list", "new-folder", "context-menu",
                "rename-edit", "renamed-folder", "before-wm-close"],
    "details": ["long-name-properties", "no-matches", "filtered-folder"],
}
MOUSE_STAGES = ["home-browser", "empty-folder", "before-wm-close"]
INPUT_STAGES = ["input-ready", "capture-released", "before-wm-close"]
INPUT_EVIDENCE = ["capture", "outsideMotion", "release", "clickSuppressed", "cancellation", "cursor", "activation"]
INTERACTION_STAGES = {
    "text": ["text-selection", "text-focus-restored", "before-wm-close"],
    "text-lifecycle": ["text-address-long", "text-focus-restored", "before-wm-close"],
    "scrollbar": ["scrollbar-top", "scrollbar-bottom", "before-wm-close"],
}
INTERACTION_EVIDENCE = {
    "text": ["capture", "outsideMotion", "release", "shiftSelection", "focus", "cursor", "focusCancel", "closeCancel"],
    "text-lifecycle": ["capture", "focus", "cursor", "horizontalScroll", "detach", "focusCancel", "closeCancel"],
    "scrollbar": ["capture", "outsideMotion", "release", "page", "keyboard", "wheelSync",
                  "bounds", "metadata", "detach", "focusCancel", "closeCancel"],
}
REQUIRED_EVIDENCE = {
    "browser": ["documents", "returnedHome", "folderCreated", "folderRenamed", "documentOpenRequested",
                "cancelled", "wheel", "keyboardRename", "history", "sort", "context", "filter", "address"],
    "details": ["documentOpenRequested", "filter", "address", "properties"],
}


def source_hashes(repo):
    paths = [
        "desktop/apps/files/app.mjs", "desktop/apps/files/logic/controller.mjs",
        "desktop/apps/files/logic/model.mjs", "desktop/apps/files/ui/view.mjs",
        "desktop/apps/files/ui/format.mjs", "desktop/shell/presentation.mjs",
        "gui/sdk/js/textinput.mjs", "desktop/tests/files-window-client.mjs",
        "gui/sdk/js/scrollbar.mjs", "desktop/tests/files-interactions.mjs",
        "desktop/tests/files-window-shell.mjs", "desktop/tests/runtime-client.c",
        "desktop/tests/files-window.py",
        "gui/include/pollyui/input.h", "gui/include/pollyui/window.h",
        "gui/src/bridge/bridge.c", "gui/src/bridge/bridge.h",
        "gui/src/context/context.c", "gui/src/host/sdl/window_sdl.c", "gui/src/host/win32/window.c",
    ]
    return {path: hashlib.sha256((repo / path).read_bytes()).hexdigest() for path in paths}


def driver_command(repo, driver, runtime, small=False, details=False, mouse=False, native_input=False, interaction=None, narrow=False):
    return ["sh", str(repo / "desktop/tests/runtime-client.sh"), "sh", "-c",
            'export XDG_CONFIG_HOME="$HOME/config" XDG_DATA_HOME="$HOME/data" XDG_CACHE_HOME="$HOME/cache"; exec "$@"',
            "polly-files-fixture", str(driver), str(runtime),
            str(repo / "desktop/tests/files-window-shell.mjs"), "files-window",
            interaction + ("-narrow" if narrow else "-small" if small else "") if interaction else
            "input" if native_input else "mouse" if mouse else
            ("details-small" if small else "details") if details else ("small" if small else "initial")]


def retain_fixture_home(root, evidence):
    info = root.lstat()
    marker = root / "fixture-marker.txt"
    token = marker.lstat()
    if root.parent != Path("/tmp") or not root.name.startswith("polly-files-window-") or \
            root.resolve() != root or not stat.S_ISDIR(info.st_mode) or \
            (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (1000, 1000, 0o700) or \
            not stat.S_ISREG(token.st_mode) or \
            (token.st_uid, token.st_gid, stat.S_IMODE(token.st_mode)) != (1000, 1000, 0o600) or \
            marker.read_text() != "POLLY-FILES-PRIVATE-WINDOW-V1\n":
        raise PermissionError("Refusing to retain an unqualified or non-synthetic Files HOME")
    shutil.copytree(root, evidence / "retained-home", symlinks=True)


def report_native_failure(evidence):
    text = (evidence / "native.log").read_text(errors="replace")
    print("Retained private Files evidence: " + str(evidence), file=sys.stderr)
    print(text[-65536:], file=sys.stderr)


def aggregate_flows(evidence, elapsed):
    flows = []
    for flow, stages in STAGES.items():
        directory = evidence / flow
        inputs = json.loads((directory / "inputs.json").read_text())
        receipt = json.loads((directory / "files-window-result.json").read_text())
        captures = json.loads((directory / "captures.json").read_text())
        log = (directory / "native.log").read_text(errors="replace")
        if inputs.get("flow") != flow or inputs.get("uid") != 1000 or receipt.get("flow") != flow or \
                receipt.get("passed") is not True or receipt.get("native") is not True or \
                receipt.get("closeObserved") is not True or not receipt.get("evidence") or \
                any(receipt["evidence"].get(key) is not True for key in REQUIRED_EVIDENCE[flow]) or \
                receipt.get("root") != inputs.get("root") or \
                [capture["stage"] for capture in receipt.get("captures", [])] != stages or \
                [capture["stage"] for capture in captures] != stages or \
                any(marker not in log for marker in
                    ("FILES_WINDOW_DRIVE_PASS:", "FILES_WINDOW_CLOSE_PASS:", "FILES_WINDOW_SUPERVISOR_PASS:")) or \
                "FILES_WINDOW_FAIL:" in log or "FILES_WINDOW_SUPERVISOR_FAIL:" in log:
            raise RuntimeError("Cannot aggregate an incomplete or failed native Files flow: " + flow)
        for capture in captures:
            image = directory / ("files-" + capture["stage"] + ".png")
            if hashlib.sha256(image.read_bytes()).hexdigest() != capture["sha256"]:
                raise RuntimeError("Native Files capture changed before aggregation: " + flow)
        mime = json.loads((directory / "mime-result.json").read_text())
        if mime.get("uid") != 1000 or mime.get("argv") != [inputs["root"] + "/literal %u; \u4e2d\u6587.txt"] or \
                mime.get("cwd") != inputs.get("cwd") or mime.get("text") != "Synthetic private Files MIME content.\n":
            raise RuntimeError("Native Files separate consumer receipt differs from its own fresh flow: " + flow)
        flows.append({"id": flow, "elapsedMs": elapsed[flow], "inputs": inputs, "receipt": receipt,
                      "captures": captures, "mime": mime})
    if flows[0]["inputs"]["root"] == flows[1]["inputs"]["root"] or any(
            flows[0]["inputs"][key] != flows[1]["inputs"][key]
            for key in ("driverSha256", "runtimeSha256", "sourceSha256")):
        raise RuntimeError("Native Files flows need distinct fresh HOME directories and identical source/runtime/driver")
    return {"version": 2, "passed": True, "flows": flows}


def run_flows(args, evidence):
    elapsed = {}
    for flow in STAGES:
        command = [sys.executable, str(Path(__file__).resolve()), str(args.driver), str(args.runtime),
                   "--flow", flow, "--evidence", str(evidence / flow)]
        if args.small:
            command.append("--small")
        started = time.monotonic()
        # Each independent process keeps the existing native supervisor and wrapper deadlines.
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        elapsed[flow] = round((time.monotonic() - started) * 1000)
        (evidence / (flow + "-run.log")).write_text(result.stdout)
        if result.returncode:
            print(result.stdout, file=sys.stderr)
            raise RuntimeError("Native Files " + flow + " flow failed; no aggregate PASS is produced")
    aggregate = aggregate_flows(evidence, elapsed)
    (evidence / "aggregate.json").write_text(json.dumps(aggregate, indent=2) + "\n")
    print("PASS: independent native Files browser/details flows, eleven current-source captures, "
          "separate HOME/MIME/WM-close receipts; " + json.dumps(elapsed))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("driver", type=Path)
    parser.add_argument("runtime", type=Path)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--small", action="store_true")
    parser.add_argument("--narrow", action="store_true")
    parser.add_argument("--flow", choices=("all", "browser", "details", "mouse", "input", "text", "text-lifecycle", "scrollbar"), default="all")
    args = parser.parse_args()
    if args.flow in ("mouse", "input") and args.small:
        raise ValueError("The focused mouse/input flows use the normal window size")
    if args.narrow and (args.flow not in INTERACTION_STAGES or args.small):
        raise ValueError("The 640px narrow option is only for independent interaction flows")
    if (os.getuid(), os.geteuid(), os.getgid(), os.getegid()) != (1000, 1000, 1000, 1000):
        raise PermissionError("Files native acceptance requires actual ordinary UID/GID1000")
    if not args.driver.is_absolute() or not args.runtime.is_absolute() or not args.evidence.is_absolute():
        raise ValueError("Driver, rebuilt engine and private evidence must be absolute")
    repo = Path(__file__).resolve().parents[2]
    evidence = args.evidence
    evidence.mkdir(parents=True, exist_ok=False)
    if args.flow == "all":
        run_flows(args, evidence)
        return
    root = Path(tempfile.mkdtemp(prefix="polly-files-window-"))
    for name in ("Documents", "Downloads", "Desktop", "config", "data", "data/applications",
                 "state", "cache", "share", "evidence"):
        (root / name).mkdir(parents=True, exist_ok=True, mode=0o700)
    for directory in (root, root / "evidence"):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (1000, 1000, 0o700):
            raise PermissionError("Private fixture HOME/evidence must be real UID/GID1000 mode0700 directories")
    (root / "fixture-marker.txt").write_text("POLLY-FILES-PRIVATE-WINDOW-V1\n")
    (root / "fixture-marker.txt").chmod(0o600)
    document = root / "literal %u; \u4e2d\u6587.txt"
    document.write_text("Synthetic private Files MIME content.\n", encoding="utf8")
    (root / ("Long project \u9879\u76ee\u8d44\u6599 - " + "readable-segment-" * 9 + ".txt")).write_text("Synthetic long-name fixture.\n")
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
    command = driver_command(repo, args.driver, args.runtime, args.small, args.flow == "details",
                             args.flow == "mouse", args.flow == "input",
                             args.flow if args.flow in INTERACTION_STAGES else None, args.narrow)
    sources = source_hashes(repo)
    (evidence / "inputs.json").write_text(json.dumps({
        "uid": os.getuid(), "root": str(root), "command": command, "cwd": str(repo),
        "driverSha256": hashlib.sha256(args.driver.read_bytes()).hexdigest(),
        "runtimeSha256": hashlib.sha256(args.runtime.read_bytes()).hexdigest(),
        "flow": args.flow, "sourceSha256": sources,
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
            retain_fixture_home(root, evidence)
            report_native_failure(evidence)
            raise RuntimeError("Files native fixture timed out; original private evidence retained") from error
    retain_fixture_home(root, evidence)
    text = (evidence / "native.log").read_text(errors="replace")
    if process.returncode or "FILES_WINDOW_FAIL:" in text or "FILES_WINDOW_SUPERVISOR_FAIL:" in text or "Uncaught" in text:
        report_native_failure(evidence)
        raise RuntimeError("Actual Files native fixture failed; original private evidence retained")
    if source_hashes(repo) != sources:
        raise RuntimeError("Native Files source changed while the independent flow was running")
    for marker in ("FILES_WINDOW_DRIVE_PASS:", "FILES_WINDOW_CLOSE_PASS:", "FILES_WINDOW_SUPERVISOR_PASS:"):
        if marker not in text:
            raise RuntimeError("Missing actual Files action/normal-close receipt: " + marker)
    if args.flow not in ("mouse", "input", "text", "text-lifecycle", "scrollbar"):
        receipt = json.loads((root / "mime-result.json").read_text())
        if receipt != {"uid": 1000, "argv": [str(document)], "cwd": str(repo), "text": document.read_text()}:
            raise RuntimeError("Actual MIME helper argv/cwd/ordinary UID/read content differs from the fixture")
        (evidence / "mime-result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    receipt_bytes = (root / "files-window-result.json").read_bytes()
    result = json.loads(receipt_bytes)
    stages = INTERACTION_STAGES[args.flow] if args.flow in INTERACTION_STAGES else \
        INPUT_STAGES if args.flow == "input" else MOUSE_STAGES if args.flow == "mouse" else STAGES[args.flow]
    required = INTERACTION_EVIDENCE[args.flow] if args.flow in INTERACTION_EVIDENCE else INPUT_EVIDENCE if args.flow == "input" else \
        ["singleClick", "doubleClick", "documents", "returnedHome"] if args.flow == "mouse" else REQUIRED_EVIDENCE[args.flow]
    if result.get("flow") != args.flow or result.get("passed") is not True or result.get("closeObserved") is not True or \
            any(result.get("evidence", {}).get(key) is not True for key in required):
        raise RuntimeError("Native Files action/close receipt differs from the requested flow")
    if [capture["stage"] for capture in result["captures"]] != stages:
        raise RuntimeError("Native Files capture order differs from its independent " + args.flow + " flow")
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
        if (width, height) != (capture["width"], capture["height"]) or \
                width != (640 if args.narrow else 680 if args.small else 1040) or not 320 <= height <= (540 if args.small or args.narrow else 760):
            raise RuntimeError("PNG dimensions differ from the actual laid-out native window (including compositor size clamps)")
        images.append({**capture, "sha256": hashlib.sha256(data).hexdigest(), "width": width, "height": height})
    (evidence / "files-window-result.json").write_bytes(receipt_bytes)
    (evidence / "captures.json").write_text(json.dumps(images, indent=2) + "\n")
    print("PASS: actual UID1000 native Files " + args.flow + " capture/outside motion/release/keyboard/detach/focus-loss/WM-close" if args.flow in INTERACTION_STAGES else
          "PASS: actual UID1000 native capture/outside motion/release/cancel/cursor/activation and WM-close" if args.flow == "input" else
          "PASS: actual UID1000 Files single/double-click navigation and WM-close" if args.flow == "mouse" else
          "PASS: actual UID1000 Files pointer/wheel/keyboard/WM-close and separate MIME helper read receipt")


if __name__ == "__main__":
    main()
