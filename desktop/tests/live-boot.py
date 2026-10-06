#!/usr/bin/env python3
"""Boot only the ISO in an isolated UEFI guest: no disk, network or host graphics."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("iso", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    iso = args.iso.resolve()
    evidence = args.evidence.resolve()
    if evidence.exists():
        raise ValueError("Refusing to overwrite prior boot evidence")
    evidence.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="polly-vm-") as temporary:
        temporary = Path(temporary)
        firmware = Path("/usr/share/OVMF")
        variables = temporary / "vars.fd"
        shutil.copyfile(firmware / "OVMF_VARS.fd", variables)
        qmp_path = temporary / "qmp.sock"
        serial = evidence / "serial.log"
        acceleration = "kvm" if os.access("/dev/kvm", os.R_OK | os.W_OK) else "tcg"
        command = [
            "qemu-system-x86_64", "-nodefaults", "-machine", "q35", "-accel", acceleration,
            "-cpu", "host" if acceleration == "kvm" else "qemu64", "-m", "3072", "-smp", "2",
            "-drive", f"if=pflash,format=raw,readonly=on,file={firmware / 'OVMF_CODE.fd'}",
            "-drive", f"if=pflash,format=raw,file={variables}",
            "-device", "virtio-vga", "-device", "qemu-xhci", "-device", "usb-kbd", "-device", "usb-tablet",
            "-audiodev", "none,id=silent", "-device", "intel-hda", "-device", "hda-duplex,audiodev=silent",
            "-cdrom", str(iso), "-boot", "order=d", "-nic", "none", "-display", "none",
            "-serial", "file:" + str(serial), "-qmp", f"unix:{qmp_path},server=on,wait=off", "-no-reboot",
        ]
        with (evidence / "qemu.log").open("w") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
            connection = None
            stream = None
            try:
                deadline = time.monotonic() + 180
                while not qmp_path.exists():
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Guest did not start; see qemu.log")
                    time.sleep(0.05)
                connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                connection.settimeout(10)
                connection.connect(str(qmp_path))
                stream = connection.makefile("rwb")
                greeting = json.loads(stream.readline())
                if "QMP" not in greeting:
                    raise RuntimeError("Invalid QMP greeting")

                def execute(name, arguments=None):
                    request = {"execute": name}
                    if arguments is not None:
                        request["arguments"] = arguments
                    stream.write(json.dumps(request).encode() + b"\n")
                    stream.flush()
                    while True:
                        response = json.loads(stream.readline())
                        if "error" in response:
                            raise RuntimeError(str(response["error"]))
                        if "return" in response:
                            return response["return"]

                execute("qmp_capabilities")
                while True:
                    text = serial.read_text(errors="replace") if serial.exists() else ""
                    if "POLLY_LIVE_DESKTOP_READY" in text:
                        break
                    if process.poll() is not None or time.monotonic() > deadline:
                        execute("screendump", {"filename": str(evidence / "failed-guest.ppm")})
                        raise RuntimeError("Desktop boot did not become ready:\n" + text[-8000:])
                    time.sleep(0.5)
                if "Starting ordinary user desktop, uid=1000" not in text:
                    raise RuntimeError("Desktop readiness did not prove ordinary-user session startup")
                if "WLR_BACKENDS: drm,libinput" not in text:
                    raise RuntimeError("Desktop did not use guest DRM/input devices")
                if "POLLY_SESSION_REGISTERED uid=1000" not in text or "Active=yes" not in text:
                    raise RuntimeError("PAM did not register an active ordinary-user elogind session")
                if any(message in text for message in ["Kernel panic", "PollyDesktop session failed", "Cannot initialize renderer"]):
                    raise RuntimeError("Boot reported a fatal error:\n" + text[-8000:])
                time.sleep(2)
                execute("screendump", {"filename": str(evidence / "desktop.ppm")})
                execute("send-key", {"keys": [{"type": "qcode", "data": key} for key in ["ctrl", "meta_l", "right"]]})
                workspace_deadline = time.monotonic() + 15
                while "POLLY_LIVE_WORKSPACE=2" not in serial.read_text(errors="replace"):
                    if process.poll() is not None or time.monotonic() > workspace_deadline:
                        raise RuntimeError("Guest keyboard did not switch the native workspace")
                    time.sleep(0.2)
                execute("screendump", {"filename": str(evidence / "workspace2.ppm")})
                execute("send-key", {"keys": [{"type": "qcode", "data": key} for key in ["ctrl", "meta_l", "left"]]})
                workspace_deadline = time.monotonic() + 15
                while "POLLY_LIVE_WORKSPACE=1" not in serial.read_text(errors="replace"):
                    if process.poll() is not None or time.monotonic() > workspace_deadline:
                        raise RuntimeError("Guest keyboard did not restore the initial workspace")
                    time.sleep(0.2)
                status = execute("query-status")
                if status.get("status") != "running":
                    raise RuntimeError("Guest is no longer running")
                result = {
                    "ready": True, "firmware": "OVMF UEFI", "acceleration": acceleration,
                    "memoryMiB": 3072, "vcpus": 2, "disks": [], "network": False,
                    "graphics": "virtio-vga", "hostAudio": False, "ordinaryUser": 1000,
                    "keyboardWorkspaceSwitch": True,
                    "pamSessionRegistered": True,
                    "iso": iso.name, "serialLog": "serial.log", "screenshot": "desktop.ppm",
                }
                with iso.open("rb") as source:
                    result["isoSha256"] = hashlib.file_digest(source, "sha256").hexdigest()
                (evidence / "result.json").write_text(json.dumps(result, indent=2) + "\n")
                execute("quit")
                process.wait(timeout=10)
                print("PASS: UEFI ISO booted a non-root PollyWM DRM desktop without any writable disk or network")
            finally:
                if stream is not None:
                    stream.close()
                if connection is not None:
                    connection.close()
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)


if __name__ == "__main__":
    main()
