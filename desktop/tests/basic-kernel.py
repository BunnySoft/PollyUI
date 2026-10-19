#!/usr/bin/env python3
"""Real tiny .deb/archive identity tests; make/compiler boundaries are explicitly synthetic."""
import copy
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
tools = runpy.run_path(str(REPO / "desktop/release/debian/basic-kernel.py"))
fixtures = runpy.run_path(str(Path(__file__).with_name("live-profiles.py")))
display = runpy.run_path(str(REPO / "desktop/release/debian/live-display.py"))
profiles = fixtures["profiles"]


def pack(directory, *, config=fixtures["BASIC_CONFIG"], architecture="amd64", extra_kernel=False, unsafe=False):
    stage = directory / "payload"
    (stage / "DEBIAN").mkdir(parents=True)
    release = "6.12.111-polly-basic"
    (stage / "DEBIAN/control").write_text(
        f"Package: linux-image-{release}\nVersion: 1.0\nArchitecture: {architecture}\n"
        "Maintainer: Fixture <fixture@example.invalid>\nDescription: non-bootable synthetic kernel fixture\n")
    (stage / "boot").mkdir()
    (stage / "boot" / ("vmlinuz-" + release)).write_bytes(b"not-a-kernel")
    (stage / "boot" / ("config-" + release)).write_text(config)
    modules = stage / "lib/modules" / release / "kernel/drivers/gpu/drm/tiny"
    modules.mkdir(parents=True)
    (modules / "simpledrm.ko").write_bytes(b"not-a-loadable-module")
    if extra_kernel:
        (stage / "boot/vmlinuz-other").write_bytes(b"extra")
    directory.mkdir(exist_ok=True)
    subprocess.run(["dpkg-deb", "--build", "--root-owner-group", str(stage), str(directory / "kernel-image.deb")],
                   check=True, stdout=subprocess.DEVNULL)
    if unsafe:
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            entry = tarfile.TarInfo("../escape")
            entry.size = 1
            archive.addfile(entry, io.BytesIO(b"x"))
        # Replace the data archive via standard ar, preserving a real Debian control member.
        (directory / "data.tar").write_bytes(stream.getvalue())
        subprocess.run(["ar", "d", str(directory / "kernel-image.deb"), "data.tar.xz"], check=True)
        subprocess.run(["ar", "r", str(directory / "kernel-image.deb"), str(directory / "data.tar")], check=True,
                       stdout=subprocess.DEVNULL)
    shutil.rmtree(stage)
    (directory / "kernel.config").write_text(config)
    value = fixtures["basic_receipt"]()
    for key in ("packManifestSha256", "imageSha256"):
        value.pop(key)
    value["package"].update({"architecture": architecture, "size": (directory / "kernel-image.deb").stat().st_size,
                             "sha256": tools["digest"](directory / "kernel-image.deb")})
    value["configSha256"] = tools["digest"](directory / "kernel.config")
    (directory / "kernel-pack.json").write_text(json.dumps(value, indent=2) + "\n")
    return value


class BasicKernel(unittest.TestCase):
    def test_actual_deb_config_arch_single_kernel_path_and_raw_hash_guards(self):
        for mode in ("valid", "stock", "simplefb", "builtin", "arch", "multiple", "unsafe", "changed", "linked",
                     "missing-module", "trusted", "revocation", "module-key", "unsigned-modules"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                config = fixtures["BASIC_CONFIG"]
                if mode == "stock":
                    config = config.replace("CONFIG_DRM_SIMPLEDRM=m", "# CONFIG_DRM_SIMPLEDRM is not set")
                if mode == "simplefb":
                    config += "CONFIG_FB_SIMPLE=y\n"
                if mode == "builtin":
                    config += "CONFIG_DRM_I915=y\n"
                for broken, symbol in (("trusted", "SYSTEM_TRUSTED_KEYS"), ("revocation", "SYSTEM_REVOCATION_KEYS")):
                    if mode == broken:
                        config = config.replace("CONFIG_" + symbol + '=""', "CONFIG_" + symbol + '="debian/missing.pem"')
                if mode == "module-key":
                    config = config.replace("certs/signing_key.pem", "debian/missing-key.pem")
                if mode == "unsigned-modules":
                    config = config.replace("CONFIG_MODULE_SIG_ALL=y", "# CONFIG_MODULE_SIG_ALL is not set")
                pack(directory, config=config, architecture="arm64" if mode == "arch" else "amd64",
                     extra_kernel=mode == "multiple", unsafe=mode == "unsafe")
                if mode == "changed":
                    with (directory / "kernel-image.deb").open("ab") as target:
                        target.write(b"tampered")
                if mode == "linked":
                    data = directory / "config-original"
                    (directory / "kernel.config").rename(data)
                    (directory / "kernel.config").symlink_to(data.name)
                if mode == "missing-module":
                    subprocess.run(["dpkg-deb", "-x", str(directory / "kernel-image.deb"), str(directory / "unpack")], check=True)
                    subprocess.run(["dpkg-deb", "-e", str(directory / "kernel-image.deb"), str(directory / "unpack/DEBIAN")], check=True)
                    (directory / "unpack/lib/modules/6.12.111-polly-basic/kernel/drivers/gpu/drm/tiny/simpledrm.ko").unlink()
                    subprocess.run(["dpkg-deb", "--build", "--root-owner-group", str(directory / "unpack"),
                                    str(directory / "kernel-image.deb")], check=True, stdout=subprocess.DEVNULL)
                    value = json.loads((directory / "kernel-pack.json").read_text())
                    value["package"].update({"size": (directory / "kernel-image.deb").stat().st_size,
                                             "sha256": tools["digest"](directory / "kernel-image.deb")})
                    (directory / "kernel-pack.json").write_text(json.dumps(value))
                if mode == "valid":
                    result = tools["verify_pack"](directory)
                    self.assertEqual(result["imageSha256"], fixtures["basic_receipt"]()["imageSha256"])
                    self.assertEqual(result["kernelRelease"], "6.12.111-polly-basic")
                else:
                    with self.assertRaises((ValueError, KeyError)):
                        tools["verify_pack"](directory)

    def test_real_archive_and_build_control_without_compiling_a_kernel(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            inputs = directory / "pack-input"
            inputs.mkdir()
            pack(inputs)
            config = directory / "base.config"
            config.write_text('CONFIG_DRM=m\n# CONFIG_DRM_SIMPLEDRM is not set\n'
                              'CONFIG_SYSTEM_TRUSTED_KEYS="debian/missing-certs.pem"\n'
                              'CONFIG_SYSTEM_REVOCATION_KEYS="debian/missing-revocation.pem"\n'
                              'CONFIG_MODULE_SIG=y\nCONFIG_MODULE_SIG_FORCE=y\n'
                              '# CONFIG_MODULE_SIG_ALL is not set\n'
                              'CONFIG_MODULE_SIG_KEY="debian/missing-key.pem"\n')
            source_dir = directory / "linux-fixture"
            (source_dir / "scripts").mkdir(parents=True)
            (source_dir / "Makefile").write_text("# not a real kernel\n")
            (source_dir / "scripts/config").write_text("# boundary fixture\n")
            source = directory / "source.tar"
            with tarfile.open(source, "w") as archive:
                archive.add(source_dir, arcname="linux-fixture")
            real_run = subprocess.run
            calls = []

            def make(command, **kwargs):
                if command[0] == "make":
                    calls.append(command)
                    obj = Path(next(arg[2:] for arg in command if arg.startswith("O=")))
                    if "kernelrelease" in command:
                        return subprocess.CompletedProcess(command, 0, stdout=b"6.12.111-polly-basic\n")
                    if "bindeb-pkg" in command:
                        shutil.copyfile(inputs / "kernel-image.deb", obj.parent / "linux-image-fixture.deb")
                    return subprocess.CompletedProcess(command, 0)
                if command[0].endswith("/scripts/config"):
                    calls.append(command)
                    Path(command[command.index("--file") + 1]).write_text(fixtures["BASIC_CONFIG"])
                    return subprocess.CompletedProcess(command, 0)
                return real_run(command, **kwargs)

            output = directory / "built-pack"
            with mock.patch.object(subprocess, "run", side_effect=make):
                receipt = tools["build"](source, tools["digest"](source), config, tools["digest"](config), output, 2)
            self.assertEqual(receipt["source"]["archiveSha256"], tools["digest"](source))
            self.assertEqual(receipt["source"]["baseConfigSha256"], tools["digest"](config))
            self.assertEqual([command[-1] for command in calls if command[0] == "make" and "olddefconfig" in command],
                             ["olddefconfig", "olddefconfig"])
            self.assertTrue(any("bindeb-pkg" in command for command in calls))
            configure = next(command for command in calls if command[0].endswith("/scripts/config"))
            for symbol, expected in (("SYSTEM_TRUSTED_KEYS", ""), ("SYSTEM_REVOCATION_KEYS", ""),
                                     ("MODULE_SIG_KEY", "certs/signing_key.pem")):
                index = configure.index(symbol)
                self.assertEqual(configure[index - 1], "--set-str")
                self.assertEqual(configure[index + 1], expected)
            self.assertEqual(configure[configure.index("MODULE_SIG_ALL") - 1], "--enable")
            self.assertEqual((output / "kernel.config").read_text(), fixtures["BASIC_CONFIG"])
            self.assertEqual(receipt["configSha256"], tools["digest"](output / "kernel.config"))
            self.assertFalse(list(output.rglob("signing_key.pem")))
            self.assertEqual(len(list(output.glob("*.deb"))), 1)
            self.assertTrue((output / "kernel-build.log").is_file())
            with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
                tools["build"](source, "0" * 64, config, tools["digest"](config), directory / "wrong", 2)
            hostile = directory / "hostile.tar"
            with tarfile.open(hostile, "w") as archive:
                entry = tarfile.TarInfo("../escape")
                entry.size = 1
                archive.addfile(entry, io.BytesIO(b"x"))
            with self.assertRaisesRegex(ValueError, "Unsafe export"):
                tools["build"](hostile, tools["digest"](hostile), config, tools["digest"](config), directory / "unsafe", 2)
            self.assertFalse((directory / "escape").exists())
            keyed = directory / "source-with-key.tar"
            with tarfile.open(keyed, "w") as archive:
                archive.add(source_dir, arcname="linux-fixture")
                entry = tarfile.TarInfo("linux-fixture/certs/signing_key.pem")
                entry.size = 0
                archive.addfile(entry, io.BytesIO(b""))
            with self.assertRaisesRegex(ValueError, "must not contain a pre-existing private signing key"):
                tools["build"](keyed, tools["digest"](keyed), config, tools["digest"](config),
                               directory / "keyed-pack", 2)
            with mock.patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(["make"], 2)):
                with self.assertRaises(subprocess.CalledProcessError) as raised:
                    tools["build"](source, tools["digest"](source), config, tools["digest"](config),
                                   directory / "failed-build", 2)
            self.assertEqual(len(list(directory.glob("failed-build.failed-*.log"))), 1)
            self.assertTrue(any("raw log retained" in note for note in raised.exception.__notes__))
            rejected = directory / "rejected-pack"
            with mock.patch.object(subprocess, "run", side_effect=make), \
                    mock.patch.dict(tools["build"].__globals__,
                                    {"verify_pack": mock.Mock(side_effect=ValueError("injected final pack rejection"))}):
                with self.assertRaisesRegex(ValueError, "^injected final pack rejection$"):
                    tools["build"](source, tools["digest"](source), config, tools["digest"](config), rejected, 2)
            self.assertFalse(rejected.exists())
            failures = list(directory.glob("rejected-pack.failed-*.log"))
            self.assertEqual(len(failures), 1)
            text = failures[0].read_text()
            self.assertIn("bindeb-pkg", text)
            self.assertIn("olddefconfig", text)
            self.assertIn("ValueError: injected final pack rejection", text)
            self.assertNotIn("BEGIN PRIVATE KEY", text)
            print("PASS: real local .deb and archive identities; standard kernel make control is mocked, not compiled")

    def test_simpledrm_primary_kms_detection_and_visible_refusal_not_framebuffer_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixtures["seed"](root, "basic")
            cmdline = root / "proc/cmdline"
            cmdline.parent.mkdir()
            args = profiles["profile"]("basic")["displayPolicy"]["kernelArguments"]
            cmdline.write_text(" ".join(args))
            drm = root / "sys/class/drm"
            drm.mkdir(parents=True)
            card = drm / "card0"
            (card / "device").mkdir(parents=True)
            driver = root / "sys/bus/platform/drivers/simple-framebuffer"
            driver.mkdir(parents=True)
            (card / "device/driver").symlink_to(driver)
            (card / "dev").write_text("226:0\n")
            connector = drm / "card0-Unknown-1"
            connector.mkdir()
            (connector / "status").write_text("connected\n")
            (connector / "modes").write_text("1024x768\n")
            device = root / "dev/dri/card0"
            device.parent.mkdir(parents=True)
            # No host device is opened; this private stat result represents the inspected primary node.
            original_stat = Path.stat

            def fake_stat(path, **kwargs):
                if path == device:
                    return type("Device", (), {"st_mode": stat.S_IFCHR | 0o660, "st_rdev": os.makedev(226, 0)})()
                return original_stat(path, **kwargs)

            with mock.patch.object(Path, "stat", fake_stat):
                self.assertEqual(display["selection"](root, "baseline", "auto"), "/dev/dri/card0")
                for mode, gpu in (("gpu", "auto"), ("baseline", "intel"), ("baseline", "amd")):
                    with self.assertRaisesRegex(ValueError, "software-only"):
                        display["selection"](root, mode, gpu)
                (connector / "status").write_text("disconnected\n")
                with self.assertRaisesRegex(ValueError, "no connected KMS"):
                    display["selection"](root, "baseline", "auto")
                (connector / "status").write_text("connected\n")
                (drm / "card1").mkdir()
                with self.assertRaisesRegex(ValueError, "exactly one"):
                    display["selection"](root, "baseline", "auto")
                (drm / "card1").rmdir()
                (card / "device/driver").unlink()
                other = root / "sys/bus/pci/drivers/i915"
                other.mkdir(parents=True)
                (card / "device/driver").symlink_to(other)
                with self.assertRaisesRegex(ValueError, "native takeover"):
                    display["selection"](root, "baseline", "auto")
            print("PASS: basic selects a unique real-KMS-shaped simple-framebuffer node; no fb0/headless success path")

    def test_generated_grub_has_only_basic_blocklist_and_no_acceleration_or_nomodeset(self):
        template = (REPO / "desktop/release/debian/live-grub.cfg").read_text()
        for sku in fixtures["SKUS"]:
            cfg = profiles["grub_configuration"](template, "a" * 32, sku)
            if sku == "basic":
                self.assertNotIn("polly.mode=gpu", cfg)
                self.assertNotIn("nomodeset", cfg)
                for line in cfg.splitlines():
                    if "polly_start console=" in line:
                        for argument in profiles["profile"](sku)["displayPolicy"]["kernelArguments"]:
                            self.assertIn(argument, line)
            else:
                self.assertNotIn("module_blacklist", cfg)
            with tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "grub.cfg"
                path.write_text(cfg)
                subprocess.run(["grub-script-check", str(path)], check=True)

    def test_actual_bootstrap_loads_required_simpledrm_without_splash_before_media_discovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("bin", "etc", "dev", "proc", "sys/class/block", "run", "tmp", "media", "newroot", "usr/lib"):
                (root / name).mkdir(parents=True, exist_ok=True)
            shutil.copyfile(shutil.which("busybox"), root / "bin/busybox")
            (root / "bin/busybox").chmod(0o755)
            fixtures["root_tools"]["copy_elf"]("dash", root, "bin/sh")
            for name in ("chmod", "cat", "cp", "mkdir", "tr", "id", "stat", "readlink", "timeout", "rm"):
                (root / "bin" / name).symlink_to("busybox")
            for name, body in (
                    ("mount", "exit 0\n"), ("mdev", "exit 0\n"),
                    ("modprobe", 'printf "%s\\n" "$1" >>/loaded-modules\n'),
                    ("sleep", 'printf media-discovery-reached >/stopped\nkill -KILL "$PPID"\n')):
                path = root / "bin" / name
                path.write_text("#!/bin/busybox sh\n" + body)
                path.chmod(0o755)
            (root / "dev/console").write_bytes(b"")
            (root / "proc/uptime").write_text("1.0 1.0\n")
            (root / "proc/cmdline").write_text("polly.media_uuid=fixture-uuid polly.media_id=fixture-id\n")
            (root / "etc/polly-live-root").write_text("POLLY_MEDIA_ID=fixture-id\nPOLLY_ROOT_SHA256=fixture\nPOLLY_ROOT_BYTES=1\n")
            (root / "etc/polly-live-modules").write_text("loop\n")
            (root / "etc/polly-live-graphics-modules").write_text("simpledrm\n")
            (root / "etc/polly-live-graphics-required").write_text("simpledrm\n")
            shutil.copyfile(REPO / "desktop/release/debian/live-splash-control", root / "usr/lib/polly-live-splash-control")
            shutil.copyfile(REPO / "desktop/release/debian/live-bootstrap", root / "init")
            result = subprocess.run(["chroot", str(root), "/bin/sh", "/init"],
                                    capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((root / "loaded-modules").is_file(),
                            result.stderr + "\n" + (root / "dev/console").read_text())
            self.assertEqual((root / "loaded-modules").read_text().splitlines(), ["loop", "simpledrm"])
            self.assertEqual((root / "stopped").read_text(), "media-discovery-reached")
            self.assertFalse((root / "run/polly-live/splash-started").exists())
            print("PASS: actual bootstrap no-splash path loads simpledrm before discovery; mounts/modules are private stubs")


if __name__ == "__main__":
    unittest.main(verbosity=2)
