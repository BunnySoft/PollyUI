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
            for name in ("bin", "usr/bin", "usr/sbin", "usr/lib", "proc", "run/polly-live", "run/plymouth"):
                (root / name).mkdir(parents=True, exist_ok=True)
            shutil.copyfile(shutil.which("busybox"), root / "bin/busybox")
            (root / "bin/busybox").chmod(0o755)
            for name in ("sh", "cat", "mkdir", "timeout"):
                (root / "bin" / name).symlink_to("busybox")
            (root / "proc/cmdline").write_text("quiet splash polly.splash=1")
            (root / "helper").write_bytes((REPO / "desktop/release/debian/live-splash").read_bytes())
            (root / "usr/lib/polly-live-splash-control").write_text(
                'control_load() { return 0; }\ncontrol_record() { return 0; }\n'
                'control_release() { timeout 1 plymouth quit "$@"; }\n')
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
                'modprobe() { :; }\nmdev() { :; }\ncontrol_release() { :; }\n'
                'splash_runtime=/run/plymouth\nlog_directory=/run/polly-live\n'
                'uptime_file=/proc/uptime\nexec 3>/console\nstart_splash\n'
                '[ "$splash_active" = 0 ]\n')
            subprocess.run(["chroot", str(root), "/bin/sh", "/check"], check=True, timeout=5)
            self.assertIn("No early framebuffer/DRM device; using console", (root / "console").read_text())
            self.assertTrue((root / "run/polly-live/splash-unavailable").is_file())
            (root / "check").write_text(
                functions + 'set -eu\nserial=0\nsplash_active=1\n'
                'control_release() { :; }\n'
                'splash_runtime=/run/plymouth\nlog_directory=/run/polly-live\n'
                'uptime_file=/proc/uptime\nexec 3>/console\n'
                'timeout() { return 124; }\nstage "Verifying RAM copy"\n'
                '[ "$splash_active" = 0 ]\n')
            subprocess.run(["chroot", str(root), "/bin/sh", "/check"], check=True, timeout=5)
            self.assertIn("graphical status update failed; using console", (root / "console").read_text())
            self.assertIn("Verifying RAM copy", (root / "run/polly-live/early-boot.log").read_text())
            (root / "etc/polly-live-graphics-modules").write_text("hyperv_drm\nvirtio_gpu\n")
            (root / "etc/polly-live-signals").write_text(
                "POLLY_PLYMOUTH_PRINT_SIGNAL=54\nPOLLY_PLYMOUTH_STOP_SIGNAL=55\n")
            # Only the hardware/device predicate is simulated; no fake node is called graphics proof.
            simulated = functions.replace(
                '[ ! -c /dev/fb0 ] && [ ! -c /dev/dri/card0 ]', '[ "$FIXTURE_GRAPHICS" != 1 ]')
            (root / "check").write_text(
                simulated + 'set -eu\nserial=0\nsplash_active=0\nFIXTURE_GRAPHICS=1\n'
                'modprobe() { printf "%s\\n" "$1" >>/attempts; [ "$1" != hyperv_drm ]; }\n'
                'mdev() { :; }\nmount() { :; }\ntimeout() { :; }\ncontrol_record() { :; }\n'
                'splash_runtime=/run/plymouth\nlog_directory=/run/polly-live\n'
                'uptime_file=/proc/uptime\nexec 3>/console\nstart_splash\n'
                '[ "$splash_active" = 1 ]\n')
            subprocess.run(["chroot", str(root), "/bin/sh", "/check"], check=True, timeout=5)
            self.assertEqual((root / "attempts").read_text().splitlines(), ["hyperv_drm", "virtio_gpu"])
            self.assertIn("trying other graphics paths", (root / "run/polly-live/early-boot.log").read_text())
            self.assertTrue((root / "run/polly-live/splash-started").is_file())


def cleanup_child(bootstrap):
    """A deliberately hung test executable, not Plymouth and not a graphical test."""
    subprocess.run(["mount", "--make-rprivate", "/"], check=True)
    subprocess.run(["mount", "-t", "proc", "proc", "/proc"], check=True)
    with tempfile.TemporaryDirectory(prefix="polly-cleanup-") as temporary:
        root = Path(temporary) / "root"
        shutil.copytree(bootstrap, root, symlinks=True)
        (root / "run/plymouth").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / "probe", root / "bin/plymouthd")
        shutil.copyfile(REPO / "desktop/release/debian/live-splash-control",
                        root / "usr/lib/polly-live-splash-control")
        for applet in ("id", "rm", "sleep", "stat", "readlink", "timeout"):
            path = root / "bin" / applet
            if not path.exists():
                path.symlink_to("busybox")
        (root / "bin/plymouth").write_text("#!/bin/sh\nexec /bin/sleep 30\n")
        (root / "bin/plymouth").chmod(0o755)
        subprocess.run(["mount", "-t", "proc", "proc", str(root / "proc")], check=True)
        children = []
        try:
            for _ in range(2):
                child = subprocess.Popen(["chroot", str(root), "/bin/plymouthd", "--ignore-term"],
                                         stdout=subprocess.PIPE, text=True)
                children.append(child)
                if child.stdout.readline().strip() != "IGNORE_TERM_READY":
                    raise RuntimeError("Cleanup fault process did not initialize")
            daemon, neighbour = children
            (root / "run/plymouth/pid").write_text(str(daemon.pid) + "\n")
            command = '. /usr/lib/polly-live-splash-control; splash_runtime=/run/plymouth; proc_directory=/proc; '
            started = time.monotonic()
            result = subprocess.run(["chroot", str(root), "/bin/sh", "-c",
                                     command + "control_record && control_release"],
                                    capture_output=True, text=True, timeout=4)
            elapsed = time.monotonic() - started
            if result.returncode or daemon.wait(timeout=1) != -signal.SIGKILL or neighbour.poll() is not None:
                raise RuntimeError("Owned daemon cleanup or neighbour isolation failed: " + result.stderr)
            if elapsed >= 3 or "ignored TERM" not in result.stderr:
                raise RuntimeError("Cleanup exceeded its service-budget margin or did not escalate: " + result.stderr)
            print(result.stderr, end="")
            for pid, expected in ((1, 1), (neighbour.pid, 1)):
                (root / "run/plymouth/polly-owned").write_text(f"{pid} {expected}\n")
                refused = subprocess.run(["chroot", str(root), "/bin/sh", "-c", command + "control_release"],
                                         capture_output=True, text=True, timeout=1)
                if refused.returncode == 0 or neighbour.poll() is not None:
                    raise RuntimeError("Protected/mismatched PID was not refused")
            print(f"PASS: private PID namespace IPC timeout + ignored TERM -> confirmed KILL/zombie exit "
                  f"in {elapsed:.3f}s; neighbour and PID1 untouched; not a Plymouth/graphics test")
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=1)
                child.stdout.close()
            subprocess.run(["umount", str(root / "proc")], check=True)


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
    if len(sys.argv) == 3 and sys.argv[1] == "--cleanup-bootstrap":
        subprocess.run(["unshare", "--mount", "--pid", "--fork", "--kill-child",
                        sys.executable, "-I", "-B", str(Path(__file__).resolve()),
                        "--cleanup-child", sys.argv[2]], check=True, timeout=10)
    elif len(sys.argv) == 3 and sys.argv[1] == "--cleanup-child":
        cleanup_child(Path(sys.argv[2]))
    elif len(sys.argv) == 3 and sys.argv[1] == "--ipc-bootstrap":
        subprocess.run(["unshare", "--mount", "--pid", "--fork", "--kill-child",
                        sys.executable, "-I", "-B", str(Path(__file__).resolve()),
                        "--ipc-child", sys.argv[2]], check=True, timeout=20)
    elif len(sys.argv) == 3 and sys.argv[1] == "--ipc-child":
        ipc_child(Path(sys.argv[2]))
    else:
        unittest.main()
