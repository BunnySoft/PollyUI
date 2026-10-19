#!/usr/bin/env python3
"""Execute the actual SKU constructor; only external ELF/module boundaries are fixtures."""
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
fixtures = runpy.run_path(str(Path(__file__).with_name("live-profiles.py")))
roots, profiles, verify = fixtures["root_tools"], fixtures["profiles"], fixtures["verify"]


class BootstrapConstructor(unittest.TestCase):
    def test_real_constructor_verifies_profile_writes_marker_and_packs_cpio_for_all_skus(self):
        constructor = roots["build_bootstrap"]
        configuration = "\n".join(name + "=y" for name in (
            "CONFIG_DEVTMPFS", "CONFIG_TMPFS", "CONFIG_PROC_FS", "CONFIG_SYSFS",
            "CONFIG_EFI_PARTITION", "CONFIG_MSDOS_PARTITION", "CONFIG_VT",
            "CONFIG_VT_CONSOLE", "CONFIG_FB_EFI", "CONFIG_FRAMEBUFFER_CONSOLE"))
        real_output = subprocess.check_output
        real_run = subprocess.run
        depmod_calls = []

        def output(command, **kwargs):
            if command[0] == "modinfo":
                return ""
            return real_output(command, **kwargs)

        def run(command, **kwargs):
            if command[0] == "depmod":
                depmod_calls.append(command)
                return subprocess.CompletedProcess(command, 0)
            return real_run(command, **kwargs)

        for sku in ("full", "vm", "intel", "nvidia"):
            with self.subTest(sku=sku), tempfile.TemporaryDirectory(prefix="polly-real-constructor-") as temp:
                directory = Path(temp)
                root, stage, boot = [directory / name for name in ("root", "stage", "boot")]
                stage.mkdir()
                boot.mkdir()
                fixtures["seed"](root, sku)
                (root / "usr/sbin").mkdir(parents=True)
                (root / "usr/sbin/blkid").write_bytes(b"external blkid ELF-copy boundary fixture")
                module_dir = root / "usr/lib/modules/fixture-kernel"
                module_dir.mkdir(parents=True)
                module = module_dir / "fixture.ko"
                module.write_bytes(b"external module-copy boundary fixture, not a loadable module")
                for name in ("modules.builtin", "modules.builtin.modinfo", "modules.order"):
                    (module_dir / name).write_bytes(b"")
                squashfs = boot / "root.squashfs"
                squashfs.write_bytes(b"external compressed-root input fixture; never booted")
                depmod_calls.clear()
                with mock.patch.dict(constructor.__globals__, {
                        "copy_root_elf": mock.Mock(return_value={}),
                        "copy_plymouth": mock.Mock(return_value=[]),
                        "module_closure": mock.Mock(return_value=[module])}), \
                        mock.patch.object(subprocess, "check_output", side_effect=output), \
                        mock.patch.object(subprocess, "run", side_effect=run):
                    result = constructor(root, stage, boot, REPO, "fixture-kernel", configuration,
                                         "a" * 32, squashfs, sku)
                    self.assertEqual(len(depmod_calls), 1)
                    bad_stage, bad_boot = directory / "bad-stage", directory / "bad-boot"
                    bad_stage.mkdir()
                    bad_boot.mkdir()
                    (root / profiles["MARKER"]).write_bytes(b"{}\n")
                    with self.assertRaisesRegex(ValueError, "Hardware profile metadata/source mismatch"):
                        constructor(root, bad_stage, bad_boot, REPO, "fixture-kernel", configuration,
                                    "a" * 32, squashfs, sku)
                    self.assertFalse((bad_boot / "initramfs.gz").exists())
                selected = profiles["profile"](sku)
                self.assertEqual(result["hardwareProfile"],
                                 {key: selected[key] for key in ("sku", "manifestSha256")})
                record = next(item for item in result["bootstrap"]["files"]
                              if item["path"] == "etc/polly-live-hardware")
                self.assertEqual(record["sha256"], roots["hashlib"].sha256(profiles["marker"](sku)).hexdigest())
                self.assertEqual(record["mode"], 0o100644)
                self.assertEqual(result["sha256"], roots["digest"](squashfs))
                verify["check_bootstrap"](boot / "initramfs.gz", result)
                self.assertFalse((stage / "bootstrap").exists())
                self.assertLessEqual(result["bootstrap"]["uncompressedBytes"], roots["MAX_BOOTSTRAP_BYTES"])
                print("PASS: actual build_bootstrap constructor + profile verification + marker/cpio for", sku)


if __name__ == "__main__":
    unittest.main(verbosity=2)
