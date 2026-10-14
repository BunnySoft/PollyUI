#!/usr/bin/env python3
"""Focused startup/supervision tests; not ISO, firmware or physical acceptance."""
import ast
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import time
import unittest
import zlib

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
startup = runpy.run_path(str(REPO / "desktop/release/live/startup.py"))
assets = runpy.run_path(str(REPO / "desktop/release/live/boot-assets.py"))
install = runpy.run_path(str(REPO / "desktop/release/debian/boot-install.py"))
READY = "POLLY_LIVE_DESKTOP_READY outputs=1"


class Startup(unittest.TestCase):
    def supervise(self, source, timeout=1):
        log = io.BytesIO()
        result = startup["supervise"]([sys.executable, "-u", "-c", source], log, timeout)
        return result, log.getvalue()

    def test_split_colored_actual_record_and_no_post_ready_deadline(self):
        result, log = self.supervise(
            "import os,time; os.write(1,b'\\x1b[32m[00:00] POLLY_LIVE_');"
            "time.sleep(.02); os.write(1,b'DESKTOP_READY outputs=1\\x1b[0m\\n');time.sleep(.3)", .2)
        self.assertEqual(result, 0)
        self.assertIn(READY.encode(), log)

    def test_exit_before_ready_is_not_success(self):
        with self.assertRaisesRegex(RuntimeError, "before its first usable frame"):
            self.supervise("print('Shell scheduling acknowledged')")
        with self.assertRaisesRegex(RuntimeError, "before its first usable frame"):
            self.supervise("print('POLLY_LIVE_DESKTOP_READY outputs=0')")
        with self.assertRaisesRegex(RuntimeError, "before its first usable frame"):
            self.supervise("print('POLLY_LIVE_DESKTOP_READY outputs=1 extra')")

    def test_failure_after_ready_stays_visible(self):
        with self.assertRaisesRegex(RuntimeError, "status 7"):
            self.supervise(f"print('{READY}');raise SystemExit(7)")

    def test_timeout_terminates_only_its_own_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            pid = Path(temporary) / "pid"
            source = f"import os,time,pathlib;pathlib.Path({str(pid)!r}).write_text(str(os.getpid()));time.sleep(30)"
            began = time.monotonic()
            with self.assertRaisesRegex(TimeoutError, "did not become usable"):
                self.supervise(source, .2)
            self.assertLess(time.monotonic() - began, 6)
            self.assertFalse(Path("/proc", pid.read_text()).exists())

    def test_source_wiring_and_legacy_scope(self):
        for name in ("build-live-image.py", "offline-live-overlay.py", "verify-live-runtime.py"):
            source = REPO / "desktop/tools" / name
            ast.parse(source.read_text(), filename=str(source))
        cfg = (REPO / "desktop/release/debian/live-grub.cfg").read_text()
        entries = cfg.split("menuentry ")[1:]
        self.assertEqual(len(entries), 6)
        self.assertIn("polly.mode=baseline polly.splash=1", entries[0])
        for entry in entries[-3:]:
            self.assertNotIn("polly.splash=1", entry)
        self.assertIn("polly.mode=console", entries[-2])
        self.assertIn("serial VM baseline", entries[-1])
        self.assertIn("polly.serial=1", entries[-1])
        main, advanced = cfg.split('submenu "Advanced startup"', 1)
        self.assertEqual(main.count("menuentry "), 1)
        self.assertEqual(advanced.count("menuentry "), 5)
        self.assertIn("set timeout=8", main)
        self.assertIn("set default=0", main)
        self.assertIn("set timeout=-1", advanced)
        self.assertIn("set default=0", advanced)
        self.assertIn("--id polly-live", main)
        self.assertIn("--id polly-serial", advanced)
        self.assertIn("terminal_output console serial", main)
        self.assertNotIn("auto", main.split("set gfxmode=", 1)[1].splitlines()[0])
        theme = (REPO / "desktop/release/live/grub-theme.txt").read_text()
        self.assertIn('id = "__timeout__"', theme)
        self.assertIn('text = "Starting the default entry in %ds"', theme)
        with tempfile.TemporaryDirectory() as temporary:
            resources = assets["write_theme"](temporary)
            generated = assets["theme_assets"]()
            self.assertEqual(len(resources), len(generated))
            self.assertEqual(generated, assets["theme_assets"]())
            for name, data in generated.items():
                self.assertEqual((Path(temporary) / name).read_bytes(), data)
                self.assertIn("boot/grub/themes/polly/" + name + "=" + str(Path(temporary) / name), resources)
            for name in ("polly", "advanced", "gpu", "verbose", "console", "serial"):
                data = generated["icons/" + name + ".png"]
                self.assertEqual(int.from_bytes(data[16:20], "big"), 32)
                self.assertEqual(int.from_bytes(data[20:24], "big"), 32)
            self.assertEqual(generated["polly.png"], assets["logo"]())
        recipe = (REPO / "desktop/release/debian/Containerfile.live").read_text()
        platform, final = recipe.split("FROM platform-base AS live-base")
        self.assertNotIn("plymouth=", platform)
        self.assertIn("plymouth=24.004.60-5", final)
        self.assertNotIn("setTimeout", (REPO / "desktop/release/live/shell.mjs").read_text())
        for target, original, data, mode in install["files"](REPO):
            if target != "home/polly/.hushlogin":
                self.assertTrue(data, target)
            self.assertIn(mode, (0o644, 0o755))
            if original == "@generated-logo":
                self.assertEqual(data, assets["logo"]())
        for file in ("session", "init"):
            subprocess.run(["sh", "-n", str(REPO / "desktop/release/live" / file)], check=True)
        subprocess.run(["sh", "-n", str(REPO / "desktop/release/debian/live-splash")], check=True)
        getty = (REPO / "desktop/release/debian/live-boot-getty.conf").read_text()
        self.assertIn("--autologin polly", getty)
        self.assertIn("--noissue --skip-login", getty)

    def test_original_logo_size_colors_and_repeatability(self):
        data = assets["logo"]()
        self.assertEqual(data, assets["logo"]())
        self.assertEqual(int.from_bytes(data[16:20], "big"), 128)
        self.assertEqual(int.from_bytes(data[20:24], "big"), 128)
        offset, compressed = 8, b""
        while offset < len(data):
            size = int.from_bytes(data[offset:offset + 4], "big")
            if data[offset + 4:offset + 8] == b"IDAT":
                compressed += data[offset + 8:offset + 8 + size]
            offset += size + 12
        pixels = zlib.decompress(compressed)
        self.assertEqual(len(pixels), 128 * (128 * 4 + 1))
        self.assertEqual(pixels[1:5], bytes((*assets["BACKGROUND"], 255)))
        index = 30 * 513 + 1 + 36 * 4
        self.assertEqual(pixels[index:index + 4], bytes((*assets["FOREGROUND"], 255)))
        dependencies = json.loads((REPO / "desktop/release/debian/boot-dependencies.json").read_text())
        self.assertEqual(set(dependencies["packages"].values()), {"24.004.60-5"})


if __name__ == "__main__":
    unittest.main()
