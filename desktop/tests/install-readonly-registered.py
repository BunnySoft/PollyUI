#!/usr/bin/env python3
"""Private rootless-container staging for the test-macro QuickJS transport only."""
import argparse
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transport", type=Path)
    args = parser.parse_args()
    if os.getuid() != 0 or os.geteuid() != 0 or not Path("/run/.containerenv").exists() or \
            not Path("/run/polly-readonly-private-fixture").is_file():
        raise RuntimeError("Registered transport fixture requires explicit private rootless-container staging")
    for path in ("/run", "/usr/lib/pollyui", "/usr/share/pollyui"):
        info = Path(path).lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
            raise RuntimeError("Private fixture deployment directories require trusted 0755 metadata")
        record = subprocess.run(["/usr/bin/findmnt", "-rn", "-M", path, "-o", "FSTYPE"],
                                check=True, capture_output=True, text=True, timeout=5)
        if record.stdout.strip() != "tmpfs":
            raise RuntimeError("Registered fixture requires private tmpfs deployment mounts")
    if not args.transport.is_absolute() or not args.transport.is_file():
        raise ValueError("Expected the absolute built transport-fixture target")
    target = Path("/tmp/install-readonly-native")
    if target.exists() or target.is_symlink():
        raise ValueError("Refusing to overwrite an existing private transport fixture binary")
    with args.transport.open("rb") as source, target.open("xb") as destination:
        shutil.copyfileobj(source, destination)
    target.chmod(0o755)
    fixture = Path(__file__).with_name("install-readonly-fixture.py")
    # Root only prepares synthetic deployment. The fixture drops every acquisition to UID1000.
    subprocess.run([sys.executable, "-I", "-B", str(fixture)], check=True, timeout=110)


if __name__ == "__main__":
    main()
