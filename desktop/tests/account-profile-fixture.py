#!/usr/bin/env python3
"""Real factory/Live/PAM separation in disposable locked-account containers."""
import argparse
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("mode", choices=("installed", "live", "recovery"))
    args = parser.parse_args()
    if os.geteuid() != 0 or not Path("/run/.containerenv").exists():
        raise RuntimeError("Profile fixture refuses non-container or non-root operation")
    spec = importlib.util.spec_from_file_location("profile_auth", args.repo / "desktop/tests/account-auth-fixture.py")
    auth = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(auth)
    helper = args.repo / "desktop/release/debian/account-profile"
    guard = Path("/usr/lib/polly-account-profile-check")
    guard.write_text((args.repo / "desktop/release/debian/profile-check").read_text(),
                     encoding="utf8", newline="\n")
    guard.chmod(0o755)
    before = Path("/etc/shadow").read_bytes()
    profile = Path("/etc/polly-account-profile")
    if profile.exists() or profile.is_symlink():
        raise RuntimeError("Fixture requires a legacy locked base without a profile")

    def prepare(mode, success=True):
        result = subprocess.run(["/bin/sh", str(helper), mode], capture_output=True, text=True, timeout=20)
        if (result.returncode == 0) != success:
            raise RuntimeError("Profile operation disagreed with expected qualification: " + result.stderr)
        return result

    prepare("template")
    if Path("/etc/shadow").read_bytes() != before:
        raise RuntimeError("Preparing factory metadata changed credentials")
    prepare(args.mode)
    if profile.read_text() != args.mode + "\n":
        raise RuntimeError("Expected profile was not published")

    def check(expected, accepted, uid=1000):
        result = subprocess.run([str(guard), expected], user=uid, group=uid, extra_groups=[],
                                capture_output=True, text=True, timeout=10)
        if (result.returncode == 0) != accepted:
            raise RuntimeError("Readonly runtime profile guard disagreed with expected result")

    check(args.mode, True)
    for other in {"installed", "live", "recovery"} - {args.mode}:
        check(other, False)
    contents = profile.read_bytes()
    profile.chmod(0o666)
    check(args.mode, False)
    profile.chmod(0o644)
    profile.write_bytes(contents + b"\n")
    check(args.mode, False)
    profile.unlink()
    check(args.mode, False)
    profile.symlink_to("/run/no-such-profile")
    check(args.mode, False)
    profile.unlink()
    profile.write_bytes(contents)
    profile.chmod(0o644)
    check(args.mode, True)
    if args.mode != "live":
        if Path("/etc/shadow").read_bytes() != before:
            raise RuntimeError("Installed template inherited or reset credentials")
        prepare("live", False)
        prepare("recovery" if args.mode == "installed" else "installed", False)
        prepare("template", False)
        if Path("/etc/shadow").read_bytes() != before:
            raise RuntimeError("Rejected cross-profile operation changed factory credentials")
        print("PASS: locked factory -> " + args.mode + "; credential bytes unchanged; Live/template reclassification refused; "
              "ordinary runtime guard rejects missing/mismatched/unsafe/linked profiles")
        return
    for name in ("root", "polly"):
        fields = next(line.split(":") for line in Path("/etc/shadow").read_text().splitlines()
                      if line.startswith(name + ":"))
        if not fields[1].startswith(("$y$", "$6$")):
            raise RuntimeError("Live preset did not publish a usable password")
    for unit in ("ssh.service", "ssh.socket", "sshd.service", "sshd.socket"):
        path = Path("/etc/systemd/system") / unit
        if not path.is_symlink() or os.readlink(path) != "/dev/null":
            raise RuntimeError("Default remote login was not masked")
    auth.root_su("polly")
    auth.root_su("not-the-public-preset", False)
    # The cached installed base has a private passwd proxy; use the exact distro
    # binary as Live does, only inside this disposable fixture.
    if Path("/usr/bin/passwd.distrib").exists():
        shutil.copyfile("/usr/bin/passwd.distrib", "/usr/bin/passwd")
        Path("/usr/bin/passwd").chmod(0o4755)
    token = auth.password()
    auth.success(["/usr/bin/passwd"], ["polly", token, token], 1000)
    after_change = Path("/etc/shadow").read_bytes()
    prepare("live", False)
    prepare("installed", False)
    prepare("recovery", False)
    prepare("template", False)
    if Path("/etc/shadow").read_bytes() != after_change:
        raise RuntimeError("A profile rerun reset an actual changed password")
    result, output = auth.interactive(
        ["/usr/bin/su", "polly", "-s", "/bin/sh", "-c", "/usr/bin/id -u"], [token], 1000)
    if result != 0 or re.search(rb"(?:^|[\r\n])1000(?:[\r\n]|$)", output) is None:
        raise RuntimeError("Changed Live password was not honored by actual PAM")
    result, _ = auth.interactive(
        ["/usr/bin/su", "polly", "-s", "/bin/sh", "-c", "/usr/bin/id -u"], ["polly"], 1000)
    if result == 0:
        raise RuntimeError("Old public user password remained valid after a real password change")
    print("PASS: public Live preset -> real root su/PAM; wrong password refused; ordinary passwd changes retained; "
          "preset reruns and installed conversion refused; default SSH/socket aliases masked; readonly runtime guard")
    print("LIMIT: cached disposable container; no new Live image boot or graphical login acceptance")


if __name__ == "__main__":
    main()
