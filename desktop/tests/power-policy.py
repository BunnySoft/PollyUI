#!/usr/bin/env python3
"""Small source/resource qualification cases; no daemon, package install, images or power calls."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


builder = load("power_image_builder", REPO / "desktop/tools/build-installed-image.py")
fixture = load("power_image_seed", Path(__file__).with_name("greeter-image-fixture.py"))
policy = builder.power_policy


class PowerPackaging(unittest.TestCase):
    def setUp(self):
        if os.getuid() != 0 or not Path("/run/.containerenv").is_file():
            raise RuntimeError("Run only as the private root-container source-fixture coordinator")
        temporary = tempfile.TemporaryDirectory(prefix="polly-power-source-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "etc").mkdir()
        for name, contents in (("passwd", "root:x:0:0::/root:/bin/sh\npolly:x:1000:1000::/home/polly:/bin/sh\n"),
                               ("group", "root:x:0:\npolly:x:1000:\n"),
                               ("shadow", "root:!:::::::\npolly:!:::::::\n")):
            (self.root / "etc" / name).write_text(contents)
        fixture.seed(self.root, builder, REPO)
        self.inventory = "usr/share/polly-installed-packages.tsv"

    def qualify(self):
        return policy.qualify(self.root, REPO, self.inventory)

    def test_both_profiles_inherit_the_same_exact_standard_resources(self):
        for profile in ("live", "installed", "template"):
            (self.root / "etc/polly-account-profile").write_text(profile + "\n")
            self.assertEqual(self.qualify()["newPackages"][0], {"name": "polkitd", "version": "126-2"})
        live = (REPO / "desktop/release/debian/Containerfile.live").read_text().split("FROM platform-base AS live-base")[0]
        self.assertIn("polkitd=126-2", live)
        self.assertIn("COPY release/debian/00-polly-power.rules", live)
        installed = (REPO / "desktop/release/debian/Containerfile.install").read_text()
        self.assertIn("FROM ${PLATFORM_IMAGE}", installed)
        self.assertIn("dpkg-query -W -f='${Version}' polkitd", installed)
        offline = (REPO / "desktop/release/debian/Containerfile.profiles").read_text()
        self.assertIn("dpkg-query -W -f='${Version}' polkitd", offline)
        self.assertNotIn("apt-get", offline)
        self.assertIn('power_policy.qualify(root, repo, "usr/share/polly-installed-packages.tsv")',
                      (REPO / "desktop/tools/build-installed-image.py").read_text())
        bus = ET.fromstring((REPO / "desktop/release/debian/live-power.conf").read_text())
        denies = {item.attrib["send_member"] for item in bus.findall("policy/deny")}
        self.assertTrue({"Suspend", "Hibernate", "HybridSleep", "SuspendThenHibernate",
                         "PowerOffWithFlags", "RebootWithFlags", "SetRebootToFirmwareSetup"}.issubset(denies))
        self.assertTrue({"CanPowerOff", "CanReboot", "PowerOff", "Reboot"}.isdisjoint(denies))
        self.assertEqual(bus.find("policy").attrib, {"user": "polly"})
        self.assertFalse(bus.findall("policy/allow"), "no blanket D-Bus permission replaces daemon authorization")

    def test_missing_dependency_old_version_or_optional_executor_is_refused(self):
        path = self.root / self.inventory
        original = path.read_text()
        for text in (original.replace("polkitd\t126-2", "polkitd\t125-1"),
                     "\n".join(line for line in original.splitlines() if not line.startswith("polkitd\t")),
                     original + "pkexec\t126-2\tfixture\n"):
            with self.subTest(inventory=text):
                path.write_text(text)
                with self.assertRaises(ValueError):
                    self.qualify()

    def test_untrusted_or_shadowed_rule_cannot_be_published_as_authorized(self):
        path = self.root / "etc/polkit-1/rules.d/00-polly-power.rules"
        original = path.read_bytes()
        for content, mode in ((original + b"polkit.addRule(function(){return 'yes';});\n", 0o644),
                              (original, 0o666)):
            path.write_bytes(content)
            path.chmod(mode)
            with self.assertRaises(ValueError):
                self.qualify()
        path.write_bytes(original)
        path.chmod(0o644)
        earlier = path.with_name("00-before-polly.rules")
        earlier.write_text("synthetic rule that would run first\n")
        with self.assertRaises(ValueError):
            self.qualify()


if __name__ == "__main__":
    unittest.main()
