"""Fast checks for the Micro Shell QMP screenshot evidence format."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zlib


SOURCE = Path(__file__).resolve().parents[1] / "release/micro/test-shell.py"
SPEC = importlib.util.spec_from_file_location("micro_shell_test", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
INSTALL_SPEC = importlib.util.spec_from_file_location("micro_shell_install", SOURCE.with_name("install-shell.py"))
INSTALL = importlib.util.module_from_spec(INSTALL_SPEC)
INSTALL_SPEC.loader.exec_module(INSTALL)


class ScreenshotTests(unittest.TestCase):
    def convert(self, content, expected_size=(1280, 800)):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "screen.ppm", Path(directory) / "screen.png"
            source.write_bytes(content)
            colors = MODULE.screenshot_png(source, target, expected_size)
            return colors, target.read_bytes()

    def test_png_preserves_rgb_pixels(self):
        row = bytes(range(256)) * 15
        pixels = row * 800
        colors, png = self.convert(b"P6\n1280 800\n255\n" + pixels)
        self.assertGreaterEqual(colors, 64)
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", png[16:24]), (1280, 800))
        position = 8
        compressed = b""
        while position < len(png):
            size = struct.unpack(">I", png[position:position + 4])[0]
            kind = png[position + 4:position + 8]
            payload = png[position + 8:position + 8 + size]
            checksum = struct.unpack(">I", png[position + 8 + size:position + 12 + size])[0]
            self.assertEqual(checksum, zlib.crc32(kind + payload))
            if kind == b"IDAT":
                compressed += payload
            position += size + 12
        self.assertEqual(zlib.decompress(compressed), (b"\0" + row) * 800)

    def test_uniform_screen_is_not_desktop_proof(self):
        with self.assertRaisesRegex(ValueError, "No rendered desktop"):
            self.convert(b"P6\n1280 800\n255\n" + b"\0" * (1280 * 800 * 3))

    def test_wrong_geometry_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "display geometry"):
            self.convert(b"P6\n640 480\n255\n")

    def test_screenshot_matches_the_actual_firmware_modeset(self):
        row = bytes(index % 256 for index in range(640 * 3))
        colors, png = self.convert(b"P6\n640 480\n255\n" + row * 480, (640, 480))
        self.assertGreaterEqual(colors, 64)
        self.assertEqual(struct.unpack(">II", png[16:24]), (640, 480))

    def test_truncated_screen_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Truncated"):
            self.convert(b"P6\n1280 800\n255\nabc")

    def test_non_rgb_ppm_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "RGB PPM"):
            self.convert(b"P5\n1280 800\n255\n")


class ModuleTests(unittest.TestCase):
    def test_product_identity_is_explicit_and_historical_default_is_preserved(self):
        with patch.dict(INSTALL.os.environ, {}, clear=True):
            self.assertEqual(INSTALL.shell_product(), "micro")
        for name in ("micro", "mini"):
            with patch.dict(INSTALL.os.environ, {"MICRO_PRODUCT": name}):
                self.assertEqual(INSTALL.shell_product(), name)
        with patch.dict(INSTALL.os.environ, {"MICRO_PRODUCT": "compact"}):
            with self.assertRaisesRegex(ValueError, "Unknown Alpine Shell product"):
                INSTALL.shell_product()

    def test_boot_modules_accept_only_distinct_module_names(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "modules"
            source.write_text("# basic graphics\nsimpledrm\nxhci_pci\nusbhid\n")
            self.assertEqual(INSTALL.read_boot_modules(source), ["simpledrm", "xhci_pci", "usbhid"])
            for content in ("", "simpledrm\nsimpledrm\n", "--remove\n", "simpledrm extra\n"):
                source.write_text(content)
                with self.assertRaisesRegex(ValueError, "boot module"):
                    INSTALL.read_boot_modules(source)

    def test_transitive_rooted_imports_are_copied(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, resources = Path(directory) / "repo", Path(directory) / "runtime"
            resources.mkdir()
            (resources / "entry.mjs").write_text("import './desktop/shared/first.mjs';")
            first, second = repo / "desktop/shared/first.mjs", repo / "gui/sdk/js/second.mjs"
            first.parent.mkdir(parents=True)
            second.parent.mkdir(parents=True)
            first.write_text("export { value } from './gui/sdk/js/second.mjs';")
            second.write_text("export const value = 1;")
            with patch.object(INSTALL, "REPO", repo):
                INSTALL.complete_modules(resources)
            self.assertEqual((resources / "gui/sdk/js/second.mjs").read_text(), second.read_text())
            INSTALL.validate_modules(resources)

    def test_missing_runtime_import_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "entry.mjs").write_text("import { service } from './desktop/launcher/services.mjs';")
            with self.assertRaisesRegex(ValueError, "Missing Shell module"):
                INSTALL.validate_modules(root)

    def test_packaged_static_and_dynamic_imports_are_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "desktop/launcher/services.mjs"
            target.parent.mkdir(parents=True)
            target.write_text("export const service = 1;")
            (root / "entry.mjs").write_text(
                "import { service } from './desktop/launcher/services.mjs';\n"
                "await import('./desktop/launcher/services.mjs');")
            INSTALL.validate_modules(root)

    def test_copy_replaces_destination_symlink_without_changing_its_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, original, destination = root / "source", root / "busybox", root / "modprobe"
            source.write_text("new program")
            original.write_text("original busybox")
            destination.symlink_to(original)
            INSTALL.copy(source, destination)
            self.assertFalse(destination.is_symlink())
            self.assertEqual(destination.read_text(), "new program")
            self.assertEqual(original.read_text(), "original busybox")


class DisplayProofTests(unittest.TestCase):
    def test_partial_serial_json_is_not_a_complete_state_record(self):
        complete = 'MICRO_DESKTOP_STATE={"panels":[1]}\n'
        self.assertEqual(MODULE.desktop_state(complete + 'MICRO_DESKTOP_STATE={"pan'),
                         {"panels": [1]})
        self.assertIsNone(MODULE.desktop_state('MICRO_DESKTOP_STATE={"pan'))
        with self.assertRaises(ValueError):
            MODULE.desktop_state('MICRO_DESKTOP_STATE=invalid\n')

    def test_timestamped_kernel_message_can_interrupt_a_serial_record(self):
        text = 'MICRO_DESKTOP_STATE={"active"[   21.274266] hrtimer: interrupt took 8425076 ns\n:false}\n'
        self.assertEqual(MODULE.desktop_state(text), {"active": False})
        with self.assertRaises(ValueError):
            MODULE.desktop_state('MICRO_DESKTOP_STATE={"active"unexpected userspace log\n:false}\n')

    def test_complete_json_can_be_followed_by_an_interleaved_compositor_log(self):
        text = 'MICRO_DESKTOP_STATE={"active":true}00:00:15.730 [/repo/server.c:2455] Mapped Settings\n'
        self.assertEqual(MODULE.desktop_state(text), {"active": True})
        with self.assertRaisesRegex(ValueError, "Unexpected data"):
            MODULE.desktop_state('MICRO_DESKTOP_STATE={"active":true}arbitrary trailing data\n')

    def simpledrm(self):
        return (
            "MICRO_DRM_DRIVER=simple-framebuffer CARD=/dev/dri/card0\n"
            "Initializing DRM backend for /dev/dri/card0 (simpledrm)\n"
            "Creating pixman renderer\n"
            "Modesetting with 1024x768 @ 60 Hz\n"
            "PollyWM ready: WAYLAND_DISPLAY=wayland-0\n"
            "input: QEMU QEMU USB Keyboard as /devices/input0\n"
        )

    def test_gop_proof_requires_the_actual_simpledrm_driver(self):
        self.assertEqual(MODULE.display_proof(self.simpledrm(), "simpledrm"), (1024, 768))
        with self.assertRaisesRegex(ValueError, "compositor proof"):
            MODULE.display_proof(self.simpledrm(), "virtio")

    def test_virtio_proof_distinguishes_pci_transport_from_the_drm_driver(self):
        text = self.simpledrm().replace("simple-framebuffer", "virtio-pci").replace("(simpledrm)", "(virtio_gpu)")
        self.assertEqual(MODULE.display_proof(text, "virtio"), (1024, 768))

    def test_gop_proof_rejects_a_virtio_renderer(self):
        text = self.simpledrm() + "Initializing DRM backend for /dev/dri/card1 (virtio_gpu)\n"
        with self.assertRaisesRegex(ValueError, "cannot qualify"):
            MODULE.display_proof(text, "simpledrm")

    def test_gop_proof_requires_usb_keyboard_enumeration(self):
        text = self.simpledrm().replace("USB Keyboard", "Virtio Keyboard")
        with self.assertRaisesRegex(ValueError, "USB keyboard"):
            MODULE.display_proof(text, "simpledrm")

    def test_unknown_profile_is_not_a_virtio_fallback(self):
        with self.assertRaisesRegex(ValueError, "Unknown display"):
            MODULE.display_proof(self.simpledrm(), "unknown")


if __name__ == "__main__":
    unittest.main()
