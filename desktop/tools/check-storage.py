#!/usr/bin/env python3
"""Fast source/unit validation; deliberately does not build or boot an image."""
import argparse
import ast
from pathlib import Path
import subprocess
import tempfile
import time


def run(label, arguments):
    started = time.monotonic()
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(label + " failed:\n" + result.stdout + result.stderr)
    print(f"PASS {label} ({time.monotonic() - started:.2f}s)", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
    started = time.monotonic()
    python_files = [
        "desktop/release/install/accounts.py", "desktop/release/storage/layout.py",
        "desktop/release/storage/homes.py",
        "desktop/release/storage/identities.py",
        "desktop/release/storage/migrate-home.py",
        "desktop/release/storage/migrate-accounts.py",
        "desktop/release/storage/storage.py", "desktop/tools/build-installed-image.py",
        "desktop/tools/build-storage-image.py", "desktop/tests/persistent-boot.py",
        "desktop/tools/check-storage.py",
        "desktop/tools/polly-plan.py",
        "desktop/tests/account-auth-fixture.py",
        "desktop/tests/storage-account-migration-fixture.py",
        "desktop/tests/account-profile-fixture.py",
        "desktop/tests/storage-managed-migration-fixture.py",
    ]
    for name in python_files:
        ast.parse((repo / name).read_text(), filename=name)
    print("PASS Python syntax", flush=True)
    with tempfile.TemporaryDirectory(prefix="polly-storage-fast-") as temporary:
        temporary = Path(temporary)
        for name in ("desktop/release/install/session", "desktop/release/storage/early-usr",
                     "desktop/release/storage/initramfs-hook", "desktop/tools/build-storage.sh",
                     "desktop/tools/check-storage.sh", "desktop/release/debian/account-profile",
                     "desktop/release/debian/profile-check",
                     "desktop/release/live/session", "desktop/tools/build-live.sh",
                     "desktop/tools/build-installed.sh"):
            script = temporary / "syntax-check"
            script.write_text((repo / name).read_text(), encoding="utf8", newline="\n")
            run("shell syntax: " + name, ["/bin/sh", "-n", str(script)])
        run("passwd proxy C -Werror", [
            "cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Wpedantic", "-Werror",
            "-o", str(temporary / "polly-passwd"),
            str(repo / "desktop/release/install/passwd-proxy.c"),
        ])
    for name in ("installed-image", "installed-accounts", "storage-layout",
                 "storage-mappings", "storage-image", "storage-homes", "storage-home-migration",
                 "storage-identities", "storage-account-migration", "polly-plan", "account-profiles"):
        run(name, ["python3", "-I", "-B", str(repo / f"desktop/tests/{name}.py")])
    print(f"PASS fast storage checks in {time.monotonic() - started:.2f}s "
          "(no image build, no VM, no host devices)", flush=True)


if __name__ == "__main__":
    main()
