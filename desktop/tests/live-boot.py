#!/usr/bin/env python3
"""Boot read-only optical/USB media in an isolated UEFI guest without host devices."""
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
import base64
import zlib
import threading
import re


def acceptance_input_required(diagnostic_prepare, profile_settings_startup):
    return not (diagnostic_prepare and profile_settings_startup)


def guest_drm_input_record(text):
    # Kernel console writes can split a journal record. Use this view only for
    # backend identification; fatal/error checks retain the complete raw log.
    journal = re.sub(r"\x1b\[[0-9;]*m", "", text)
    configured = "WLR_BACKENDS: drm,libinput" in journal
    for match in re.finditer(
            r"Loading user-specified backends due to ([A-Z_]+)"
            r"\[\s*\d+\.\d+\] hrtimer: interrupt took \d+ ns\r?\n([A-Z_]+: drm,libinput)", journal):
        configured |= match[1] + match[2] == "WLR_BACKENDS: drm,libinput"
    return (configured and
            "Initializing DRM backend for /dev/dri/" in journal and
            "Seat opened with backend 'logind'" in journal)


def fatal_guest_record(raw):
    return any(message in raw for message in
               ["Kernel panic", "PollyDesktop session failed", "Cannot initialize renderer"])


def settings_tab_steps(control, user_theme_loaded=False):
    # Present leaves no active element; the first Tab focuses the tabindex=0 body.
    positions = {"bigsur": 13, "reload": 14, "xp": 9, "user-theme": 14, "restore": 15}
    if control == "user-theme" and not user_theme_loaded:
        raise ValueError("A user theme must be loaded before selecting its native control")
    return positions[control] + int(user_theme_loaded and control in ("reload", "restore"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("iso", type=Path)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--usb", action="store_true")
    parser.add_argument("--memory-mib", type=int, choices=[4096, 8192], default=4096)
    parser.add_argument("--new-architecture", action="store_true",
                        help="Inject ordinary-user test source into guest RAM and exercise production Settings/files")
    parser.add_argument("--harness-revision", help="Exact separate producer/test commit, never the runtime source label")
    parser.add_argument("--runtime-revision", help="Exact frozen runtime commit required by the guest origin receipt")
    parser.add_argument("--diagnostic-prepare", action="store_true",
                        help="Capture startup diagnostics only; never publish an acceptance result")
    parser.add_argument("--profile-settings-startup", action="store_true",
                        help="One ordinary-user owned-bus header-only startup diagnostic, maximum 30 seconds")
    args = parser.parse_args()
    if args.new_architecture and (not args.harness_revision or len(args.harness_revision) != 40 or
                                 any(char not in "0123456789abcdef" for char in args.harness_revision)):
        raise ValueError("New-architecture acceptance requires an explicit full harness revision")
    if args.new_architecture and (not args.runtime_revision or not re.fullmatch(r"[0-9a-f]{40}", args.runtime_revision)):
        raise ValueError("New-architecture acceptance requires an explicit full frozen runtime revision")
    if args.diagnostic_prepare and not args.new_architecture:
        raise ValueError("Startup diagnosis requires the ordinary-user new-architecture helper")
    if args.profile_settings_startup and not args.diagnostic_prepare:
        raise ValueError("Owned-bus header monitoring is allowed only in explicit startup-only diagnostics")
    iso = args.iso.resolve()
    evidence = args.evidence.resolve()
    if evidence.exists():
        raise ValueError("Refusing to overwrite prior boot evidence")
    evidence.mkdir(parents=True)
    if args.diagnostic_prepare:
        with iso.open("rb") as source:
            planned_hash = hashlib.file_digest(source, "sha256").hexdigest()
        (evidence / "diagnostic-plan.json").write_text(json.dumps({
            "acceptance": False, "isoSha256": planned_hash, "harnessRevision": args.harness_revision,
            "runtimeSourceRevision": args.runtime_revision,
            "profileSettingsStartup": args.profile_settings_startup,
            "skippedAcceptanceGates": ["nativeChineseCommit", "nativeClipboardPaste",
                                       "keyboardWorkspaceSwitch"] if args.profile_settings_startup else [],
            "maximumMonitorSeconds": 30 if args.profile_settings_startup else None,
            "limits": "Diagnosis only, including on failure; no successful acceptance result is implied."
        }, indent=2) + "\n")
    with tempfile.TemporaryDirectory(prefix="polly-vm-") as temporary:
        temporary = Path(temporary)
        firmware = Path("/usr/share/OVMF")
        code_name, vars_name = "OVMF_CODE.fd", "OVMF_VARS.fd"
        if not (firmware / code_name).exists():
            code_name, vars_name = "OVMF_CODE_4M.fd", "OVMF_VARS_4M.fd"
        variables = temporary / "vars.fd"
        shutil.copyfile(firmware / vars_name, variables)
        qmp_path = temporary / "qmp.sock"
        serial_path = temporary / "serial.sock"
        serial = evidence / "serial.log"
        acceleration = "kvm" if os.access("/dev/kvm", os.R_OK | os.W_OK) else "tcg"
        command = [
            "qemu-system-x86_64", "-nodefaults", "-machine", "q35", "-accel", acceleration,
            "-cpu", "host" if acceleration == "kvm" else "qemu64", "-m", str(args.memory_mib), "-smp", "2",
            "-drive", f"if=pflash,format=raw,readonly=on,file={firmware / code_name}",
            "-drive", f"if=pflash,format=raw,file={variables}",
            "-device", "virtio-vga", "-device", "qemu-xhci", "-device", "usb-kbd", "-device", "usb-tablet",
            "-audiodev", "none,id=silent", "-device", "intel-hda", "-device", "hda-duplex,audiodev=silent",
            "-nic", "none", "-display", "none",
            *(["-chardev", f"socket,id=guestserial,path={serial_path},server=on,wait=off,logfile={serial}",
               "-serial", "chardev:guestserial"] if args.new_architecture else ["-serial", "file:" + str(serial)]),
            "-qmp", f"unix:{qmp_path},server=on,wait=off", "-no-reboot",
        ]
        if args.usb:
            command += ["-drive", f"if=none,id=liveusb,format=raw,readonly=on,file={iso}",
                        "-device", "usb-storage,drive=liveusb,bootindex=1"]
        else:
            command += ["-cdrom", str(iso), "-boot", "order=d"]
        with (evidence / "qemu.log").open("w") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
            connection = None
            stream = None
            serial_connection = None
            serial_stop = threading.Event()
            serial_thread = None
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
                if args.new_architecture:
                    serial_connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    serial_connection.settimeout(10)
                    serial_connection.connect(str(serial_path))
                    serial_connection.settimeout(0.2)

                    def drain_serial():
                        while not serial_stop.is_set():
                            try:
                                if not serial_connection.recv(8192):
                                    return
                            except socket.timeout:
                                continue
                            except OSError:
                                if not serial_stop.is_set():
                                    raise

                    serial_thread = threading.Thread(target=drain_serial, daemon=True)
                    serial_thread.start()
                while "serial VM baseline" not in (serial.read_text(errors="replace") if serial.exists() else ""):
                    if process.poll() is not None or time.monotonic() > deadline:
                        execute("screendump", {"filename": str(evidence / "failed-firmware.ppm")})
                        raise RuntimeError("UEFI firmware did not reach the Live boot menu")
                    time.sleep(0.1)
                execute("send-key", {"keys": [{"type": "qcode", "data": "end"}]})
                time.sleep(0.2)
                execute("send-key", {"keys": [{"type": "qcode", "data": "ret"}]})
                deadline = time.monotonic() + 240
                while True:
                    text = serial.read_text(errors="replace") if serial.exists() else ""
                    if "Initramfs unpacking failed" in text:
                        execute("screendump", {"filename": str(evidence / "failed-guest.ppm")})
                        raise RuntimeError("The memory-only root did not unpack completely; do not accept partial startup:\n" + text[-8000:])
                    if "POLLY_LIVE_DESKTOP_READY" in text:
                        break
                    if text.count("POLLY_SESSION_REGISTERED uid=1000") > 1:
                        execute("screendump", {"filename": str(evidence / "failed-guest.ppm")})
                        raise RuntimeError("Live login/session is restarting instead of retaining a diagnostic console:\n" + text[-8000:])
                    if process.poll() is not None or time.monotonic() > deadline:
                        execute("screendump", {"filename": str(evidence / "failed-guest.ppm")})
                        raise RuntimeError("Desktop boot did not become ready:\n" + text[-8000:])
                    time.sleep(0.5)
                if "Starting ordinary user desktop, uid=1000" not in text:
                    raise RuntimeError("Desktop readiness did not prove ordinary-user session startup")
                if not guest_drm_input_record(text):
                    raise RuntimeError("Desktop did not use guest DRM/input devices")
                if "POLLY_SESSION_REGISTERED uid=1000" not in text or "Active=yes" not in text:
                    raise RuntimeError("PAM did not register an active ordinary-user elogind session")
                if fatal_guest_record(text):
                    raise RuntimeError("Boot reported a fatal error:\n" + text[-8000:])
                def wait_log(marker, seconds=30, pattern=False):
                    until = time.monotonic() + seconds
                    while True:
                        transcript = re.sub(r"\x1b\[[0-9;]*m", "", serial.read_text(errors="replace"))
                        if (re.search(marker, transcript) if pattern else marker in transcript):
                            return
                        if process.poll() is not None or time.monotonic() > until:
                            execute("screendump", {"filename": str(evidence / "failed-guest.ppm")})
                            raise RuntimeError("Missing native guest marker: " + marker)
                        time.sleep(0.2)

                def keys(*names):
                    execute("send-key", {"keys": [{"type": "qcode", "data": key} for key in names],
                                         "hold-time": 80})
                    time.sleep(1.0 if acceleration == "tcg" else 0.15)

                if acceptance_input_required(args.diagnostic_prepare, args.profile_settings_startup):
                    wait_log("Input-method protocol ready", 120)
                    time.sleep(10 if acceleration == "tcg" else 1)
                    for key in ("n", "i", "h", "a", "o", "spc"):
                        keys(key)
                    wait_log("POLLY_LIVE_IME_COMMIT")
                    keys("ctrl", "a")
                    keys("ctrl", "c")
                    keys("right")
                    keys("ctrl", "v")
                    wait_log("POLLY_LIVE_CLIPBOARD_PASTE")
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
                new_architecture = None
                if args.new_architecture:
                    def send_text(value):
                        serial_connection.sendall(value.encode())
                        time.sleep(0.3)

                    def console():
                        time.sleep(0.3)

                    def desktop_view():
                        time.sleep(0.5)

                    wait_log("login:", 30)
                    send_text("polly\n")
                    time.sleep(1)
                    send_text("polly\n")
                    time.sleep(1)
                    send_text("logger -t polly-vm-check POLLY_VM_CONSOLE_READY\n")
                    wait_log(r"polly-vm-check\[\d+\]: POLLY_VM_CONSOLE_READY", 30, pattern=True)
                    fixture = {
                        "guest.py": Path(__file__).with_name("live-newarch-guest.py").read_bytes(),
                        "files.mjs": Path(__file__).with_name("live-files-guest.mjs").read_bytes(),
                    }
                    payload = base64.b64encode(zlib.compress(json.dumps(
                        {name: value.decode() for name, value in fixture.items()}).encode())).decode()
                    send_text("umask 077; set -C; : > /tmp/polly-alpha-fixtures.b64\n")
                    for offset in range(0, len(payload), 1000):
                        send_text("printf %s '" + payload[offset:offset + 1000] +
                                  "' >> /tmp/polly-alpha-fixtures.b64\n")
                    send_text("python3 -I -c \"import base64,zlib,json,pathlib;"
                              "d=json.loads(zlib.decompress(base64.b64decode(pathlib.Path("
                              "'/tmp/polly-alpha-fixtures.b64').read_text())));"
                              "pathlib.Path('/tmp/polly-alpha-guest.py').write_text(d['guest.py']);"
                              "pathlib.Path('/tmp/polly-alpha-files-guest.mjs').write_text(d['files.mjs'])\"\n")
                    stages = {}

                    def stage(name):
                        previous = serial.read_text(errors="replace")
                        send_text("python3 -I -B /tmp/polly-alpha-guest.py " + name + " " + args.runtime_revision + "\n")
                        deadline = time.monotonic() + 60
                        prefix = "POLLY_VM_NEWARCH_" + name.upper() + "="
                        while True:
                            current = serial.read_text(errors="replace")
                            fresh = re.sub(r"\x1b\[[0-9;]*m", "", current[len(previous):])
                            complete = fresh[:fresh.rfind("\n") + 1]
                            if "POLLY_VM_NEWARCH_FAILED=" in complete:
                                execute("screendump", {"filename": str(evidence / "newarch-failed.ppm")})
                                raise RuntimeError("Guest new-architecture action failed:\n" + complete[-6000:])
                            if prefix in complete:
                                value = complete.split(prefix, 1)[1].splitlines()[0].strip()
                                result = json.loads(value)
                                stages[name] = result
                                return result
                            if process.poll() is not None or time.monotonic() > deadline:
                                execute("screendump", {"filename": str(evidence / "newarch-failed.ppm")})
                                raise RuntimeError("Missing actual guest new-architecture result: " + name)
                            time.sleep(0.2)

                    def press_tab(count):
                        for _ in range(count):
                            keys("tab")
                        keys("ret")
                        time.sleep(1)

                    preparation = "prepare-profile" if args.profile_settings_startup else "prepare"
                    stage(preparation)
                    if args.diagnostic_prepare:
                        execute("screendump", {"filename": str(evidence / "diagnostic-settings.ppm")})
                        with iso.open("rb") as source:
                            diagnostic_hash = hashlib.file_digest(source, "sha256").hexdigest()
                        (evidence / "diagnostic.json").write_text(json.dumps({
                            "acceptance": False, "isoSha256": diagnostic_hash,
                            "harnessRevision": args.harness_revision, "prepare": stages[preparation],
                            "skippedAcceptanceGates": ["nativeChineseCommit", "nativeClipboardPaste",
                                                       "keyboardWorkspaceSwitch"]
                            if args.profile_settings_startup else [],
                            "limits": "Startup-only diagnostic, not full new-architecture or physical acceptance."
                        }, indent=2) + "\n")
                        execute("quit")
                        process.wait(timeout=10)
                        print("Completed startup diagnosis only; no acceptance result was published")
                        return
                    desktop_view()
                    execute("screendump", {"filename": str(evidence / "settings-appearance.ppm")})
                    press_tab(settings_tab_steps("bigsur"))
                    console()
                    stage("selected")
                    stage("appearance")
                    desktop_view()
                    press_tab(settings_tab_steps("reload"))
                    time.sleep(1)
                    console()
                    stage("appearance")
                    desktop_view()
                    press_tab(settings_tab_steps("user-theme", True))
                    console()
                    stage("user-theme")
                    stage("appearance")
                    desktop_view()
                    press_tab(settings_tab_steps("xp", True))
                    console()
                    stage("appearance")
                    desktop_view()
                    press_tab(settings_tab_steps("restore", True))
                    console()
                    stage("restored")
                    stage("about")
                    desktop_view()
                    execute("screendump", {"filename": str(evidence / "settings-about.ppm")})
                    keys("alt", "f4")
                    time.sleep(1)
                    console()
                    stage("reopen")
                    desktop_view()
                    execute("screendump", {"filename": str(evidence / "settings-reopened.ppm")})
                    new_architecture = {"harnessRevision": args.harness_revision,
                                        "runtimeSourceRevision": args.runtime_revision,
                                        "fixturesInIso": False, "ordinaryUser": 1000,
                                        "actualStages": stages,
                                        "input": "QMP physical USB keyboard and ordinary public Live serial login"}
                result = {
                    "ready": True, "firmware": "OVMF UEFI", "acceleration": acceleration,
                    "memoryMiB": args.memory_mib, "vcpus": 2, "disks": [], "network": False,
                    "bootMedia": "read-only USB" if args.usb else "read-only optical",
                    "graphics": "virtio-vga", "hostAudio": False, "ordinaryUser": 1000,
                    "keyboardWorkspaceSwitch": True,
                    "pamSessionRegistered": True,
                    "nativeChineseCommit": True, "nativeClipboardPaste": True,
                    "inputCadenceSeconds": 1.0 if acceleration == "tcg" else 0.15,
                    "iso": iso.name, "serialLog": "serial.log", "screenshot": "desktop.ppm",
                    **({"newArchitecture": new_architecture} if new_architecture else {}),
                    "termination": "QMP quit, not a guest user power-off assertion",
                }
                with iso.open("rb") as source:
                    result["isoSha256"] = hashlib.file_digest(source, "sha256").hexdigest()
                (evidence / "result.json").write_text(json.dumps(result, indent=2) + "\n")
                execute("quit")
                process.wait(timeout=10)
                print("PASS: UEFI Live media booted a non-root PollyWM DRM desktop without any writable disk or network")
            finally:
                if stream is not None:
                    stream.close()
                if connection is not None:
                    connection.close()
                if serial_connection is not None:
                    serial_stop.set()
                    if serial_thread is not None:
                        serial_thread.join(timeout=1)
                    serial_connection.close()
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)


if __name__ == "__main__":
    main()
