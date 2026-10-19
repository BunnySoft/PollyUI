#!/bin/bash
# Build a Pixman-only wlroots + tinywl in the Polly Debian SDK.
#
# This is an experiment, not a supported production build entry. It reuses the
# patched wlroots source in /opt/wlroots-0.19.3, removes the DRM DMABUF guard,
# and builds with no GLES/Vulkan/GBM allocator.
#
# Usage:
#   SDK_IMAGE=localhost/polly-debian-sdk EXP_DIR=$PWD/build/pixman-exp \
#     bash desktop/tools/experiments/pixman-build.sh
set -euo pipefail

SDK_IMAGE=${SDK_IMAGE:-localhost/polly-debian-sdk}
EXP_DIR=${EXP_DIR:-$PWD/build/pixman-exp}
EFFECTS_SHA=${EFFECTS_SHA:-7b58c4a0c4c8a0cfac4ab8016f1f3590b463d961405102fbe133e0054fcebf0e}

mkdir -p "$EXP_DIR"
podman run --rm --pull=never --network=none \
  -v "$EXP_DIR:/exp" "$SDK_IMAGE" sh -c '
set -e
cp -a /opt/wlroots-0.19.3 /exp/src
python3 - <<PY
from pathlib import Path
p = Path("/exp/src/backend/drm/renderer.c")
t = p.read_text()
old = """\tif (wlr_renderer_get_texture_formats(renderer->wlr_rend, WLR_BUFFER_CAP_DMABUF) == NULL) {
\t\twlr_log(WLR_ERROR, \"Renderer did not support importing DMA-BUFs\");
\t\twlr_renderer_destroy(renderer->wlr_rend);
\t\trenderer->wlr_rend = NULL;
\t\treturn false;
\t}
"""
if old not in t:
    raise SystemExit("DMABUF guard not found")
p.write_text(t.replace(old, "", 1))
PY
meson setup /exp/build /exp/src --prefix=/exp/prefix --libdir=lib --buildtype=release \
  --wrap-mode=nofallback -Dexamples=true -Dxwayland=disabled \
  -Dbackends=drm,libinput -Drenderers= -Dallocators= \
  -Dpolly-effects-sha256='"$EFFECTS_SHA"' > /exp/setup.log 2>&1
ninja -C /exp/build > /exp/build.log 2>&1
ninja -C /exp/build install > /exp/install.log 2>&1
'
echo "Pixman-only wlroots built in $EXP_DIR"
