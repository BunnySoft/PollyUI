# PollyDesktop

An experimental Linux desktop subproject. **PollyWM** is our own C11 Wayland
compositor built on **wlroots 0.19.3 or newer 0.19.x**, not labwc, GNOME or KDE.
This is the window-management foundation, **not yet a PollyUI desktop shell
or a bootable distribution**.

## Architecture and implementation plan

Keep three boundaries:

- `compositor/`: PollyWM owns outputs, seats, window geometry, focus and
  composition. wlroots supplies device/rendering/protocol infrastructure.
- `shell/`: shared appearance presets and a native PollyUI **simulated-shell
  preview**. Future real panels, launcher, notifications and settings will run
  in a separate process; a shell crash must not terminate other applications.
- Future session/system integration: application launching, D-Bus services,
  permissions, persistence and distribution packaging.

The compositor does not link QuickJS, Yoga, Skia or SDL. The generic PollyUI
engine must not depend on the desktop. Use wlroots' scene graph for external
applications rather than importing their buffers into the PollyUI DOM.

| Stage | Scope and acceptance gate |
|---|---|
| 1 - implemented here | Standalone compositor, two real xdg-shell clients, rendering/frame callbacks, focus, move/resize, close, lifecycle and nested WSLg execution. |
| 2a - implemented here | Maximize/fullscreen/restore, output-aware placement and migration, logical output geometry, and popup constraints. Independent clients exercise delayed/skipped configures, nested menus and simulated output changes. |
| 2b - remaining window policy | Workspaces, chosen tiling/floating rules and client-decoration policy; user-facing output configuration and real-hardware hotplug qualification. |
| Appearance - implemented preview | Switchable XP, Server 2003 Classic, OS X Aqua, Lion and Big Sur-inspired original themes, exercised with real PollyUI layout/input/rendering. These do not yet style PollyWM or other applications. |
| Linux runtime - raster/GLES milestone | Native Alpine/musl Skia build, Fontconfig/FreeType fonts, SDL3 EGL/GLES with explicit raster fallback and runtime error handling. Software GL is validated; physical GPU acceleration is not yet qualified. |
| 3 - PollyUI shell | Implement layer-shell on both sides, panel exclusive zones and output-specific shell surfaces. Start with a panel and launcher; restart the shell without disrupting application windows. Linux GPU and richer input remain separate work items. |
| 4 - usable session | Desktop entries, notifications, clipboard/drag-and-drop coverage, IME, audio/network/power integration, secure session lock, restricted management commands where standard protocols are insufficient. |
| 5 - system image | Alpine boot/login/session integration, non-root seat access, installation, persistent user data, signed updates/recovery and real hardware qualification. |

Prefer standard Wayland protocols. Workspaces/window management may later
require a narrowly scoped private protocol or socket, with an explicit trust
boundary. **There is no custom management socket, virtual-input global, or
test-control protocol in the production compositor.**

## Appearance direction and native preview

The desktop will offer multiple selectable appearances rather than hard-code a
single era. Appearance is separate from window-management policy: the compositor
remains floating, and no workspace/tiling policy was selected by choosing these
visual styles.

| Theme ID | Inspiration | Current visual treatment |
|---|---|---|
| `xp` | Windows XP / Luna | Blue rounded frames, green launcher, soft controls, original vector hills |
| `server2003` | Windows Server 2003 / Classic | Square gray frames, horizontal blue title gradient, beveled buttons, solid desktop |
| `aqua` | OS X / Aqua | Pinstriped chrome, glossy pill controls, left-side circular captions, menu bar and dock |
| `lion` | OS X / Lion | Gray chrome, graphite woven-grid background, left-side captions, compact gray dock |
| `bigsur` | macOS / Big Sur | Larger rounded frames, unified light title/toolbar, blue accents, rounded-square dock tiles and original colorful bands |

`shell/themes.mjs` contains deeply immutable, dependency-free token objects.
Every preset has the same desktop, color, window, icon, button and panel groups.
`getDesktopTheme(id)` rejects unknown IDs rather than silently choosing a
different appearance. The Server 2003 preset intentionally represents its
Classic look, not another Luna color variant.

`shell/appearance.mjs` draws the preview using the **actual PollyUI reconciler
and native renderer**, not browser HTML or screenshots of another desktop.
The theme picker and launcher menu work with pointer, Enter and Space.
Minimize/maximize/close/reopen operate on the **sample window inside the
preview**; folder and sample-action controls update local demo state only.
Switching themes preserves this state. The outer native window keeps its
normal host decorations.

The window-frame, taskbar/dock and menu designs are original implementations
inspired by these eras. No Microsoft/Apple logos, wallpaper photographs, OS
fonts, copied assets or system binaries are bundled. Aqua and Big Sur's glass-like gradients
are opaque drawing, not compositor transparency/blur. The preview is explicitly
labeled **SIMULATED SHELL**; it does not launch applications, modify files or
OS settings, provide real window decorations, or communicate with PollyWM.
Theme selection currently lasts for the preview process only.
Big Sur currently provides the light appearance; a dark variant, actual
transparency and live background blur are not implemented. The larger floating
dock has reserved space in both normal and maximized sample-window layouts.

Run from the repository root with an already built PollyUI runtime:

```powershell
.\build\win-clang\pollyui.exe .\desktop\shell\preview.mjs

# Native rendering, layout, input and pixel assertions; failures exit nonzero:
.\build\win-clang\pollyui.exe --test .\tests\desktop-appearance.mjs
```

The existing root README describes the Windows/macOS runtime build. If Skia
has not been fetched, use `tools/fetch_skia.ps1` before `tools/build.ps1`.
The same `.mjs` entry is portable to the macOS and Linux runtimes. Linux now has
a separate native raster-runtime image; the compositor-only image does not
include PollyUI. See the root README's Linux build instructions or run:

```powershell
.\desktop\tools\test-linux-runtime.ps1 -Nested
```

This runs the actual PollyUI appearance code under WSLg and then PollyWM.
Linux has a Skia GLES path and structured input with separate text commits;
IME preedit and real `layer-shell` integration are still pending.

The appearance test saves `build/appearance-<id>-<width>x<height>.png` for each
theme. It covers token shape/immutability, native layout and color rendering,
caption positions, menus, keyboard activation, preview window lifecycle,
state-preserving theme switches and mount/unmount. Use `PU_TEST_W` and
`PU_TEST_H` for different viewports; 640x480 is the preview's minimum target.
These appearance tests run separately from the WSL compositor suite.

Next integration steps are layer-shell surfaces for
real panels/docks, an application launcher and a shared decoration policy.
Window-manager state remains owned by PollyWM; theme code must not become an
alternate window manager.

## Implemented behavior

- xdg-shell toplevels and parented popups; wl_shm clients and wlroots rendering.
- Click-to-focus and raise; activation and keyboard/pointer event forwarding,
  including implicit pointer grabs for drags outside a window.
- Cascaded initial placement on the output nearest the pointer, with the window
  origin kept accessible on small displays; interactive move/resize and client min/max sizes.
  Top/left resize anchors use the geometry actually committed by the client.
- Maximize/fullscreen and restore, including requests before the initial map.
  Floating geometry survives repeated state changes and fullscreen over maximized
  windows. Restoring floating mode uses the saved geometry's nearest live output;
  leaving fullscreen while still maximized fills the current output.
- Placement follows configure acknowledgement **and buffer commit**, not merely
  the request. Late buffers do not receive newer positions. Smaller fullscreen
  content is centered over an opaque black backdrop, and content is clipped to
  its output in fullscreen/maximized mode (including client-side shadows).
- Existing windows select the output with the greatest overlap (nearest output
  if offscreen). Fullscreen honors an explicit live output requested by the client.
  Output mode, scale, transform, disable and removal update affected placements.
  Windows migrate to an enabled output when their target disappears, including
  configured windows that have not mapped yet.
- Popups and nested menus honor positioner constraint adjustments at creation
  and reposition. Reactive popups are reconstrained when parent/output geometry
  changes; non-reactive popups retain their requested parent-relative placement.
- Client-side move/resize requests require a matching seat, client and pointer
  grab serial. Forged, cross-client and expired requests are ignored.
- Focus falls back to another mapped window on unmap, close or disconnect.
- Basic selection forwarding through `wl_data_device_manager`.
- XKB keymaps (standard `XKB_DEFAULT_*` environment settings), input-device
  lifecycle, frame scheduling via wlroots, signal-driven clean shutdown.
- Auto-selected wlroots backends; tested with headless and nested Wayland using
  the Pixman software renderer. No Skia GPU support is implied by these results.

| Binding | Action |
|---|---|
| Alt + left-button drag | Move the window |
| Alt + right-button drag | Resize from the bottom-right |
| Alt + Tab | Cycle mapped windows |
| Alt + F4 | Ask the focused client to close |
| Alt + F10 | Toggle maximize |
| Alt + F11 | Toggle fullscreen |
| Alt + Escape | Exit PollyWM |

The parent desktop may intercept shortcuts in nested mode. Running clients may
draw their own title bars; PollyWM does not yet draw server-side decorations.
Maximize/fullscreen capabilities are advertised. Restore a maximized/fullscreen
window before dragging it; interactive move/resize is ignored while in those
states or while a state/placement configure is outstanding. State requests during
an existing interactive drag end that drag. Maximized/fullscreen sizes follow the
output rather than floating min/max size hints. Floating windows whose minimum
size exceeds an output may extend beyond it, but their top-left remains reachable.
Without layer-shell panels, maximized and fullscreen use the same output bounds.

Not implemented: layer-shell, workspaces/tiling, Xwayland, window lists/control
IPC, drag-and-drop policy, primary selection, screen capture/portals, IME
integration, secure lock, desktop services or installer. Output changes are
handled internally, but there is no user-facing display settings protocol/UI yet.
Popup constraints follow the adjustments allowed by the client (not arbitrary
forced clipping). Multi-output/HiDPI and DRM/seat access still need real-hardware
qualification; **WSLg is not evidence of native GPU/DRM or boot readiness**.

## Build independently on Linux

wlroots has an unstable API: this target deliberately accepts **0.19.3 <= version
< 0.20**. Alpine 3.24 provides the tested `wlroots0.19` package. Earlier 0.19
versions omit `wlr_buffer_finish()` in the SHM allocator destructor, causing
use-after-free during nested/Pixman teardown. Upstream 0.19.3 fixes this; do not
lower the minimum or work around it by changing teardown timing.
Other wlroots API series need an explicit port, not an unbounded dependency change.

```sh
# Alpine 3.24, as root only for package installation:
apk add build-base cmake ninja pkgconf wlroots0.19-dev wayland-dev \
    wayland-protocols libxkbcommon-dev xkeyboard-config capitaine-cursors

# From the repository root, as a normal user:
cmake -S desktop -B build/desktop -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build build/desktop
ctest --test-dir build/desktop --output-on-failure
```

This standalone build does not fetch or build Skia, SDL, QuickJS or Yoga.
The root project also exposes `-DPU_BUILD_DESKTOP=ON` for a combined build;
it remains **OFF by default**, so normal Windows/macOS builds do not acquire
Linux dependencies. A combined build still needs the normal PollyUI dependencies.
Use `-DBUILD_TESTING=OFF` when only the compositor is needed.

## Run nested in an existing Wayland session

Keep the parent's socket separate from the new compositor's socket:

```sh
parent="$WAYLAND_DISPLAY"
case "$parent" in /*) ;; *) parent="$XDG_RUNTIME_DIR/$parent" ;; esac
export XDG_RUNTIME_DIR="$(mktemp -d)"
printf 'Use this runtime directory for clients: %s\n' "$XDG_RUNTIME_DIR"
WAYLAND_DISPLAY="$parent" WLR_BACKENDS=wayland WLR_RENDERER=pixman \
    ./build/desktop/pollywm --socket pollywm-0
```

From a second terminal, use the printed directory:

```sh
XDG_RUNTIME_DIR=<printed-directory> WAYLAND_DISPLAY=pollywm-0 foot
```

Launch a second client the same way. Exit with Alt+Escape or SIGTERM, then remove
the now-empty temporary runtime directory. PollyWM requires an absolute,
user-owned, mode-0700 runtime directory. Do not reuse WSLg's world-accessible
runtime directory as PollyWM's runtime, and do not run a real desktop as root.

## Windows / WSL validation

The helper uses Podman **inside WSL** and the checked-in Alpine development
`Containerfile`. It does not install packages into the WSL distribution or need
privileged containers/device passthrough. It leaves a reusable development image
and build artifacts, but removes test containers and terminates their processes.
The development image includes Valgrind and wlroots debug symbols to diagnose
code inside the uninstrumented distribution libraries as well.

```powershell
# From the repository root; defaults to the Podman WSL distribution:
.\desktop\tools\test-wsl.ps1

# Also check a real WSLg output under Valgrind and launch two foot terminals:
.\desktop\tools\test-wsl.ps1 -Nested

# Clang AddressSanitizer + UndefinedBehaviorSanitizer, including nested checks:
.\desktop\tools\test-wsl.ps1 -Nested -Sanitize
```

Use `-Distro <name>` for another WSL distro with Podman installed. Nested checks
require the WSLg socket at `/mnt/wslg/runtime-dir/wayland-0` and briefly display
test windows. The default suite does not require a display or GPU. Sanitizers
instrument our code/fixtures, not the distribution's prebuilt wlroots library.

The integration suite runs independent Wayland client processes with shared
memory buffers, xdg configure/ack/commit and frame callbacks. It checks focus,
input, move/resize including geometry offsets and min/max sizes, shortcut
consumption, invalid/cross-client/stale grab serials, popup lifecycle, unmap/remap,
client crashes and destruction of a role before its surface. Synthetic input is
injected in the **test process**, not through a production protocol; nested
tests exclude physical input to avoid racing the fixture or the user's mouse.
Non-sanitized `-Nested` runs the fixture under Valgrind to cover library-level
buffer lifetime errors; `-Sanitize` uses ASan/UBSan instead, not simultaneously.
CLI tests cover invalid arguments, runtime permissions, socket collisions,
startup failures and shutdown/socket cleanup.

Window-policy coverage also includes repeated and pre-map state requests,
fullscreen over maximized windows, delayed/older/skipped buffer commits, restore
geometry, centered fullscreen pixel readback, popup/submenu constraints and
reposition tokens. The headless suite additionally creates/removes real wlroots
headless outputs and checks negative coordinates, gaps, 125% scale, rotation,
output disable/re-enable, small outputs and migration before a client maps.
These are protocol/geometry checks, not a claim of physical monitor validation.

The optional `runtime` container stage builds pinned Skia from source using
native Clang 18 and system font/codec libraries. `test-linux-runtime.ps1` builds
PollyUI and PollyWM together without replacing the Windows/macOS dependencies.
Its headless suite covers text/font fallback, rendering, JS/DOM, workers,
file-based fetch/storage and the five appearances, plus explicit startup failure
cases, keyboard/text/pointer/wheel contracts and detached DOM callback teardown.
The SDL adapter fixture exercises actual host translation with synthetic SDL
events, including modifier/repeat/code fields, text suppression, right-click
mapping and fractional two-axis scroll. `-Nested` checks a real SDL3 Wayland
client on WSLg and inside PollyWM; add `-Sanitize` for ASan/UBSan in PollyUI,
QuickJS, Yoga and the compositor (not the prebuilt Skia/wlroots libraries).
All nested processes are bounded and cleaned up. Nested rendering checks run
raster, required GLES and automatic selection through resize/restore. PNG
readback verifies fills, gradients, opacity, rounded clipping and text. CI forces
Mesa llvmpipe; this validates GLES code, not physical GPU/DRM acceleration,
physical input, CJK composition or a bootable session.

For Linux-native nested validation after building (install `foot` first):

```sh
# Resolve the parent socket before the fixture creates its own runtime:
parent="$WAYLAND_DISPLAY"
case "$parent" in /*) ;; *) parent="$XDG_RUNTIME_DIR/$parent" ;; esac
WAYLAND_DISPLAY="$parent" \
    ./build/desktop/tests/pollywm-integration \
    "$PWD/build/desktop/tests/pollywm-test-client" --nested
sh desktop/tests/nested.sh "$PWD/build/desktop/pollywm"
```

## Attribution

The wlroots tinywl example informed the Wayland lifecycle and scene integration.
Its MIT license notice is retained in `LICENSE.wlroots`. This notice does not
choose a license for the rest of PollyUI, whose project license is still TBD.
