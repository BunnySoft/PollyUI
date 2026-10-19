#!/usr/bin/env python3
"""Focused startup/supervision tests; not ISO, firmware or physical acceptance."""
import ast
import io
import json
import os
from pathlib import Path
import runpy
import shutil
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
        self.assertIn("search --no-floppy --file --set=root /polly/@POLLY_MEDIA_ID@.marker", main)
        self.assertIn("probe --set=polly_media_uuid --fs-uuid", main)
        self.assertNotIn("/polly-live.marker", cfg)
        for entry in entries:
            self.assertIn("polly.media_uuid=$polly_media_uuid", entry)
            self.assertIn("polly.media_id=@POLLY_MEDIA_ID@", entry)
            self.assertIn("polly_start console=", entry)
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

    def test_grub_load_stages_do_not_claim_a_failed_kernel_is_starting(self):
        cfg = (REPO / "desktop/release/debian/live-grub.cfg").read_text()
        function = cfg.split("function polly_start {", 1)[1].split("function polly_prepare_media", 1)[0]
        # Shell command stubs exercise the shared branches, not a GRUB boot.
        script = ('linux() { return "$KERNEL_RESULT"; }\n'
                  'initrd() { return "$BOOTSTRAP_RESULT"; }\n'
                  'halt() { exit 27; }\npolly_start() {' + function + "\npolly_start test=1\n")
        for kernel, bootstrap in ((0, 0), (1, 0), (0, 1)):
            with self.subTest(kernel=kernel, bootstrap=bootstrap):
                result = subprocess.run(["sh", "-c", script], text=True, capture_output=True, timeout=5,
                                        env={**os.environ, "KERNEL_RESULT": str(kernel),
                                             "BOOTSTRAP_RESULT": str(bootstrap)})
                self.assertEqual(result.returncode, 27 if kernel or bootstrap else 0, result.stderr)
                self.assertEqual("Starting kernel..." in result.stdout, not (kernel or bootstrap))
                self.assertEqual("Polly ERROR:" in result.stdout, bool(kernel or bootstrap))

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

    def test_diagnostics_keeps_boot_timeline_and_reports_unavailable_tools(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tools, home = root / "tools", root / "home"
            tools.mkdir()
            home.mkdir()
            stub = tools / "diagnostic-stub"
            stub.write_text("#!/bin/sh\n"
                            "name=${0##*/}\n"
                            "if [ \"$name\" = id ]; then printf '1000\\n'; exit 0; fi\n"
                            "if [ \"$name\" = systemd-analyze ]; then\n"
                            "  printf 'Boot timing unavailable while startup is still in progress\\n'\n"
                            "  exit 1\n"
                            "fi\n"
                            "printf 'fixture %s %s\\n' \"$name\" \"$*\"\n")
            stub.chmod(0o755)
            for name in ("id", "uname", "cat", "lspci", "lsusb", "lsmod", "aplay",
                         "arecord", "ip", "rfkill", "systemctl", "systemd-analyze",
                         "journalctl", "iw", "loginctl", "ps", "findmnt", "dmesg", "sh"):
                (tools / name).symlink_to(stub.name)
            (tools / "mktemp").symlink_to(shutil.which("mktemp"))
            # Restrict utility discovery so no host journal/device command can run.
            script = REPO / "desktop/release/live/diagnostics"
            result = subprocess.run(["/bin/sh", str(script)], text=True, capture_output=True,
                                    timeout=10, env={**os.environ, "HOME": str(home),
                                    "XDG_RUNTIME_DIR": "/run/user/1000", "PATH": str(tools)})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report, = home.glob("polly-diagnostics.*/report.txt")
            text = report.read_text()
            for command in ("cat /proc/uptime", "cat /usr/share/pollyui/runtime-origin.json",
                            "systemctl list-jobs", "systemd-analyze --no-pager time",
                            "systemd-analyze --no-pager blame",
                            "systemd-analyze --no-pager critical-chain getty@tty1.service",
                            "journalctl -b -k -o short-monotonic",
                            "journalctl -b -o short-monotonic --no-pager -t polly-live"):
                self.assertIn(command, text)
            self.assertIn("InactiveExitTimestampMonotonic", text)
            self.assertIn("systemd-udev-settle.service", text)
            self.assertIn("polly-live-handoff.service", text)
            self.assertIn("getty@tty2.service", text)
            self.assertIn("cat /sys/class/tty/tty0/active", text)
            self.assertIn("loginctl list-sessions --no-pager", text)
            self.assertIn("loginctl seat-status seat0 --no-pager", text)
            self.assertIn("ps -eo pid,ppid,uid,tty,stat,comm", text)
            self.assertIn("[unavailable or failed: exit 1]", text)
            self.assertIn("fixture journalctl -b -k -o short-monotonic", text)
            self.assertEqual(text.count("Boot timing unavailable while startup is still in progress"), 3)
            self.assertIn("Saved local diagnostics:", result.stdout)
            self.assertEqual(report.stat().st_mode & 0o777, 0o600)
            self.assertEqual(report.parent.stat().st_mode & 0o777, 0o700)

    def test_secondary_live_login_keeps_a_console_instead_of_starting_another_desktop(self):
        source = (REPO / "desktop/release/live/session").read_text()
        route = source.split('if [ "$live_mode" = console ]; then exec /bin/sh; fi\n', 1)[1]
        route = route.split("for capability in ", 1)[0]
        with tempfile.TemporaryDirectory() as temporary:
            tools = Path(temporary)
            tty = tools / "tty"
            tty.write_text('#!/bin/sh\n'
                           'if [ "$TEST_TTY" = unavailable ]; then exit 1; fi\n'
                           'printf "%s\\n" "$TEST_TTY"\n')
            tty.chmod(0o755)
            for terminal in ("/dev/tty1", "/dev/tty2", "/dev/ttyS0", "unavailable"):
                with self.subTest(terminal=terminal):
                    result = subprocess.run(
                        ["/bin/sh", "-c", route + "\nprintf 'DESKTOP_START_ALLOWED\\n'\n"],
                        input="printf 'DIAGNOSTIC_SHELL_READY\\n'\nexit 0\n",
                        text=True, capture_output=True, timeout=5,
                        env={**os.environ, "PATH": str(tools), "TEST_TTY": terminal})
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    if terminal == "/dev/tty1":
                        self.assertIn("DESKTOP_START_ALLOWED", result.stdout)
                        self.assertNotIn("DIAGNOSTIC_SHELL_READY", result.stdout)
                    else:
                        self.assertIn("DIAGNOSTIC_SHELL_READY", result.stdout)
                        self.assertNotIn("DESKTOP_START_ALLOWED", result.stdout)
                        if terminal == "unavailable":
                            self.assertIn("Cannot identify the Live login terminal", result.stderr)
                        else:
                            self.assertIn("desktop remains on tty1", result.stdout)


if __name__ == "__main__":
    unittest.main()
