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

Demos: `js/components.js` (gallery), `js/counter.js`, `js/textfield.js`,
`js/threads.js`. Planned next: macOS/Linux ports, `requestAnimationFrame`, text
selection. Full implemented-vs-planned list in **[DESIGN.md](./DESIGN.md) §10**.

## Building

Windows, with CMake ≥ 3.25, Ninja, and LLVM/clang-cl (against an installed
MSVC + Windows SDK).

```powershell
./tools/fetch_skia.ps1     # one-time: download prebuilt Skia (gitignored)
./tools/build.ps1          # configure + build (sets up the MSVC env)
./tools/fetch_angle.ps1    # stage ANGLE DLLs for GPU (from installed Chrome/Edge)
./tools/build.ps1 -Run     # build then open the built-in demo window

# the component gallery (interactive: buttons, toggles, tabs, ...)
./build/win-clang/pollyui.exe js/components.js

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

## License

TBD.
