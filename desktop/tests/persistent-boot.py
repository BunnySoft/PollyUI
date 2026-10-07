#!/usr/bin/env python3
"""Installed image acceptance on a disposable overlay, without host disks."""
import argparse
import ast
import base64
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
import zlib


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def system_uuid(manifest):
    system = [volume["uuid"] for volume in manifest["storageContract"]["volumes"]
              if volume["role"] == "SYSTEM"]
    if len(system) != 1 or not isinstance(system[0], str) or \
            not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", system[0]):
        raise ValueError("Invalid acceptance root UUID")
    return system[0]


def console_boot_commands(manifest, config):
    lines = [line.strip().split() for line in config.splitlines()
             if line.strip().startswith("linux ") and "polly.serial=1" in line.split()]
    if len(lines) != 1:
        raise ValueError("Expected exactly one declared serial boot entry")
    kernel = lines[0][1]
    if not re.fullmatch(r"/System/Boot/vmlinuz-[a-zA-Z0-9.+_-]+", kernel) or \
            "root=UUID=" + system_uuid(manifest) not in lines[0]:
        raise ValueError("Console acceptance kernel disagrees with the declared system")
    initrd = kernel.replace("/vmlinuz-", "/initrd.img-", 1)
    return [f"search --no-floppy --fs-uuid --set=root {system_uuid(manifest)}",
            f"linux {kernel} root=UUID={system_uuid(manifest)} ro rootwait panic=0 console=tty0 "
            "console=ttyS0,115200 polly.mode=console polly.serial=1 "
            "systemd.journald.forward_to_console=yes",
            f"initrd /System/Boot/intel-ucode.img {initrd}", "boot"]


def key_chords(text):
    plain = {" ": "spc", "\n": "ret", "-": "minus", "=": "equal", "/": "slash",
             ".": "dot", ",": "comma", ";": "semicolon", "'": "apostrophe",
             "\\": "backslash", "`": "grave_accent", "[": "bracket_left", "]": "bracket_right"}
    shifted = dict(zip("!@#$%^&*()", "1234567890"))
    shifted.update({"_": "minus", "+": "equal", ":": "semicolon", '"': "apostrophe",
                    "<": "comma", ">": "dot", "?": "slash", "|": "backslash",
                    "~": "grave_accent", "{": "bracket_left", "}": "bracket_right"})
    result = []
    for character in text:
        if character in string.ascii_lowercase + string.digits:
            result.append([character])
        elif character in string.ascii_uppercase:
            result.append(["shift", character.lower()])
        elif character in plain:
            result.append([plain[character]])
        elif character in shifted:
            result.append(["shift", shifted[character]])
        else:
            raise ValueError("Unsupported acceptance keyboard character")
    return result


def console_fixture_source():
    source = Path(__file__).with_name("account-auth-fixture.py").read_text()
    names = {"interactive", "success", "console_message", "console_password",
             "console_authenticate", "console_data", "verify_console"}
    nodes = [node for node in ast.parse(source).body if isinstance(node, (ast.Import, ast.ImportFrom)) or
             isinstance(node, ast.FunctionDef) and node.name in names]
    found = {node.name for node in nodes if isinstance(node, ast.FunctionDef)}
    if found != names:
        raise ValueError("Console acceptance client is incomplete")
    main = (
        "\nif __name__ == '__main__':\n"
        "    try:\n"
        "        verify_console(sys.argv[2] == 'first', int(sys.argv[1]))\n"
        "    except (OSError, RuntimeError, subprocess.SubprocessError) as error:\n"
        "        console_message('POLLY_ACCOUNT_CONSOLE_FAILED: ' + str(error))\n"
        "        raise\n"
    )
    return ("\n\n".join(ast.get_source_segment(source, node) for node in nodes) + main).encode()


def console_fixture_commands(count, source=None):
    source = console_fixture_source() if source is None else source
    encoded = base64.b64encode(zlib.compress(source)).decode("ascii")
    commands = ["umask 077; set -C; : > Cache/.polly-account-console.b64\n"]
    commands += [f"printf %s '{encoded[start:start + 1200]}' >> Cache/.polly-account-console.b64\n"
                 for start in range(0, len(encoded), 1200)]
    stage = "first" if count == 1 else "retained"
    commands.append("python3 -I -c \"import base64,zlib,sys;sys.argv=['console','" + str(count) +
                    "','" + stage +
                    "'];exec(zlib.decompress(base64.b64decode(open('Cache/.polly-account-console.b64').read())))\"\n")
    return commands


def diagnostic_kernel_arguments(manifest, directory):
    if manifest.get("layout") != "single-system-independent-recovery":
        raise ValueError("Direct-kernel diagnostics require the single-system layout")
    for name in ("vmlinuz", "initrd"):
        file = directory / name
        if not stat.S_ISREG(file.lstat().st_mode) or file.stat().st_size == 0:
            raise ValueError("Expected a nonempty regular diagnostic input: " + name)
    return ["-kernel", str(directory / "vmlinuz"), "-initrd", str(directory / "initrd"),
            "-append", f"root=UUID={system_uuid(manifest)} ro rootwait panic=0 console=tty0 "
            "console=ttyS0,115200 polly.mode=baseline polly.serial=1 "
            "systemd.journald.forward_to_console=yes"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--smoke", action="store_true", help="Check a regular image without test helpers")
    parser.add_argument("--diagnostic-inputs", type=Path,
                        help="Direct kernel/initrd directory for diagnosis only; NOT UEFI acceptance")
    parser.add_argument("--account-persistence", action="store_true",
                        help="Three ordinary UEFI console boots; authenticate/change passwords and power off cleanly")
    args = parser.parse_args()
    artifact = args.artifact.resolve()
    manifest = json.loads((artifact / "installed-manifest.json").read_text())
    single_system = manifest.get("layout") == "single-system-independent-recovery"
    if args.account_persistence and (not single_system or args.smoke or args.diagnostic_inputs):
        raise ValueError("Account persistence requires an ordinary single-system image and UEFI")
    if single_system and not (args.smoke or args.account_persistence):
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
    regular = args.smoke or args.account_persistence
    if original_hash != manifest["image"]["sha256"] or manifest["verificationFixture"] != (not regular):
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
    account_tokens = ["".join(secrets.choice(string.ascii_lowercase + string.digits)
                             for _ in range(28)) for _ in range(4)] if args.account_persistence else []
    boot_commands = console_boot_commands(manifest, (artifact / "grub.cfg").read_text()) \
        if args.account_persistence else []
    console_source = console_fixture_source() if args.account_persistence else None
    with tempfile.TemporaryDirectory(prefix="polly-persistent-vm-") as temporary:
        temporary = Path(temporary)
        variables = temporary / "vars.fd"
        shutil.copyfile(firmware / f"OVMF_VARS{suffix}.fd", variables)
        sequence = (["SYSTEM"] * 3 if args.account_persistence else ["SYSTEM"]) if single_system else \
            (["A"] if args.smoke else ["A", "A", "B", "A"])
        for count, slot in enumerate(sequence, 1):
            boot = evidence / f"boot-{count}-{slot}"
            boot.mkdir()
            serial = boot / "serial.log"
            serial_socket = temporary / "serial.sock"
            interactive_setup = regular and "accountSetup" in manifest
            if args.account_persistence and not interactive_setup:
                raise ValueError("Account acceptance requires the ordinary interactive setup policy")
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
                    def send_text(text, interval=0.03, hold_time=10):
                        for chord in key_chords(text):
                            execute("send-key", {"keys": [{"type": "qcode", "data": key} for key in chord],
                                                 "hold-time": hold_time})
                            time.sleep(interval)

                    raw_serial = b""
                    tokens = account_tokens or (["".join(secrets.choice(string.ascii_lowercase + string.digits)
                                      for _ in range(28)) for _ in range(2)] if interactive_setup else []
                    )
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
                                if args.account_persistence and count != 1:
                                    raise RuntimeError("Initialized accounts unexpectedly reopened setup")
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
                        if args.account_persistence:
                            transcript()
                            position = len(raw_serial)
                            execute("send-key", {"keys": [{"type": "qcode", "data": "c"}]})
                            prompt_deadline = time.monotonic() + 20
                            while b"grub>" not in raw_serial[position:]:
                                transcript()
                                if process.poll() is not None or time.monotonic() > prompt_deadline:
                                    raise RuntimeError("GRUB command line did not become ready")
                                time.sleep(0.1)
                            for instruction in boot_commands:
                                transcript()
                                position = len(raw_serial)
                                serial_connection.sendall((instruction + "\r").encode("ascii"))
                                if instruction == "boot":
                                    break
                                prompt_deadline = time.monotonic() + 20
                                while b"grub>" not in raw_serial[position:]:
                                    transcript()
                                    if process.poll() is not None or time.monotonic() > prompt_deadline:
                                        raise RuntimeError("GRUB did not accept the console boot command")
                                    time.sleep(0.1)
                                if b"error:" in raw_serial[position:]:
                                    raise RuntimeError("GRUB rejected the declared console boot command")
                        else:
                            menu_index = manifest["serialMenuIndex"] if single_system else (4 if slot == "A" else 5)
                            if type(menu_index) is not int or not 0 <= menu_index <= 10:
                                raise ValueError("Invalid serial boot menu index")
                            for key in ["home", *(["down"] * menu_index), "ret"]:
                                execute("send-key", {"keys": [{"type": "qcode", "data": key}]})
                                time.sleep(0.15)
                    deadline = time.monotonic() + 240
                    captured = False
                    console_started, supplied = False, set()
                    while process.poll() is None:
                        text = transcript()
                        if interactive_setup and "POLLY_LOGIN_AUTH_PENDING" in text and not login_sent:
                            time.sleep(1)
                            login_token = tokens[2] if args.account_persistence and count > 1 else tokens[0]
                            for key in [*login_token, "ret"]:
                                execute("send-key", {"keys": [{"type": "qcode", "data": key}], "hold-time": 10})
                                time.sleep(0.03)
                            login_sent = True
                        if args.account_persistence and "POLLY_SESSION_REGISTERED uid=1000" in text and \
                                not console_started:
                            time.sleep(1)
                            for instruction in console_fixture_commands(count, console_source):
                                send_text(instruction)
                            console_started = True
                        if args.account_persistence:
                            for match in re.finditer(r"POLLY_AUTH_SECRET_PENDING index=([0-3]) round=(\d+)", text):
                                index = int(match[1])
                                if int(match[2]) == count and index not in supplied:
                                    send_text(tokens[index] + "\n")
                                    supplied.add(index)
                        if any(message in text for message in [
                            "POLLY_PERSISTENCE_FAILED", "Kernel panic", "PollyDesktop session failed",
                            "POLLY_STORAGE_FAILED", "POLLY_STORAGE_EARLY_FAILED",
                            "POLLY_ACCOUNT_CONSOLE_FAILED",
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
                    required = ["POLLY_SESSION_REGISTERED uid=1000", "Active=yes"]
                    if args.account_persistence:
                        required += [f"POLLY_ACCOUNT_CONSOLE_PASS round={count} uid=1000",
                                     "POLLY_LOGIN_AUTH_PENDING", "POLLY_STORAGE_READY", "Power down"]
                        if supplied != {0, 1, 2, 3} or not login_sent or \
                                reply_index != (4 if count == 1 else 0):
                            raise RuntimeError("Account console did not follow the authenticated acceptance flow")
                        if count == 1:
                            required += ["POLLY_SETUP_COMPLETE"]
                        elif "POLLY_SETUP_COMPLETE" in text:
                            raise RuntimeError("Initialized image reran first-boot setup")
                    else:
                        required += ["POLLY_INSTALLED_DESKTOP_READY", "WLR_BACKENDS: drm,libinput"]
                    if not regular:
                        required += [f"POLLY_PERSISTENCE_PASS count={count} slot={slot}",
                                     f"POLLY_APPDATA_PASS {count}", f"POLLY_SETTINGS_PASS {count}",
                                     "theme=bigsur", "Power down"]
                        if "accountSetup" in manifest:
                            required += [f"POLLY_ACCOUNT_AUTH_PASS count={count} slot={slot}"]
                    elif interactive_setup and not args.account_persistence:
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
                                   "settings": not args.smoke,
                                   "managedAppData": not regular,
                                   "document": not args.smoke,
                                   "nativeDesktop": not args.account_persistence,
                                   "standardPasswordChanges": args.account_persistence and count == 1,
                                   "oldCredentialsRejected": args.account_persistence,
                                   "serialLog": str(serial.relative_to(evidence))})
                    rounds[-1]["accountAuthentication"] = "accountSetup" in manifest
                    print(f"PASS: authenticated console round {count}, changed credentials retained, clean poweroff"
                          if args.account_persistence else
                          "PASS: regular installed desktop without verification helpers" if args.smoke else
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
        "mode": "single-system-account-persistence" if args.account_persistence else
                "diagnostic-native-desktop-smoke" if kernel_arguments else
                ("native-desktop-smoke" if args.smoke else "persistence"),
        "layout": manifest.get("layout", "historical-D1-A/B"),
        "memoryMiB": 4096, "network": False, "hostDevices": False, "rounds": rounds,
        "originalImageUnchanged": True, "imageSha256": original_hash,
        "disk": "disposable qcow2 overlay with read-only raw backing",
        "testClient": "ordinary-user console client after password login" if args.account_persistence else None,
        "testClientSha256": hashlib.sha256(console_source).hexdigest() if console_source is not None else None,
        "limits": ["Not physical-device qualification", "No actual system update or migration",
                   *(["Not UEFI acceptance; diagnostic kernel/initrd supplied separately"]
                     if kernel_arguments else [])],
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
