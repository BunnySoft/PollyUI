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

The Windows vertical slice is **working** — `pollyui app.js` runs real,
interactive, GPU-accelerated UIs from plain JavaScript. Implemented:

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

The macOS backend is **scaffolded** (SDL3 host + an opt-in Skia **Metal**
surface) and selectable via CMake, but is **not yet verified on hardware** —
treat it as a starting point. The shared engine (JS, DOM, Yoga, Skia draw calls)
is identical to Windows; only the host (`src/host/sdl/window_sdl.c`) and the
Metal surface (`src/render/skia_metal.mm`) are new.

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

## License

TBD.
