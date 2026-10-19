#!/usr/bin/env python3
"""Source/control tests and optional actual isolated Plymouth IPC, never a guest boot."""
import os
from pathlib import Path
import pty
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]


class EarlySplash(unittest.TestCase):
    def test_system_stage_reuses_the_daemon_and_never_restarts_a_failed_early_display(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("bin", "usr/bin", "usr/sbin", "proc", "run/polly-live", "run/plymouth"):
                (root / name).mkdir(parents=True, exist_ok=True)
            shutil.copyfile(shutil.which("busybox"), root / "bin/busybox")
            (root / "bin/busybox").chmod(0o755)
            for name in ("sh", "cat", "mkdir", "timeout"):
                (root / "bin" / name).symlink_to("busybox")
            (root / "proc/cmdline").write_text("quiet splash polly.splash=1")
            (root / "helper").write_bytes((REPO / "desktop/release/debian/live-splash").read_bytes())
            (root / "usr/bin/plymouth").write_text(
                '#!/bin/sh\nprintf "client %s\\n" "$*" >>/calls\n'
                'case "$1" in --ping) [ -f /alive ];; quit) /bin/busybox rm /alive;; *) :;; esac\n')
            (root / "usr/bin/plymouth").chmod(0o755)
            (root / "usr/sbin/plymouthd").write_text(
                '#!/bin/sh\nprintf "NEW_DAEMON\\n" >>/calls\n: >/alive\n')
            (root / "usr/sbin/plymouthd").chmod(0o755)
            (root / "alive").touch()
            (root / "run/polly-live/splash-started").touch()
            result = subprocess.run(["chroot", str(root), "/bin/sh", "/helper", "start"],
                                    text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = (root / "calls").read_text()
            self.assertNotIn("NEW_DAEMON", calls)
            self.assertNotIn("show-splash", calls)
            self.assertIn("update-root-fs --read-write", calls)
            subprocess.run(["chroot", str(root), "/bin/sh", "/helper", "handoff"], check=True, timeout=5)
            self.assertIn("quit --retain-splash", (root / "calls").read_text())
            (root / "calls").write_text("")
            result = subprocess.run(["chroot", str(root), "/bin/sh", "/helper", "start"],
                                    text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            self.assertIn("exited unexpectedly", result.stderr)
            self.assertNotIn("NEW_DAEMON", (root / "calls").read_text())

    def test_graphics_routes_and_root_transfer_are_explicit_without_changing_readiness(self):
        init = (REPO / "desktop/release/debian/live-bootstrap").read_text()
        self.assertLess(init.index("start_splash\n"), init.index('stage "Finding the exact boot filesystem'))
        self.assertIn("--attach-to-session", init)
        self.assertIn("plymouth.ignore-udev plymouth.use-legacy-input", init)
        self.assertIn("trap ':'", init)
        self.assertNotIn("trap ''", init)
        self.assertLess(init.index("mount --move /run"), init.index("plymouth update-root-fs --new-root-dir=/newroot"))
        self.assertLess(init.index("plymouth update-root-fs"), init.index("exec switch_root"))
        cfg = (REPO / "desktop/release/debian/live-grub.cfg").read_text()
        self.assertEqual(cfg.count("quiet splash loglevel=3"), 3)
        self.assertIn("background_image --mode=stretch", cfg)
        self.assertIn("set timeout=8", cfg)
        self.assertNotIn("sleep ", cfg)
        startup = (REPO / "desktop/release/live/startup.py").read_text()
        self.assertIn("STARTUP_SECONDS = 90", startup)

    def test_missing_early_graphics_explicitly_keeps_text_and_records_the_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("bin", "proc", "etc", "run/polly-live"):
                (root / name).mkdir(parents=True, exist_ok=True)
            shutil.copyfile(shutil.which("busybox"), root / "bin/busybox")
            (root / "bin/busybox").chmod(0o755)
            for name in ("sh", "cat"):
                (root / "bin" / name).symlink_to("busybox")
            for name in ("mdev", "modprobe"):
                (root / "bin" / name).write_text("#!/bin/sh\nexit 0\n")
                (root / "bin" / name).chmod(0o755)
            (root / "proc/cmdline").write_text("splash polly.splash=1")
            (root / "proc/uptime").write_text("1.25 0.0\n")
            (root / "etc/polly-live-graphics-modules").write_text("hyperv_drm\n")
            functions = (REPO / "desktop/release/debian/live-bootstrap").read_text().split("set -eu\n", 1)[0]
            (root / "check").write_text(
                functions + 'set -eu\nserial=0\nsplash_active=0\n'
                'modprobe() { :; }\nmdev() { :; }\n'
                'splash_runtime=/run/plymouth\nlog_directory=/run/polly-live\n'
                'uptime_file=/proc/uptime\nexec 3>/console\nstart_splash\n'
                '[ "$splash_active" = 0 ]\n')
            subprocess.run(["chroot", str(root), "/bin/sh", "/check"], check=True, timeout=5)
            self.assertIn("No early framebuffer/DRM device; using console", (root / "console").read_text())
            self.assertTrue((root / "run/polly-live/splash-unavailable").is_file())
            (root / "check").write_text(
                functions + 'set -eu\nserial=0\nsplash_active=1\n'
                'splash_runtime=/run/plymouth\nlog_directory=/run/polly-live\n'
                'uptime_file=/proc/uptime\nexec 3>/console\n'
                'timeout() { return 124; }\nstage "Verifying RAM copy"\n'
                '[ "$splash_active" = 0 ]\n')
            subprocess.run(["chroot", str(root), "/bin/sh", "/check"], check=True, timeout=5)
            self.assertIn("graphical status update failed; using console", (root / "console").read_text())
            self.assertIn("Verifying RAM copy", (root / "run/polly-live/early-boot.log").read_text())


def ipc_child(bootstrap):
    """No attach-to-session/TIOCCONS, no GPU, no host VT: IPC/root transition only."""
    bootstrap = bootstrap.resolve()
    subprocess.run(["mount", "--make-rprivate", "/"], check=True)
    subprocess.run(["mount", "-t", "proc", "proc", "/proc"], check=True)
    with tempfile.TemporaryDirectory(prefix="polly-plymouth-ipc-") as temporary:
        root = Path(temporary) / "bootstrap"
        shutil.copytree(bootstrap, root, symlinks=True)
        new = Path(temporary) / "ram-root"
        shutil.copytree(bootstrap, new, symlinks=True)
        for directory in (root, new):
            (directory / "run/plymouth").mkdir(parents=True, exist_ok=True)
            (directory / "dev/pts").mkdir(parents=True, exist_ok=True)
            (directory / "dev/null").touch()
        master, slave = pty.openpty()
        terminal = os.ttyname(slave)
        subprocess.run(["mount", "--rbind", "/dev/pts", str(root / "dev/pts")], check=True)
        (root / "dev/tty1").symlink_to(terminal)
        (root / "newroot").mkdir(exist_ok=True)
        (new / "etc/ipc-new-root").write_text("same-daemon-new-root")
        subprocess.run(["mount", "--bind", str(new), str(root / "newroot")], check=True)
        errors = Path(temporary) / "daemon.stderr"
        with errors.open("wb") as log:
            daemon = subprocess.Popen(
                ["chroot", str(root), "/bin/plymouthd", "--no-daemon", "--tty=/dev/tty1",
                 "--pid-file=/run/plymouth/pid",
                 "--kernel-command-line=splash plymouth.ignore-udev plymouth.use-legacy-input"],
                stdout=log, stderr=subprocess.STDOUT)
            def client(*args, check=True):
                return subprocess.run(["chroot", str(root), "/bin/plymouth", *args],
                                      capture_output=True, text=True, timeout=3, check=check)
            try:
                deadline = time.monotonic() + 3
                while client("--ping", check=False).returncode:
                    if daemon.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError("Actual Plymouth IPC did not start: " + errors.read_text())
                    time.sleep(.02)
                pid = (root / "run/plymouth/pid").read_text()
                client("show-splash")
                client("display-message", "--text=Verifying compressed RAM root")
                client("update-root-fs", "--new-root-dir=/newroot")
                marker = Path("/proc") / str(daemon.pid) / "root/etc/ipc-new-root"
                if marker.read_text() != "same-daemon-new-root":
                    raise RuntimeError("Actual Plymouth did not chroot")
                client("--ping")
                client("update-root-fs", "--read-write")
                if (root / "run/plymouth/pid").read_text() != pid or daemon.poll() is not None:
                    raise RuntimeError("Plymouth daemon identity changed")
                client("quit", "--retain-splash")
                if daemon.wait(timeout=3):
                    raise RuntimeError("Plymouth quit failed")
            finally:
                if daemon.poll() is None:
                    daemon.terminate()
                    daemon.wait(timeout=3)
                os.close(master)
                os.close(slave)
                subprocess.run(["umount", str(root / "newroot")], check=True)
                subprocess.run(["umount", str(root / "dev/pts")], check=True)
        print("PASS: actual isolated Plymouth IPC, same PID/chroot/read-write/retain-splash quit; no graphics/Esc/console-redirection claim")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--ipc-bootstrap":
        subprocess.run(["unshare", "--mount", "--pid", "--fork", "--kill-child",
                        sys.executable, "-I", "-B", str(Path(__file__).resolve()),
                        "--ipc-child", sys.argv[2]], check=True, timeout=20)
    elif len(sys.argv) == 3 and sys.argv[1] == "--ipc-child":
        ipc_child(Path(sys.argv[2]))
    else:
        unittest.main()
