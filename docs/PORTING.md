# PollyUI — Multi-Platform Porting & Deployment

Two deployment tiers, one codebase:

1. **Tier 1 — SDL3 backend**: Windows, Linux, macOS, **iOS**, Android. One host
   implementation; you write zero Java/Objective-C app code.
2. **Tier 2 — bare embedded Linux**: Wayland *or* DRM/KMS, **no Java, no SDL**.
   For appliances/kiosks/IVI that boot straight into a PollyUI binary.

The raw Win32 host stays as an opt-in backend (zero deps, hand-tuned).

For building our own desktop rather than a client application, see
**[PollyDesktop](../desktop/README.md)**. Its independently buildable wlroots
compositor lives in `desktop/`; it does not replace the Linux client host.
The native Alpine client build uses SDL3 EGL/GLES or raster presentation and Fontconfig
fonts; see the root README for its source-build recipe and WSL helper.
Physical GPU qualification and PollyUI shell integration are later stages.

---

## 0. The portability boundary

Only **one** of the five engines is platform-specific. Everything below "Host"
is shared C/C++ and **100% of the app/JS is shared**.

| Layer | Shared? | Notes |
|-------|---------|-------|
| App + components (`gui/sdk/js/*.mjs`) | ✅ 100% | reconciler, Vue reactivity, CSS, naive.mjs, forms/dialogs… |
| ScriptEngine (QuickJS-ng) | ✅ | pure C |
| LayoutEngine (Yoga) | ✅ | pure C++ |
| Model (DOM-like) | ✅ | pure C |
| RenderEngine (Skia) | ✅ *logic* | **surface creation and font discovery** are per-platform |
| **HostEngine** | ❌ | window + event loop + input + present (§1) — the only new C per platform |

Porting includes a host, surface creation, font discovery and any platform
services used by the app (for example WinHTTP versus Linux libcurl).
The UI/DOM/layout logic remains shared.

### Canvas 2D and Image resources

Canvas uses an independent CPU raster backing store on every host, including
GPU-presented windows. Do not multiply HTML canvas width/height by host DPI;
only the normal DOM paint pass scales its snapshot to physical pixels.
`img` is a measured/painted replaced element with PNG/JPEG natural dimensions,
not a background-image-only convention or a new native surface role.
The standard JS API is embedded in the GUI library at build time and needs no
source-root file at runtime or SysRT dependency. CMake compiles the private
`render/canvas_c.cpp`, `bridge/media.c`, and regular-file/UTF-8-path adapter
`bridge/image_file.c` using the existing Skia codecs and font pipeline.

The [Canvas compatibility matrix](../gui/sdk/CANVAS.md) describes API,
source, allocation, text/shaping and timing limits. Native file decoding is
currently UI-thread synchronous with task-based notification, not a background
decoder or a browser-origin/CORS implementation. Native `gui-canvas` tests run
without an HWND/SDL window; the optional `gui-canvas-wayland` smoke exercises a
mapped fractional-DPI window. Neither requires an ISO/VM or Windows desktop
screen sampling. Existing window/popup/transparency/grab semantics are unchanged.

### Owned GPU Canvas / WebGL2

Windows/Linux `PU_WEBGL2=ON` adds a private EGL/GLES3 offscreen context/device
adapter, common native validation/resource ownership and embedded browser-shaped
JS interfaces. `EGL`/`GLES3` headers are required; Windows can use the existing
Skia ANGLE include directory, Linux uses its system headers. Libraries load
dynamically; Windows confines development ANGLE DLL lookup to the application
directory/system loader dependency paths. Missing runtime/ES3 support returns
`null` with creation-error notification, not a fake context or silent success.
`PU_WEBGL2=OFF` keeps 2D available; macOS WebGL2 is explicitly unavailable.

Each canvas has an owned framebuffer, not a native surface/window. The adapter
restores the owning UI EGL context and never terminates a shared display.
The first composition path is real GPU readback to a raster Skia snapshot,
not zero-copy. Canvas width/height are independent of host DPI; regular DOM
clipping, scrolling, opacity, transforms and pointer handling remain shared.
No SysRT service or WebGPU dependency is introduced.

Windows WebGL2 explicitly uses a fixed ANGLE Vulkan/SwiftShader software CPU
provider, rather than the D3D11 candidates with a reproduced nonzero-base mip
defect. `tools/fetch_webgl_angle.ps1` verifies the official Electron v41.10.7
archive/release hashes and stages only its native EGL/GLES/Vulkan/SwiftShader
libraries, original application-relative ICD and complete licenses. It does not
install or execute Electron/a browser or alter global Vulkan settings. This
remains WebGL2, not JS WebGPU or hardware Vulkan qualification; missing libraries
return `null`/creation error with no D3D fallback. The existing UI renderer is
not switched. The bundled-library provenance is not a standalone official ANGLE
redistribution package or product release certification. Three.js is an optional
manifest-pinned qualification dependency, not a GUI library/runtime download.
See [WEBGL2.md](../gui/sdk/WEBGL2.md) for exact qualified platforms, optional
extension handling, source/license/integrity records and remaining conformance
boundaries.

---

## 1. The HostEngine contract

Every backend implements the exact interface already defined in
`gui/include/pollyui/window.h`. This is the seam:

```c
typedef struct PuWindow PuWindow;
typedef struct PuWindowConfig { const char *title; int width, height; } PuWindowConfig;

/* draw a frame; w/h are LOGICAL px, scale maps to physical px of `surface` */
typedef void (*PuPaintFn)(PuSurface *surface, int width, int height, float scale, void *user);

#include "host/input.h"
typedef int  (*PuPointerFn)(const PuPointerEvent *event, void *user); /* >0 => repaint */
typedef int  (*PuKeyFn)(const PuKeyEvent *event, void *user);         /* PuInputResult flags */
typedef int  (*PuWheelFn)(const PuWheelEvent *event, void *user);     /* >0 => repaint */
typedef int  (*PuAsyncFn)(void *user);  /* pump microtasks/timers/rAF; >0 => repaint */

PuWindow *pu_window_create(const PuWindowConfig *cfg);
void pu_window_set_paint  (PuWindow *, PuPaintFn,  void *user);
void pu_window_set_pointer(PuWindow *, PuPointerFn,void *user);
void pu_window_set_key    (PuWindow *, PuKeyFn,    void *user);
void pu_window_set_wheel  (PuWindow *, PuWheelFn,  void *user);
void pu_window_set_async  (PuWindow *, PuAsyncFn,  void *user);
void pu_window_wake       (PuWindow *);   /* thread-safe: nudge the loop to drain async */
int  pu_window_run        (PuWindow *);   /* run the event loop until quit */
void pu_window_destroy    (PuWindow *);
```

`main.c` is already backend-neutral: it only calls these and provides
`app_paint` / `app_pointer` / `app_key` / `app_wheel` / `app_async`. A new
backend is a drop-in `.c` implementing the same symbols.

### Native window contract

The complete public types are in `pollyui/window.h` (the introductory seam
above is abbreviated). `PuWindowConfig` adds `parent`, `popup` (`PU_POPUP_NONE`,
`PU_POPUP_MENU`, `PU_POPUP_TOOLTIP`), `popup_x`/`popup_y`, `modal` and
`PuWindowLimits limits`. Initialize the struct to zero before filling it.
Creation borrows the config but retains the native owner relationship.
Every window/owner operation except `pu_window_wake` belongs to the UI thread.
Parent pointers are checked against the Host's live registry before dereference.
Dedicated layer, input-method and lock roles cannot mix with ordinary ownership,
popup, modal or size limits.

`pu_window_close` is explicit for the addressed window; it coordinates
descendants through their request hooks. `pu_window_request_close` additionally
consults the addressed window's own hook, after descendants actually retire.
They return `PU_CLOSE_DECLINED`, `PU_CLOSE_ACCEPTED` or `PU_CLOSE_PENDING`;
pending is not acceptance and does not report the owner closed. Declined
attempts are not retried automatically. Native close notifications precede
parent closure and are once-only. `pu_window_close_all` is the existing explicit
forced-quit path and bypasses hooks. `pu_window_destroy` relinquishes the caller's
window ownership; native resources stay pinned while descendants or callbacks
still reference them. A callback may destroy another window safely; live
registries and callback iteration use bounded ownership snapshots.

`pu_window_capabilities`, `pu_window_get_state` and `pu_window_set_state` expose
driver/compositor capabilities and actual client geometry/state. State callbacks
are deferred to a loop boundary and may close/create windows. Native size
changes still drive rendering and the document viewport; notifications never
replace the native resize path. `width`/`height`, limits and popup offsets are
logical client units; buffer sizes are physical pixels. Win32 adds the actual
DPI-dependent nonclient frame when computing `WM_GETMINMAXINFO`; SDL passes
logical min/max sizes to the native backend. PollyWM applies xdg constraints
to interactive resize and maximize, not fullscreen.

Wayland modality requires the standard `xdg_wm_dialog_v1` registry global.
Querying it uses SDL's public display property and a private Wayland event queue,
without reading SDL internals or changing its listeners. PollyWM implements
same-client, owner-only modality via wlroots' public dialog objects.
The current SDL public popup constructor/properties create a real `xdg_popup`
but do not request `xdg_popup.grab`; explicit grabs are unsupported. Popup
dismissal is a terminal native notification, not a vetoable save request.

Focused fixtures build with `PU_BUILD_LAUNCHER=OFF`:

```powershell
cmake --build --preset win-clang --target pollyui-native-window-test pollyui-native-lifetime-test pollyui-close-tree-test pollyui-playground
ctest --test-dir build\win-clang -R "gui-(win32-window-contract|win32-close-tree|native-window-lifetime|window-contract)" --output-on-failure
```

For a Linux SDL build configured with `PU_BUILD_DESKTOP=ON`, build
`pollywm-window-contract-test`, `pollyui-playground`, `pollyui-native-lifetime-test`
and `pollyui-close-tree-test`, then run
`ctest --test-dir <build> -R gui-wayland-window-contract --output-on-failure`.
The bounded fixture uses a real private headless Wayland compositor, an ordinary
GUI client, native seat input and decoration resize/maximize, mapped popup/parent
roles, modal close veto, compositor dismissal, and 1.5x logical/buffer geometry.
Additional bounded cases cover missing-modal feature errors, retained native
owner resources, multi-level close coordination, native close requests,
GC-dropped handles, reentrant save/new-child creation, captured input cancellation
and the separate forced-quit path. ASan/UBSan can instrument these targets with
compiler/linker flags; prebuilt Skia/SDL/wlroots libraries remain uninstrumented.
It leaves a constraints PNG in `<build>/native-window-evidence`; it does not
use a VM, a synthetic DOM close/resize controller, or production trusted roles.
Headless qualification is not a physical-GPU or macOS execution claim.

### Ordinary-window alpha

`PuWindowConfig.transparent` is a creation-time 0/1 option for ordinary windows,
including owned/modal windows. Query `PU_WINDOW_TRANSPARENT` before creation.
Unsupported features return NULL with Host diagnostics and become JS exceptions.
Popup transparency and mixing the ordinary flag with a dedicated service role
are invalid contracts. Existing `PuLayerConfig.transparent` is independent.
GUI rendering reuses `pu_render_tree_transparent`: zero-alpha black clear, with
each node/text/image preserving its own alpha. The default white clear is unchanged.

On Wayland, the public SDL transparent window flag selects an alpha-capable
presentation buffer and clears the surface's opaque region. GLES explicitly
requests and verifies at least 8 alpha bits; SDL also selects nonopaque EGL
presentation where `EGL_EXT_present_opaque` is available. Skia supplies premultiplied
RGBA. Raster supplies premultiplied BGRA, clears the SDL output with alpha zero,
and copies the streaming texture with `SDL_BLENDMODE_NONE` (no second alpha
multiplication). Auto may fall back to this same alpha-preserving raster path;
explicit GL failure is an error. No SDL private layouts, offsets or SDK patches
are used. Native input remains rectangular.

Build `pollyui-wayland-transparency-test` and `pollyui-playground` with
`PU_BUILD_DESKTOP=ON`, then run `ctest -R gui-wayland-transparency --output-on-failure`.
The real private PollyWM fixture tests raster/gl/auto at 1x and 1.5x, with opaque
and transparent ordinary clients over a two-color native marker window. It reads
the composed output (not merely a client PNG), requires alpha-zero/half/opaque
colors within two 8-bit channel values, checks opaque text pixels, movement,
resized buffers, empty opaque/nonempty input regions, frames, owned/modal lifecycle
and actual native pointer/capture delivery. Raster tests include SDL's default
GL presentation and its software SHM presentation. This bounds software-compositor
qualification; it does not claim physical GPU execution.

The raw Win32 Host uses a backend-private C++ COM helper with an opaque C seam.
Ordinary transparent HWNDs use `WS_EX_NOREDIRECTIONBITMAP`, retaining the existing
native nonclient frame, owner, modal, DPI, resizing and hit-test behavior. They
render into Skia raster BGRA8 and upload the complete premultiplied frame to an
`IDCompositionSurface` (`DXGI_ALPHA_MODE_PREMULTIPLIED`). The helper uses a WARP
device deliberately; this is not Skia hardware GPU rendering or ANGLE. Update
offsets and dimensions are checked, resized surfaces are replaced only after a
successful commit, and each HWND retires its own composition resources.
Unavailable desktop composition or invalid/GL renderer policy rejects creation.
Create/surface/upload/device/commit failures have explicit diagnostics; frame
failure closes the affected native window with a nonzero loop result. There is
no opaque fallback for a transparent request. Default opaque windows retain
their existing GPU-then-raster/blit policy. Other SDL drivers are unsupported.

Build `pollyui-win32-transparency-test`, `pollyui-native-window-test` and
`pollyui-playground`, then run:

```powershell
ctest --test-dir <build> -R "gui-win32-(transparency|transparent-window-contract)" -V
```

The Windows fixture runs the same JS color/foreground document over its own
native marker windows, probes only owned points, and copies only one output pixel
at a time to CPU memory using Desktop Duplication. It never saves the desktop or
activates another application. Capture starts before positioning the own fixture
windows. Each geometry/input phase records a QPC presentation fence; the GUI loop
continues pumping while a nonblocking capture waits, for at most two seconds, for
a desktop-present image at or after that fence. Pointer-only updates
(`LastPresentTime == 0`, `AccumulatedFrames == 0`) and older images are not sampled.
The capture texture must be single-sampled BGRA8; frame timing, format, crop and
marker-client DC diagnostics are logged without saving other window content.
`gui-win32-desktop-frame-contract` tests the metadata gate only, not native pixels.
The native fixture still requires the same alpha-zero/half/opaque/text,
movement, resize, native caption, input/capture and owner/modal close criteria as
the Wayland fixture. Windows input checks use addressed native mouse messages
and the real capture HWND; they do not move the user's physical pointer.
Run it in an interactive desktop session permitting capture
of these own fixture windows. `E_ACCESSDENIED` is an explicit **SKIP (77), not
PASS**; mismatched colors or presentation failures are failures. An optional
second executable argument saves auxiliary Skia PNGs; these are not native proof.

For bounded reference-color diagnosis, run the executable with the script and
`--reference-chart` as its two arguments instead. This diagnostic hides only the
other fixture HWNDs, records a two-color marker-only grid, shows those HWNDs in
their normal fixture positions, then moves the fixture's opaque window upward
and records the grid again. Each scene has one fresh-frame sample after a fixed
500ms setup interval with no further fixture geometry changes; the GUI loop
continues pumping. The re-shown windows use `SW_SHOWNOACTIVATE`, so this controlled
scene does not establish identical activation/shadow state to the initial scene.
Points inside other
visible fixture outer rectangles or outside the marker's native hit-test area
are not read. Uncovered points report measured RGB/channel deltas and unchanged
tolerance2, without retrying until expected colors happen to appear. Successful
diagnostic completion returns **78, not the native verifier's PASS (0)**, and
does not test or qualify transparency. All own windows retire on exit.

**Windows native composition remains unqualified in the current validation
environment.** Own HWNDs were visible, uncloaked, on the Default input/thread
desktop; the marker's own DC/Skia surface contained the correct colors, but screen
GDI reads were white and `DuplicateOutput` returned `0x80070005`. A later diagnostic
reproduction of the user's old-fixture black-marker failure acquired only a
pointer-update notification and read its zero-filled image. This fixture timing defect is corrected
by the desktop-present gate above; correcting it does not itself qualify the
Windows composition path. A later user run obtained a real fresh frame, but an
opaque purple reference read `7b1f3e` rather than `802040` and failed tolerance2
before any transparent-window assertions. Bounded marker-only, re-shown-own-scene
and moved-opaque-window diagnostics at DPI144 subsequently preserved every
uncovered reference RGB exactly after their fixed setup interval. This proves
that this server-side Desktop Duplication path can preserve these colors; it
does not establish the cause of the earlier reference difference, certify RDP
client display/encoding, or qualify the alpha path. Failed experiments disabling
only own-window DWM transitions did not resolve the early reference difference
and are not used by the formal verifier. A successful full native run remains
required; neither near-colored reference pixels nor diagnostic exit78 substitute
for it.
The separate transparent-window native contract fixture can still check real HWND lifecycle,
limits, resize/maximize, native/custom frame geometry and owned/modal relationships
without claiming composed pixels. Native-DPI geometry uses the current monitor;
this does not certify cross-monitor/fractional-DPI desktop pixels or a hardware
GPU. MT-01 needs a successful Windows composed-output run before full qualification.

The user subsequently exercised a persistent three-window manual demo,
confirmed opaque-versus-alpha blending and rectangular input without
click-through, and approved integration on 2026-10-12. That manual functional
acceptance is recorded separately: the early opaque-reference mismatch and
incomplete automatic pixel qualification remain explicit, not relabelled PASS.

### Native drag-source seam

`pollyui/drag.h` defines platform-neutral `PuDragItem`, opaque `PuDragInput` and
`PuDragSession`, COPY completion/cancellation/error results, UI-thread callbacks,
explicit cancellation and reference release. `pu_window_drag_supported` and
`pu_window_start_drag` are the per-Host seam. A native pointer event borrows its
credential; C consumers retain/release it explicitly. Payloads are deep-copied.
Clear a callback before disposing its user/VM; releasing a pending session cancels
it, while the backend retains the snapshot until native cleanup. There are no
Wayland/COM/native-handle types in the public API.

The initial SDL-Wayland backend takes native handles from the exact `PuWindow`,
not a global window search. Its own seat/pointer/data-device proxies share SDL's
connection and never replace SDL listeners. Only one current pointer seat and an
exact still-held origin are admitted. Credentials retain an independent owner
generation across window destruction and address reuse. Popup, modal, special
roles, multi-button/touch and unsupported drivers reject explicitly.

Wayland source callbacks run on a dedicated public event queue with a pure-C
worker. Nonblocking partial sends handle EINTR/EAGAIN/EPIPE without entering JS
or blocking the UI on a recipient. The owning loop samples completion under the
backend lock and invokes callbacks without it. Registry/seat/connection loss
invalidates credentials and terminates pending work. Teardown joins the worker
before destroying its sources, proxies, queue or borrowed SDL display.

Additional data devices receive mirrored offers: they are passive and cannot
accept, change actions, receive or finish. Leave/drop/replacement only marks
retirement; actual destruction is after SDL's entire native pump. Default-queue
source delivery fails for synchronous SDL self-drop, and immediate mirror
destruction can cancel the real source. Both negative cases remain in the
original feasibility evidence; neither is the product implementation.

Build the GUI with `PU_BUILD_LAUNCHER=OFF`, `PU_BUILD_DESKTOP=OFF` and optionally
`PU_LAYER_SHELL=OFF`; this backend requires only wayland-client plus the existing
SDL/GUI dependencies, not wlroots or SysRT. Other Hosts retain the same contract
with an unsupported capability/error, not a fake successful drag. Future native
backends can implement this seam without changing JS's opaque credentials.
The Windows/OLE implementation is explicitly deferred.

`gui-wayland-drag-copy` exercises actual JS application origins and native/SDL
recipients in a bounded headless PollyWM fixture. It includes UTF-8, offset binary
views, empty and 17-MiB payloads, stale/foreign/reused input, capture, self-drop,
role reversal, cancelled/error terminals, GC/owner close, seat/global/connection
loss, backpressure and clipboard regression. The forced-global-loss fixture
retires the production clients but exits its faulted server process without a
second wlroots removal of the same global. Qualification is COPY/no-icon on the
pinned SDL 3.4.10/wlroots 0.19.3 stack, not every compositor or platform. See the
[JS contract](../README.md#native-copy-drag-sources) for results and permission limits.

### Interface extensions needed for mobile/touch

The current contract is desktop-shaped. Mobile needs three additive extensions
(non-breaking — desktop backends ignore them):

```c
/* touch: map to pointer for single-touch; add ids for multi-touch/gestures */
typedef int (*PuTouchFn)(int id, int x, int y, PuPointerType phase, void *user);

/* OS lifecycle (mobile suspend/resume, surface lost/recreated) */
typedef enum { PU_APP_RESUME, PU_APP_PAUSE, PU_APP_SURFACE_LOST, PU_APP_SURFACE_READY,
               PU_APP_LOW_MEMORY } PuAppEvent;
typedef void (*PuLifecycleFn)(PuAppEvent ev, void *user);

/* text input / IME (also raises the soft keyboard on mobile) */
void pu_window_start_text_input(PuWindow *, float caret_x, float caret_y);
void pu_window_stop_text_input (PuWindow *);
/* committed UTF-8 arrives as PuKeyEvent { .type=PU_KEY_TEXT, .text=... } */
```

`safe-area insets` (notch/home-indicator) are reported by extending
`PuPaintFn`'s contract: the backend passes a content rect; the app treats it as
the body's padding. Simplest: add `PuWindowConfig.on_safe_area` callback.

---

## 2. The Skia surface seam

`skia_c.h` already exposes an **opaque-handle** GPU constructor — it takes
`void *`, not `HWND`:

```c
PuSurface *pu_surface_create(int width, int height);                 /* raster (CPU) */
PuSurface *pu_surface_create_gpu(void *native_window, int w, int h); /* GPU; opaque native handle */
PuSurface *pu_surface_create_metal(void *ca_metal_layer, int w, int h); /* Apple; stub in GL build */
int  pu_surface_is_gl(const PuSurface *);
void pu_surface_present(PuSurface *);
void pu_surface_resize (PuSurface *, int w, int h);
void pu_surface_destroy(PuSurface *);
```

So the surface boundary is portable — each host passes a different native handle.
**Phase 1 done:** `pu_surface_create_gl` was renamed to `pu_surface_create_gpu`
(opaque handle) and a guarded `pu_surface_create_metal` stub added, verified
behavior-neutral on Windows (GPU path intact, 250/250 tests). The Apple Metal
implementation lands in `gui/src/render/skia_metal.mm` (defining `PU_METAL_BACKEND`).

| Platform | Skia backend | Native handle passed | EGL/context source |
|----------|--------------|----------------------|--------------------|
| Windows  | GL (ANGLE→D3D11) *(current)* | `HWND` | ANGLE `libEGL`/`libGLESv2` |
| Linux    | Ganesh GLES or CPU raster; Vulkan pending | SDL-owned GLES context with framebuffer 0 | SDL + Mesa EGL (no ANGLE) |
| macOS    | **Metal** | `CAMetalLayer*` | Ganesh Metal / Graphite |
| iOS      | **Metal** | `CAMetalLayer*` | Ganesh Metal / Graphite |
| Android  | GL (GLES) or Vulkan | `ANativeWindow*` | system EGL |

Concretely, the only *new* render code is one Metal constructor alongside the
existing GL one:

```cpp
// skia_metal.mm  (Apple only)
PuSurface *pu_surface_create_metal(void *caMetalLayer, int w, int h) {
    // GrDirectContexts::MakeMetal(device, queue) ; wrap the next drawable each frame
    // identical Ganesh path afterward — pu_surface_present = commit drawable
}
```

Everything downstream (`pu_surface_fill_rrect`, text, gradients, clip, the whole
`render.c`) is **unchanged** — it draws into an `SkCanvas` regardless of backend.

---

## 3. JS event-loop integration (the crux)

PollyUI has its own JS event loop (microtasks, `setTimeout`, `requestAnimationFrame`)
pumped via `PuAsyncFn` (`app_async` → `pu_script_flush_raf` + `pu_script_pump`).
The only thing that differs per platform is **who owns the outer loop**:

| Model | Platforms | Outer loop | Where you pump |
|-------|-----------|-----------|----------------|
| **You own it** | Win32, SDL desktop, Wayland, DRM | `while(GetMessage)` / `SDL_PollEvent` / `wl_display_dispatch` / page-flip loop | each iteration → `PuAsyncFn` + paint if dirty |
| **OS owns it** | iOS, Android, SDL mobile | OS calls you per frame | `SDL_AppIterate` / `CADisplayLink` / `Choreographer` → `PuAsyncFn` + paint |

The key win: **`SDL_AppIterate` unifies both.** SDL calls it every frame on
*all* platforms (desktop and mobile), so one code path drives the pump
everywhere. This maps 1:1 onto the existing `app_async` design.

```c
/* SDL3 main-callback model — same on desktop AND mobile */
SDL_AppResult SDL_AppIterate(void *appstate) {
    PuApp *app = appstate;
    int worked = app_async(app);          /* pump JS: rAF + microtasks + timers */
    if (worked || app->dirty) {
        app_paint(app->surface, lw, lh, app->scale, app);
        pu_surface_present(app->surface);
    }
    return SDL_APP_CONTINUE;
}
```

---

## 4. Tier 1 — SDL3 backend  (`gui/src/host/sdl/`)

The desktop implementation uses a classic event loop, Metal on Apple when enabled,
and GLES or raster on Linux. Linux uses `pu_surface_create_current_gl` with an
SDL procedure resolver; SDL owns context lifetime and swapping, while Skia
owns drawing and wraps the default framebuffer. Keep the context current
through drawing, resize and readback. `PU_RENDERER` controls auto/gl/raster.

The maintained implementation is `gui/src/host/sdl/window_sdl.c`; use it rather than
copying the earlier callback-model sketch. SDL3 supplies native Wayland and
Metal access; mobile lifecycle work remains separate.

Input translation uses `gui/src/host/input.h`: physical keys have logical `key`,
physical `code`, modifiers and repeat; committed text is `PU_KEY_TEXT`. The
application forwards commits as `textinput.data`, and editors insert only from
that event. Win32 combines UTF-16 surrogate pairs before submitting UTF-8.
Pointer callbacks include button identity, held-button masks and logical
coordinates (SDL coordinates must not be divided by DPI again). Right release
becomes `contextmenu`, not a primary `click`. Wheel callbacks carry both axes.
The bridge handles cancellable default scrolling and forward/reverse Tab focus.

**Per-platform specifics under SDL3:**

- **Android** — SDL ships `SDLActivity` (Java) + JNI glue that hands you the
  `ANativeWindow`, input, and the soft keyboard (`SDL_StartTextInput` raises it
  via `InputMethodManager`). **You write zero Java.** ART is in the process (the
  OS mandates it; see `docs` discussion) but is invisible to your code. Artifact:
  APK; the only dex is SDL's bootstrap Activity.
- **iOS** — Metal backend; SDL owns the `UIApplication`/`CADisplayLink`, soft
  keyboard, and safe-area. You add `Info.plist` + signing. Artifact: `.ipa`.
- **macOS** — Metal; SDL owns the `NSApplication`. Artifact: `.app`.
- **Windows/Linux** — GL (ANGLE on Win, Mesa on Linux). SDL handles Wayland↔X11
  automatically. Artifacts: `.exe` / ELF.

---

## 5. Tier 2 — bare embedded Linux (no Java, no SDL)

For appliances that own the whole stack. Two sub-profiles.

### 5a. Wayland client (`gui/src/host/wayland/`) — a compositor is present

```c
// connect + bind globals
wl_display *dpy = wl_display_connect(NULL);
// registry → wl_compositor, xdg_wm_base, wl_seat, wl_shm
wl_surface  *surf = wl_compositor_create_surface(comp);
xdg_surface *xs   = xdg_wm_base_get_xdg_surface(wm_base, surf);
xdg_toplevel_set_title(xdg_surface_get_toplevel(xs), cfg->title);

// GPU: wl_egl_window → EGL (Mesa, NOT ANGLE) → Skia GL
struct wl_egl_window *eglwin = wl_egl_window_create(surf, w, h);
PuSurface *s = pu_surface_create_gpu((void*)eglwin, w, h);  // EGL_PLATFORM_WAYLAND_KHR

// loop: wl_display_dispatch(); pump app_async; commit on wl_surface.frame callback (vsync)
// input: wl_pointer/wl_keyboard/wl_touch + xkbcommon for keymaps → §1 callbacks
```

You provide **client-side decorations** (draw your own title bar — trivial with
PollyUI) or negotiate `xdg-decoration` if the compositor supports SSD.

### 5b. DRM/KMS + GBM (`gui/src/host/drm/`) — **no compositor**, direct to display

The true single-app appliance path: boot → your binary owns the screen.

```c
int fd = open("/dev/dri/card0", O_RDWR);          // libdrm
// drmModeGetResources → pick connector + CRTC + mode
struct gbm_device  *gbm = gbm_create_device(fd);
struct gbm_surface *gs  = gbm_surface_create(gbm, mode.hdisplay, mode.vdisplay,
                              GBM_FORMAT_XRGB8888, GBM_BO_USE_SCANOUT|GBM_BO_USE_RENDERING);
// EGL from gbm: eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, gbm, …)
PuSurface *s = pu_surface_create_gpu((void*)gs, mode.hdisplay, mode.vdisplay);

// per frame: render → eglSwapBuffers → gbm_surface_lock_front_buffer →
//            drmModeAddFB2 + drmModePageFlip (vsync); release prev bo
// input: libinput + libudev (evdev) + xkbcommon → §1 callbacks
```

Dependencies: `libdrm`, `gbm`, `libEGL`/`libGLESv2` (Mesa), `libinput`,
`libudev`, `xkbcommon`. **No X, no Wayland, no Java, no SDL.** Boots from
Yocto/Buildroot straight into PollyUI. This is the kiosk / IVI / set-top path.

---

## 6. CMake wiring

```cmake
set(PU_HOST "win32" CACHE STRING "win32 | sdl | wayland | drm")
set(PU_GPU  "auto"  CACHE STRING "auto | gl | metal | vulkan | raster")

if(PU_HOST STREQUAL "win32")    target_sources(pollyui PRIVATE gui/src/host/win32/window.c)
elseif(PU_HOST STREQUAL "sdl")  target_sources(pollyui PRIVATE gui/src/host/sdl/window_sdl.c)
                                find_package(SDL3 REQUIRED); target_link_libraries(pollyui SDL3::SDL3)
elseif(PU_HOST STREQUAL "wayland") target_sources(pollyui PRIVATE src/host/wayland/window_wl.c)
                                target_link_libraries(pollyui wayland-client wayland-egl xkbcommon EGL GLESv2)
elseif(PU_HOST STREQUAL "drm")  target_sources(pollyui PRIVATE src/host/drm/window_drm.c)
                                target_link_libraries(pollyui drm gbm EGL GLESv2 input udev xkbcommon)
endif()

if(APPLE)  target_sources(pollyui PRIVATE gui/src/render/skia_metal.mm)   # Metal path (PU_METAL_BACKEND)
                                                                     # skia_c.cpp's metal stub is then excluded
endif()
# gui/src/render/skia_c.cpp (GL/ANGLE/raster + metal stub) builds on every target
```

---

## 7. Build & packaging matrix

| Target | PU_HOST | PU_GPU | Toolchain | Artifact |
|--------|---------|--------|-----------|----------|
| Windows | `win32` *(or `sdl`)* | gl (ANGLE) | clang-cl / MSVC | `.exe` |
| Linux desktop | `sdl` | GLES or raster | clang/gcc, native musl build available | ELF |
| macOS | `sdl` | metal | clang + Xcode SDK | `.app` |
| iOS | `sdl` | metal | Xcode + iOS SDK | `.ipa` |
| Android | `sdl` | gl (GLES) | NDK + SDL Java shell | `.apk` |
| Appliance (compositor) | `wayland` | gl (Mesa) | Yocto SDK | rootfs binary |
| Appliance (bare) | `drm` | gl (Mesa) | Yocto SDK | rootfs binary |

---

## 8. What you write vs what you get free

- **App + UI**: 100% JS + PollyUI, **shared across every target**. Zero per-platform app code.
- **Per platform you write**: one host `.c` (or *reuse SDL's for 5 targets at once*).
- **Per GPU API you write**: one surface constructor (`_gpu` GL exists; add `_metal`).
- **Java/ObjC/Swift**: **none** on the SDL path (SDL owns the shells); **none** on bare Linux (there is no Java).

---

## 9. Honest gaps & decisions

| Gap | Status / mitigation |
|-----|---------------------|
| **Accessibility** (screen readers) | None today. Per-platform (UIA/AT-SPI/UIKit a11y). Real work; the Skia-direct (Flutter) trade-off. |
| **IME depth** | SDL gives basic candidate/commit + soft keyboard; raw native is richer. Fine for Latin; verify for CJK. |
| **QuickJS = interpreter (no JIT)** | Fine for UI logic (hot path is native Skia). Engine is swappable → Hermes for compute-heavy mobile. |
| **Prebuilt Skia lacks Metal** | The pinned aseprite/skia m124 macOS prebuilt ships the GL backend, not Metal. The default macOS build therefore renders via the CPU raster fallback; GPU Metal (`-DPU_METAL=ON`) needs a Skia built with `skia_use_metal=true`. |
| **Touch / gestures** | Needs the §1 `PuTouchFn` extension for multi-touch; single-touch maps to pointer today. |
| **HiDPI / fractional scaling** | SDL + Wayland handle it; the existing `scale` plumbing already supports it. |
| **Packaging / signing / stores** | Per platform (`.ipa` signing, Play upload, notarization). Out of engine scope. |

---

## 10. Recommended sequencing

1. ✅ **Refactor the surface seam** (`create_gl`→`create_gpu`, stub `create_metal`).
   *Done — behavior-neutral, GPU path intact, 250/250 tests pass on Windows.*
2. **SDL3 desktop backend** (`gui/src/host/sdl/`) → validate Win/Linux/macOS with one
   host. macOS forces the **Metal** path, exercising the new render code.
   *Done (macOS):* `gui/src/host/sdl/window_sdl.c` (PuWindow contract via SDL3, classic
   poll loop so `main.c` is unchanged) + `gui/src/render/skia_metal.mm` (Ganesh Metal
   via `SkSurfaces::WrapCAMetalLayer`) + CMake `PU_HOST`/`PU_METAL` wiring + the
   `mac-sdl-metal` preset. **Verified on Apple Silicon**: GPU Metal rendering,
   native traffic-light title bar (`window.setTitleBarStyle('overlay')`), live
   input, and clean live resize. Also ported thread.c (pthreads), fetch.c, and
   the CoreText font manager.
   *Linux raster milestone:* SDL3 presentation, Fontconfig/FreeType discovery
   and a pinned native Skia source build for Alpine/musl. The runtime helper
   runs PollyUI as a real Wayland client on WSLg and PollyWM. An SDL-owned
   EGL/GLES path now supports auto/gl/raster selection and framebuffer readback;
   software llvmpipe coverage is not physical GPU validation. Hardware qualification,
   complete IME remains pending. Linux libcurl and XDG app storage are available;
   macOS HTTP and native app-directory integration remain separate work.
3. **iOS + Android via the same SDL3 backend** (Metal already done; add the
   §1 touch/lifecycle/text-input extensions + APK/ipa packaging).
4. **Embedded Linux** (`wayland` first, then `drm`) for appliances — no Java, no SDL.

Throughout, the raw **`win32`** backend stays selectable for a zero-dependency
Windows build. The HostEngine interface never changes shape — every backend is a
drop-in implementation of §1.
