#!/usr/bin/env python3
"""Exercise the actual per-user manager on disposable Linux directories."""
import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import resource
import signal
import zipfile

program = str(Path(sys.argv[1]).resolve())
ui = str(Path(sys.argv[2]).resolve())
graphical = "--graphical" in sys.argv[3:]
if os.getuid() == 0:
    if not Path("/run/.containerenv").exists():
        raise RuntimeError("Root fixture must run only in a disposable Podman container")
    os.setgroups([])
    os.setgid(65534)
    os.setuid(65534)
platform = "musl" if Path("/etc/alpine-release").exists() else "glibc"
base = {"schemaVersion": 1, "id": "org.example.bundle", "name": "Managed Notes", "version": "1.0.0",
        "target": {"os": "linux", "architecture": "x86_64", "libc": platform},
        "launch": {"kind": "pollyui", "entry": "main.mjs", "arguments": ["write"]},
        "data": {"layout": "pollyui", "schema": 1}}
source = """
if (application.id !== 'org.example.bundle') throw new Error('Unstable application identity');
if (application.arguments[0] === 'write') localStorage.setItem('note', 'kept across upgrades');
else if (localStorage.getItem('note') !== 'kept across upgrades') throw new Error('Lost application data');
console.log('PASS: installed bundle application ' + application.arguments[0]);
window.close();
"""

with tempfile.TemporaryDirectory(prefix="polly-bundle-manager-") as temporary:
    root = Path(temporary)
    environment = dict(os.environ, HOME=str(root / "home"), XDG_DATA_HOME=str(root / "data"),
                       XDG_CONFIG_HOME=str(root / "config"), XDG_CACHE_HOME=str(root / "cache"),
                       XDG_STATE_HOME=str(root / "state"), PU_RENDERER="raster",
                       SDL_VIDEODRIVER="dummy", SDL_RENDER_DRIVER="software")
    store = root / "data/polly-apps"
    def run(*args, ok=True, env=None):
        result = subprocess.run([program, *map(str, args)], env=env or environment,
                                capture_output=True, text=True, timeout=30)
        output = result.stdout + result.stderr
        assert not any(word in output for word in ("AddressSanitizer", "LeakSanitizer", "runtime error:", "Uncaught")), output
        assert (result.returncode == 0) == ok, (args, result.returncode, output)
        return result
    def package(name, manifest=None):
        directory = root / name
        directory.mkdir()
        (directory / "manifest.json").write_text(json.dumps(manifest or base))
        (directory / "main.mjs").write_text(source)
        return directory
    def record():
        return json.loads((store / "apps/org.example.bundle.json").read_text())
    def clean_staging():
        assert not list((store / "objects").glob(".stage-*"))
        assert not list((store / "apps").glob(".stage-*"))

    assert run("list").stdout.strip() == "[]"
    assert not store.exists(), "Read-only discovery must not create application storage"
    original = package("Notes v1.app")
    first = run("install", original).stdout.split()[1]
    assert len(first) == 64 and record()["current"]["digest"] == first
    assert json.loads(run("list").stdout)[0]["current"]["digest"] == first
    first_root = store / "objects" / first
    assert (first_root.stat().st_mode & 0o777) == 0o500
    assert (first_root / "main.mjs").stat().st_mode & 0o222 == 0
    assert (store / "apps/org.example.bundle.json").stat().st_mode & 0o077 == 0
    assert "PASS: installed bundle application write" in run("run", base["id"], first).stdout
    data = root / "data/pollyui/org.example.bundle/localstorage.dat"
    data_bytes = data.read_bytes()
    assert not list(original.glob("localstorage*"))
    run("install", original, ok=False)
    run("replace", original, "0" * 64, ok=False)
    assert record()["current"]["digest"] == first
    clean_staging()

    manifest2 = {**base, "version": "2.0.0", "name": "Moved notes",
                 "launch": {**base["launch"], "arguments": ["read"]}}
    new = package("Different location v2.app", manifest2)
    archive = root / "notes-v2.tar.gz"
    with tarfile.open(archive, "w:gz") as out:
        out.add(new / "manifest.json", arcname="./manifest.json")
        out.add(new / "main.mjs", arcname="./main.mjs")
    second = run("replace", archive, first).stdout.split()[1]
    assert second != first and record()["previous"]["digest"] == first
    run("replace", archive, second)
    assert record()["previous"]["digest"] == first, "Identical replacement must not discard rollback history"
    assert "PASS: installed bundle application read" in run("run", base["id"], second).stdout
    assert data.read_bytes() == data_bytes and first_root.exists()
    run("run", base["id"], first, ok=False)
    run("rollback", base["id"], first, ok=False)
    run("rollback", base["id"], second)
    assert record()["current"]["digest"] == first
    run("rollback", base["id"], first)
    assert record()["current"]["digest"] == second
    changed_schema = package("Schema3.app", {**manifest2, "data": {"layout": "pollyui", "schema": 2}})
    run("replace", changed_schema, second, ok=False)
    assert record()["current"]["digest"] == second and data.read_bytes() == data_bytes
    clean_staging()
    print("PASS: native manager installs, validates, replaces and rolls back code without changing appdata")
    interrupted = package("interrupted.app", manifest2)
    (interrupted / "large.bin").write_bytes(b"x" * 8192)
    def limit_file():
        resource.setrlimit(resource.RLIMIT_FSIZE, (2048, 2048))
        signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
    limited = subprocess.run([program,"replace",str(interrupted),second], env=environment,
                             capture_output=True,text=True,preexec_fn=limit_file,timeout=10)
    assert limited.returncode != 0
    assert record()["current"]["digest"] == second and data.read_bytes() == data_bytes
    run("recover")
    clean_staging()
    print("PASS: interrupted storage write leaves the current program and data intact")

    for label, kind in (("traversal", "path"), ("symlink", "symlink"), ("hardlink", "hardlink"),
                        ("special", "fifo"), ("oversized", "size"), ("duplicate", "duplicate")):
        bad = root / (label + ".tar")
        with tarfile.open(bad, "w") as out:
            meta = json.dumps(base).encode()
            info = tarfile.TarInfo("manifest.json"); info.size = len(meta)
            out.addfile(info, io.BytesIO(meta))
            info = tarfile.TarInfo("../escape" if kind == "path" else "main.mjs")
            if kind == "symlink": info.type = tarfile.SYMTYPE; info.linkname = str(root / "external")
            elif kind == "hardlink": info.type = tarfile.LNKTYPE; info.linkname = "manifest.json"
            elif kind == "fifo": info.type = tarfile.FIFOTYPE
            elif kind == "size": info.size = 300 * 1024 * 1024
            else: info.size = 1
            if kind == "size":
                out.fileobj.write(info.tobuf())
                out.offset += 512
            else:
                out.addfile(info, io.BytesIO(b"x") if kind in ("path", "duplicate") else None)
            if kind == "duplicate": out.addfile(info, io.BytesIO(b"y"))
        run("install", bad, ok=False)
        clean_staging()
        assert not (store / "objects/escape").exists() and not (root / "escape").exists()
    outside = root / "outside"
    outside.write_text("untouched")
    linked = package("linked.app")
    (linked / "linked-data").symlink_to(outside)
    run("install", linked, ok=False)
    assert outside.read_text() == "untouched"
    hard = package("hard.app")
    os.link(outside, hard / "linked-data")
    run("install", hard, ok=False)
    fifo = package("fifo.app")
    os.mkfifo(fifo / "pipe")
    run("install", fifo, ok=False)
    root_link = root / "root-link.app"
    root_link.symlink_to(new, target_is_directory=True)
    run("install", root_link, ok=False)
    invalid = package("invalid.app", {**base, "target": {**base["target"], "libc": "unknown"}})
    run("install", invalid, ok=False)
    reserved = package("reserved.app", {**base, "id": "org.pollyui.shell"})
    run("install", reserved, ok=False)
    existing = root / "data/pollyui/org.example.adopt"
    existing.mkdir(mode=0o700)
    (existing / "old-data").write_text("do not take over")
    adopt = package("adopt.app", {**base, "id": "org.example.adopt"})
    run("install", adopt, ok=False)
    assert (existing / "old-data").read_text() == "do not take over"
    clean_staging()
    print("PASS: tar path traversal, archive/source links, special files, duplicate members and oversized data rejected")

    native_manifest = {**base, "id": "org.example.native", "name": "Native",
                       "launch": {"kind": "native", "entry": "entry", "arguments": ["literal ; $HOME"]},
                       "data": {"layout": "xdg", "schema": 1}}
    native_code = """#!/usr/bin/python3
import json, os
from pathlib import Path
assert 'WAYLAND_SOCKET' not in os.environ
assert 'SDL_APP_ID' not in os.environ
try: os.fstat(31)
except OSError: pass
else: raise RuntimeError('Inherited authority descriptor leaked')
p = Path(os.environ['XDG_DATA_HOME']) / 'native-document'
p.write_text('native data')
print(json.dumps({'home':os.environ['HOME'],'data':str(p),'arg':__import__('sys').argv[1]}))
"""
    zipped = root / "native.zip"
    with zipfile.ZipFile(zipped, "w") as out:
        out.writestr("manifest.json", json.dumps(native_manifest))
        info = zipfile.ZipInfo("entry"); info.create_system = 3; info.external_attr = 0o100755 << 16
        out.writestr(info, native_code)
    native_digest = run("install", zipped).stdout.split()[1]
    read_fd, write_fd = os.pipe()
    try:
        os.dup2(read_fd, 31)
        child = subprocess.run([program, "run", "org.example.native", native_digest],
                               env=dict(environment, WAYLAND_SOCKET="31", SDL_APP_ID="private-shell"),
                               capture_output=True, text=True, pass_fds=(31,), timeout=20)
        assert child.returncode == 0, child.stdout + child.stderr
        returned = json.loads(child.stdout)
        assert returned["home"] == environment["HOME"] and returned["arg"] == "literal ; $HOME"
        assert returned["data"] == str(root / "data/pollyui/org.example.native/native-document")
    finally:
        os.close(read_fd); os.close(write_fd); os.close(31)
    print("PASS: zip executable launch preserves literal argv, separates native XDG data and closes inherited authority")
    native_data = Path(returned["data"]).read_bytes()
    run("remove", "org.example.native", "0"*64, ok=False)
    run("remove", "org.example.native", native_digest)
    run("run", "org.example.native", ok=False)
    assert all(item["current"]["manifest"]["id"] != "org.example.native" for item in json.loads(run("list").stdout))
    assert Path(returned["data"]).read_bytes() == native_data
    assert (store / "objects" / native_digest / "entry").exists()
    run("install", zipped, ok=False)
    run("restore", "org.example.native", "0"*64, ok=False)
    run("restore", "org.example.native", native_digest)
    assert any(item["current"]["manifest"]["id"] == "org.example.native" for item in json.loads(run("list").stdout))
    print("PASS: explicit removal/restoration preserves appdata and retained identity without deleting live code")

    with (store / "lock").open("rb") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        assert "busy" in run("replace", archive, second, ok=False).stderr
    staging = store / "objects" / (".stage-" + "1"*32)
    staging.mkdir(mode=0o700); (staging / "partial").write_text("incomplete")
    run("recover")
    assert not staging.exists() and data.read_bytes() == data_bytes
    assert (store / "objects" / second).exists()
    tampered = store / "objects" / second / "main.mjs"
    tampered.chmod(0o600); tampered.write_text("throw new Error('tampered');")
    assert "modified" in run("run", base["id"], second, ok=False).stderr
    run("replace", archive, second, ok=False)
    assert record()["current"]["digest"] == second, "Identical replacement must not bless modified installed bytes"
    print("PASS: concurrent writers excluded, interrupted staging recovered and content tampering blocks launch")

    shell_app = package("Shell-integrated.app", {**base, "id": "org.example.shelltest", "name": "Bundle launch fixture"})
    (shell_app / "main.mjs").write_text("""
if (application.id !== 'org.example.shelltest') throw new Error('Incorrect managed identity');
if (typeof desktop !== 'undefined') throw new Error('Shell APIs leaked to application');
const app = window.create({title:'Managed bundle public window',width:320,height:160});
app.document.body.textContent = 'Independent installed application';
window.close();
localStorage.setItem('launch','through Shell catalog');
setTimeout(() => window.quit(), 1500);
""")
    run("install", shell_app)
    terminal = package("Foot.app", {
        **base, "id": "org.example.foot", "name": "Managed Foot fixture",
        "launch": {"kind": "native", "entry": "foot",
                   "arguments": ["--title=Managed third-party terminal", "/bin/sh", "-c",
                                 'printf "%s" "$XDG_DATA_HOME" > "$XDG_DATA_HOME/terminal-data"; sleep 2']},
        "data": {"layout": "xdg", "schema": 1},
    })
    shutil.copyfile(shutil.which("foot"), terminal / "foot")
    (terminal / "foot").chmod(0o755)
    terminal_digest = run("install", terminal).stdout.split()[1]
    terminal_config = root / "config/pollyui/org.example.foot/foot"
    terminal_config.mkdir(parents=True)
    terminal_config.parent.chmod(0o700)
    terminal_config.joinpath("foot.ini").write_text("[main]\napp-id=org.example.foot\nfont=monospace:size=11\n")
    runtime = root / "run"
    runtime.mkdir(mode=0o700)
    compositor = str(Path(ui).parent / "pollyui-layer-client-test")
    if graphical:
        shell_result = subprocess.run([compositor, ui, str(Path("desktop/tests/bundle-shell.mjs").resolve()), "bundles", "initial"],
                                  env=dict(environment, XDG_RUNTIME_DIR=str(runtime), WLR_BACKENDS="headless",
                                           WLR_HEADLESS_OUTPUTS="2", WLR_RENDERER="pixman", SDL_VIDEODRIVER="wayland",
                                           PU_RENDERER=os.environ.get("PU_RENDERER", "raster")),
                                  capture_output=True, text=True, timeout=30)
        output = shell_result.stdout + shell_result.stderr
        assert shell_result.returncode == 0 and "PASS: managed bundle launches through the native Shell catalog" in output, output
        assert not any(word in output for word in ("FAIL:", "Uncaught", "AddressSanitizer", "LeakSanitizer", "runtime error:")), output
        assert b"through Shell catalog" in (root / "data/pollyui/org.example.shelltest/localstorage.dat").read_bytes()
        terminal_data = root / "data/pollyui/org.example.foot"
        assert (terminal_data / "terminal-data").read_text() == str(terminal_data)
        print("PASS: managed bundle public process, data and cleanup through native Shell pointer input")
        print("PASS: copied third-party foot binary runs with the current distro dependencies and independent XDG data")
        old_data = (terminal_data / "terminal-data").read_bytes()
        old_config = terminal_config.joinpath("foot.ini").read_bytes()
        terminal_v2 = json.loads(terminal.joinpath("manifest.json").read_text())
        terminal_v2["version"] = "2.0.0"
        terminal_v2["launch"]["arguments"] = [
            "--title=Managed third-party terminal", "/bin/sh", "-c",
            'test "$(cat "$XDG_DATA_HOME/terminal-data")" = "$XDG_DATA_HOME" && '
            'printf verified > "$XDG_DATA_HOME/upgrade-check"; sleep 2',
        ]
        terminal.joinpath("manifest.json").write_text(json.dumps(terminal_v2))
        replacement = run("replace", terminal, terminal_digest).stdout.split()[1]
        shell_result = subprocess.run([compositor, ui, str(Path("desktop/tests/bundle-shell.mjs").resolve()), "bundles", "initial"],
                                      env=dict(environment, XDG_RUNTIME_DIR=str(runtime), WLR_BACKENDS="headless",
                                               WLR_HEADLESS_OUTPUTS="2", WLR_RENDERER="pixman", SDL_VIDEODRIVER="wayland",
                                               PU_RENDERER=os.environ.get("PU_RENDERER", "raster")),
                                      capture_output=True, text=True, timeout=30)
        output = shell_result.stdout + shell_result.stderr
        assert shell_result.returncode == 0 and "PASS: managed bundle launches through the native Shell catalog" in output, output
        assert not any(word in output for word in ("FAIL:", "Uncaught", "AddressSanitizer", "LeakSanitizer", "runtime error:")), output
        assert (terminal_data / "upgrade-check").read_text() == "verified"
        assert (terminal_data / "terminal-data").read_bytes() == old_data
        assert terminal_config.joinpath("foot.ini").read_bytes() == old_config
        run("rollback", "org.example.foot", replacement)
        assert (terminal_data / "terminal-data").read_bytes() == old_data
        print("PASS: third-party bundle revision keeps its actual XDG configuration and existing data across update/rollback")

    # All retained immutable version directories are owned by this fixture.
    for current, directories, files in os.walk(root):
        with contextlib.suppress(OSError): Path(current).chmod(0o700)
        for filename in files:
            file = Path(current) / filename
            if not file.is_symlink():
                with contextlib.suppress(OSError): file.chmod(0o600)
