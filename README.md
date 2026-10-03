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
- **Input** — pointer buttons/modifiers, two-axis wheels, physical keyboard
  events separate from committed text, `tabIndex` focus with Tab/Shift+Tab,
  and text fields with a blinking caret.
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
The Windows driver discovers the latest installed C++ toolchain through
`vswhere`, including Community/Professional/Enterprise installations.

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

### Linux (experimental - native Alpine/musl build, EGL/GLES and raster)

The Linux path uses SDL3, Skia Ganesh GLES or CPU drawing, and Fontconfig/FreeType system fonts.
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
    fontconfig-dev freetype-dev libpng-dev libjpeg-turbo-dev libwebp-dev zlib-dev curl-dev \
    font-dejavu font-noto-cjk font-noto-emoji nodejs openssl

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

**Renderer selection:** `PU_RENDERER=auto` (default) attempts an SDL-owned
EGL/GLES 3 context and falls back to raster with a diagnostic if creation fails.
`PU_RENDERER=gl` requires GLES and fails rather than silently falling back;
`PU_RENDERER=raster` keeps CPU drawing. SDL may itself use a GPU to present raster
pixels, which is distinct from Skia GLES drawing.

The GLES implementation reports its renderer string. Automated WSL checks use
Mesa **llvmpipe**, a software GL implementation, not proof of physical GPU
acceleration. Physical GPU/DRM support still needs separate qualification.
IME preedit/complex text and physical-device qualification remain work items.
Set `PU_TRACE_STARTUP=1` to log the first successfully presented SDL frame,
or `PU_TRACE_FRAMES=1` for every frame. Linux-only `PU_CAPTURE_FRAME=<path.png>`
writes the latest rendered frame (including GLES readback) for diagnostics;
it is off by default and adds synchronous readback/file I/O when enabled.
Missing fonts, failed window creation and
failed SDL presentation return errors rather than reporting a working blank app.
Native DOM callbacks and font/render caches are released explicitly at shutdown;
the bridge must be freed before its JavaScript runtime.
The headless harness accepts `PU_TEST_STORAGE` for isolated test data; its default
is `build/_localstorage.dat`.
`-Sanitize` instruments PollyUI, QuickJS and Yoga with ASan/UBSan while reusing
the Release Skia dependency. It is not a sanitizer build of Skia itself.

### Continuous integration

`.github/workflows/ci.yml` defines Windows native, macOS CPU-raster, and Alpine
runtime/compositor jobs for pushes and pull requests. Actions are pinned by
commit, repository permissions are read-only, and checkout credentials are not
persisted. The Alpine image caches the native Skia build; runtime sources are
compiled separately in ordinary and ASan/UBSan builds.

Linux checks include real Wayland clients connected to headless PollyWM, with
raster/GLES pixel checks using software Mesa. No WSLg, physical GPU or privileged
container is needed. This is not DRM, Metal or ANGLE hardware qualification.
The workflow must be pushed with an authorized account to execute on GitHub;
local checks do not establish that the macOS or hosted-runner jobs passed.

The Windows/macOS core test runners share `tools/core-tests.txt`; the repeated
storage test intentionally checks persistence across processes:

```powershell
.\tools\test-core.ps1
```

```sh
sh tools/test-core.sh "$PWD/build/mac-sdl/pollyui"
```

`desktop/tools/check-linux-runtime.sh build/linux-ci [--sanitize]` runs the
Alpine build and headless engine/compositor checks **inside the runtime image**.
The WSL runtime helper also exercises real clients on headless PollyWM by
default; `-Nested` additionally covers the parent WSLg display. To run the same
display-independent client checks directly inside the image:

```sh
sh desktop/tests/runtime-wayland.sh "$PWD/build/linux-ci/pollyui" \
    "$PWD/build/linux-ci/desktop/pollywm" --headless
```

### Input event contract

Native host callbacks now take the structs in `src/host/input.h` rather than
positional key/pointer arguments. Both Win32 and SDL hosts use the same contract:
`keydown`/`keyup` carry `key`, `code`, `repeat` and modifier booleans;
`textinput` carries committed UTF-8 as `event.data`. Unknown physical codes are
reported as `Unidentified`. Hosts suppress a key's following text commit when
its keydown default action is prevented. Tab is dispatched before focus traversal;
Shift+Tab reverses it, hidden nodes are skipped, and `preventDefault()` cancels it.

Text editors should insert from `textinput`, not from `keydown`; keydown remains
for navigation, deletion and shortcuts. The bundled inputs have been migrated.
They preserve surrogate pairs when moving/deleting, but do not yet implement
grapheme-cluster editing, IME preedit/candidate UI or full input-method protocols.

Pointer events expose fractional `clientX/clientY`, `button`, `buttons` and
modifiers. Only the primary button generates `click`; secondary release generates
`contextmenu`, other buttons `auxclick`. `button` is -1 for motion, otherwise
left/middle/right/back/forward = 0/1/2/3/4; `buttons` uses masks 1/4/2/8/16.
Wheel deltas are logical pixels (`deltaMode=0`), with both `deltaX` and `deltaY`;
`preventDefault()` cancels the nearest scroll container's default scrolling.

The headless harness keeps `host.key('a')` as keydown plus a convenient text
commit. `host.key('a', 'keydown', {code:'KeyA', ctrlKey:true, repeat:true,
text:false})` sends a physical event only. `host.text('text')` submits a whole
string. `host.mouse(type,x,y,{button,buttons,...modifiers})` and
`host.scroll(x,y,deltaY,deltaX,{...modifiers})` expose richer pointer/wheel input.
`tests/input-events.mjs`, `tests/pointer-events.mjs` and the Linux SDL adapter
test cover these contracts; the latter queues synthetic SDL events and is not
physical-device or locale-layout qualification.

### HTTP and application data

`fetch(url, {method, body, headers})` uses libcurl on Linux and WinHTTP on Windows.
It accepts HTTP(S) and the existing `file://` local-read form, returns status,
2xx-only `ok`, final `url`, `text()` and `json()`, and preserves UTF-8/NUL in
request/response strings. Request headers are a plain object: names are
case-insensitive (last value wins), invalid fields and transport-managed framing
headers are rejected. Body, when supplied, must be a string.

Requests without custom headers follow up to ten redirects; requests with
custom headers return the redirect response instead of forwarding headers to an
unexpected destination. Linux HTTPS verifies certificates and hostnames;
requests starting with HTTPS cannot redirect to HTTP. `PU_CA_BUNDLE` selects an explicit Linux trust bundle;
it does not disable verification. Linux has a 10-second connection and 30-second
total timeout; WinHTTP operations have 10-second timeouts.
This is not a full browser Fetch implementation: response-header/stream/blob
APIs and AbortController are not implemented, and unsupported `signal`,
`redirect`, `credentials`, `mode` and `cache` options fail explicitly.

Closing the application cancels/joins pending requests and compute tasks,
interrupts CPU-bound JS workers, and removes queued deliveries before destroying
the VM. OS-blocking operations may still wait for their OS/transport timeout.

Linux apps use private per-application XDG directories:

```sh
./build/linux-sdl/pollyui --app-id org.pollyui.appearance desktop/shell/preview.mjs
```

Config/data/cache live below `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME` and
`$XDG_CACHE_HOME` in `pollyui/<app-id>`; unset bases fall back to the standard
locations under `$HOME`. Bases must be absolute, IDs cannot contain path
separators, and app directories must be user-owned/private (0700).
`localStorage` is stored in the data directory. Without `--app-id`, a stable
non-cryptographic hash of the canonical script path supplies a namespace;
installed apps should always supply a stable ID. This is data separation,
**not a sandbox or encrypted secret store**. Windows/macOS retain the legacy
working-directory store and currently reject `--app-id`.

Windowed scripts receive `application.id`, `application.arguments`, and on Linux
`application.configDir/dataDir/cacheDir`. Extra command-line arguments are passed
as an array, not evaluated. The Linux ID also supplies SDL's app ID unless
`SDL_APP_ID` was explicitly set. Config/cache directories are reserved for app
services; this does not add an arbitrary filesystem-write API.

Storage reads existing `PUST1` data, supports complete strings including NUL,
and atomically replaces its file on mutation. Failed writes preserve the in-memory
store and throw; malformed existing files stop startup instead of being treated
as empty and overwritten. There is no concurrent multi-process synchronization
or automatic migration of legacy working-directory data.
Node/OpenSSL in the development image serve only local runtime fixtures;
PollyUI itself still runs QuickJS, not Node.

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
