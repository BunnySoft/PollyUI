#!/usr/bin/env python3
"""Exercise the real native selector without performance sampling."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

program = str(Path(sys.argv[1]).resolve())
supported = subprocess.check_output([program, "--supports-experimental"], text=True).strip() == "1"
cases = [(None, "production-single-output"), ("0", "production-single-output"),
         ("1", "experimental-four-phase" if supported else None),
         ("", None), ("true", None), ("false", None), ("2", None), ("01", None), (" 1", None)]
for value, backend in cases:
    with tempfile.TemporaryDirectory(prefix="polly-fir-selector-") as temporary:
        runtime = Path(temporary) / "runtime"
        runtime.mkdir(mode=0o700)
        env = dict(os.environ, XDG_RUNTIME_DIR=str(runtime), WLR_BACKENDS="headless",
                   WLR_HEADLESS_OUTPUTS="1", WLR_RENDERER="pixman", PU_RENDERER="raster")
        env.pop("POLLY_EXPERIMENTAL_FIR", None)
        if value is not None:
            env["POLLY_EXPERIMENTAL_FIR"] = value
        result = subprocess.run([program], env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, timeout=10)
        if backend:
            assert result.returncode == 0, result.stdout
            assert f"Backdrop FIR backend: {backend} " in result.stdout, result.stdout
            assert f"Backdrop FIR executing: {backend}" in result.stdout, result.stdout
            assert "PASS: real backdrop filtered" in result.stdout, result.stdout
            assert "[ERROR]" not in result.stdout, result.stdout
            unexpected = "experimental-four-phase" if value != "1" else "production-single-output"
            assert f"Backdrop FIR executing: {unexpected}" not in result.stdout, result.stdout
        else:
            assert result.returncode == 1, result.stdout
            expected = "requires x86-64 SSE2" if value == "1" else "must be exactly 0 or 1"
            assert expected in result.stdout, result.stdout
            assert "Backdrop FIR executing:" not in result.stdout, result.stdout
        print(f"PASS: POLLY_EXPERIMENTAL_FIR={value!r} backend={backend!r} exit={result.returncode}")
print("PASS: native FIR default/disabled/enabled/invalid/architecture and scene-lifetime selection")
