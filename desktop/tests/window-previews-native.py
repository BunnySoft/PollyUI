#!/usr/bin/env python3
"""Private UID1000 native preview fixture; no host bus, graphics device or user data."""
import argparse
import os
import re
import stat
import sys
from pathlib import Path
import subprocess
import tempfile
import time
from PIL import Image


def ordinary_user():
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("supervisor", type=Path)
    parser.add_argument("pollyui", type=Path)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--projection", action="store_true")
    parser.add_argument("--companion", action="store_true")
    parser.add_argument("--video", action="store_true")
    parser.add_argument("--cube", action="store_true")
    parser.add_argument("--video-fixtures", type=Path)
    parser.add_argument("--drm-node", type=Path, help="Explicit primary DRM node in the isolated GPU test lane")
    parser.add_argument("--software-gles", action="store_true", help="Explicit llvmpipe probe, not physical-GPU acceptance")
    args = parser.parse_args()
    if sum((args.projection, args.companion, args.video, args.cube)) > 1:
        raise ValueError("Select one native preview/companion fixture")
    fixtures = args.video_fixtures or (Path(os.environ["POLLY_VIDEO_TEST_FILES"]) if os.environ.get("POLLY_VIDEO_TEST_FILES") else None)
    if args.video and fixtures is None:
        print("UNQUALIFIED: select original local video fixtures explicitly")
        return 77
    drm = args.drm_node or (Path(os.environ["POLLY_TEST_DRM_NODE"]) if os.environ.get("POLLY_TEST_DRM_NODE") else None)
    if (args.projection or args.cube) and drm is None:
        print("UNQUALIFIED: native 3D requires an explicitly selected isolated DRM test node")
        return 77
    if not (args.projection or args.cube) and (args.drm_node or args.software_gles):
        raise ValueError("DRM and software GLES options require --projection")
    if (args.projection or args.cube) and (not re.fullmatch(r"/dev/dri/card[0-9]+", str(drm)) or
                           not stat.S_ISCHR(drm.stat().st_mode)):
        raise ValueError("The GPU fixture requires an explicit DRM primary character device")
    if os.geteuid() not in (0, 1000):
        raise RuntimeError("Use an isolated UID1000 native lane or root fixture coordinator")
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="private-", dir=evidence))
    if os.geteuid() == 0:
        os.chown(root, 1000, 1000)
    for name in ("run", "home", "config", "data", "cache"):
        path = root / name
        path.mkdir(mode=0o700)
        if os.geteuid() == 0:
            os.chown(path, 1000, 1000)
    env = {key: value for key, value in os.environ.items() if not key.startswith(
        ("XDG_", "DBUS_", "POLLY_", "PIPEWIRE_", "WAYLAND_", "SDL_", "PU_", "PULSE_"))}
    env.update(HOME=str(root / "home"), XDG_RUNTIME_DIR=str(root / "run"),
               XDG_CONFIG_HOME=str(root / "config"), XDG_DATA_HOME=str(root / "data"),
               XDG_CACHE_HOME=str(root / "cache"), SDL_VIDEODRIVER="wayland",
               SDL_RENDER_DRIVER="software", PU_RENDERER="raster", WLR_BACKENDS="headless",
               WLR_RENDERER="pixman", WLR_HEADLESS_OUTPUTS="2", PULSE_SERVER="disabled:",
               DBUS_SYSTEM_BUS_ADDRESS="unix:path=" + str(root / "run/no-system-bus"),
               POLLY_PREVIEW_EVIDENCE=str(root / "composed"))
    if args.companion:
        env["PU_DESKTOP_FIXTURE_LOCK"] = str(args.pollyui.resolve().parent / "desktop/tests/polly-lock-test-client")
    if args.video:
        env["PU_DESKTOP_FIXTURE_LOCK"] = str(args.pollyui.resolve().parent / "desktop/tests/polly-lock-test-client")
        env["POLLY_VIDEO_TEST_FILES"] = str(fixtures.resolve(strict=True))
    if args.projection or args.cube:
        env["WLR_RENDERER"] = "gles2"
        env["POLLY_FIXTURE_DRM_ALLOCATOR"] = str(drm)
        env["PU_DESKTOP_FIXTURE_LOCK"] = str(args.pollyui.resolve().parent / "desktop/tests/polly-lock-test-client")
        if args.software_gles:
            env.update(WLR_RENDERER_FORCE_SOFTWARE="1", LIBGL_ALWAYS_SOFTWARE="1", GALLIUM_DRIVER="llvmpipe")
    bus = None
    preexec = ordinary_user if os.geteuid() == 0 else None
    try:
        with (root / "bus.address").open("w+") as address_log, (root / "bus.log").open("w+") as bus_log:
            bus = subprocess.Popen(["dbus-daemon", "--session", "--nofork", "--nopidfile",
                "--address=unix:path=" + str(root / "run/bus"), "--print-address"],
                env=env, stdout=address_log, stderr=bus_log, preexec_fn=preexec)
            deadline = time.monotonic() + 5
            while not (root / "run/bus").is_socket() or not (root / "bus.address").read_text().strip():
                if bus.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("Private preview fixture bus did not become ready")
                time.sleep(0.02)
            env["DBUS_SESSION_BUS_ADDRESS"] = env["POLLY_SESSION_BUS_ADDRESS"] = (root / "bus.address").read_text().strip()
            repo = Path(__file__).resolve().parents[2]
            try:
                result = subprocess.run([str(args.supervisor.resolve(strict=True)), str(args.pollyui.resolve(strict=True)),
                    str(repo / ("desktop/tests/workspace-cube-native.mjs" if args.cube else
                                "desktop/tests/window-projection-native.mjs" if args.projection else
                                "desktop/tests/companion-native.mjs" if args.companion else
                                "desktop/tests/video-wallpaper-native.mjs" if args.video else
                                "desktop/tests/window-previews-native.mjs")), "switcher"],
                    cwd=repo, env=env, preexec_fn=preexec, text=True, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, timeout=100)
            except subprocess.TimeoutExpired as error:
                output = error.stdout or b""
                (root / "native.log").write_text(output.decode(errors="replace") if isinstance(output, bytes) else output)
                raise
            (root / "native.log").write_text(result.stdout)
            label = "workspace cube" if args.cube else "Flip 3D" if args.projection else "desktop companion" if args.companion else \
                "video wallpaper" if args.video else "window previews"
            required = ["PASS: native " + label + " initial complete", "PASS: native " + label + " reload complete"]
            if result.returncode or any(marker not in result.stdout for marker in required) or "FAIL" in result.stdout:
                print(result.stdout)
                raise RuntimeError("Native window preview interaction failed")
            for mode in ("initial", "reload"):
                if not (root / ("composed-" + mode + ".ppm")).is_file():
                    raise RuntimeError("Actual compositor output capture is missing")
            for capture in root.glob("composed-*.ppm"):
                with Image.open(capture) as image:
                    if image.size != (1280, 720):
                        raise RuntimeError("Unexpected actual compositor capture dimensions")
                    image.save(capture.with_suffix(".png"))
            print("PASS: native UID1000 " + label + ", actual composed pixels, lifecycle, pointer/keyboard and Shell restart")
    finally:
        if bus is not None and bus.poll() is None:
            bus.terminate()
            try:
                bus.wait(timeout=5)
            except subprocess.TimeoutExpired:
                bus.kill()
                bus.wait(timeout=5)
        print("Retained preview evidence: " + str(root))
    return 0


if __name__ == "__main__":
    sys.exit(main())
