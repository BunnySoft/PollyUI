#!/usr/bin/env bash
# Fetches the prebuilt Skia used by PollyUI into third_party/skia (gitignored).
# macOS / Linux counterpart of tools/fetch_skia.ps1. Run once after cloning.
#
#   ./tools/fetch_skia.sh                 # auto-detect OS + arch
#   ./tools/fetch_skia.sh x64             # force x64 (e.g. Rosetta)
#
# Pinned to the aseprite/skia m124 release, matching the vendored headers. NOTE:
# this prebuilt has the GL backend but NOT Metal — the default macOS build of
# PollyUI renders via the CPU raster fallback. For GPU Metal you must build Skia
# yourself with skia_use_metal=true (see README "macOS").
set -euo pipefail

TAG="${PU_SKIA_TAG:-m124-08a5439a6b}"
REPO="aseprite/skia"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
dest="$repo_root/third_party/skia"

# OS
case "$(uname -s)" in
  Darwin) os="macOS" ;;
  Linux)  os="Linux" ;;
  *) echo "Unsupported OS: $(uname -s) (use the .ps1 on Windows)"; exit 1 ;;
esac

# Arch (overridable via $1)
arch="${1:-}"
if [[ -z "$arch" ]]; then
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) echo "Unsupported arch: $(uname -m)"; exit 1 ;;
  esac
fi
# aseprite ships only x64 for Linux.
if [[ "$os" == "Linux" ]]; then arch="x64"; fi

asset="Skia-${os}-Release-${arch}.zip"
outdir="$dest/out/Release-${arch}"
url="https://github.com/${REPO}/releases/download/${TAG}/${asset}"

if [[ -f "$outdir/libskia.a" ]]; then
  echo "Skia already present: $outdir/libskia.a"
  echo "SKIA_LIB_DIR=$outdir"
  exit 0
fi

mkdir -p "$dest"
tmp="$repo_root/third_party/_skia_${arch}.zip"
echo "Downloading $url"
if command -v gh >/dev/null 2>&1; then
  gh release download "$TAG" --repo "$REPO" --pattern "$asset" --output "$tmp" --clobber
else
  curl -fL --retry 3 -o "$tmp" "$url"
fi

echo "Extracting to $dest"
# The archive contains out/Release-<arch>/... and include/..., so extract at $dest.
unzip -q -o "$tmp" -d "$dest"
rm -f "$tmp"

if [[ -f "$outdir/libskia.a" ]]; then
  echo "Skia ready."
  echo "Configure PollyUI with: -DSKIA_LIB_DIR=$outdir"
else
  echo "libskia.a not found in $outdir after extraction — unexpected archive layout." >&2
  exit 1
fi
