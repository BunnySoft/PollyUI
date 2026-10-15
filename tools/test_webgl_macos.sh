#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="${1:-$root/build/mac-webgl}"
evidence="${2:-$root/build/mac-webgl-evidence}"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "ERROR: native macOS execution is required; another OS cannot qualify Metal." >&2
  exit 1
fi
mkdir -p "$evidence"
evidence="$(cd "$evidence" && pwd)"
build="$(cd "$build" && pwd)"
if [[ ! -f "$root/gui/tests/gpu/node_modules/three/build/three.module.js" ]]; then
  echo "ERROR: missing manifest-pinned Three.js dependency; restore gui/tests/gpu with npm ci." >&2
  exit 1
fi
stage="$build/gui/polly-angle"
python3 - "$stage" <<'PY'
import hashlib, json, pathlib, sys
stage = pathlib.Path(sys.argv[1])
receipt = json.loads((stage / "build-receipt.json").read_text())
for name, item in receipt["stagedDylibs"].items():
    if hashlib.sha256((stage / name).read_bytes()).hexdigest() != item["sha256"]:
        raise RuntimeError("Staged native dylib differs from build receipt: " + name)
for name, expected in receipt["licenses"].items():
    if hashlib.sha256((stage / "licenses" / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError("Original dependency license differs: " + name)
PY
previous_set="${PU_WEBGL2_DEVICE+x}"
previous="${PU_WEBGL2_DEVICE-}"
restore() {
  if [[ -n "$previous_set" ]]; then export PU_WEBGL2_DEVICE="$previous"
  else unset PU_WEBGL2_DEVICE; fi
}
trap restore EXIT
export PU_WEBGL2_DEVICE=hardware
cd "$root"
node gui/tests/gpu/capture-receipt.mjs "$root" "$build" "$evidence/compiled-inputs.json" "" \
  e6997e632cefe51ac2dd6046d8e644083f8faa9b
cp "$stage/build-receipt.json" "$evidence/angle-native-build.json"
shasum -a 256 "$build/gui/pollyui-gpu-device-test" "$build/gui/pollyui-gpu-metal-current-test" \
  "$build/gui/pollyui-gpu-current-test" "$build/gui/pollyui-gpu-test" \
  "$build/gui/pollyui-canvas-test" >"$evidence/native-binaries.sha256"
set +e
"$build/gui/pollyui-gpu-device-test" --metal-required --strict >"$evidence/native-device.log" 2>&1
result=$?
set -e
cat "$evidence/native-device.log"
if [[ "$result" == 77 ]]; then
  "$build/gui/pollyui-gpu-test" "$root/gui/tests/gpu-unavailable.mjs" --unavailable \
    >"$evidence/no-metal-2d.log" 2>&1
  echo "SKIP: native Metal inventory has no accessible GPU. Core/Three positive cases NOT RUN."
  echo "Compilation and no-GPU/2D evidence do not certify Metal pixels or physical hardware."
  exit 77
fi
if [[ "$result" != 0 ]]; then
  echo "ERROR: native runtime/ABI/device selection failed, not an unavailable-hardware SKIP." >&2
  exit "$result"
fi
for hint in --low-power --high-performance; do
  "$build/gui/pollyui-gpu-device-test" --hardware --strict "$hint" >"$evidence/$hint.log" 2>&1
done
"$build/gui/pollyui-gpu-current-test" >"$evidence/owning-egl.log" 2>&1
"$build/gui/pollyui-gpu-metal-current-test" >"$evidence/owning-metal.log" 2>&1
for fixture in gpu.mjs gpu-core.mjs gpu-api.mjs gpu-transfer.mjs gpu-state.mjs gpu-uniform.mjs gpu-review.mjs gpu-three.mjs; do
  "$build/gui/pollyui-gpu-test" "$root/gui/tests/$fixture" >"$evidence/$fixture.log" 2>&1
done
"$build/gui/pollyui-canvas-test" "$root/gui/tests/canvas.mjs" >"$evidence/canvas2d.log" 2>&1
echo "PASS: native-queried Metal GPU, real core/mip/pixel/Three/current/lifetime/2D fixtures."
echo "Physical machine/GPU qualification remains separate; MTLDevice is not proof of non-virtualization."
