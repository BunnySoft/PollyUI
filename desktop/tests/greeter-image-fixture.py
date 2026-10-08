"""Synthetic guest-root resources for source assembly tests, never boot/PAM proof."""
import json
from pathlib import Path


def seed(root, builder, repo):
    for source, destination, mode in builder.GREETER_RESOURCES:
        path = root / destination
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((repo / "desktop/session" / source).read_bytes().replace(b"\r\n", b"\n"))
        path.chmod(mode)
    for name, line in (
        ("passwd", "polly-greeter:x:991:991::/nonexistent:/usr/sbin/nologin\n"),
        ("shadow", "polly-greeter:!:20000:0:99999:7:::\n"),
        ("group", "polly-greeter:x:991:\n"),
    ):
        with (root / "etc" / name).open("a") as target:
            target.write(line)
    daemon = root / "usr/sbin/greetd"
    daemon.parent.mkdir(parents=True, exist_ok=True)
    daemon.write_text("synthetic source-layout executable placeholder; never launched\n")
    daemon.chmod(0o755)
    contract = json.loads((repo / "desktop/session/greeter-dependencies.json").read_text())
    packages = {name: "synthetic-source-fixture" for name in contract["requiredPackages"]}
    packages.update({package["name"]: package["version"] for package in contract["newPackages"]})
    (root / "usr/share/polly-installed-packages.tsv").write_text("".join(
        name + "\t" + version + "\tfixture:source-layout-only\n" for name, version in packages.items()))
