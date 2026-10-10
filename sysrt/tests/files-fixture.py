"""Exercise native FileSystem mappings and desktop policy on private real files."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

runner, library = sys.argv[1:]
repo = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="polly-files-sdk-") as temporary:
    home = Path(temporary)
    if os.getuid():
        for run in (0, 8, 1):
            root = home / f"run-{run}"
            root.mkdir(mode=0o700)
            (root / "hello.txt").write_text("Existing text.\n", encoding="utf-8")
            (root / "target").mkdir()
            (root / "folder-link").symlink_to("target")
            (root / "file-link").symlink_to("hello.txt")
            (root / "broken-link").symlink_to("missing")
            (root / "loop-link").symlink_to("loop-link")
            (root / "denied").mkdir(mode=0)
            os.mkfifo(root / "fifo", 0o600)
            (root / "invalid-utf8").write_bytes(b"\xc0\x80")
            (root / "nul-text").write_bytes(b"x\0y")
            (root / "oversized").touch()
            os.truncate(root / "oversized", 1048577)
            (root / "hard-original").write_text("shared", encoding="utf-8")
            os.link(root / "hard-original", root / "hard-other")
            (root / "retiring").mkdir()
            (root / "many").mkdir()
            for index in range(1025):
                (root / "many" / f"entry-{index}").touch()
            (root / "invalid-name").mkdir()
            descriptor = os.open(os.fsencode(root / "invalid-name") + b"/\xff", os.O_CREAT | os.O_WRONLY, 0o600)
            os.close(descriptor)
    for script in (repo / "sysrt" / "tests" / "files.mjs",
                   repo / "desktop" / "tests" / "file-system-service.mjs"):
        subprocess.run([runner, str(script), library],
                       cwd=repo, env={**os.environ, "HOME": str(home)}, check=True, timeout=160)
