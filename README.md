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

🚧 Early development (Windows-first vertical slice). Working so far:

- **M0** — Win32 window rendered by a Skia raster surface.
- **M1** — embedded QuickJS: runs a `.js` file with `console`, timers, promises.
- **M2** — DOM Model + bridge: JS builds a retained native node tree
  (`document.createElement`, `style`, `appendChild`, …) with GC-safe lifetimes.
- **M3** — Yoga layout + Skia paint: the full pipeline (JS → DOM → layout → paint).
- **M4** — text rendering (Skia + DirectWrite), measured into the layout.
- **M5** — input: `addEventListener('click', …)` with hit-testing + bubbling.
- **+** — `position: absolute` insets, so views can overlap.

So `pollyui app.js` now runs real interactive UIs with text and clicks. See
`js/counter.js`. Next: `requestAnimationFrame` + animation, then **M6**
macOS/Linux host ports. See `DESIGN.md` §10.

## Building

Windows, with CMake ≥ 3.25, Ninja, and LLVM/clang-cl (against an installed
MSVC + Windows SDK).

```powershell
./tools/fetch_skia.ps1     # one-time: download prebuilt Skia (gitignored)
./tools/build.ps1          # configure + build (sets up the MSVC env)
./tools/build.ps1 -Run     # build then open the built-in demo window

# the component gallery (interactive: buttons, toggles, tabs, ...)
./build/win-clang/pollyui.exe js/components.js

# headless test: no window, no OS input — deterministic (host.click/pixel/save)
./build/win-clang/pollyui.exe --test tests/smoke.js
```

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
