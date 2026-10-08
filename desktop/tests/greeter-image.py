#!/usr/bin/env python3
"""Source-only guest root/dependency/unit tests; no packages, PAM, services or boot."""
import importlib.util
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import tarfile
import unittest

REPO = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


builder = load("greeter_image_builder", REPO / "desktop/tools/build-installed-image.py")
fixture = load("greeter_image_fixture", Path(__file__).with_name("greeter-image-fixture.py"))


class GreeterImage(unittest.TestCase):
    def setUp(self):
        if os.getuid() != 0 or not Path("/run/.containerenv").is_file():
            raise RuntimeError("Source fixture needs a marked private root-container coordinator")
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "root"
        (self.root / "etc").mkdir(parents=True)
        for name, value in (("passwd", "root:x:0:0::/root:/bin/sh\npolly:x:1000:1000::/home/polly:/bin/sh\n"),
                            ("shadow", "root:!:20000:0:99999:7:::\npolly:!:20000:0:99999:7:::\n"),
                            ("group", "root:x:0:\npolly:x:1000:\n")):
            (self.root / "etc" / name).write_text(value)
        fixture.seed(self.root, builder, REPO)

    def test_graphical_target_reaches_one_manager_and_setup_socket(self):
        builder.qualify_greeter(self.root, REPO)
        builder.configure_graphical_login(self.root)
        units = self.root / "etc/systemd/system"
        self.assertEqual(os.readlink(units / "default.target"), "/usr/lib/systemd/system/graphical.target")
        self.assertEqual(os.readlink(units / "graphical.target.wants/polly-greetd.service"), "../polly-greetd.service")
        self.assertEqual(os.readlink(units / "sockets.target.wants/polly-greeter-setup.socket"), "../polly-greeter-setup.socket")
        for name in ("greetd.service", "display-manager.service", "getty@tty1.service"):
            self.assertEqual(os.readlink(units / name), "/dev/null")
        self.assertNotIn("polly-firstboot", (self.root / builder.GETTY_DROPIN).read_text())
        self.assertFalse((units / "multi-user.target.wants/polly-firstboot.service").exists())
        fallback = (units / "polly-console-fallback.service").read_text()
        self.assertIn("Requires=polly-accounts.service polly-firstboot.service", fallback)
        self.assertIn("ExecStart=/usr/sbin/polly-accounts getty tty1", fallback)
        self.assertIn("Conflicts=polly-greetd.service", fallback)
        self.assertIn("Requires=polly-console-fallback.service", (units / "polly-console.target").read_text())

    def test_missing_or_wrong_greetd_version_refused(self):
        path = self.root / "usr/share/polly-installed-packages.tsv"
        original = path.read_text()
        for value in (original.replace("0.10.3-4", "0.10.3-3"),
                      "\n".join(line for line in original.splitlines() if not line.startswith("greetd\t")),
                      "\n".join(line for line in original.splitlines() if not line.startswith("libpam-systemd\t"))):
            with self.subTest(value=value):
                path.write_text(value)
                with self.assertRaises(ValueError):
                    builder.qualify_greeter(self.root, REPO)

    def test_live_or_linked_factory_profile_refused(self):
        path = self.root / "etc/polly-account-profile"
        path.write_text("live\n")
        with self.assertRaises(ValueError):
            builder.qualify_greeter(self.root, REPO)
        path.unlink()
        path.symlink_to("/dev/null")
        with self.assertRaises(ValueError):
            builder.qualify_greeter(self.root, REPO)

    def test_changed_source_or_executable_mode_refused(self):
        path = self.root / "usr/lib/pollyui/greeter-entry"
        original = path.read_bytes()
        path.write_bytes(original + b"# synthetic mismatch\n")
        with self.assertRaises(ValueError):
            builder.qualify_greeter(self.root, REPO)
        path.write_bytes(original)
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            builder.qualify_greeter(self.root, REPO)

    def test_unlocked_or_administrative_greeter_refused(self):
        shadow = self.root / "etc/shadow"
        original = shadow.read_text()
        shadow.write_text(original.replace("polly-greeter:!", "polly-greeter:synthetic-not-locked"))
        with self.assertRaises(ValueError):
            builder.qualify_greeter(self.root, REPO)
        shadow.write_text(original)
        with (self.root / "etc/group").open("a") as groups:
            groups.write("sudo:x:27:polly-greeter\n")
        with self.assertRaises(ValueError):
            builder.qualify_greeter(self.root, REPO)

    def test_runtime_archive_preserves_executable_entry_but_not_python_authority(self):
        runtime = Path(self.temporary.name) / "runtime"
        for name in ("greeter-entry", "greetd-launch.py"):
            path = runtime / "usr/lib/pollyui" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((REPO / "desktop/session" / name).read_bytes())
        archive = Path(self.temporary.name) / "synthetic-runtime.tar.gz"
        subprocess.run([sys.executable, "-I", "-B", str(REPO / "desktop/tools/package-tar.py"),
                        str(runtime), str(archive)], check=True, timeout=10)
        with tarfile.open(archive) as contents:
            self.assertEqual(contents.getmember("./usr/lib/pollyui/greeter-entry").mode, 0o755)
            self.assertEqual(contents.getmember("./usr/lib/pollyui/greetd-launch.py").mode, 0o644)


if __name__ == "__main__":
    unittest.main()
