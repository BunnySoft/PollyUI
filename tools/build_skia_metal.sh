#!/usr/bin/env bash
# Build a Metal-enabled Skia (matching PollyUI's vendored m124 headers) on macOS.
#
# The aseprite/skia prebuilt that tools/fetch_skia.sh downloads has GL but NOT
# Metal. This compiles the SAME Skia commit from source with skia_use_metal=true,
# so its libskia.a is ABI-compatible with the headers already in third_party/skia.
#
#   ./tools/build_skia_metal.sh                 # builds for the host arch
#   SKIA_SRC=~/skia ./tools/build_skia_metal.sh # use/keep a specific checkout
#
# Then build PollyUI against it:
#   ./tools/build.sh --metal --skia-dir <printed SKIA_LIB_DIR>
#
# Heavy: clones Skia + deps (~GBs) and compiles (~20-60 min the first time).
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS only (Metal)."; exit 1; }
command -v git    >/dev/null || { echo "git required"; exit 1; }
command -v python3>/dev/null || { echo "python3 required"; exit 1; }

# Same commit as the pinned prebuilt (m124-08a5439a6b) so headers match.
SKIA_COMMIT="${SKIA_COMMIT:-08a5439a6b}"
SKIA_REPO="${SKIA_REPO:-https://github.com/aseprite/skia.git}"
SKIA_SRC="${SKIA_SRC:-$HOME/skia-metal-src}"

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  *)             ARCH="x64"   ;;
esac
OUT="out/Release-metal-${ARCH}"

echo "==> Skia source: $SKIA_SRC  (commit $SKIA_COMMIT, $ARCH)"
if [[ ! -d "$SKIA_SRC/.git" ]]; then
  git clone "$SKIA_REPO" "$SKIA_SRC"
fi
cd "$SKIA_SRC"
git fetch --all --tags --quiet || true
git checkout "$SKIA_COMMIT" 2>/dev/null || git checkout "m124-${SKIA_COMMIT}" 2>/dev/null || \
  { echo "Could not checkout $SKIA_COMMIT; using current HEAD"; }

echo "==> syncing third-party deps (tools/git-sync-deps)"
python3 tools/git-sync-deps

echo "==> fetching gn + ninja"
python3 bin/fetch-gn
python3 bin/fetch-ninja

# Mirror the prebuilt's args.gn (self-contained, freetype+harfbuzz) and turn
# Metal ON. Keep the macOS deployment target/c++ flags identical for ABI match.
ARGS="is_debug=false is_official_build=true \
skia_use_metal=true \
skia_use_system_expat=false skia_use_system_icu=false \
skia_use_system_libjpeg_turbo=false skia_use_system_libpng=false \
skia_use_system_libwebp=false skia_use_system_zlib=false \
skia_use_freetype=true skia_use_harfbuzz=true skia_pdf_subset_harfbuzz=true \
skia_use_system_freetype2=false skia_use_system_harfbuzz=false \
target_cpu=\"${ARCH}\" \
extra_cflags=[\"-stdlib=libc++\",\"-mmacosx-version-min=11.0\"] \
extra_cflags_cc=[\"-frtti\"]"

echo "==> gn gen $OUT"
bin/gn gen "$OUT" --args="$ARGS"

echo "==> ninja (this takes a while)"
third_party/ninja/ninja -C "$OUT" skia

LIBDIR="$SKIA_SRC/$OUT"
if [[ -f "$LIBDIR/libskia.a" ]]; then
  echo ""
  echo "==> Metal Skia ready."
  echo "    SKIA_LIB_DIR=$LIBDIR"
  echo ""
  echo "Build PollyUI with Metal:"
  echo "    ./tools/build.sh --metal --skia-dir \"$LIBDIR\""
else
  echo "Build finished but libskia.a not found in $LIBDIR" >&2
  exit 1
fi
