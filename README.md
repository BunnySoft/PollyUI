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
apk add build-base cmake ninja pkgconf git python3 gn clang18 bash meson sdl3-dev icu-dev \
    fontconfig-dev freetype-dev libpng-dev libjpeg-turbo-dev libwebp-dev zlib-dev curl-dev \
    font-dejavu font-noto-cjk font-noto-emoji nodejs openssl \
    wayland-dev wayland-protocols wlr-protocols

# Build as a normal user, from the repository root:
sh desktop/tools/build-skia-linux.sh "$PWD/third_party/skia-linux"
sh desktop/tools/build-harfbuzz-linux.sh "$PWD/third_party/harfbuzz-linux" "$PWD/third_party/text-libs"
export PKG_CONFIG_PATH="$PWD/third_party/text-libs/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
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
It omits PDF, SVG and GIF/Wuffs. Skia itself is built without its optional ICU
and HarfBuzz modules; PollyUI's Linux shim calls those libraries directly for
text shaping and Unicode segmentation. Font fallback includes installed
CJK/emoji faces, and the optional native input-method service remains separate
from the text drawing path.

**Renderer selection:** `PU_RENDERER=auto` (default) attempts an SDL-owned
EGL/GLES 3 context and falls back to raster with a diagnostic if creation fails.
`PU_RENDERER=gl` requires GLES and fails rather than silently falling back;
`PU_RENDERER=raster` keeps CPU drawing. SDL may itself use a GPU to present raster
pixels, which is distinct from Skia GLES drawing.

The GLES implementation reports its renderer string. Automated WSL checks use
Mesa **llvmpipe**, a software GL implementation, not proof of physical GPU
acceleration. Physical GPU/DRM support still needs separate qualification.
Linux supports HarfBuzz shaping, ICU bidi/grapheme/line boundaries, native
preedit and a separately trusted Rime service. Physical-device qualification
and typography extensions such as explicit paragraph direction remain work.
The development image also builds pinned SDL 3.4.10 with a Wayland show/hide
callback lifetime fix for forced disconnection. See the desktop guide's
**SDL disconnect hardening** section when using system SDL or an existing cache.
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
discovery/Exec launching, live window buttons and negotiated server-side
decorations are implemented; system services and secure lock remain incomplete.
The original appearance preview remains
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
identity/debug variables. The development launcher now owns a **private D-Bus
session**; it never reuses the parent bus. Launched apps receive its address only
after the runtime checks the matching address marker, owned 0700 runtime and
owned Unix socket. Outside that launcher, the previous `disabled:` address
remains the explicit fallback. Invalid configured sessions fail rather than
falling back to the parent's bus. Entries with an `Exec` path use that path;
D-Bus-only desktop-entry activation is still unsupported.
X11 apps need future Xwayland integration. Apps that independently reuse an
existing process/profile can still require a dedicated test account/profile.
Terminal entries use `foot -e` by default; `POLLY_TERMINAL` selects a terminal
executable supporting `-e`, not an arbitrary shell command string.

The desktop APIs are explicitly opt-in and are not a security sandbox. Discovery
limits files to 1 MiB, nesting to 32 levels and the catalog to 10,000 entries;
the launcher validates up to 256 argv strings. The vendored QuickJS normalization
paths use their existing correctly typed allocator adapter rather than casting
allocator function pointers, fixing the UBSan failure exposed by Unicode sorting.

### Native desktop notifications

The real Shell registers `org.freedesktop.Notifications` on its private session
bus using libdbus, without GLib/GIO. It implements notification creation,
same-sender replacement, actions, dismissal, application-requested closure,
expiry, capabilities, server information and introspection. Capabilities are
`actions` and `body`: content is plain text, not HTML/markup, and supplied icon,
image and sound paths are not opened. No notification history is persisted.

The newest three notices appear on a non-keyboard-grabbing top-right surface on
the first output. A panel button opens the full current list; overflow and long
bodies scroll. Display removal/geometry changes recreate affected surfaces, and
rendering follows the selected theme. A sender's normal exit does not discard
its notice; stopping/restarting the Shell does discard its in-memory queue.

The bounded model accepts 64 active notices globally and 16 per sender, at
most eight actions, 256-byte application/action strings, a nonempty 1024-byte
summary and an 8192-byte body. Malformed or oversized requests receive D-Bus
errors. Default expiry is five seconds, or no timeout for critical urgency;
explicit zero means no automatic expiry. A resident notice remains after an
action. Signals are addressed to the originating bus connection, and one sender
cannot replace or close another's notice.

On the trusted Shell's `desktop` API, `notificationsAvailable` indicates a
configured private bus. `startNotifications()` acquires the standard name
without replacing an incumbent; `stopNotifications()` releases it.
`notifications()` returns `{id, revision, application, summary, body, urgency,
resident, actions:[{key,label}]}` entries. `dismissNotification(id, revision)`
and `invokeNotificationAction(id, revision, key)` reject stale UI actions.
`onNotificationsChanged` signals model/error changes. Public Wayland
connections cannot start this server merely by selecting `--desktop`.
This is not a D-Bus sandbox: another same-user process on the private bus can
use standard D-Bus APIs, subject to name ownership and sender checks.

### Native status tray and application menus

A separate private-session libdbus watcher/host handles
`org.kde.StatusNotifierWatcher` and the `org.freedesktop` alias. Applications
register their own bus name or object path. Well-known names are resolved
asynchronously and must belong to the registering sender; later calls target
that unique owner, never a replacement process which acquires the same name.
Owner loss unregisters items, cancels requests and releases icon assets.

The panel shows Active items, hides Passive items and marks NeedsAttention.
ARGB icon pixmaps are copied into bounded native memory assets and rendered by
Skia; attention pixmaps replace the ordinary icon when supplied. Icon paths and
`IconName` are never opened as arbitrary files. An item with no usable pixmap
has a title-label fallback; themed icon-name lookup, overlay/movie icons and
rich tooltips are not yet implemented.

Left/middle/right clicks and wheel input map to Activate/SecondaryActivate/
ContextMenu/Scroll, with real screen-coordinate hints. If the item exports a
`com.canonical.dbusmenu` path, menu activation instead opens a native themed
Shell menu. It supports lazy submenus, AboutToShow, live layout/property
updates, separators, hidden/disabled entries, check/radio state and clicked
events. Labels are plain text with DBusMenu underscore escaping, not markup.
Escape, Tab and arrow navigation work within the menu. Client-requested
automatic menu opening, menu icons and shortcut visualization are deferred.

Discovery, property reads, menu loading and actions are asynchronous, with a
two-second native deadline; a hung provider cannot block the UI. Limits include
64 tray items, eight per sender, bounded registration/request queues, 16
pixmaps per property (each at most 256x256), 128 menu nodes, eight nesting levels
and bounded text/properties. Invalid data produces an explicit item/menu error.

Trusted-Shell APIs are `startTray()`, `stopTray()`, `trayItems()` and
`onTrayChanged`; `trayAvailable` indicates a private bus. Item snapshots contain
`{id, revision, title, status, icon, iconName, menu, menuOnly, error}`.
`trayAction(id, revision, kind, x, y)` accepts `activate`, `secondary` or `menu`;
`trayScroll(id, revision, delta, horizontal)` forwards scrolling.
`openTrayMenu(id, revision, rootId)` starts at root 0 or a current enabled submenu.
`trayMenu()` returns `{itemId, revision, root, pending, error, items}`, with
entry fields `{id, label, enabled, separator, submenu, toggle, toggleState}`.
`invokeTrayMenu(itemId, menuRevision, entryId)` rejects stale/disabled entries;
`closeTrayMenu()` invalidates outstanding UI state.

The renderer's `polly-memory:` keys are process-local owned assets, not paths
or network URLs. Closing/replacing the provider releases/replaces those pixels.
Legacy XEmbed trays still require future Xwayland compatibility.

### Wi-Fi settings with iwd

The appearance/settings menu's **Wi-Fi** entry opens a native settings surface
backed by `net.connman.iwd` on the **system bus**, separate from the private
session bus used for notifications/tray. It discovers station devices, ordered
networks and RSSI; supports scan, radio power, connect/disconnect and forgetting
a discovered saved network. iwd owns association, DHCP/address configuration
and profile storage. No NetworkManager, GNOME/KDE or GLib/GIO integration is used.

The client resolves iwd's unique owner and verifies its bus-reported Unix UID
is root before registering its agent or forwarding requests. Calls and agent
prompts remain pinned to that owner. Agent requests are accepted only from it
and only for the currently user-requested connection. A service restart clears
old devices, actions and credential prompts, then re-verifies the new owner.
Discovery and operations are asynchronous with native deadlines and bounded
queues/models; a missing system bus, denied policy or missing daemon is an
explicit unavailable/error state, not a successful empty connection.

Connect confirmation warns that **iwd can save credentials and enable automatic
reconnection**. Authentication fields are masked, automatically focused and
excluded from clipboard copying/IME preedit. Submitted passwords are not
included in state snapshots, application storage or logs; UI values are cleared
after submission/cancellation. This is not a claim of guaranteed zeroization of
JavaScript/DBus allocator memory. Agent requests support PSK passphrases and
credentials for already-provisioned EAP profiles; the UI does not create EAP
certificate policies or bypass certificate validation. WEP is unsupported.
Forgetting requires its own confirmation and may disconnect the network.

Shell APIs are `startNetwork()`, `stopNetwork()`, `refreshNetworks()`,
`networkState()` and `onNetworkChanged`. State includes `ready`, `registered`,
`refreshing`, `revision`, `error`, `operation`, `target`, tri-state
`networkConfiguration`, `devices`, `networks` and an optional
`authentication:{id,kind,network,username}` prompt. Devices contain
`{id,name,address,mode,state,powered,scanning,station,connectedNetwork}`;
networks contain `{id,device,name,type,known,connected,signal,order}`.
Signal is dBm or null. `networkAction(revision,id,action)` accepts `scan`,
`connect`, `disconnect`, `forget`, `power-on` or `power-off` only for current
model objects. `replyNetworkAuthentication(id,username,password)` submits to the
current prompt; two null fields cancel. `cancelNetworkConnection()` aborts an
interactive connection by requesting station disconnect. Stale revisions and
prompt tokens are rejected.

The development process does **not** start iwd, alter the host's networking,
grant itself system-bus permissions or install network profiles.
`desktop/system/iwd-main.conf` is a proposed Alpine image configuration using
iwd's built-in network configuration plus `resolvconf`; deploying it requires
the system iwd/OpenRC service, `openresolv` and appropriate distribution
permissions. The UI reports disabled/unknown IP configuration rather than
assuming an association provides Internet access.

Native raster/GLES fixtures use an isolated fake iwd service and actual
pointer/keyboard input, including password masking, cancellation, sender
verification, stale-token rejection, saved-profile deletion and owner restart.
They do **not** qualify physical Wi-Fi, DHCP/DNS, enterprise certificates or
real hardware hotplug. Hidden-network provisioning, editing static-IP/EAP
profiles, saved networks absent from scans, wired networking and VPN management
remain separate system-service work.

### Private PipeWire audio

Add `--audio` to `desktop/tools/run-session.sh` to start a session-owned PipeWire
core. PollyShell supplies its own routing policy and native **Audio** settings:
endpoint/stream discovery, volume, mute and default playback/recording devices.
There is no WirePlumber, GNOME/KDE or GLib/GIO dependency in this implementation.

The Shell connects through a validated Unix socket FD in its owned 0700 runtime,
checking socket ownership and the peer UID. It does not fall back to a parent's
PipeWire socket. Public Wayland clients cannot acquire the Shell policy APIs;
ordinary applications can still use the session's PipeWire server. This is
**not** per-application microphone consent, a portal or an audio sandbox.

Own policy honors autoconnect, explicit target names/serials and manually
managed links. It adapts raw streams to supported endpoint channel maps,
reconciles managed routes on default-device changes, and falls back after
device removal. Explicitly targeted streams do not silently select a different
device when their target is absent. Lingering managed links survive policy
reconnection. Preferred names are distinct from currently available defaults.
PollyShell persists acknowledged endpoint volume/mute changes and selected
devices under `desktop.audio.v1` in its existing localStorage. This includes the
explicitly chosen microphone mute **and unmute** state across logins. It restores
by unique node name and media class, not runtime node IDs, object serials or
revisions. Those names are matching keys, not authenticated hardware identities.
Missing devices keep the existing fallback and their saved preferences are
retained for when they return. Duplicate names are reported rather than guessed.

Only changes made through these settings controls are recorded; transient stream
controls and external applications' changes are not automatically persisted.
Requests must be reflected in actual PipeWire state before saving, with a
five-second acknowledgment deadline. Restore attempts are not repeatedly replayed
for a live node. Invalid saved data and storage failures are reported; Forget
saved audio settings clears preferences without changing current device controls.
Data is bounded to 64 KiB and 256 endpoints. The memory-only Live image still
discards settings at shutdown; this does not add disk persistence or capture
permission isolation.

APIs are `startAudio()`, `stopAudio()`, `audioState()`, `onAudioChanged`,
`setAudioVolume(id,revision,value)`, `setAudioMute(id,revision,boolean)` and
`setDefaultAudio(id,revision)`. State includes `ready`, `revision`, `generation`, `error`,
`defaultSink`, `defaultSource`, `preferredSink`, `preferredSource`, `nodes`,
`routes` and `connections`. Node revisions reject stale controls; unsupported
volume/mute values are null. Node `instance` plus the connection `generation`
identify pending runtime acknowledgments and are never persisted.
Volume requests are limited to 0-1 and preserve
existing channel ratios. Native models are bounded to 256 nodes, 1024 ports
and 1024 links, with at most 256 pending route creations.

Real private-daemon fixtures exercise playback, nonzero synthetic capture,
mono adaptation, controls, explicit/manual routing, reconnection and output
loss without accessing host sound devices. The production configuration uses
PipeWire's ALSA/ACP infrastructure; physical cards, profiles, jack detection,
Bluetooth and latency still require qualification. PulseAudio emulation and
ALSA-client redirection are not started/configured; audio mode explicitly sets
`PULSE_SERVER=disabled:`. Unsupported multichannel maps are reported rather than
treated as working audio. Daemon loss ends the development session with an
error; ordinary exit and signals clean up only its owned service and sockets.

### Linux window management

With `PU_DESKTOP_SERVICES`, `PU_LAYER_SHELL` and `--desktop`, the `desktop` object
also exposes `windows()` and `onWindowsChanged`. These require the trusted Shell's
shared Wayland connection and foreign-toplevel management v3; a public connection
cannot enumerate or control other applications merely by passing `--desktop`.

`windows()` returns snapshots containing `id`, `title`, `appId`, `workspaceId`, `active`,
`minimized`, `maximized` and `fullscreen`. Metadata is published at protocol
`done` boundaries. IDs are process-local handles, never reused within the
runtime, not PIDs or persistent application identities. A coalesced
`onWindowsChanged()` callback tells the UI to read a fresh snapshot.

`activateWindow(id)`, `minimizeWindow(id)`, `restoreWindow(id)`,
`maximizeWindow(id)`, `unmaximizeWindow(id)`, `fullscreenWindow(id)`,
`unfullscreenWindow(id)` and `closeWindow(id)` send asynchronous requests.
Observe subsequent snapshots for resulting state. Activation also restores
minimized windows and switches to their workspace; `restoreWindow` alone does
not force focus or switch workspaces. Close requests a
graceful application-window close, not process termination. Invalid/stale handles
and unavailable connections throw; callback failures are logged.

The native taskbar/Dock shows one text button per running window on the current
workspace, on each output. Clicking an active window minimizes it; other windows are restored
and activated. Right click opens window actions. The window list scrolls
horizontally with the wheel and resets when its membership or viewport changes.
App grouping, icons/pinning and complete desktop keyboard
navigation remain future work.

PollyWM supplies titlebars and borders through `xdg-decoration` negotiation.
Server-side decoration is the default for negotiating clients without an
explicit preference; an explicit client-side request is honored. Clients that
do not negotiate keep their existing headers. Titlebars support drag, double
click to toggle maximize, minimize/maximize/close buttons, active/inactive
colors, and edge/corner resizing. Fullscreen hides decorations; maximized
content respects both panel reservations and frame extents.

`desktop.setAppearance(themeId)` selects a known decoration theme on the trusted
Shell connection through the restricted `polly_appearance_v1` global. Shell
appearance selection calls it automatically. The compositor's C tokens are
generated from the existing JavaScript themes, not maintained as a second
palette. Regenerate with `node desktop/tools/generate-decoration-themes.mjs`;
`--check` verifies the committed header. Standalone compositor builds require
Fontconfig/FreeType but still do not link SDL, Skia, QuickJS, Yoga or GLib/GIO.
Captions have basic Unicode font fallback, not complex shaping/bidi. Blur,
frame shadows, fully rounded client-content clipping and polished animations
remain separate appearance work.

### Window switcher and shortcut settings

The native Shell presents an Alt+Tab window list for the current workspace,
including minimized windows. The list is frozen in recent-use order while the
shortcut modifiers are held. Tab advances, Shift reverses, Escape cancels, and
releasing a required modifier activates/restores the selection. Clicking a row
also accepts it. Preview does not change application focus. Closed candidates
are removed safely; workspace changes, external focus changes and presenter
loss cancel the picker. Without a Shell presenter, switching remains immediate.

Open **Appearance > Keyboard shortcuts** to record a new chord, disable an
action, or restore defaults. The fixed catalog covers switching, closing,
minimizing, maximizing, fullscreen and previous/next workspace. Chords require
Ctrl, Alt or Super; Shift is reserved for reverse window switching. Conflicts
(including that reverse alias) and attempts to replace Alt+Escape are rejected
without partially changing the map. Alt+Escape remains the development exit
outside switching/recording; Escape cancels those modes instead.

`desktop.shortcuts()` and `shortcutDefaults()` return records containing
`action`, `label`, `modifiers` and `key`. Modifier bits are Shift=1, Ctrl=2,
Alt=4 and Super=8; keys use XKB names or a single basic character.
`setShortcuts(records)` validates a complete map and waits for compositor
acknowledgement. An empty key with modifiers=0 disables an action. Shell
preferences use `desktop.shortcuts.v1` in app-scoped localStorage and are
reapplied on a new compositor session; failed saving attempts roll back the
live map and report any rollback failure.

The connection-restricted `polly_shortcuts_v1` interface carries only this
catalog and switcher presentation, not shell commands. A presenter must opt in
with `enableWindowSwitcher(true)`. `windowSwitcher()` supplies a coherent,
serial-tagged snapshot; `acceptWindowSwitch(serial, index)` rejects stale UI
selections and `cancelWindowSwitch()` dismisses it. `captureShortcuts(true)`
only suppresses global bindings while a Shell layer owns keyboard focus.
All suppression ends when its connection/resource is destroyed.

The initial picker is a themed text list on the first available display,
not live application thumbnails or an app-icon grid. It displays a bounded
slice around the selection; richer overview/icon behavior remains separate.

### Display settings and guarded output changes

**Appearance > Displays** edits actual compositor outputs: enable/disable,
resolution, refresh rate, scale, rotation and logical X/Y placement. Mode
selection uses advertised modes where available; custom sizes are checked by
the backend. At least one output must remain enabled.

Changes are provisional for 15 seconds. A native confirmation overlay offers
Keep/Revert (Enter/Escape). The compositor, not a JavaScript timer, owns the
saved configuration and deadline. Timeout, Shell connection loss or output
topology changes trigger rollback on the remaining outputs. Failed/partial
backend commits also attempt recovery; recovery failures are explicitly
reported rather than described as restored. A removed physical display cannot
be recreated by software.

`desktop.outputConfiguration()` returns `{serial, heads, pendingToken,
remainingMs, outcome, message}`. Each head has a runtime-local ID, name,
manufacturer (`make`), model and `serialNumber`, enabled state,
resolution/refresh, scale/transform, logical position, advertised
modes and adaptive-sync state. `testOutputConfiguration(snapshot)` is
non-mutating; `applyOutputConfiguration(snapshot)` requires a complete, current
snapshot and returns a confirmation token. Use
`confirmOutputConfiguration(token)` or `revertOutputConfiguration(token)`.
`onOutputsChanged` announces coherent snapshots and guard state.

Output state/configuration uses `wlr-output-management` v4 and the narrow
`polly_output_guard_v1` confirmation interface, both restricted to the trusted
Shell connection. Read-only `xdg-output` information is available to ordinary
clients so fractional scaling, rotations and logical display coordinates agree
with the compositor. Current safety bounds include scale 0.25–4, hardware
dimensions up to 16384, 32 Mi pixels per output and bounded logical coordinates;
backend support remains authoritative.

PollyShell saves only confirmed layouts as a versioned JSON document under
`desktop.displays.v1` in its existing `localStorage`. This first stage remembers
one last-confirmed display combination, not application/window placement.
Connection-local IDs and protocol serials are never persisted. On fresh startup,
connector, manufacturer, model and device serial must match the complete saved
combination. Missing/placeholder serials, duplicate hardware identities or
missing/replaced displays prevent automatic restoration; the safe current layout
is retained. EDID identity is a matching aid, not a hardware-authentication claim.

If the matching layout actually differs, it is applied provisionally with the
same 15-second Keep/Revert watchdog. Unchanged layouts need no confirmation.
Output-guard version 2 provides the trusted `claimOutputStartup()` one-shot
claim, so Shell reconnect cannot repeatedly reapply an unconfirmed or rejected
startup profile. Closing a confirmation overlay reverts immediately; a frozen
Shell still falls back to the compositor's timer.

Invalid profiles are reported without overwriting them. Forget saved layout
removes only the preference, leaving current outputs unchanged. If saving fails
after Keep, the display change remains kept and the storage failure is reported.
Profile data is limited to 64 KiB with validated geometry and bounded identity
strings. Physical DRM/HDR/VRR qualification and automatic hotplug profile switching
remain separate work. Memory-only Live sessions still lose settings at shutdown.

### Linux manual workspaces

PollyWM defaults to four workspaces and one active workspace shared by all
outputs. Creation and removal are manual: empty workspaces remain, new ones
append without activating, and existing names/order do not change automatically.
Fullscreen stays within the existing workspace, not a separate Space.
Appearance selection does not change this behavior.

Use the panel/menu-bar workspace button to switch, add, remove, rename or
manually reorder workspaces.
`Ctrl+Super+Left/Right` switches to the previous/next workspace without wrapping;
`Alt+Tab` cycles only windows in the current workspace. Window menus can move a
window to another workspace without following it. Transient parents and their
descendants move together. New toplevels use the workspace active at creation,
while transients inherit their parent's workspace without stealing focus.

Removing a populated workspace migrates its windows to the preceding workspace,
or the following one when removing the first. Applications are not closed;
minimized, maximized and fullscreen state is retained. At least one workspace
must remain. Inactive-workspace windows stay mapped with stable foreign handles
but have disabled scene trees, no input focus, and dismissed popups.

The opt-in `desktop` APIs expose `workspaces()` snapshots with `id`, `name`,
`order`, `active` and `canRemove`, plus `onWorkspacesChanged`.
`createWorkspace(name?)`, `activateWorkspace(id)`, `removeWorkspace(id)` and
`moveWindowToWorkspace(windowId, workspaceId)` send asynchronous requests.
`renameWorkspace(id, name)` and `reorderWorkspace(id, position)` edit a live
workspace without changing its identity, activation or window membership.
Positions are zero-based; a position beyond the end appends.
Names may contain at most 128 UTF-8 bytes without NUL; an omitted/empty name
gets an automatic label. Renaming requires a nonempty name. Observe subsequent
snapshots for results.

Listing, creation, removal and activation use standard `ext-workspace-v1`
with one workspace group for all outputs. The narrow
`polly_workspace_toplevel_manager_v1` extension adds foreign-window membership
and moves; version 2 adds rename/reorder and an atomic startup restore
transaction. Both globals are restricted to the exact trusted Shell connection.
Standard requests are staged until `commit`, and snapshots are published at
`done` boundaries.

PollyShell validates and persists `{version: 1, names: [...], active: index}` in
its existing `localStorage` under `desktop.workspaces.v1`. Names/order and the
current choice survive compositor/session restart when the user's configuration
directory is retained. Native IDs are runtime-local and never persisted.
`restoreWorkspaces(names, activeIndex)` applies the staged layout synchronously
only to an unused compositor, returning `true` when restored or `false` when live
state must be retained. An ordinary application (even an unmapped toplevel),
prior workspace operation or completed restore prevents replacement. The trusted
Shell's bootstrap window can be rebound before its deferred SDL teardown.
Individual protocol messages carry one bounded name, not an oversized JSON
string; the restore payload is limited to 1 MiB.

Shell reconnect retains live state rather than overwriting it with older
preferences. Invalid settings produce a visible warning and are not overwritten;
the workspace menu's explicit **Save current layout** recovers by replacing them.
Write errors are reported and retried on subsequent snapshots. No application
processes, window positions or persistent Wayland IDs are restored. The memory-only
Live ISO still loses these settings at guest shutdown. No dynamic workspaces, per-output
switching, automatic reordering or speculative settings for these are included.

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
On Linux, editors move/delete whole Unicode graphemes, including combining
marks, emoji modifiers/ZWJ sequences, flags and Indic conjuncts. Other hosts
retain their existing code-point editing and draw path.

### Linux Unicode text layout

The Linux renderer uses HarfBuzz glyph substitution/positioning over Skia
typeface tables, ICU bidi analysis and ICU grapheme/line boundaries. Measurement,
plain drawing, gradients and editor hit testing share shaped advances.
Fallback attempts to keep an entire grapheme in one font; installed fonts still
determine which scripts and emoji can be displayed. Missing glyphs retain the
font's normal missing-glyph behavior.

`textBoundaries(text)` returns UTF-16 grapheme boundaries. `layoutText(text,
fontSize = 16, weight = 400)` returns a single-line `{width, clusters}` snapshot;
each cluster has `{start, end, x, width, rtl}`. Its indices are UTF-16, including
correct indexing for lone surrogates; coordinates are logical pixels.
`js/textgeometry.mjs` uses these snapshots for caret placement, nearest-boundary
hit testing and potentially disjoint bidi selection rectangles.
Logical arrow navigation follows grapheme order; visual bidi caret affinity and
explicit paragraph direction/locale settings are not implemented.
Ligature advance is evenly divided between its constituent graphemes for
caret placement, rather than using font-specific ligature caret tables.

Wrapping recognizes Unicode line opportunities (including CJK without spaces)
and preserves the existing behavior of allowing an unbreakable word to overflow
rather than inserting arbitrary breaks. Direction is inferred per shaped line;
full paragraph-style bidi configuration and advanced line breaking/hyphenation
remain outside this implementation. Native caches are bounded by entry counts
and aggregate text size; JavaScript editor caches avoid retaining large values.

The development image builds HarfBuzz 13.2.1 at
`6f4c5cec306d31e6822303f5ba248a14293d588e` with GLib/GObject/Cairo integrations
disabled, plus system ICU. `desktop/tools/build-harfbuzz-linux.sh` reproduces it.
Alpine's stock HarfBuzz links GLib and is not used by this profile. Runtime
dependency checks enforce the no-GLib/GIO boundary. This is a private static
library at `/opt/pollyui-text`, not a replacement for the system HarfBuzz:
other applications retain the complete ABI from their distribution package.
System SDL users also need
the disconnect fix described in the desktop guide.

### Composition events

Linux SDL translates preedit into `compositionstart`, `compositionupdate` and
`compositionend`; `data` carries text and update events expose `selectionStart`
and `selectionLength` in UTF-16 units. A commit ends composition before the
single `textinput` event; cancellation ends it with empty data. Preedit is
rendered separately from the editor's committed value. Focus changes, removal
and external value replacement cancel it without inserting into another field.

Focused nodes may call `setInputMethod({purpose, x, y, width, height})`; the
rectangle is local to the node and is converted to viewport coordinates after
layout, including scroll offsets. Purposes are `text`, `password`, `pin`,
`email`, `number` and `name`. `cancelComposition()` resets composition;
`setInputMethod(null)` disables that node's input session. Native focus loss
and stale queued preedit are handled separately from DOM focus.
`createTextInput` and stable-ID `NInput` use this contract automatically.
Their `password: true` or `purpose: 'pin'` mode masks text, disables selection
copy/cut and primary publication, and prevents preedit display. `ownerDocument`
identifies the containing native document.
Numeric purposes temporarily use ASCII in PollyIME instead of composing pinyin;
input-value validation remains the application's responsibility.

SDL 3.4 does not expose a surrounding-text setter through this host API.
PollyUI therefore sends caret/purpose information, not surrounding text or
delete-surrounding edits. The compositor relay supports those standard
text-input-v3 operations for other clients; the current Rime client does not
consume surrounding text.

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
`host.compose(text, selectionStart, selectionLength)` submits preedit in tests.
Top-level `.mjs` exceptions and rejected or unfinished top-level `await`
evaluations now fail with a nonzero exit status rather than ending silently.
`tests/input-events.mjs`, `tests/pointer-events.mjs` and the Linux SDL adapter
test cover these contracts; the latter queues synthetic SDL events and is not
physical-device or locale-layout qualification.

### Clipboard and incoming drops

`clipboard.writeText(text)` / `readText()` use the native application clipboard.
The SDL host also provides `write([{type, data}, ...])`, `read(type)` and
`formats()` for MIME data; `data` is an ArrayBuffer or typed-array view whose
selected bytes are copied, and `read` returns an ArrayBuffer or `null` for an
absent format. `write([])` clears the clipboard. Writes accept at most 16
distinct formats and 16 MiB of bytes in total. MIME names must be nonempty,
printable ASCII strings of at most 127 bytes. Text writes reject embedded NUL.
`supportsFormats` distinguishes the SDL implementation from the raw Win32
host's UTF-8 text-only implementation.

On Linux SDL, `supportsPrimary` is true and `writePrimaryText` /
`readPrimaryText` expose the independent primary selection. Native calls require
a focused application window and report errors; `--test` instead uses a
process-local memory clipboard without touching the host clipboard.
Reads reject results over 16 MiB **after SDL has received them**; this is not
a transport-level memory limit. There is no clipboard history, persistence,
background clipboard manager or payload logging.

`createTextInput` and `NInput` with a stable `id` support Ctrl/Meta+A/C/X/V,
publish mouse-selected text to primary selection, and paste primary selection
on middle click. A failed clipboard write does not delete the selected text.
Anonymous `NInput` retains its existing basic append/backspace editing path;
use a stable `id` for selection and clipboard shortcuts.

SDL windows receive bubbling `dragenter`, `dragover`, `drop`, `dragleave` and
`droperror` events. A completed `drop` carries `text` (or null), `files` (UTF-8
path strings, not File objects), `source` metadata and logical `clientX/Y`.
`droperror.error` describes rejected payloads. The adapter aggregates up to
1024 paths and 16 MiB of strings including separators/terminators; source
metadata is capped at 1024 bytes. SDL has already received individual chunks
before these limits are applied. Paths are untrusted data: nothing is opened,
executed, moved or deleted automatically.

This is an incoming native-drop API, **not** browser DataTransfer: SDL controls
protocol acceptance, `preventDefault()` does not negotiate native actions, and
no PollyUI outgoing drag-source API or automatic text-input drop insertion is
implemented yet. `dragenter` announces a window-level transfer; SDL provides
no distinct leave notification, so an empty completion becomes `dragleave`.

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
The real Shell provides per-output surfaces, an application launcher, window
controls, manual global workspaces, display settings and five original themes,
shared with negotiated compositor titlebars. `desktop/shell/preview.mjs` remains
a separate simulated appearance preview. An opt-in Rime input-method service
renders its own candidate windows with PollyUI, without GNOME/KDE or GLib/GIO.
A relocatable Alpine runtime bundle now includes a private patched SDL,
dependency inventory, license notices and checksums; it can start in a clean,
non-root container without the source checkout or SDK. A separate memory-only
x86_64 UEFI development ISO boots the ordinary-user desktop with OpenRC/PAM/elogind
in a disposable VM. It is not an installer or a production-qualified release;
protected login, secure lock, updates and hardware qualification remain. See the desktop guide for
the architecture, roadmap, standalone build and WSL/WSLg checks.

The next desktop base is planned as **Debian 13 trixie amd64 minbase** while
retaining our own compositor and Shell. The current implementation and images
remain Alpine-based. See the [base and maintenance plan](./docs/desktop-base-maintenance.md)
for the confirmed build principle, dependency ownership, update cadence and
required acceptance before replacing the user-validated Alpine baseline.

## License

Project-owned code is licensed under the [MIT License](./LICENSE).
Third-party code, libraries, fonts and input-method data retain their own
licenses; this grant does not replace their copyright notices or obligations.
