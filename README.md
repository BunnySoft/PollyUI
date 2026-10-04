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
    font-dejavu font-noto-cjk font-noto-emoji nodejs openssl \
    wayland-dev wayland-protocols wlr-protocols

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

### Multiple native windows

A windowed script can create additional native windows in the **same JavaScript
realm**. Each has a separate document, layout cache, DOM focus/hover state,
renderer and native event target. Timers, animation callbacks, workers, HTTP,
application identity and storage remain application-wide.

```js
const inspector = window.create({ title: 'Inspector', width: 480, height: 320 });
const label = inspector.document.createElement('text');
label.textContent = 'Shared application state, independent window';
inspector.document.body.appendChild(label);
inspector.onclose = () => console.log('Inspector closed');
```

`window.document === document` for the original window. Use the returned handle's
`document` for queries and its methods for window controls. The existing
reconciler/Vue APIs accept a container from any document; global `document`
always refers to the original document, not whichever window has OS focus.
Duplicate element IDs in different documents do not collide. Moving a focused
node between documents clears its old document's focus; document bodies cannot
be reparented.

`handle.close()` closes only that window. `handle.closed` reflects a pending or
completed close, and `onclose` runs once after native teardown. Closing the
original window does not stop the others. An `onclose` callback may create a
replacement, even for the last window. `window.quit()` closes the entire
application and prevents new windows. With no surviving/replacement windows,
the loop exits and shared background services shut down.

Retained closed-window handles/documents remain readable, but minimize/maximize,
chrome and capture operations throw after close; closing again is harmless. Native ownership, input references
and attached DOM listeners are released on close. Shared timers/workers are
not automatically cancelled by an individual close; dispose component-specific
work in `onclose`. As before, detached native/JS listener cycles are swept at
whole-runtime shutdown.

`handle.capture('frame.png')` draws and saves that window at its current native
size, before swapping the GPU buffer; it does not capture other applications or
the screen. It rejects invalid paths and not-yet-presented
or closed windows. Raster and Linux GLES readback are exercised; Metal capture
is explicitly unsupported. Windows ANGLE code binds the owning EGL context
before drawing/readback/destruction, but requires installed ANGLE runtime DLLs.

The common host loop supports Win32 and SDL3. Linux raster/GLES and Windows
raster multi-window behavior have local coverage; macOS execution and Windows
ANGLE execution require their corresponding environments/dependencies.

```powershell
node .\tools\test-multi-window.mjs .\build\win-clang\pollyui.exe
# Require GPU instead of accepting raster fallback:
node .\tools\test-multi-window.mjs .\build\win-clang\pollyui.exe --require-gpu
```

### Wayland shell surfaces

The Linux SDL host now supports native `layer-shell` surfaces alongside ordinary
xdg windows in the same process. The default Linux build enables
`PU_LAYER_SHELL`; disable it with `-DPU_LAYER_SHELL=OFF` for an ordinary-window-only
runtime. It needs Wayland client headers, `wayland-scanner`, `wayland-protocols`
and `wlr-protocols`, not a link to wlroots or the compositor.

The connection must expose layer-shell v4, viewporter and fractional-scale
protocols. PollyWM supplies these, but permits layer-shell only on the private
connection passed to an explicitly launched `--shell` program. A public
connection, unsupported host/build, or missing protocol fails explicitly;
it never substitutes an ordinary window for a requested layer.

```js
window.close(); // Do not create the default ordinary window.
const output = window.displays()[0];
const panel = window.create({
  title: 'PollyUI panel',
  layer: 'top',
  output: output.id,
  width: 0,
  height: 32,
  anchors: ['top', 'left', 'right'],
  exclusiveZone: 32,
  keyboard: 'on-demand',
});
panel.document.body.style.backgroundColor = '#254878';
```

`layer` is `background`, `bottom`, `top`, or `overlay`. Width/height and
`margins: { top, right, bottom, left }` use integer logical pixels. A zero
dimension requires both opposing anchors. `exclusiveZone` defaults to zero;
positive values reserve workspace, and -1 uses the whole output.
`keyboard` defaults to `none`; `on-demand` and `exclusive` follow the compositor's
focus policy. Layer geometry options are creation-time settings: close/recreate
the surface to change them. Minimize/maximize and title-bar controls are not
applicable to layers and throw.

`transparent: true` opts a layer into alpha composition, including a transparent
DOM viewport. Rounded docks can reveal the actual wallpaper at their corners;
this is not background blur. Transparent pixels do not automatically define a
click-through input shape: the native surface still has a rectangular input area.

`window.displays()` returns a snapshot of `{ id, name, x, y, width, height, scale }`.
IDs are host-local and nonpersistent; use current IDs for `output` and re-query
after display changes. Bounds use the host's desktop coordinates and `scale` is
its content-scale hint, not a physical display-mode configuration API. Omitting
`output` or using zero lets the compositor choose. Output removal/disable closes
its layer windows through the normal one-shot `onclose` lifecycle.

PollyUI owns each layer's `wl_surface`, which SDL imports for input/presentation.
This prevents renderer initialization from replacing a surface with a different
role. The initial configure is acknowledged before renderer creation, and SDL
owns the viewport/fractional scaling. Role destruction precedes renderer/SDL
teardown; the owned surface is destroyed last. Raster means **Skia CPU drawing**:
the layer presenter still uses SDL/EGL, which may be software Mesa.

The host, rather than SDL's visible-toplevel counter, owns application lifetime:
closing the last ordinary window cannot implicitly quit surviving layer windows.
Wayland presentation uses nonblocking swap/presentation intervals so an occluded
surface cannot delay the shared UI loop waiting for its own frame callback.

Creating an authorized layer enables SDL focus-click-through for that process
unless explicitly configured already, so the activating click also operates a
panel control. This applies to mixed ordinary/layer windows in that shell
process; ordinary applications that never create layers keep their prior policy.

The native development Shell is `desktop/shell/main.mjs`. It creates real
wallpaper/panel/Dock surfaces for each output, offers all five appearances, and
persists the choice under the explicit `org.pollyui.shell` application identity:

```sh
sh desktop/tools/run-session.sh --nested --restarts 3 \
  ./build/desktop/pollywm ./build/linux-sdl/pollyui ./desktop/shell/main.mjs
```

Its Polly menu and Dock appearance/about controls operate on actual Shell
windows. XP/Classic use a bottom panel; Aqua/Lion/Big Sur use a menu bar and
floating Dock. Theme changes reuse unchanged surface geometry and preserve
wallpaper windows. Failure to create replacement surfaces or persist the choice
keeps the prior selection, reports the error, and cleans up staged windows.

This is still a **development desktop**, not the final system. Application
discovery/Exec launching is implemented; running-window buttons, system services, secure lock, and application
decorations are not yet integrated. The original appearance preview remains
available separately and is still labeled simulated.

### Linux application launcher

The real Shell's Polly menu and Apps Dock button discover `.desktop` entries,
filter/search them, and launch selected applications. The implementation uses
existing dependencies only: an in-house JavaScript compatibility layer and a
small libc-only exec helper, not GLib/GIO.

Build with `PU_DESKTOP_SERVICES=ON` (default for combined desktop builds), or
`bash tools/build.sh --desktop-services`, and enable the APIs explicitly with
`pollyui --desktop`. The development session launcher passes this flag.
`pollyui-app-launcher` must remain beside `pollyui`; it is not a standalone
user-facing application.

Discovery follows `XDG_DATA_HOME` then `XDG_DATA_DIRS`, with recursive desktop IDs
and higher-priority masking. It handles localized names/comments/keywords,
`Hidden`, `NoDisplay`, `OnlyShowIn`, `NotShowIn`, `TryExec`, working directories,
terminal entries, quoted `Exec` arguments and standard field codes. File/URL
placeholders are removed when launching without files. Invalid entries are
logged; unsupported D-Bus-only entries are visibly disabled. Search accepts
committed text, Backspace and Enter; Refresh rescans installed entries.

Applications execute an argument vector directly, without an implicit command
shell. Entry authors can explicitly name interpreters in `Exec`; desktop files
are executable application definitions, not sandboxed content. The helper
closes inherited descriptors, reports exec errors over a close-on-exec pipe and
starts applications in separate process groups. Application exits are reaped
and reported while the Shell runs; closing/restarting the Shell does not kill
its launched application processes.

Launch environments retain the current public Wayland display but remove the
private `WAYLAND_SOCKET`, inherited `DISPLAY`, activation tokens and Shell app
identity/debug variables. **A private D-Bus session is not implemented yet**:
the parent session bus is deliberately not reused. Entries with an `Exec` path
use that path; D-Bus-only activation and bus-dependent apps may remain unavailable.
X11 apps need future Xwayland integration. Apps that independently reuse an
existing process/profile can still require a dedicated test account/profile.
Terminal entries use `foot -e` by default; `POLLY_TERMINAL` selects a terminal
executable supporting `-e`, not an arbitrary shell command string.

The desktop APIs are explicitly opt-in and are not a security sandbox. Discovery
limits files to 1 MiB, nesting to 32 levels and the catalog to 10,000 entries;
the launcher validates up to 256 argv strings. The vendored QuickJS normalization
paths use their existing correctly typed allocator adapter rather than casting
allocator function pointers, fixing the UBSan failure exposed by Unicode sorting.

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
