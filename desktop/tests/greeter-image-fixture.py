"""Synthetic guest-root resources for source assembly tests, never boot/PAM proof."""
import json
from pathlib import Path


def seed(root, builder, repo):
    profile = root / "etc/polly-account-profile"
    if not profile.exists():
        profile.write_text("installed\n")
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
    power = builder.power_policy
    with (root / "etc/passwd").open("a") as target:
        target.write("polkitd:x:990:990::/nonexistent:/usr/sbin/nologin\n")
    (root / "usr/share/polkit-1/rules.d").mkdir(parents=True, exist_ok=True)
    for source, destination in power.RESOURCES:
        path = root / destination
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((repo / "desktop/release/debian" / source).read_bytes().replace(b"\r\n", b"\n"))
        path.chmod(0o644)
    for name, content, mode in (
        ("usr/lib/polkit-1/polkitd", "synthetic source-layout daemon; never launched\n", 0o755),
        ("usr/lib/systemd/system/polkit.service", "[Service]\nType=notify-reload\nUser=polkitd\n"
         "ExecStart=/usr/lib/polkit-1/polkitd --no-debug --log-level=notice\n"
         "BusName=org.freedesktop.PolicyKit1\n", 0o644),
        ("usr/share/dbus-1/system-services/org.freedesktop.PolicyKit1.service",
         "[D-BUS Service]\nName=org.freedesktop.PolicyKit1\nSystemdService=polkit.service\n", 0o644),
        ("usr/share/polkit-1/actions/org.freedesktop.login1.policy",
         '<policyconfig><action id="org.freedesktop.login1.power-off"/>'
         '<action id="org.freedesktop.login1.reboot"/></policyconfig>\n', 0o644),
    ):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        path.chmod(mode)
    power_contract = json.loads((repo / "desktop/release/debian/power-dependencies.json").read_text())
    packages.update({name: "synthetic-source-fixture" for name in power_contract["requiredPackages"]})
    packages.update({package["name"]: package["version"] for package in power_contract["newPackages"]})
    (root / "usr/share/polly-installed-packages.tsv").write_text("".join(
        name + "\t" + version + "\tfixture:source-layout-only\n" for name, version in packages.items()))
