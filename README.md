# PollyUI

A cross-platform UI framework: write your UI in **JavaScript**, lay it out with
**Flexbox**, render it with **Skia**, and run it as a native app on **Windows,
macOS, and Linux**.

```js
const box = document.createElement('view');
box.style.width = 200;
box.style.height = 120;
box.style.backgroundColor = '#3b82f6';
document.body.appendChild(box);
```

## Architecture

PollyUI is built from five cooperating engines (host & engines in **C11**):

- **ScriptEngine** — [QuickJS](https://github.com/quickjs-ng/quickjs) runs your JS.
- **Model (DOM)** — a retained, DOM-like node tree exposed to JS; the shared
  source of truth.
- **LayoutEngine** — [Yoga](https://www.yogalayout.dev/) computes Flexbox geometry.
- **RenderEngine** — [Skia](https://skia.org/) paints the tree on the GPU.
- **HostEngine** — the per-OS layer: window, GPU surface, input, event loop.

The full design — layering, the JS↔native bridge, lifetimes, threading, and the
build plan — lives in **[DESIGN.md](./DESIGN.md)**. Read that first.

## Status

The Windows and **macOS** vertical slices are **working** — `pollyui app.js`
runs real, interactive, GPU-accelerated UIs from plain JavaScript (Windows via
ANGLE/D3D11; macOS via SDL3 + Skia **Metal**). Implemented:

- **Pipeline** — JS (QuickJS) → DOM bridge → Yoga Flexbox → Skia → **GPU
  (ANGLE / D3D11)**, per-monitor **DPI-aware**, with a CPU-raster fallback.
- **Layout** — `flexDirection`, `flexGrow`, `flexWrap`, `justifyContent`/
  `alignItems`, px/%/auto sizes, per-edge `padding`/`margin`, `position:absolute`.
- **Text** — Skia + DirectWrite, measured into layout; `measureText()`.
- **Input** — clicks (hit-test + bubbling), keyboard + `tabIndex` focus + Tab,
  a **text field with a blinking caret**.
- **Concurrency** — `Worker` (JS on a worker thread) + `computeAsync` (native
  background work), results marshaled back to the UI thread.
- **Tooling** — a deterministic **headless test harness** (`--test`), a
  no-console release build, an in-process crash handler.

Demo: `js/gallery.mjs` — every Naive UI-style component on one scrollable page.
Concurrency example: `js/threads.js`. Multi-platform plan (SDL3 + embedded
Linux) in **[docs/PORTING.md](./docs/PORTING.md)**; full feature matrix in
**[ROADMAP.md](./ROADMAP.md)** (architecture in [DESIGN.md](./DESIGN.md)).

## Building

Windows, with CMake ≥ 3.25, Ninja, and LLVM/clang-cl (against an installed
MSVC + Windows SDK).

```powershell
./tools/fetch_skia.ps1     # one-time: download prebuilt Skia (gitignored)
./tools/build.ps1          # configure + build (sets up the MSVC env)
./tools/fetch_angle.ps1    # stage ANGLE DLLs for GPU (from installed Chrome/Edge)
./tools/build.ps1 -Run     # build then open the built-in demo window

# the component gallery (interactive: buttons, toggles, tabs, ...)
./build/win-clang/pollyui.exe js/gallery.mjs

# headless test: no window, no OS input — deterministic (host.click/pixel/save)
./build/win-clang/pollyui.exe --test tests/smoke.js
```

Rendering is **GPU-accelerated** via Skia Ganesh → **ANGLE** (GLES → D3D11) — the
standard Windows path, which works even where native OpenGL doesn't (remote/VM
sessions). It falls back to a CPU raster surface if ANGLE is unavailable.

The app is **per-monitor DPI-aware** — JS authors in logical pixels, Skia renders
crisp at physical resolution. For a release GUI build with no console window:

```powershell
./tools/build.ps1   # (or configure the windowed preset directly:)
cmake --preset win-clang-windowed && cmake --build --preset win-clang-windowed
```

QuickJS (quickjs-ng) is vendored under `third_party/quickjs`; Skia is fetched by
the script above.

### macOS (experimental — SDL3 host)

The macOS backend is **working** (verified on Apple Silicon): an SDL3 host plus a
Skia **Metal** GPU surface, with a native title bar and clean live resize. The
shared engine (JS, DOM, Yoga, Skia draw calls) is identical to Windows; only the
host (`src/host/sdl/window_sdl.c`) and the Metal surface
(`src/render/skia_metal.mm`) are macOS-specific. Two build modes:

- **CPU raster** (default) — works with the fetched prebuilt Skia, no GPU.
- **GPU Metal** (`--metal`) — real GPU acceleration; needs a Metal-enabled Skia
  you build once with `tools/build_skia_metal.sh` (see below).

**Default build (CPU raster, works with the prebuilt Skia):**

```bash
# tools (Xcode command-line tools must already be installed)
brew install cmake ninja sdl3

# one shot: fetch Skia, configure, build (mirrors tools/build.ps1 on Windows)
chmod +x tools/build.sh tools/fetch_skia.sh
./tools/build.sh                # add --clean to wipe, --run to launch after

# run
./build/mac-sdl/pollyui js/gallery.mjs          # interactive demo
./build/mac-sdl/pollyui --test tests/smoke.js   # headless test
```

`tools/build.sh` auto-fetches the matching prebuilt Skia, then configures +
builds the `mac-sdl-metal` preset. The equivalent manual steps:

```bash
./tools/fetch_skia.sh           # prebuilt Skia -> third_party/skia
cmake --preset mac-sdl-metal
cmake --build --preset mac-sdl-metal
```

The pinned aseprite/skia prebuilt has the **GL** backend but **not Metal**, so
the default build renders on the **CPU** (a raster surface blitted via
`SDL_Renderer`). It runs, just not GPU-accelerated.

**GPU Metal build (optional — real GPU acceleration):**

The pinned prebuilt has no Metal, so for GPU you build a Metal-enabled Skia of
the **same version** (ABI-compatible with the vendored headers) and point the
build at it:

```bash
# 1. compile a Metal Skia from source (heavy: clones Skia + deps, ~20-60 min)
./tools/build_skia_metal.sh
#    -> prints SKIA_LIB_DIR=<skia>/out/Release-metal-arm64

# 2. build PollyUI against it with the Metal backend
./tools/build.sh --metal --skia-dir <skia>/out/Release-metal-arm64
```

`-DPU_METAL=ON` (set by `--metal`) compiles `skia_metal.mm` and links the Metal
frameworks; the host then renders to a `CAMetalLayer` via Skia Ganesh/Metal and
presents in lockstep with live resize (`presentsWithTransaction`).

`-DPU_METAL=ON` compiles `skia_metal.mm` and links the Metal frameworks; the
host then creates a `CAMetalLayer`-backed GPU surface (Skia Ganesh/Metal).

Full plan and seam-by-seam details: **[docs/PORTING.md](./docs/PORTING.md)**.

### Linux (experimental - native Alpine/musl build, CPU raster)

The Linux path uses SDL3, Skia CPU drawing, and Fontconfig/FreeType system fonts.
The native source recipe pins Skia to
`08a5439a6be726021c1c1905d23ce298a3edc5e4`, matching m124, and uses Clang 18
(newer Clang removed intrinsics used by this Skia revision). GN, the compiler,
font libraries and codecs all come from the target Linux distribution.
No glibc Skia/GN binaries are downloaded for Alpine.

The easiest Windows development path uses the existing WSL/Podman environment:

```powershell
.\desktop\tools\test-linux-runtime.ps1
.\desktop\tools\test-linux-runtime.ps1 -Nested
.\desktop\tools\test-linux-runtime.ps1 -Nested -Sanitize
```

The first invocation builds the `runtime` stage of `desktop/Containerfile`,
including Skia; later invocations reuse that image layer. `-Nested` runs an
actual PollyUI window on WSLg, then inside PollyWM, and checks successful frame
presentation and clean shutdown. The normal compositor-only helper remains
`desktop/tools/test-wsl.ps1` and builds only the lightweight `compositor` stage.

For a native Alpine 3.24 development machine:

```sh
apk add build-base cmake ninja pkgconf git python3 gn clang18 bash sdl3-dev \
    fontconfig-dev freetype-dev libpng-dev libjpeg-turbo-dev libwebp-dev zlib-dev \
    font-dejavu font-noto-cjk font-noto-emoji

# Build as a normal user, from the repository root:
sh desktop/tools/build-skia-linux.sh "$PWD/third_party/skia-linux"
bash tools/build.sh
./build/linux-sdl/pollyui desktop/shell/preview.mjs
sh desktop/tests/runtime-headless.sh "$PWD/build/linux-sdl/pollyui"
```

`PU_BUILD_JOBS` controls Skia compilation concurrency (default 2).
`--skia-root` and `--skia-dir` select a matching source/header root and library
directory when using `tools/build.sh`. These also map to CMake's `SKIA_ROOT`
and `SKIA_LIB_DIR`. A missing Linux library is an error, not an automatic
download of a potentially incompatible prebuilt. The checkout is revision-checked;
the recipe does not promise bit-for-bit reproducibility of rolling distro packages.

The Linux profile includes PNG, JPEG and WebP support through system libraries.
It omits PDF, SVG, GIF/Wuffs, ICU and HarfBuzz integrations not used by the current
PollyUI draw path. Font fallback includes installed CJK/emoji faces, but is not
complex-script shaping or an IME implementation.

**Rendering boundary:** Skia draws on the CPU. SDL may use a GPU to present the
result, which does not make this a Skia GPU backend. Linux EGL/GLES integration,
full input/IME support, native HTTP and XDG per-application storage remain work
items. Set `PU_TRACE_STARTUP=1` to log the first successfully presented SDL frame
and its video driver/rendering path. Missing fonts, failed window creation and
failed SDL presentation return errors rather than reporting a working blank app.
Native DOM callbacks and font/render caches are released explicitly at shutdown;
the bridge must be freed before its JavaScript runtime.
The headless harness accepts `PU_TEST_STORAGE` for isolated test data; its default
is `build/_localstorage.dat`.
`-Sanitize` instruments PollyUI, QuickJS and Yoga with ASan/UBSan while reusing
the Release Skia dependency. It is not a sanitizer build of Skia itself.

## Experimental Linux desktop

**[PollyDesktop](./desktop/README.md)** is a separately buildable Linux subproject:
our own wlroots-based Wayland compositor, without labwc or a GNOME/KDE desktop.
It implements native client windows, focus, interactive move/resize,
maximize/fullscreen/restore, output-aware placement and popup constraints.
The subproject also includes a native PollyUI appearance preview with selectable
XP, Server 2003 Classic, OS X Aqua, Lion and Big Sur-inspired original themes:
`pollyui desktop/shell/preview.mjs`. Its sample shell/windows are simulated;
theme selection does not yet change PollyWM or other applications.
PollyUI shell integration and an Alpine system image
are later stages, not implemented desktop features. See the desktop guide for
the architecture, roadmap, standalone build and WSL/WSLg checks.

## License

TBD.
