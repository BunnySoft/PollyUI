#!/usr/bin/env python3
"""Real wrapper/argv/environment probe only; no engine, Wayland, MIME launch or GUI."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("files_window_producer", Path(__file__).with_name("files-window.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)

PROBE = r'''
import json, os, pathlib, stat, sys
home = pathlib.Path(os.environ["HOME"])
runtime = pathlib.Path(os.environ["XDG_RUNTIME_DIR"])
assert runtime != home and not runtime.is_relative_to(home), "Wrapper must own a separate runtime"
info = runtime.lstat()
assert stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1000, 1000, 0o700)
for name, suffix in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache")):
    assert os.environ[name] == str(home / suffix), name + " was overwritten: " + os.environ[name]
catalog = pathlib.Path(os.environ["XDG_DATA_HOME"]) / "applications/files-fixture.desktop"
defaults = pathlib.Path(os.environ["XDG_CONFIG_HOME"]) / "mimeapps.list"
assert catalog.read_text() == "[Desktop Entry]\nType=Application\nName=Private fixture\nExec=/bin/true %F\nMimeType=text/plain;\n"
assert defaults.read_text() == "[Default Applications]\ntext/plain=files-fixture.desktop;\n"
assert sys.argv[1] == os.environ["FILES_PROBE_SHELL"]
assert sys.argv[2:] == ["files-window", "initial"]
assert os.environ["WLR_BACKENDS"] == "headless" and os.environ["SDL_VIDEODRIVER"] == "wayland"
print(json.dumps({"uid": os.getuid(), "gid": os.getgid(), "home": str(home),
    "runtime": str(runtime), "runtimeMode": "0700", "runtimeUid": info.st_uid,
    "config": os.environ["XDG_CONFIG_HOME"], "data": os.environ["XDG_DATA_HOME"],
    "cache": os.environ["XDG_CACHE_HOME"], "catalog": str(catalog), "defaults": str(defaults),
    "argv": sys.argv[1:], "nativeBackendPreserved": True, "guiExecuted": False}, sort_keys=True))
'''


class FilesEnvironment(unittest.TestCase):
    def test_real_wrapper_restores_private_files_xdg_paths_and_preserves_runtime_and_literal_argv(self):
        self.assertEqual((os.getuid(), os.geteuid(), os.getgid(), os.getegid()), (1000, 1000, 1000, 1000))
        with tempfile.TemporaryDirectory(prefix="polly-files-window-env-") as temporary:
            home = Path(temporary)
            for name in ("config", "data", "data/applications", "cache"):
                (home / name).mkdir(mode=0o700)
            (home / "data/applications/files-fixture.desktop").write_text(
                "[Desktop Entry]\nType=Application\nName=Private fixture\nExec=/bin/true %F\nMimeType=text/plain;\n")
            (home / "config/mimeapps.list").write_text(
                "[Default Applications]\ntext/plain=files-fixture.desktop;\n")
            probe = home / "driver probe 'quoted'.py"
            probe.write_text(PROBE)
            shell = REPO / "desktop/tests/files-window-shell.mjs"
            environment = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / "config"),
                               XDG_DATA_HOME=str(home / "data"), XDG_CACHE_HOME=str(home / "cache"),
                               XDG_DATA_DIRS=str(home / "empty-share"), FILES_PROBE_SHELL=str(shell))
            command = producer.driver_command(REPO, Path(sys.executable), probe)
            result = subprocess.run(command, cwd=REPO, env=environment, umask=0,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads(result.stdout)
            self.assertFalse(receipt["guiExecuted"])
            self.assertFalse(Path(receipt["runtime"]).exists(), "Real wrapper must clean its own runtime")
            print("FILES_ENVIRONMENT_PROBE_PASS " + json.dumps(receipt, sort_keys=True), flush=True)


if __name__ == "__main__":
    unittest.main()
