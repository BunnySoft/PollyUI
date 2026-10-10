"""Real native JSON files, failure publication, migration and competing processes; private /tmp only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

runtime, oracle = map(str, sys.argv[1:])
repo = Path(__file__).resolve().parents[2]
default = dict(version=1, theme=dict(id=None, filesEnabled=True),
               audio=None, display=None, workspace=None, shortcuts=None)
with tempfile.TemporaryDirectory(prefix="polly-config-", dir="/tmp") as temporary:
    root = Path(temporary)
    paths = {name: str(root / child) for name, child in (("configDir", "config"), ("dataDir", "data"))}
    for directory in paths.values():
        Path(directory).mkdir(mode=0o700)
    config = Path(paths["configDir"]) / "shell-preferences.json"
    old = Path(paths["dataDir"]) / "localstorage.dat"
    environment = dict(os.environ, HOME=str(root), TMPDIR="/tmp", PU_TEST_STORAGE=str(root / "test-storage"))
    def script(mode, expected=None):
        entry = root / (mode + ".mjs")
        entry.write_text("globalThis.configurationFixture = " +
                         json.dumps(dict(paths=paths, mode=mode, expected=expected)) +
                         ";\nawait import('./desktop/tests/configuration-native.mjs');\n")
        return entry
    def run(mode, expected=None, fault=None):
        result = subprocess.run([runtime, "--test", str(script(mode, expected))], cwd=repo,
                                env={**environment, **(dict(LD_PRELOAD=oracle, POLLY_CONFIG_FAULT=fault) if fault else {})},
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15)
        if result.returncode or f"PASS: configuration fixture {mode}" not in result.stdout:
            raise RuntimeError(result.stdout)
        if list(config.parent.glob(".configuration-*")):
            raise RuntimeError("Leaked staging files")
        print(f"PASS: native configuration {mode} {fault or ''}")
    def put(path, value):
        path.write_bytes(value)
        path.chmod(0o600)
    run("load", default)
    run("roundtrip")
    changed = {**default, "theme": dict(id="bigsur", filesEnabled=False),
               "workspace": dict(version=1, names=["Code", "\u8d44\u6599\U0001f430"], active=1)}
    run("load", changed)
    put(old, b"broken old file must never be read")
    run("load", changed)
    for fault in ("write", "zero", "sync", "rename", "close"):
        before = config.read_bytes()
        run("write-failure", fault=fault)
        assert config.read_bytes() == before
    run("roundtrip", fault="short")
    run("committed", fault="directory")
    for contents in (b"{broken", b'{"version":99}', json.dumps({**default, "unexpected": 1}).encode(),
                     json.dumps({**default, "audio": {"version": 2}}).encode(), b"\xc0\x80"):
        put(config, contents)
        run("reject")
        assert config.read_bytes() == contents
    put(config, json.dumps(default).encode())
    config.chmod(0o644)
    run("reject")
    config.chmod(0o600)
    config.chmod(0o400)
    run("write-failure")
    config.chmod(0o600)
    config.parent.chmod(0o500)
    run("write-failure")
    config.parent.chmod(0o700)
    config.parent.chmod(0o755)
    run("reject")
    config.parent.chmod(0o700)
    config.unlink()
    config.symlink_to(old)
    run("reject")
    config.unlink()
    os.mkfifo(config, 0o600)
    run("reject")
    config.unlink()
    # Complete first migration uses actual UTF-8 byte lengths, including unknown keys.
    audio = dict(version=1, preferredSink="speaker", preferredSource="", devices=[
        dict(name="speaker", **{"class": "Audio/Sink"}, volume=0.4, muted=False)])
    display = dict(version=1, heads=[dict(name="DP-1", make="Fixture", model="Monitor", serialNumber="A",
        enabled=True, width=1280, height=720, refresh=60000, scale=1, transform=0, x=0, y=0, adaptiveSync=False)])
    shortcuts = [dict(action="minimize-window", modifiers=2, key="m")] + [
        dict(action=action, modifiers=0, key="") for action in ("switch-window", "close-window",
            "maximize-window", "fullscreen-window", "previous-workspace", "next-workspace")]
    migrated = {**changed, "audio": audio, "display": display, "shortcuts": shortcuts}
    pairs = [("desktop.theme", "bigsur"), ("desktop.theme.files", "disabled"),
             ("desktop.audio.v1", json.dumps(audio)), ("desktop.displays.v1", json.dumps(display)),
             ("desktop.shortcuts.v1", json.dumps(shortcuts)),
             ("desktop.workspaces.v1", json.dumps(changed["workspace"], ensure_ascii=False)),
             ("unrelated.key", "kept in old file only")]
    legacy = b"PUST1\n" + b"".join(str(len(field.encode())).encode() + b"\n" + field.encode() + b"\n"
                                  for pair in pairs for field in pair)
    put(old, legacy)
    run("reject", fault="write")
    assert not config.exists() and old.read_bytes() == legacy
    run("reject", fault="race")
    assert config.read_bytes() == b'{"version":99}' and old.read_bytes() == legacy
    config.unlink()
    run("load", migrated)
    assert old.read_bytes() == legacy
    put(old, b"malformed after migration")
    run("load", migrated)
    config.unlink()
    invalid_audio = b'{"version":2}'
    invalid_section = b"PUST1\n16\ndesktop.audio.v1\n" + str(len(invalid_audio)).encode() + b"\n" + invalid_audio + b"\n"
    for contents in (legacy[:-2], b"PUST1\n5\nx\n", b"PUST1\n1\n\xff\n0\n\n", invalid_section):
        put(old, contents)
        run("reject")
        assert not config.exists() and old.read_bytes() == contents
    put(old, legacy)
    run("load", migrated)
    holder = subprocess.Popen([runtime, "--test", str(script("hold"))], cwd=repo, env=environment,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        import time
        time.sleep(0.4)
        assert holder.poll() is None
        run("reject", "EAGAIN")
        holder.terminate()
        holder.wait(timeout=5)
        run("load", migrated)
    finally:
        if holder.poll() is None:
            holder.kill()
            holder.wait()
    # Every component is opened NOFOLLOW, including ancestors of the private application directory.
    real = config.parent
    moved = root / "moved-config"
    real.rename(moved)
    real.symlink_to(moved, target_is_directory=True)
    run("reject")
    real.unlink()
    moved.rename(real)
    run("load", migrated)
print("PASS: native configuration closure")
