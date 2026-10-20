#!/usr/bin/env python3
"""Require a real Shell boot, delivered keyboard input and a QMP screenshot."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import socket
import struct
import subprocess
import time
import zlib


def screenshot_png(source, destination, expected_size=(1280, 800)):
    data = source.read_bytes()
    position = 0

    def token():
        nonlocal position
        while position < len(data):
            if data[position:position + 1] == b"#":
                position = data.index(b"\n", position) + 1
            elif data[position] in b" \r\n\t":
                position += 1
            else:
                break
        start = position
        while position < len(data) and data[position] not in b" \r\n\t":
            position += 1
        return data[start:position]

    if token() != b"P6":
        raise ValueError("QMP screenshot must be an RGB PPM")
    width, height, maximum = int(token()), int(token()), int(token())
    if (width, height) != expected_size or maximum != 255:
        raise ValueError("Unexpected native display geometry")
    position += 2 if data[position:position + 2] == b"\r\n" else 1
    pixels = data[position:]
    if len(pixels) != width * height * 3:
        raise ValueError("Truncated screenshot")
    colors = set(pixels[index:index + 3] for index in range(0, len(pixels), 3))
    if len(colors) < 64:
        raise ValueError("No rendered desktop content in screenshot")

    def chunk(kind, payload):
        return (struct.pack(">I", len(payload)) + kind + payload +
                struct.pack(">I", zlib.crc32(kind + payload)))

    rows = b"".join(b"\0" + pixels[start:start + width * 3]
                    for start in range(0, len(pixels), width * 3))
    destination.write_bytes(
        b"\x89PNG\r\n\x1a\n" +
        chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) +
        chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
    return len(colors)


def display_proof(text, display):
    if display not in ("virtio", "simpledrm"):
        raise ValueError("Unknown display proof profile")
    driver = "simpledrm" if display == "simpledrm" else "virtio_gpu"
    sysfs_driver = "simple-framebuffer" if display == "simpledrm" else "virtio-pci"
    if (f"MICRO_DRM_DRIVER={sysfs_driver} " not in text or
            not re.search(r"Initializing DRM backend for /dev/dri/card\d+ \(" + driver + r"\)", text) or
            "Creating pixman renderer" not in text or "PollyWM ready:" not in text):
        raise ValueError("Missing actual " + driver + "/Pixman compositor proof")
    modeset = re.search(r"Modesetting with ([0-9]+)x([0-9]+)", text)
    if not modeset:
        raise ValueError("Missing native modeset geometry")
    if display == "simpledrm":
        if not re.search(r"input: .*USB Keyboard", text):
            raise ValueError("Missing actual USB keyboard enumeration")
        if re.search(r"Initializing DRM backend .* \(virtio_gpu\)", text):
            raise ValueError("A virtio renderer cannot qualify the GOP path")
    return int(modeset[1]), int(modeset[2])


def desktop_state(text):
    # Kernel console messages can interrupt a userspace serial write mid-record.
    # Keep the raw log intact; remove only timestamped kernel lines for parsing.
    text = re.sub(r"\[\s*[0-9]+\.[0-9]+\] [^\n]*\n", "", text)
    # A serial read may end midway through the next JSON record.
    for line in reversed(text.split("\n")[:-1]):
        marker = "MICRO_DESKTOP_STATE="
        if marker in line:
            payload = line.split(marker, 1)[1]
            value, end = json.JSONDecoder().raw_decode(payload)
            suffix = payload[end:].strip()
            if suffix and not re.fullmatch(r"[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+ \[[^\r\n]+\] [^\r\n]*", suffix):
                raise ValueError("Unexpected data after a desktop state record: " + suffix)
            return value
    return None


def main(work, display, desktop=False, product="micro"):
    if product not in ("micro", "mini"):
        raise ValueError("Unknown Alpine Shell product")
    base = "mini" if product == "mini" else "micro-shell"
    welcome_title = "Polly Mini Shell" if product == "mini" else "Polly Micro Shell"
    image = work / (base + ".iso")
    metadata_file = image.with_suffix(".json")
    metadata = json.loads(metadata_file.read_text())
    if product == "mini" and metadata.get("product") != "mini":
        raise ValueError("Mini testing requires an actual Mini build report")
    with image.open("rb") as source:
        expected_digest = hashlib.file_digest(source, "sha256").hexdigest()
    if metadata["isoSha256"] != expected_digest:
        raise ValueError("Build report does not match the ISO being tested")
    prefix = base if display == "virtio" else base + "-simpledrm"
    serial = work / (prefix + "-serial.log")
    qmp = work / (prefix + ".qmp")
    qmp.unlink(missing_ok=True)
    command = [
        "qemu-system-x86_64", "-machine", "q35,i8042=off", "-accel", "kvm",
        "-bios", "/usr/share/ovmf/OVMF.fd", "-m", "2048", "-smp", "2",
        "-vga", "none",
        *(["-device", "virtio-gpu-pci", "-device", "virtio-keyboard-pci",
           "-device", "virtio-mouse-pci"] if display == "virtio" else
          ["-device", "VGA,xres=1280,yres=800", "-device", "qemu-xhci",
           "-device", "usb-kbd", "-device", "usb-tablet"]),
        "-display", "none", "-nic", "none", "-serial", "file:" + str(serial),
        "-qmp", "unix:" + str(qmp) + ",server=on,wait=off",
        "-cdrom", str(image), "-boot", "d", "-no-reboot",
    ]
    connection = None
    stream = None
    with (work / (prefix + "-qemu.log")).open("w") as errors:
        process = subprocess.Popen(command, stdout=errors, stderr=errors)
        try:
            deadline = time.monotonic() + 90
            while not qmp.exists():
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("QEMU failed to expose QMP; see " + prefix + "-qemu.log")
                time.sleep(0.1)
            connection = socket.socket(socket.AF_UNIX)
            connection.settimeout(5)
            connection.connect(str(qmp))
            stream = connection.makefile("rwb")
            if "QMP" not in json.loads(stream.readline()):
                raise RuntimeError("Missing QMP greeting")

            def execute(name, arguments=None):
                request = {"execute": name}
                if arguments is not None:
                    request["arguments"] = arguments
                stream.write(json.dumps(request).encode() + b"\n")
                stream.flush()
                while True:
                    response = json.loads(stream.readline())
                    if "error" in response:
                        raise RuntimeError("QMP failed: " + str(response["error"]))
                    if "return" in response:
                        return response["return"]

            def wait_for(marker):
                while True:
                    text = serial.read_text(errors="replace") if serial.exists() else ""
                    if marker in text:
                        return text
                    if process.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError("Guest did not report " + marker + "; see " + str(serial))
                    time.sleep(0.2)

            def latest_state():
                text = serial.read_text(errors="replace") if serial.exists() else ""
                return desktop_state(text)

            def state_until(predicate, message):
                limit = min(deadline, time.monotonic() + 15)
                while True:
                    state = latest_state()
                    if state and predicate(state):
                        return state
                    if process.poll() is not None or time.monotonic() >= limit:
                        raise RuntimeError("Desktop did not reach " + message + ": " + str(state))
                    time.sleep(0.2)

            def key(*keys):
                execute("send-key", {"keys": [{"type": "qcode", "data": name} for name in keys],
                                     "hold-time": 80})
                time.sleep(0.2)

            def click(x, y):
                if display != "simpledrm":
                    raise ValueError("Absolute pointer test requires the USB tablet profile")
                execute("input-send-event", {"events": [
                    {"type": "abs", "data": {"axis": "x", "value": round(x * 32767 / (width - 1))}},
                    {"type": "abs", "data": {"axis": "y", "value": round(y * 32767 / (height - 1))}},
                ]})
                time.sleep(0.2)
                execute("input-send-event", {"events": [
                    {"type": "btn", "data": {"button": "left", "down": True}},
                ]})
                time.sleep(0.1)
                execute("input-send-event", {"events": [
                    {"type": "btn", "data": {"button": "left", "down": False}},
                ]})

            execute("qmp_capabilities")
            wait_for("MICRO_SHELL_STARTED")
            if desktop:
                wait_for("MICRO_SESSION_UID=1000")
                state_until(lambda state: state["services"]["decorations"] == "ready" and
                            state["panels"] and all(panel["width"] > 0 and panel["height"] > 0
                                                   for panel in state["panels"]), "decorations and taskbar")
            time.sleep(1)
            for letter in "hello":
                key(letter)
            text = wait_for("MICRO_TEXT_INPUT=hello")
            if desktop:
                wait_for("MICRO_CARET_PHASE=visible")
                wait_for("MICRO_CARET_PHASE=hidden")
            width, height = display_proof(text, display)
            if display == "virtio" and (width, height) != (1280, 800):
                raise ValueError("Virtio display geometry changed")
            def pointer_click():
                click(100, 100)
                wait_for("MICRO_POINTER_INPUT")
            if display == "simpledrm" and not desktop:
                pointer_click()
            execute("screendump", {"filename": str(work / (prefix + ".ppm"))})
            colors = screenshot_png(work / (prefix + ".ppm"), work / (prefix + ".png"), (width, height))
            desktop_result = None
            if desktop:
                key("alt", "f10")
                state_until(lambda state: state["welcome"]["maximized"], "welcome maximized")
                key("alt", "f10")
                state_until(lambda state: not state["welcome"]["maximized"], "welcome restored")
                key("alt", "f9")
                state_until(lambda state: any(item["title"] == welcome_title and item["minimized"]
                                              for item in state["windows"]), "welcome minimized in compositor")
                key("alt", "tab")
                state_until(lambda state: any(item["title"] == welcome_title and
                                              not item["minimized"] and item["active"]
                                              for item in state["windows"]),
                            "welcome restored by window switcher")
                # The input follows four real, focusable launch buttons in the welcome window.
                opened = []
                for label, title in (("Foot", "foot"), ("Processes", "Processes"),
                                     ("Settings", "Settings"), ("Files", "Files")):
                    key("shift", "tab")
                    key("ret")
                    wait_for("MICRO_LAUNCH_REQUEST=" + label)
                    def matches(item):
                        return (item["appId"] == "foot" if label == "Foot" else item["title"] == title)
                    current = state_until(lambda state: any(matches(item) for item in state["windows"]),
                                          label + " application")
                    if label == "Settings":
                        state_until(lambda state: state["settings"]["connected"] and not state["settings"]["error"],
                                    "owned Settings handshake")
                    time.sleep(2)
                    current = latest_state()
                    if not current or not any(matches(item) for item in current["windows"]):
                        raise RuntimeError(label + " exited before rendering could be checked")
                    opened.append(label)
                    execute("screendump", {"filename": str(work / (prefix + "-" + label.lower() + ".ppm"))})
                    screenshot_png(work / (prefix + "-" + label.lower() + ".ppm"),
                                   work / (prefix + "-" + label.lower() + ".png"), (width, height))
                    if label == "Foot":
                        for character in "exit":
                            key(character)
                        key("ret")
                    else:
                        key("alt", "f4")
                    state_until(lambda state: not any(matches(item) for item in state["windows"]) and
                                state["welcome"]["active"], label + " closed")
                desktop_result = {"decorations": "ready", "taskbar": "laid-out",
                                  "sessionUid": 1000,
                                  "inputCaret": "visible-and-hidden-phases",
                                  "windowActions": ["maximize", "restore", "minimize", "switch", "close"],
                                  "applicationsOpenedAndClosed": opened}
                if display == "simpledrm":
                    pointer_click()
                    current = state_until(lambda state: (state["panels"][0].get("launcher") or {}).get("width", 0) > 0,
                                          "taskbar launcher layout")
                    panel = current["panels"][0]
                    launcher = panel["launcher"]
                    click(launcher["x"] + launcher["width"] / 2,
                          height - panel["height"] + launcher["y"] + launcher["height"] / 2)
                    time.sleep(1)
                    execute("screendump", {"filename": str(work / (prefix + "-menu.ppm"))})
                    screenshot_png(work / (prefix + "-menu.ppm"), work / (prefix + "-menu.png"), (width, height))
                    key("esc")
                    desktop_result["taskbarPointer"] = "application-menu-click"
                key("alt", "f4")
                state_until(lambda state: state["welcome"] is None and state["panels"] and
                            state["services"]["decorations"] == "ready", "desktop after closing welcome")
                desktop_result["welcomeClosedWithoutEndingDesktop"] = True
            with image.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            if digest != expected_digest:
                raise ValueError("ISO changed while QEMU was running")
            result = {
                "schemaVersion": 1, "product": product, "isoSha256": digest, "qemuBoot": "pass",
                "display": f"{width}x{height}", "displayBackend": display,
                "shell": "pollyui", "compositor": "pollywm",
                "keyboardDevice": "usb" if display == "simpledrm" else "virtio",
                "pointerInput": "usb-tablet-click" if display == "simpledrm" else "not-exercised",
                "keyboardText": "hello", "screenshot": prefix + ".png",
                "screenshotColors": colors, "physicalHardware": "not-tested",
                "multiOutput": "not-tested", "suspendResume": "not-tested",
                "shutdown": "QMP quit, not a normal guest shutdown qualification",
            }
            if desktop_result:
                result["desktop"] = desktop_result
            report_name = prefix + "-boot.json"
            (work / report_name).write_text(json.dumps(result, indent=2) + "\n")
            reports = metadata.setdefault("bootReports", {})
            reports[display] = report_name
            for name in reports.values():
                saved = json.loads((work / name).read_text())
                if saved["isoSha256"] != digest or saved["qemuBoot"] != "pass":
                    raise ValueError("Display proof belongs to a different or unqualified ISO")
            metadata["bootValidation"] = ("qemu-pass" if {"virtio", "simpledrm"} <= reports.keys()
                                          else "qemu-partial")
            metadata["bootReport"] = report_name
            if desktop:
                metadata["desktopValidation"] = (
                    "qemu-pass" if {"virtio", "simpledrm"} <= reports.keys() and
                    all(json.loads((work / name).read_text()).get("desktop", {}).get("decorations") == "ready"
                        for name in reports.values()) else "qemu-partial")
            metadata_file.write_text(json.dumps(metadata, indent=2) + "\n")
            print(json.dumps(result, indent=2))
            execute("quit")
        finally:
            if stream is not None:
                stream.close()
            if connection is not None:
                connection.close()
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            qmp.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("work", type=Path)
    parser.add_argument("--display", choices=("virtio", "simpledrm"), default="virtio")
    parser.add_argument("--desktop", action="store_true", help="Require decorations, taskbar and application interaction")
    parser.add_argument("--product", choices=("micro", "mini"), default="micro")
    arguments = parser.parse_args()
    main(arguments.work.resolve(strict=True), arguments.display, arguments.desktop, arguments.product)
