#!/usr/bin/env python3
"""Validate only software GLES shader primitives, not DRM/whole-WM qualification."""
from importlib.util import module_from_spec, spec_from_file_location
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

repo = Path(__file__).resolve().parents[2]
spec = spec_from_file_location("effects", repo / "desktop/release/debian/apply-wlroots-effects.py")
effects = module_from_spec(spec)
spec.loader.exec_module(effects)
with tempfile.TemporaryDirectory(prefix="polly-effects-gles-") as temporary:
    with tarfile.open("/opt/wlroots-0.19.3.tar.gz") as archive:
        archive.extractall(temporary, filter="data")
    source = Path(temporary) / "wlroots-0.19.3"
    effects.apply(source)
    shaders = source / "render/gles2/shaders"
    result = subprocess.run([sys.argv[1], str(shaders / "common.vert"), str(shaders / "quad.frag")],
                            env=dict(os.environ, LIBGL_ALWAYS_SOFTWARE="true", EGL_PLATFORM="surfaceless"),
                            timeout=30)
    raise SystemExit(result.returncode)
