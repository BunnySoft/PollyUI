#!/usr/bin/env python3
"""Private native Settings fixture; no host bus, radio, audio core or user preferences."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from xml.sax.saxutils import escape


def stop(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def ordinary_user():
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)


def wait_socket(path, process):
    deadline = time.monotonic() + 5
    while not path.is_socket():
        if process.poll() is not None or time.monotonic() >= deadline:
            raise RuntimeError("Private fixture service did not create " + str(path))
        time.sleep(0.02)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime_client", type=Path)
    parser.add_argument("pollyui", type=Path)
    parser.add_argument("--mode", choices=("ui", "audio", "network", "installed", "all"), default="all")
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--renderer", choices=("raster", "gl"), default="raster")
    parser.add_argument("--package-root", type=Path, help="Use the verified runtime bundle rootfs instead of reinstalling")
    args = parser.parse_args()
    if args.package_root and args.mode != "installed":
        raise ValueError("--package-root requires --mode installed")
    modes = ("ui", "audio", "network") if args.mode == "all" else (args.mode,)
    if sys.platform != "linux" or os.geteuid() not in (0, 1000):
        raise RuntimeError("Run only in the isolated Linux native lane, as root coordinator or UID1000")
    if "network" in modes and os.geteuid() != 0:
        raise RuntimeError("Synthetic iwd must be root-owned; the Shell still runs as UID1000")
    if args.evidence:
        args.evidence.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="polly-settings-", dir=args.evidence))
    if os.geteuid() == 0:
        os.chown(root, 1000, 1000)
    repo = Path(__file__).resolve().parents[2]
    runtime_client, pollyui = args.runtime_client.resolve(strict=True), args.pollyui.resolve(strict=True)
    helper = pollyui.parent / "polly-iwd-test"
    if "network" in modes and not helper.is_file():
        raise RuntimeError("Build the existing polly-iwd-test target in the native lane")
    preexec = ordinary_user if os.geteuid() == 0 else None
    environment = dict(os.environ)
    for key in tuple(environment):
        if key.startswith(("XDG_", "DBUS_", "POLLY_", "PIPEWIRE_", "WAYLAND_", "SDL_", "PU_", "PULSE_")):
            del environment[key]
    environment.update(SDL_VIDEODRIVER="wayland", SDL_RENDER_DRIVER="software",
                       WLR_RENDERER="pixman", WLR_BACKENDS="headless", WLR_HEADLESS_OUTPUTS="2",
                       PU_RENDERER=args.renderer)
    try:
        for mode in modes:
            stage = root / mode
            stage.mkdir(mode=0o700)
            if os.geteuid() == 0:
                os.chown(stage, 1000, 1000)
            for name in ("run", "home", "config", "data", "cache"):
                path = stage / name
                path.mkdir(mode=0o700)
                if os.geteuid() == 0:
                    os.chown(path, 1000, 1000)
            run = stage / "run"
            env = dict(environment, HOME=str(stage / "home"), XDG_RUNTIME_DIR=str(run),
                       XDG_CONFIG_HOME=str(stage / "config"), XDG_DATA_HOME=str(stage / "data"),
                       XDG_CACHE_HOME=str(stage / "cache"), PULSE_SERVER="disabled:")
            processes, logs = [], []
            try:
                address = stage / "bus.address"
                address_log = address.open("w+")
                logs.append(address_log)
                bus_log = (stage / "bus.log").open("w+")
                logs.append(bus_log)
                bus = subprocess.Popen(["dbus-daemon", "--session", "--nofork", "--nopidfile",
                                        "--address=unix:path=" + str(run / "bus"), "--print-address"],
                                       env=env, stdout=address_log, stderr=bus_log, preexec_fn=preexec)
                processes.append(bus)
                env["POLLY_SETTINGS_TEST_BUS_PID"] = str(bus.pid)
                wait_socket(run / "bus", bus)
                deadline = time.monotonic() + 5
                while not address.read_text().strip():
                    if bus.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Private session bus address was not published")
                    time.sleep(0.01)
                env["DBUS_SESSION_BUS_ADDRESS"] = env["POLLY_SESSION_BUS_ADDRESS"] = address.read_text().strip()
                if mode == "ui":
                    for label, change in (
                            ("missing-owned", {"POLLY_SESSION_BUS_ADDRESS": ""}),
                            ("mismatched", {"POLLY_SESSION_BUS_ADDRESS": "unix:path=/must-not-connect"}),
                            ("wrong-socket", {"POLLY_SESSION_BUS_ADDRESS": "unix:path=" + str(run / "wrong"),
                                              "DBUS_SESSION_BUS_ADDRESS": "unix:path=" + str(run / "wrong")})):
                        rejected = subprocess.run(
                            [str(pollyui), "--app-id", "org.pollyui.settings",
                             str(repo / "desktop/tests/settings-startup-error.mjs")],
                            cwd=repo, env=dict(env, SDL_VIDEODRIVER="offscreen", **change),
                            preexec_fn=preexec, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)
                        if rejected.returncode or "PASS: standalone Settings startup error is visible" not in rejected.stdout:
                            raise RuntimeError("Settings negative startup case failed: " + label + "\n" + rejected.stdout)
                provider = None
                if mode == "network":
                    config = stage / "system-bus.conf"
                    config.write_text('<busconfig><type>system</type><listen>unix:path=' +
                                      escape(str(run / "system-bus")) + '</listen><auth>EXTERNAL</auth>'
                                      '<policy context="default"><allow user="*"/><allow own="*"/>'
                                      '<allow send_destination="*"/><allow receive_sender="*"/>'
                                      '</policy></busconfig>')
                    system_log = (stage / "system-bus.log").open("w+")
                    logs.append(system_log)
                    system_bus = subprocess.Popen(["dbus-daemon", "--nofork", "--nopidfile",
                                                   "--config-file=" + str(config)],
                                                  env=env, stdout=system_log, stderr=subprocess.STDOUT)
                    processes.append(system_bus)
                    wait_socket(run / "system-bus", system_bus)
                    env["DBUS_SYSTEM_BUS_ADDRESS"] = "unix:path=" + str(run / "system-bus")
                    provider_log = (stage / "iwd.log").open("w+")
                    logs.append(provider_log)
                    provider = subprocess.Popen([str(helper), "multi"], env=env, stdout=provider_log, stderr=subprocess.STDOUT)
                    processes.append(provider)
                elif mode == "audio":
                    config = repo / "desktop" / "tests" / "audio.conf"
                    audio_log = (stage / "audio.log").open("w+")
                    logs.append(audio_log)
                    audio = subprocess.Popen(["pipewire"], env=dict(env, PIPEWIRE_CONFIG_DIR=str(config.parent),
                                             PIPEWIRE_CONFIG_NAME=config.name), stdout=audio_log,
                                             stderr=subprocess.STDOUT, preexec_fn=preexec)
                    processes.append(audio)
                    wait_socket(run / "polly-audio", audio)
                    env.update(PIPEWIRE_REMOTE="polly-audio", POLLY_AUDIO_REMOTE="polly-audio")
                # Every non-network mode explicitly avoids the host system bus as well.
                env.setdefault("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=" + str(run / "no-system-bus"))
                fixture_runtime, cwd = pollyui, repo
                script = repo / "desktop/tests/settings-shell.mjs"
                if mode == "installed":
                    if args.package_root:
                        destination = args.package_root.resolve(strict=True)
                    else:
                        destination = stage / "relocated install"
                        subprocess.run(["cmake", "--install", str(pollyui.parent), "--prefix", "/usr",
                                        "--component", "PollyDesktop"], env=dict(env, DESTDIR=str(destination)),
                                       check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
                    fixture_runtime = destination / "usr/bin/pollyui"
                    cwd = destination / "usr/share/pollyui"
                    script = repo / "desktop/tests/settings-installed-shell.mjs"
                    entry = destination / "usr/share/applications/polly-settings.desktop"
                    if "Exec=polly-settings" not in entry.read_text():
                        raise RuntimeError("Installed standalone Settings desktop entry is missing")
                command = [str(runtime_client), str(fixture_runtime), str(script), "settings", mode]
                result = subprocess.run(command, cwd=cwd, env=env, preexec_fn=preexec, text=True,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=300)
                (stage / "native.log").write_text(result.stdout)
                if result.returncode or f"PASS: native Settings {mode} complete" not in result.stdout or any(
                        marker in result.stdout for marker in ("FAIL:", "Uncaught", "AddressSanitizer", "runtime error:")):
                    print(result.stdout)
                    raise RuntimeError("Native Settings fixture failed: " + mode)
                if provider and provider.wait(timeout=5) != 0:
                    raise RuntimeError("Root-owned synthetic iwd did not acknowledge all operations")
                captures = list((stage / "cache").rglob("settings-*.png"))
                if mode != "installed" and len(captures) < 7:
                    raise RuntimeError("Native Settings screenshots are missing")
                print(f"PASS: Settings {mode}, Shell/public app UID1000, {len(captures)} native captures")
            finally:
                for process in reversed(processes):
                    stop(process)
                for log in logs:
                    log.close()
    finally:
        print("Retained private Settings evidence: " + str(root))


if __name__ == "__main__":
    main()
