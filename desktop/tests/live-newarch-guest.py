#!/usr/bin/env python3
"""Ordinary-user acceptance helper injected into guest RAM, never installed in ISO."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def check(value, message):
    if not value:
        raise RuntimeError(message)


def process_arguments():
    result = {}
    for file in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            args = file.read_bytes().rstrip(b"\0").split(b"\0")
            if args and args[0].endswith(b"/pollyui"):
                result[int(file.parent.name)] = [value.decode() for value in args]
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return result


def shell_environment():
    processes = process_arguments()
    shells = [pid for pid, args in processes.items() if "--desktop-shell" in args and
              "/usr/share/pollyui/desktop/shell/live.mjs" in args]
    check(len(shells) == 1, "Expected exactly one production Live Shell")
    pid = shells[0]
    fields = (Path("/proc") / str(pid) / "environ").read_bytes().rstrip(b"\0").split(b"\0")
    values = dict(value.decode().split("=", 1) for value in fields if b"=" in value)
    wanted = ("HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
              "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "POLLY_SESSION_BUS_ADDRESS",
              "SDL_VIDEODRIVER", "SDL_RENDER_DRIVER", "PU_RENDERER")
    env = dict(os.environ)
    env.update({key: values[key] for key in wanted if key in values})
    check(values.get("DBUS_SESSION_BUS_ADDRESS") == values.get("POLLY_SESSION_BUS_ADDRESS"),
          "Expected the production owned private session bus")
    check("--no-legacy-storage" in processes[pid], "Production Shell still enabled legacy storage")
    return pid, env


def configuration():
    files = list((Path.home() / ".config").rglob("shell-preferences.json"))
    check(len(files) == 1, "Expected actual typed Shell JSON file")
    file = files[0]
    check(file.stat().st_uid == 1000 and file.stat().st_mode & 0o777 == 0o600,
          "Shell JSON is not an ordinary-user private file")
    value = json.loads(file.read_text())
    check(value["version"] == 1, "Unexpected typed configuration version")
    return file, value


def settings_pid(shell_pid):
    deadline = time.monotonic() + 10
    while True:
        candidates = [pid for pid, args in process_arguments().items() if "--app-id" in args and
                      "org.pollyui.settings" in args and "--managed" in args]
        if len(candidates) == 1 and candidates[0] != shell_pid:
            return candidates[0]
        check(time.monotonic() < deadline, "Settings is not an independent owned PID")
        time.sleep(0.1)


def emit(stage, result):
    subprocess.run(["logger", "-t", "polly-vm-check", "POLLY_VM_NEWARCH_" + stage.upper() + "=" +
                    json.dumps(result, separators=(",", ":"))], check=True)


def main():
    check(os.getuid() == os.geteuid() == 1000, "Run acceptance only as the ordinary Live user")
    stage = sys.argv[1]
    state_file = Path("/tmp/polly-alpha-acceptance-state.json")
    shell, env = shell_environment()
    if stage == "prepare":
        origin = json.loads(Path("/usr/share/pollyui/runtime-origin.json").read_text())
        check(origin["runtimeSourceRevision"] == "5fc944e3d3eb5cb7a4db568e052a9cc4793cc618" and
              origin["runtimeSourceDirty"] is False, "Guest did not boot the frozen runtime")
        file, value = configuration()
        catalog = json.loads(Path("/usr/share/pollyui/desktop/resources/themes/builtin.json").read_text())
        theme = next(item for item in catalog["themes"] if item["id"] == "xp")
        theme.update(id="alpha-vm", name="Alpha VM user theme")
        themes = Path(env.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "pollyui/themes/alpha-vm"
        themes.mkdir(mode=0o700, parents=True)
        (themes / "theme.json").write_text(json.dumps(theme))
        (themes / "theme.json").chmod(0o600)
        temporary = Path("/tmp/polly-alpha-files")
        temporary.mkdir(mode=0o700)
        files = subprocess.run(["/usr/bin/pollyui", "--app-id", "org.pollyui.alpha-files",
                                "/tmp/polly-alpha-files-guest.mjs", str(temporary)],
                               env=env, cwd="/usr/share/pollyui", text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        check(files.returncode == 0 and "POLLY_VM_FILES_NATIVE_OK" in files.stdout and
              "FAILED" not in files.stdout, "Actual native Files SDK failed: " + files.stdout)
        launch = subprocess.run(["/usr/bin/polly-settings", "appearance"], env=env, cwd="/tmp",
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)
        check(launch.returncode == 0, "Production Settings launcher failed: " + launch.stdout)
        pid = settings_pid(shell)
        state = {"shellPid": shell, "settingsPid": pid, "configurationFile": str(file), "theme": str(themes)}
        state_file.write_text(json.dumps(state))
        state_file.chmod(0o600)
        emit(stage, {**state, "filesNative": True, "configuration": value["theme"],
                     "runtimeManifestSha256": origin["runtimeManifestSha256"]})
    else:
        state = json.loads(state_file.read_text())
        check(shell == state["shellPid"], "Production Shell exited/restarted during Settings acceptance")
        file, value = configuration()
        if stage in ("selected", "user-theme", "restored"):
            check(settings_pid(shell) == state["settingsPid"], "Settings operation replaced its owned process")
            expected = {"selected": "bigsur", "user-theme": "alpha-vm", "restored": "xp"}[stage]
            check(value["theme"]["id"] == expected, "UI theme choice did not persist to actual Shell JSON")
            if stage == "restored":
                check(value["theme"]["filesEnabled"] is False, "Use packaged themes did not persist")
            if stage == "user-theme":
                check(value["theme"]["filesEnabled"] is True, "User theme was not read through the JS file path")
            emit(stage, {"shellPid": shell, "settingsPid": state["settingsPid"], "configuration": value["theme"]})
        elif stage == "about":
            launch = subprocess.run(["/usr/bin/polly-settings", "about"], env=env, cwd="/",
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)
            check(launch.returncode == 0 and settings_pid(shell) == state["settingsPid"],
                  "About did not present in the existing production Settings process")
            emit(stage, {"sameSettingsPid": state["settingsPid"]})
        elif stage == "appearance":
            launch = subprocess.run(["/usr/bin/polly-settings", "appearance"], env=env, cwd="/tmp",
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)
            check(launch.returncode == 0 and settings_pid(shell) == state["settingsPid"],
                  "Appearance did not present in the existing production Settings process")
            emit(stage, {"sameSettingsPid": state["settingsPid"]})
        elif stage == "reopen":
            check(not any("--managed" in args and "org.pollyui.settings" in args
                          for args in process_arguments().values()), "Settings window close did not end its owned process")
            launch = subprocess.run(["/usr/bin/polly-settings", "appearance"], env=env, cwd="/tmp",
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)
            check(launch.returncode == 0, "Production Settings reopen failed")
            pid = settings_pid(shell)
            check(pid != state["settingsPid"], "Closed Settings did not reopen a new generation")
            state["settingsPid"] = pid
            state_file.write_text(json.dumps(state))
            emit(stage, {"shellPid": shell, "newSettingsPid": pid, "configuration": value["theme"]})
        else:
            raise ValueError("Unknown acceptance stage")


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        emit("failed", {"stage": sys.argv[1], "error": str(error)})
        raise
