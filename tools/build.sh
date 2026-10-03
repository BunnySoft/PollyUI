#!/usr/bin/env bash
# PollyUI build driver for macOS / Linux (the bash counterpart of build.ps1).
# Ensures Skia is present, then configures + builds the SDL3 host with Ninja.
#
#   ./tools/build.sh                 # configure + build (CPU raster, default)
#   ./tools/build.sh --clean         # wipe the build dir first
#   ./tools/build.sh --metal         # macOS: GPU Metal backend (-DPU_METAL=ON)
#   ./tools/build.sh --skia-dir DIR  # use a specific Skia out/ dir
#   ./tools/build.sh --skia-root DIR # matching Skia source/header directory
#   ./tools/build.sh --run           # launch the demo afterward
#   ./tools/build.sh --run js/gallery.mjs   # run with a JS app
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

clean=0
run=0
metal=0
skia_dir=""
skia_root="${SKIA_ROOT:-}"
run_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)    clean=1; shift ;;
    --metal)    metal=1; shift ;;
    --run)      run=1; shift; run_args=("$@"); break ;;
    --skia-dir) skia_dir="${2:?--skia-dir needs a path}"; shift 2 ;;
    --skia-root) skia_root="${2:?--skia-root needs a path}"; shift 2 ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# --- toolchain checks --------------------------------------------------------
for tool in cmake ninja; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Required tool not found: $tool (install the native build dependencies)" >&2; exit 1; }
done

case "$(uname -s)" in
  Darwin) os="macos";  preset="mac-sdl-metal"; builddir="$repo/build/mac-sdl"; arch_dir="Release-$([[ $(uname -m) == arm64 ]] && echo arm64 || echo x64)" ;;
  Linux)  os="linux";  preset="";              builddir="$repo/build/linux-sdl"; arch_dir="Release-linux" ;;
  *) echo "Unsupported OS: $(uname -s) (use tools/build.ps1 on Windows)" >&2; exit 1 ;;
esac

if [[ "$os" == "linux" && "$metal" == 1 ]]; then
  echo "--metal is only supported on macOS" >&2
  exit 2
fi

# --- ensure Skia -------------------------------------------------------------
if [[ -z "$skia_root" ]]; then
  if [[ "$os" == "linux" ]]; then skia_root="$repo/third_party/skia-linux"
  else skia_root="$repo/third_party/skia"; fi
fi
if [[ -z "$skia_dir" ]]; then
  skia_dir="$skia_root/out/$arch_dir"
fi
if [[ ! -f "$skia_dir/libskia.a" ]]; then
  if [[ "$os" == "linux" ]]; then
    echo "Native Linux Skia missing: $skia_dir/libskia.a" >&2
    echo "Build it with: sh desktop/tools/build-skia-linux.sh \"$skia_root\"" >&2
    exit 1
  fi
  echo "==> Skia not found at $skia_dir — fetching"
  "$here/fetch_skia.sh"
fi
[[ -f "$skia_dir/libskia.a" ]] || { echo "Skia still missing at $skia_dir" >&2; exit 1; }

# --- clean -------------------------------------------------------------------
if [[ "$clean" == 1 ]]; then
  echo "==> cleaning $builddir"
  rm -rf "$builddir"
fi

cd "$repo"

# --- configure ---------------------------------------------------------------
cmake_args=(-DSKIA_LIB_DIR="$skia_dir" -DSKIA_ROOT="$skia_root")
[[ "$metal" == 1 ]] && cmake_args+=(-DPU_METAL=ON)

echo "==> configure"
if [[ -n "$preset" ]]; then
  cmake --preset "$preset" "${cmake_args[@]}"
else
  cmake -S "$repo" -B "$builddir" -G Ninja \
        -DCMAKE_BUILD_TYPE=RelWithDebInfo -DPU_HOST=sdl "${cmake_args[@]}"
fi

# --- build -------------------------------------------------------------------
echo "==> build"
if [[ -n "$preset" ]]; then
  cmake --build --preset "$preset"
else
  cmake --build "$builddir"
fi

exe="$builddir/pollyui"
echo "==> built: $exe"

# --- run ---------------------------------------------------------------------
if [[ "$run" == 1 ]]; then
  echo "==> running"
  "$exe" "${run_args[@]}"
fi
