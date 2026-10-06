#!/usr/bin/env python3
import os
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

with tempfile.TemporaryDirectory(prefix="polly-audio-profile-") as temporary:
    root = Path(temporary)
    environment = dict(os.environ, XDG_CONFIG_HOME=str(root / "config"),
                       XDG_DATA_HOME=str(root / "data"), XDG_CACHE_HOME=str(root / "cache"),
                       SDL_VIDEODRIVER="wayland", SDL_RENDER_DRIVER="software",
                       WLR_RENDERER="pixman", WLR_BACKENDS="headless", WLR_HEADLESS_OUTPUTS="2",
                       PIPEWIRE_REMOTE="polly-audio", POLLY_AUDIO_REMOTE="polly-audio", PULSE_SERVER="disabled:")
    config = Path("desktop/tests/audio.conf").resolve()
    for stage in ("save", "missing", "reload", "unmute", "unmuted", "damaged"):
        run = root / stage
        run.mkdir(mode=0o700)
        environment["XDG_RUNTIME_DIR"] = str(run)
        with (run / "audio.log").open("w+") as log:
            audio = subprocess.Popen(["pipewire"], env=dict(environment,
                                     PIPEWIRE_CONFIG_DIR=str(config.parent), PIPEWIRE_CONFIG_NAME=config.name),
                                     stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 5
                while not (run / "polly-audio").is_socket():
                    if audio.poll() is not None or time.monotonic() >= deadline:
                        log.seek(0)
                        raise RuntimeError("Fixture audio startup failed: " + log.read())
                    time.sleep(0.02)
                if stage == "missing":
                    objects = json.loads(subprocess.check_output(["pw-dump"], env=environment, text=True, timeout=5))
                    target = next(item["id"] for item in objects
                                  if item.get("info", {}).get("props", {}).get("node.name") == "Polly-Test-B")
                    subprocess.run(["pw-cli", "destroy", str(target)], env=environment, check=True,
                                   stdout=subprocess.DEVNULL, timeout=5)
                result = subprocess.run([*sys.argv[1:], "audio-profile", stage], env=environment, text=True,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=50)
                if (result.returncode or f"PASS: audio persistence {stage}" not in result.stdout
                        or any(marker in result.stdout for marker in ("FAIL:", "Uncaught", "AddressSanitizer", "runtime error:"))):
                    print(result.stdout)
                    raise SystemExit(f"Audio persistence failed: {stage}")
            finally:
                audio.terminate()
                try:
                    audio.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    audio.kill()
                    audio.wait()
    print("PASS: audio preferences restore across fresh private PipeWire and compositor sessions")
