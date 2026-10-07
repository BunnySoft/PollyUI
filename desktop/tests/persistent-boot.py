#!/usr/bin/env python3
"""Cold-boot A/A/B/A using one disposable writable overlay, without host devices."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import secrets
import socket
import stat
import string
import subprocess
import tempfile
import time


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def diagnostic_kernel_arguments(manifest, directory):
    if manifest.get("layout") != "single-system-independent-recovery":
        raise ValueError("Direct-kernel diagnostics require the single-system layout")
    for name in ("vmlinuz", "initrd"):
        file = directory / name
        if not stat.S_ISREG(file.lstat().st_mode) or file.stat().st_size == 0:
            raise ValueError("Expected a nonempty regular diagnostic input: " + name)
    system = [volume["uuid"] for volume in manifest["storageContract"]["volumes"]
              if volume["role"] == "SYSTEM"]
    if len(system) != 1 or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", system[0]):
        raise ValueError("Invalid diagnostic root UUID")
    return ["-kernel", str(directory / "vmlinuz"), "-initrd", str(directory / "initrd"),
            "-append", f"root=UUID={system[0]} ro rootwait panic=0 console=tty0 "
            "console=ttyS0,115200 polly.mode=baseline polly.serial=1 "
            "systemd.journald.forward_to_console=yes"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--smoke", action="store_true", help="Check a regular image without test helpers")
    parser.add_argument("--diagnostic-inputs", type=Path,
                        help="Direct kernel/initrd directory for diagnosis only; NOT UEFI acceptance")
    args = parser.parse_args()
    artifact = args.artifact.resolve()
    manifest = json.loads((artifact / "installed-manifest.json").read_text())
    single_system = manifest.get("layout") == "single-system-independent-recovery"
    if single_system and not args.smoke:
        raise ValueError("Single-system persistence needs its own acceptance flow, not A/A/B/A")
    if args.diagnostic_inputs and not args.smoke:
        raise ValueError("Direct-kernel diagnostics cannot be persistence acceptance")
    kernel_arguments = diagnostic_kernel_arguments(manifest, args.diagnostic_inputs.resolve()) \
        if args.diagnostic_inputs else []
    name = manifest["image"]["name"]
    if Path(name).name != name or not name.endswith(".img"):
        raise ValueError("Unsafe image name")
    image = artifact / name
    if not stat.S_ISREG(image.lstat().st_mode) or image.stat().st_size != manifest["image"]["size"]:
        raise ValueError("Expected the declared regular disk image")
    original_hash = digest(image)
    if original_hash != manifest["image"]["sha256"] or manifest["verificationFixture"] != (not args.smoke):
        raise ValueError("Expected an intact image with the matching verification/smoke mode")
    evidence = args.evidence.absolute()
    evidence.mkdir(parents=True)
    disk = evidence / "guest.qcow2"
    subprocess.run(["qemu-img", "create", "-q", "-f", "qcow2", "-F", "raw",
                    "-b", str(image), str(disk)], check=True, timeout=30)
    acceleration = "kvm" if os.access("/dev/kvm", os.R_OK | os.W_OK) else "tcg"
    firmware = Path("/usr/share/OVMF")
    suffix = "" if (firmware / "OVMF_CODE.fd").exists() else "_4M"
    rounds = []
    with tempfile.TemporaryDirectory(prefix="polly-persistent-vm-") as temporary:
        temporary = Path(temporary)
        variables = temporary / "vars.fd"
        shutil.copyfile(firmware / f"OVMF_VARS{suffix}.fd", variables)
        sequence = ["SYSTEM"] if single_system else (["A"] if args.smoke else ["A", "A", "B", "A"])
        for count, slot in enumerate(sequence, 1):
            boot = evidence / f"boot-{count}-{slot}"
            boot.mkdir()
            serial = boot / "serial.log"
            serial_socket = temporary / "serial.sock"
            interactive_setup = args.smoke and "accountSetup" in manifest
            if serial_socket.exists():
                serial_socket.unlink()
            qmp = temporary / "qmp.sock"
            if qmp.exists():
                qmp.unlink()
            command = [
                "qemu-system-x86_64", "-nodefaults", "-machine", "q35", "-accel", acceleration,
                "-cpu", "host" if acceleration == "kvm" else "qemu64", "-m", "4096", "-smp", "2",
                *(kernel_arguments or [
                    "-drive", f"if=pflash,format=raw,readonly=on,file={firmware / f'OVMF_CODE{suffix}.fd'}",
                    "-drive", f"if=pflash,format=raw,file={variables}"]),
                "-drive", f"if=none,id=installed,format=qcow2,file={disk}",
                "-device", "virtio-blk-pci,drive=installed,bootindex=1",
                "-device", "virtio-vga", "-device", "qemu-xhci", "-device", "usb-kbd",
                "-device", "usb-tablet", "-nic", "none", "-display", "none",
                "-serial", f"unix:{serial_socket},server=on,wait=off" if interactive_setup else "file:" + str(serial),
                "-qmp", f"unix:{qmp},server=on,wait=off",
                "-no-reboot",
            ]
            with (boot / "qemu.log").open("w") as log:
                process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
                connection, stream, serial_connection = None, None, None
                try:
                    deadline = time.monotonic() + 180
                    while not qmp.exists():
                        if process.poll() is not None or time.monotonic() > deadline:
                            raise RuntimeError("QEMU did not start; see " + str(boot))
                        time.sleep(0.1)
                    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    connection.settimeout(10)
                    connection.connect(str(qmp))
                    stream = connection.makefile("rwb")
                    if "QMP" not in json.loads(stream.readline()):
                        raise RuntimeError("Invalid QMP greeting")

                    def execute(name, arguments=None):
                        request = {"execute": name}
                        if arguments is not None:
                            request["arguments"] = arguments
                        stream.write(json.dumps(request).encode() + b"\n")
                        stream.flush()
                        while True:
                            line = stream.readline()
                            if not line:
                                raise RuntimeError("QMP disconnected")
                            response = json.loads(line)
                            if "error" in response:
                                raise RuntimeError(str(response["error"]))
                            if "return" in response:
                                return response["return"]

                    execute("qmp_capabilities")
                    raw_serial = b""
                    tokens = ["".join(secrets.choice(string.ascii_lowercase + string.digits)
                                      for _ in range(28)) for _ in range(2)] if interactive_setup else []
                    reply_index, last_prompt, login_sent = 0, 0, False
                    if interactive_setup:
                        serial_connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                        serial_connection.connect(str(serial_socket))
                        serial_connection.setblocking(False)

                    def transcript():
                        nonlocal raw_serial, reply_index, last_prompt
                        if serial_connection is None:
                            return serial.read_text(errors="replace") if serial.exists() else ""
                        while True:
                            try:
                                chunk = serial_connection.recv(8192)
                            except BlockingIOError:
                                break
                            if not chunk:
                                break
                            raw_serial += chunk
                            if len(raw_serial) > 2 * 1024 * 1024:
                                raise RuntimeError("Serial transcript exceeded its bound")
                        text = raw_serial.decode(errors="replace")
                        for match in re.finditer(r"(?i)(?:New|Retype new) password:", text):
                            if match.end() > last_prompt:
                                if reply_index >= 4:
                                    raise RuntimeError("Unexpected setup password retry; transcript withheld")
                                serial_connection.sendall(tokens[reply_index // 2].encode() + b"\n")
                                reply_index += 1
                                last_prompt = match.end()
                        # Only complete, redacted lines are published; passwords stay in memory.
                        safe = text[:text.rfind("\n") + 1]
                        for token in tokens:
                            safe = safe.replace(token, "[redacted]")
                        serial.write_text(safe)
                        return safe

                    if not kernel_arguments:
                        while "serial VM baseline" not in transcript():
                            if process.poll() is not None or time.monotonic() > deadline:
                                raise RuntimeError("Installed UEFI menu did not appear; see " + str(boot))
                            time.sleep(0.1)
                        menu_index = manifest["serialMenuIndex"] if single_system else (4 if slot == "A" else 5)
                        if type(menu_index) is not int or not 0 <= menu_index <= 10:
                            raise ValueError("Invalid serial boot menu index")
                        for key in ["home", *(["down"] * menu_index), "ret"]:
                            execute("send-key", {"keys": [{"type": "qcode", "data": key}]})
                            time.sleep(0.15)
                    deadline = time.monotonic() + 240
                    captured = False
                    while process.poll() is None:
                        text = transcript()
                        if interactive_setup and "POLLY_LOGIN_AUTH_PENDING" in text and not login_sent:
                            time.sleep(1)
                            for key in [*tokens[0], "ret"]:
                                execute("send-key", {"keys": [{"type": "qcode", "data": key}], "hold-time": 10})
                                time.sleep(0.03)
                            login_sent = True
                        if any(message in text for message in [
                            "POLLY_PERSISTENCE_FAILED", "Kernel panic", "PollyDesktop session failed",
                            "POLLY_STORAGE_FAILED", "POLLY_STORAGE_EARLY_FAILED",
                        ]):
                            raise RuntimeError("Installed guest reported a failure:\n" + text[-8000:])
                        if "POLLY_INSTALLED_DESKTOP_READY" in text and not captured:
                            if interactive_setup and not login_sent:
                                raise RuntimeError("Regular image started the desktop before password login; inspect getty policy")
                            execute("screendump", {"filename": str(boot / "desktop.ppm")})
                            captured = True
                            if args.smoke:
                                execute("quit")
                                process.wait(timeout=10)
                                break
                        if time.monotonic() > deadline:
                            raise RuntimeError("Guest did not complete a clean boot/shutdown:\n" + text[-8000:])
                        time.sleep(0.2)
                    text = transcript()
                    required = ["POLLY_INSTALLED_DESKTOP_READY", "POLLY_SESSION_REGISTERED uid=1000",
                                "Active=yes", "WLR_BACKENDS: drm,libinput"]
                    if not args.smoke:
                        required += [f"POLLY_PERSISTENCE_PASS count={count} slot={slot}",
                                     f"POLLY_APPDATA_PASS {count}", f"POLLY_SETTINGS_PASS {count}",
                                     "theme=bigsur", "Power down"]
                        if "accountSetup" in manifest:
                            required += [f"POLLY_ACCOUNT_AUTH_PASS count={count} slot={slot}"]
                    elif interactive_setup:
                        required += ["POLLY_SETUP_COMPLETE", "POLLY_LOGIN_AUTH_PENDING"]
                        if reply_index != 4 or not login_sent:
                            raise RuntimeError("Regular image did not complete interactive setup/password login")
                    for marker in required:
                        if marker not in text:
                            raise RuntimeError(f"Missing {marker}:\n" + text[-8000:])
                    if process.returncode != 0:
                        raise RuntimeError("QEMU exited unsuccessfully")
                    rounds.append({"count": count, "slot": slot, "cleanShutdown": not args.smoke,
                                   "uefiBoot": not bool(kernel_arguments),
                                   "settings": not args.smoke, "managedAppData": not args.smoke,
                                   "document": not args.smoke,
                                   "nativeDesktop": True, "serialLog": str(serial.relative_to(evidence))})
                    rounds[-1]["accountAuthentication"] = "accountSetup" in manifest
                    print("PASS: regular installed desktop without verification helpers" if args.smoke else
                          f"PASS: cold boot {count}, slot {slot}, retained settings/app registration/AppData/document")
                finally:
                    if stream is not None:
                        stream.close()
                    if connection is not None:
                        connection.close()
                    if serial_connection is not None:
                        serial_connection.close()
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
    if digest(image) != original_hash:
        raise RuntimeError("The original image changed during verification")
    (evidence / "result.json").write_text(json.dumps({
        "ready": True, "firmware": "direct kernel diagnostic" if kernel_arguments else "OVMF UEFI",
        "acceleration": acceleration,
        "mode": "diagnostic-native-desktop-smoke" if kernel_arguments else
                ("native-desktop-smoke" if args.smoke else "persistence"),
        "layout": manifest.get("layout", "historical-D1-A/B"),
        "memoryMiB": 4096, "network": False, "hostDevices": False, "rounds": rounds,
        "originalImageUnchanged": True, "imageSha256": original_hash,
        "disk": "disposable qcow2 overlay with read-only raw backing",
        "limits": ["Not physical-device qualification", "No actual system update or migration",
                   *(["Not UEFI acceptance; diagnostic kernel/initrd supplied separately"]
                     if kernel_arguments else [])],
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
