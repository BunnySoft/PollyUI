# PollyUI — Design

> A cross-platform UI framework: write UI in JavaScript, lay it out with
> Flexbox, render it with Skia, run it natively on Windows, macOS, and Linux.

Status: **working (Windows)**. The full vertical slice runs — JavaScript drives
a native, GPU-accelerated, Flexbox-laid-out window. This document is the design
contract; the layering and the JS↔native boundary have held stable. See §10 for
the implemented-vs-planned feature list.

---

## 1. Goals & non-goals

**Goals**
- One JS codebase drives a real native window on Win/macOS/Linux.
- DOM-like API (`document.createElement`, `style`, `appendChild`,
  `addEventListener`) so web developers are immediately productive.
- GPU-accelerated rendering via Skia; Flexbox layout via Yoga.
- Small, embeddable script runtime (QuickJS) — no V8/Node heaviness.
- Clean, documented C ABI at the script boundary so the model is bindable from
  other languages later.

**Non-goals (for now)**
- Not a web browser. No HTML parser, no CSS cascade/selectors engine, no
  network stack. Styling is imperative (`el.style.x = y`) at MVP.
- No HTML/JSX bundler. Apps are plain `.js` files; a React-style layer can come
  later *on top of* the DOM API.
- No accessibility tree or animation timeline at MVP (planned,
  see §10).

### 1.1 Product and module boundaries

Discussion conclusions (2026-10-10):

- PollyUI remains an independent cross-platform, native self-rendered GUI.
  PollyOS uses it; GUI code must not depend on Linux desktop policy.
- PollySystemRT is the optional system-capability runtime, not the QuickJS
  ScriptEngine. Borrow stable component boundaries from COM, not its naming,
  base-object model or remote reference counting. The target is JS-first:
  Application JS -> RuntimeSDK (JS) -> generic QuickJS FFI module -> OS libraries.
  Use libffi plus platform loading (dlopen/dlsym or LoadLibrary/GetProcAddress),
  not a handwritten C bridge for each domain.
- Generated binding descriptions define ABI types/layouts and explicit ownership.
  JS SDK/services own domain semantics, state machines and policy. Keep native
  code for generic interop and unavoidable mechanisms; prefer generated thin
  adapters for macros/inline functions. FFI does not make calls asynchronous or
  callbacks thread-safe, and does not constitute a sandbox.
- Separate presentation, application logic and OS implementations regardless
  of whether calls are in-process or IPC. Logic must work without a GUI;
  deployment adapters are selected at the composition root.
- Isolate applications by process, UI VM and event loop. Windows of the same
  application may share its realm. Settings must eventually be independent
  from Shell without inheriting its private desktop connection.
- Keep PollyWM independent. Desktop authority, display recovery and dedicated
  input/lock roles must not move into ordinary application UI.
- FFI is local; RPC reuses suitable IPC; discovery is not authorization.
  REST/OpenAPI is an explicit external subset, not a mandatory desktop stack.
  System services can run headless JS logic over the same SDK/FFI; e.g. D-Bus
  calls use native transport libraries rather than duplicating per-service C bindings.
- Aim for basic configuration, management and everyday GUI applications,
  not full Windows feature coverage. Prefer sound boundaries over breadth.
- During development, replace implementations directly: migrate callers and
  tests and remove superseded code in the same change. Do not maintain legacy
  APIs, parallel bridges or reference copies; history belongs in Git.
- Organize by product: `gui/` delivers a library, public headers and `sdk/js/`;
  `sysrt/` and `desktop/` stay separate. GUI context does not own the application.
  `desktop/launcher` assembles the formal runtime; `examples/playground` is a
  GUI-only example, not the desktop application host.

Migration: native GUI/SDK/examples/tests now live in `gui`, system capabilities
in `sysrt`, and execution primitives in `shared`. The GUI library exposes
context hooks; Linux service assembly stays in `desktop/launcher`. Existing
Files and installer modules distinguish UI, logic and tests. Mixed active
integration remains in `desktop/native`. The generic FFI and JS/config SDK path is implemented, including the Linux
filesystem SDK; its old C provider/projection are removed. Native mappings
preserve OS behavior; bounded text, directory snapshots and ordinary-user
rules belong to the desktop file service, not SysRT. The launcher uses
a JS service prelude before the app entry; a generic shared-module root makes
SDK loading independent of the app's working directory.
The basic process SDK now maps native creation/wait/signal APIs; argument
vectors and pointer fields use generic FFI memory, not a process-specific C
bridge. Desktop launch/activation policy remains separate.
The socket SDK follows the same native-mapping boundary for TCP/UDP and
readiness calls. Protocol services, socket ownership and asynchronous scheduling
remain above it; native fetch and desktop network services are not yet migrated.
The asynchronous native-call path supports scalar/CString inputs and exclusive
loans of flat managed buffers, settling through the owning dispatcher.
External allocations can now be explicitly adopted with their byte extent and
matching void(pointer) releaser. Scoped same-thread synchronous scalar callbacks
are implemented; foreign-thread/retained callback routing, borrowed external
views and native cancellation remain staged.
The first generated ABI path covers Linux x86_64 statx and file constants from
native headers, with deterministic output and explicit target/type checks.
The first D-Bus client uses explicit-address libdbus connections and zero-wait
uint32 request/reply polling; setup is synchronous, and remote services/cancellation
semantics remain separate. Existing native desktop services are not yet replaced.
The complete runtime and logic/UI extraction remain unfinished. Record stable
decisions here, not detailed file inventories or speculative implementations.

---

## 2. The five engines (and how they fit)

```
            ┌──────────────────────────────────────────────────────┐
            │                    app.js  (user code)                │
            └───────────────────────────┬──────────────────────────┘
                                         │  DOM-like API
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ ScriptEngine  (QuickJS)                                                     │
 │   • JS VM, GC, event loop (timers, microtasks, rAF)                         │
 │   • Hosts the bindings that expose the Model to JS                          │
 └───────────────────────────────┬───────────────────────────────────────────┘
                                  │  Bridge  (C ABI: JS class ⇄ native Node*)
 ┌───────────────────────────────┴───────────────────────────────────────────┐
 │ Model  (the "DOM")                                                          │
 │   • Retained tree of Nodes: Document, Element, TextNode                     │
 │   • Each node owns: style props, attributes, children, event listeners,    │
 │     a Yoga node handle, and resolved paint properties                       │
 │   • The single source of truth shared by every engine below                │
 └───────┬───────────────────────────────────────────┬───────────────────────┘
         │                                             │
 ┌───────┴─────────────┐                     ┌─────────┴───────────────────────┐
 │ LayoutEngine (Yoga) │                     │ RenderEngine (Skia)             │
 │  • Flexbox geometry │  computed box →     │  • Walks tree, builds display   │
 │  • dirty-tracking   │  ───────────────►   │    list, paints to SkSurface    │
 └─────────────────────┘                     └─────────┬───────────────────────┘
                                                        │ surface / GPU context
 ┌──────────────────────────────────────────────────────┴──────────────────────┐
 │ HostEngine  (platform layer)                                                  │
 │   • Window, GPU surface (GL/Metal/Vulkan/raster), OS event loop, input        │
 │   • Win32 · Cocoa · X11/Wayland                                               │
 └───────────────────────────────────────────────────────────────────────────────┘
```

### What each one is responsible for

| Engine | Library | Owns | Talks to |
|---|---|---|---|
| **ScriptEngine** | QuickJS-ng | JS VM, GC, JS event loop | Bridge → Model |
| **Bridge** | our C++ | JS-object ⇄ native-Node mapping, lifetimes, event dispatch | Script ↔ Model |
| **Model (DOM)** | our C++ | retained node tree, style, listeners | Layout, Render |
| **LayoutEngine** | Yoga | Flexbox computation, dirty flags | reads/writes Model geometry |
| **RenderEngine** | Skia | surface, display list, painting | Model (read), Host (surface) |
| **HostEngine** | per-OS | window, GPU context, input loop | Render (surface), Script (events) |

---

## 3. Your HostEngine question: is it part of it? what language?

**Yes — the HostEngine is a first-class part of the framework**, not optional
glue. It is the only platform-specific layer; everything above it is portable.
Its job: create the window, obtain a drawable GPU surface for Skia, pump the OS
event loop, and translate native input into framework events. It is also where
"app lifecycle" lives (start, vsync tick, resize, close).

It is **not** a separate "bridge". The bridge (Script↔Model) is portable C and
lives in `gui/src/bridge`. Mixing "host" and "bridge" is a common confusion — we
keep them separate: Host = *platform*, Bridge = *language boundary*.

### Language: **C (C11)** — chosen. Reasoning vs the alternatives.

Selection criteria (in priority order): **readability, runtime performance,
long-term maintainability / a stable language standard.** C++ was rejected
specifically for dialect sprawl (C++11/14/17/20/23, multiple idioms for every
task) — a permanent maintenance tax — despite minimizing glue.

- **QuickJS is C, Yoga has a first-class C API, Skia is C++.** Two of the three
  libraries are used natively from C with zero binding layer. Only Skia needs
  glue (see below).
- **Why C wins for our criteria:** one obvious way to write things (readable),
  identical codegen/performance to C++, and a standard (C11/C17) that has been
  stable for a decade and doesn't move under us. QuickJS and Skia are
  themselves proof that C-style code reaches top-tier performance.
- **The cost — Skia:** Skia has no first-class C API, so we write **one thin
  `extern "C"` C++ shim** (`gui/src/render/skia_c.cpp`) exposing just the draw calls
  we need. It is the *only* `.cpp` in the tree; everything else (host, model,
  bridge, layout, script) is plain C. The maintained C++ surface is near zero.
  (Alternative: the third-party `sk4d` C API → no C++ at all, at the cost of
  Skia's C-API ceiling. We start with our own shim for full control.)
- **Manual memory:** the lifetime-heavy bridge (§6) is managed the way QuickJS
  itself is — intrusive refcounts, single-owner trees, arena/pool allocators
  for transients. The Model uses tagged structs (`NodeType` + union) instead of
  class inheritance — arguably more readable than a class hierarchy.
- **vs Pascal:** also stable/readable and Skia4Delphi exists, but it needs a
  binding layer for *all three* libs (mature for Skia, community for QuickJS,
  hand-rolled for Yoga) vs C's two-of-three native. Stays a viable alternative
  if the team is Delphi/Lazarus-strong.
- **vs Rust/Zig:** rejected for our criteria — Rust adds borrow-checker
  ceremony (against "readable"); Zig is pre-1.0 and still changing (against
  "stable standard").

**Verdict:** Host + all engines in **C11**, with a single isolated `extern "C"`
C++ Skia shim. Ranking for these criteria: **C (1) > Pascal (2) > C++ (3)**.

---

## 4. The Model (DOM) — the heart of the bridge

The Model is the shared retained tree. One `Node` struct tagged by `NodeType`
(`DOCUMENT`, `ELEMENT`, `TEXT`) — a tagged union, not a class hierarchy.

```
Node
 ├─ parent, firstChild/nextSibling (intrusive linked list)
 ├─ YGNodeRef            // Yoga layout node (Elements only)
 ├─ Style style          // resolved style props (flex, size, color, ...)
 ├─ map<string,string> attributes
 ├─ vector<Listener> listeners   // event type → JS callback handles
 ├─ JSValue jsWrapper (weak)      // cached JS object, see §6 lifetimes
 └─ dirty flags { layout, paint }
```

- **Ownership:** the tree owns its nodes. Parent → child via intrusive refcount
  (or `unique_ptr` children + raw parent). JS holds *handles*, never ownership.
- **Style:** a flat struct of the supported properties (size, margin, padding,
  flex-*, position, background-color, border, opacity, text props). Setting a
  style prop sets the corresponding Yoga input and/or marks paint dirty.
- **Node kinds at MVP:** `view` (box), `text` (text run), `image` (later).
  Tag → kind mapping in `document.createElement(tag)`.

### JS-facing API (MVP surface)

```js
const root = document.body;                 // the window's root element
const box  = document.createElement('view');
box.style.width = 200;
box.style.height = 120;
box.style.flexDirection = 'row';
box.style.backgroundColor = '#3b82f6';
box.style.padding = 8;

const label = document.createElement('text');
label.textContent = 'Hello PollyUI';
label.style.color = 'white';

box.appendChild(label);
root.appendChild(box);

box.addEventListener('click', (e) => {
  box.style.backgroundColor = '#ef4444';
});

requestAnimationFrame(function tick(t) {
  // animate, then schedule again
  requestAnimationFrame(tick);
});
```

This is intentionally a familiar subset of the web DOM so the mental model
transfers, without committing us to implementing the whole web platform.

---

## 5. Frame pipeline (one tick)

```
OS event loop (Host)
   │  input / vsync / resize
   ▼
ScriptEngine: drain JS event loop
   • run due timers, microtasks, rAF callbacks
   • JS mutates the Model → nodes flagged dirty(layout|paint)
   ▼
LayoutEngine: if any layout-dirty → YGNodeCalculateLayout(root, w, h)
   • write computed (x,y,w,h) back onto nodes
   ▼
RenderEngine: build display list from tree, paint to SkSurface
   • background rects, borders, text, clips, opacity
   ▼
Host: present (swap buffers / flush GPU)
```

Only dirty subtrees recompute. If nothing is dirty and no animation is pending,
we idle (don't repaint) — event-driven, not a busy 60fps loop, until rAF or an
animation requests frames.

---

## 6. The Bridge: JS ⇄ native lifetimes (the hard part)

This is where these frameworks usually break, so we pin it down now.

- Each native node type gets a **QuickJS `JSClassID`**. The JS wrapper object
  stores the native `Node*` via `JS_SetOpaque`.
- **Wrapper cache:** `Node → JSValue (weak)`. `node.jsWrapper()` returns the
  existing wrapper or lazily creates one. Guarantees object identity:
  `el.firstChild === el.firstChild`.
- **Ownership direction:** the *native tree owns nodes*. JS wrappers are weak
  references into it. A node is destroyed when removed from the tree **and** no
  JS wrapper keeps it alive — handled by a small refcount that counts (in-tree)
  + (live-wrapper).
- **GC finalizer:** when QuickJS collects a wrapper, the finalizer drops the
  wrapper's hold on the node (clears the cache slot, decrefs). If the node is
  still in the tree it survives.
- **Event callbacks:** listeners are `JSValue` callables held with an explicit
  ref (`JS_DupValue`) in the node's listener list, released on
  `removeEventListener`/node destruction. Dispatch = hit-test → walk listener
  list → `JS_Call`.
- **Errors:** uncaught JS exceptions are caught at the call boundary, printed
  with stack, and never cross into C++ as exceptions.

All bridge entry points are plain C functions (`static JSValue qjs_*`),
registered as methods — this is the documented C ABI seam from §3.

**Shutdown order:** stop event dispatch, cancel/join requests, workers and native
tasks, discard their queued deliveries, then call `pu_bridge_free`
while the JS context/runtime is still alive, and only then `pu_script_destroy`.
The bridge releases native-held callbacks across all live nodes (including
detached trees), plus focus/hover/body references. A temporary native hold keeps
the listener sweep safe against wrapper finalizers. Once all windows and scripts
are gone, `pu_render_shutdown` releases image/font caches and Linux Fontconfig
state. Releasing native callback values after destroying their VM is invalid.

---

## 7. Threading model

**Implemented: UI thread + isolated work threads.** The main JS, the DOM,
layout, and paint all run on the **UI thread** (the DOM is touched from one
thread only — like browsers and Flutter). Parallelism comes from isolation, not
a shared multithreaded DOM:

- **`Worker`** — a separate `JSRuntime` on its own thread, no DOM; communicates
  by **copied messages** (`postMessage`/`onmessage`, JSON). No shared mutable
  state ⇒ no locks around the tree, race-free by construction.
- **Native async tasks** (`computeAsync`) — background C work on a thread, the
  completion callback **marshaled back to the UI thread**.
- A UI-thread **dispatcher** (`shared/dispatch`) is the marshal-to-UI
  mechanism (cf. WinForms `Control.BeginInvoke` / WPF `Dispatcher`); an
  outstanding-async refcount keeps the event loop alive while work is in flight
  (cf. libuv handle refs). Worker threads wake the window via a posted message.

**Deferred:** moving the *main* DOM-manipulating JS onto its own thread (the
old React-Native async-bridge model). The industry moved away from it
(Fabric/JSI), and our bridge is already synchronous/JSI-like — so Workers cover
parallelism without the bridge's costs.

---

## 8. Dependencies & how we get them

| Dep | Role | Acquisition |
|---|---|---|
| **QuickJS-ng** | JS engine | **Vendored** in `third_party/quickjs` (v0.15.1, `add_subdirectory` builds the `qjs` lib). Maintained fork of Bellard's QuickJS. |
| **Yoga** | Flexbox | **Vendored** (trimmed) in `third_party/yoga` (v3.2.1, `yogacore`). Used via its **first-class C API** (`YGNode*`). |
| **Skia** | 2D GPU renderer | **Prebuilt** (aseprite/skia m124) via `tools/fetch_skia.ps1` (gitignored). Driven through **our `extern "C"` shim** (`gui/src/render/skia_c.cpp`) compiled against Skia's headers — see §3. |
| **ANGLE** | GLES → D3D11 | `libEGL`/`libGLESv2`/`d3dcompiler_47` (x64), **dynamically loaded** at runtime — no import lib. Staged next to the exe by `tools/fetch_angle.ps1` (from an installed Chrome/Edge). |
| **Platform** | window/GPU | Win32 + ANGLE (Windows, done); Cocoa + Metal/ANGLE (macOS) and X11/Wayland + GL/ANGLE (Linux) — planned (§10). |

Build system: **CMake** (≥3.25) + Ninja + **clang-cl** (against an installed
MSVC SDK), presets in `CMakePresets.json` (`win-clang`, `win-clang-windowed`).
Language: **C11** for everything except `skia_c.cpp` (C++ — the Skia + ANGLE
shim). Skia is the only heavyweight dependency.

---

## 9. Repo layout

```
repository/
├─ gui/                    # native library, public headers, JS SDK, playground and GUI tests
├─ sysrt/                  # system capabilities and language projections
├─ desktop/                # launcher, compositor, Shell, applications and Linux deployment
├─ shared/                 # small execution primitives
├─ tests/                  # cross-product boundary checks
├─ tools/                  # repository build/maintenance
└─ third_party/            # external dependencies
```

---

## 10. Status — implemented vs planned

The Windows-first vertical slice is **complete and working**. Features are
committed with runnable demos (`gui/examples/playground`) and deterministic
headless tests (`gui/tests`, run via `pollyui --test`) — **101 assertions** at present.

The full, row-by-row matrix lives in **[ROADMAP.md](./ROADMAP.md)**; this is the
narrative summary.

### Implemented ✅

**Engines & pipeline** — Win32 host (window/loop/resize, per-monitor-v2 **DPI**,
`WM_DPICHANGED`); **QuickJS-ng** script engine; retained refcounted **DOM**;
**Bridge** with a weak wrapper cache + GC finalizers; **Yoga** Flexbox; **Skia**
renderer; async-aware event loop.

**Paint (Skia)** — rect/rounded-rect fills, **borders**, **border-radius**,
blurred **box shadows**, linear **gradients**, **images** (cached, scaled,
clipped), **opacity** (subtree layers), **transforms** (rotate/scale/translate
about center), **clipping** (`overflow:hidden`) and **scrolling**
(`overflow:scroll`/`auto` + wheel). **Text** with DirectWrite, inherited
`fontSize`/`color`, **bold/italic** weight, **multi-line** (`\n`), and a
**blinking, movable caret**.

**Rendering backend** — **GPU: Skia Ganesh → ANGLE → Direct3D 11** (works
without native GL); **raster (CPU)** + `StretchDIBits` fallback (headless tests
always use raster).

**Layout** — `flexDirection`/`Grow`/`Shrink`/`Basis`/`Wrap`,
`justify`/`align`(`Items`/`Self`/`Content`), `gap`, `width`/`height` +
`min`/`max` (px/%/auto), per-edge `padding`/`margin`, `position:absolute`,
`display:none`.

**DOM** — create/append/remove/insert, tree accessors, `textContent`;
`setAttribute`/`getAttribute`/`has`/`remove`, `id`/`className`/`classList`,
`getElementById`/`querySelector(All)` (`#id`/`.class`/tag/`*`), `scrollTop`/
`scrollLeft`, `measureText()`.

**Events** — click/`mousedown`/`up`/`move`, `mouseenter`/`leave` hover, `wheel`,
`keydown`/`keyup`, `focus`/`blur`; **bubbling** with `stopPropagation`/
`stopImmediatePropagation`/`preventDefault`; `tabIndex` + **Tab** focus cycling.

**Runtime** — `console.*`, `setTimeout`/`setInterval`, promises/microtasks,
**`requestAnimationFrame`**, **ES modules** (`.mjs` `import`/`export`),
**`localStorage`** (file-backed, survives restarts), and **`fetch`** (Promise;
http/https via WinHTTP on a thread, plus `file://`; `Response.text()`/`json()`).

**JS framework layer** (in `gui/sdk/js/`, on the DOM API) — a **React-style reconciler**
(`reconciler.mjs`: `h`/`render`/`mount`, diffing), a **Vue-style reactivity +
Composition API** (`vue.mjs`: `ref`/`reactive`/`computed`/`watch`,
`createApp`/`setup`) layered on it, a **Naive UI-style component library**
(`naive.mjs`: `NButton`/`NCard`/`NInput`/`NSwitch`/`NTag`/`NSpace` + theme), a
**CSS stylesheet + selector engine** (`css.mjs`), an **rAF tween library**
(`anim.mjs`), and a **text input** with selection + editing (`textinput.mjs`).

**Concurrency** — **`Worker`** (per-thread QuickJS, JSON messages),
**`computeAsync`** (native background compute), and a UI-thread **dispatcher**
(the `BeginInvoke` mechanism) that keeps the loop alive while async is pending.

**Tooling** — headless test API (`render`/`click`/`mouse`/`scroll`/`key`/`pixel`/
`save`); no-console release build (`PU_WINDOWED`); symbolized **crash handler**;
CMake + Ninja + clang-cl.

### Planned 🛠

- **macOS / Linux host ports** (Cocoa/Metal, X11/Wayland + ANGLE-or-native GL) —
  the last big architectural piece; everything above Host is already portable.
- **Accessibility** — semantic tree → UI Automation / AT-SPI / NSAccessibility.
- **Text:** explicit paragraph-direction/locale policy, advanced typography and additional input engines.
- **Reconciler hooks** (`useState`-style state) + a packaged component library.
- **Perf** (persist + dirty-track the Yoga tree) and CSS units
  (`em`/`rem`/`vh`/`vw`) + pseudo-states.

### Private session bus and notifications

The development session owns a private D-Bus daemon with the compositor's
lifetime. Parent bus addresses never become application defaults; native
launching validates the private marker/address and user-owned runtime socket.
Session-bus connections use libdbus directly, with bounded message/receive
queues and no GLib event loop.

The Shell notification server parses protocol requests into copied C-owned
records, not retained D-Bus messages or JavaScript values. Sender unique names
own their IDs; revisions guard native UI actions against replacements.
The main pump dispatches a bounded batch, expires notices by monotonic time,
then notifies JavaScript outside D-Bus callbacks. Rendering treats content as
plain text and sends action signals instead of executing sender-provided
commands. Shutdown releases the bus before destroying the JS realm.

The StatusNotifier host uses a separate libdbus connection with bounded
asynchronous requests. Registration resolves a well-known service to its
actual sender, and subsequent calls pin that unique owner so a name replacement
cannot inherit an old UI action. Native monotonic deadlines cover requests even
when the libdbus main-loop timeout hooks are not integrated.

Pixmap payloads become process-local Skia images under reserved memory keys;
no temporary icon files or client-selected image paths are opened. DBusMenu
trees are parsed into bounded flat records, validating types, IDs and depth
before exposing a snapshot. Only visible enabled current entries can send the
fixed clicked event; layout changes and owner loss invalidate prior revisions.

iwd uses a separate system-bus connection. Discovery first verifies the
service's unique owner and root UID; only then can that owner call the
interactive agent. Current-model revisions constrain actions, and prompt
tokens constrain credential replies. A connection initiated by the user owns
the only allowed authentication target; unrelated or stale agent calls are
rejected. Password values stay outside model snapshots and storage, while
explicit UI confirmation explains iwd's own persistent profile behavior.
The daemon's property snapshots, not method return alone, determine displayed
connection state. System-service testing uses an isolated API fixture rather
than mutating the execution host's network.

### Private audio policy

An opt-in session-owned PipeWire core replaces dependence on an ambient audio
server. The Shell validates its runtime/socket ownership and peer UID before
connecting via an already-open FD. Its native client uses a nonblocking
PipeWire main-loop iteration in the ordinary runtime pump; protocol callbacks
update bounded C-owned state, and JavaScript receives changes afterward.
There is no WirePlumber or GLib/GIO event-loop dependency.

Policy tracks nodes, ports, default metadata and links. It honors autoconnect,
explicit endpoint targets and manual routes; negotiated raw DSP adapters handle
supported channel layouts. Tagged lingering links survive policy reconnection.
Only obsolete tagged routes are removed. Preferred endpoint names remain in
metadata when a device disappears, while the actual default can fall back.
Node revisions protect UI writes; volume requests preserve channel balance and
cannot request amplification above one.

The launcher owns daemon startup and failure/exit cleanup. Real fixtures
exercise virtual playback and nonzero capture, not physical devices. The
ALSA/ACP configuration still needs hardware qualification. PollyShell persists
acknowledged user setting changes in bounded JSON, restoring unique endpoint
names/classes into fresh runtime IDs. Runtime connection generations and node
instances distinguish stale acknowledgments. Missing-device fallback does not
overwrite saved choices; microphone mute/unmute follows the saved preference.
Invalid data, duplicate names, missing acknowledgments and failed writes are
reported instead of silently treated as saved. PulseAudio compatibility,
Bluetooth policy, application capture consent and portals are not implied by
this audio service.

### Clipboard ownership and data devices

Clipboard callbacks retain copied C buffers, not JavaScript references. SDL
owns each valid offered payload and its cleanup callback, including a backend
setter failure after ownership transfer. Shutdown stops the host before
destroying the JS realm; callbacks cannot reenter a destroyed context.
The test harness substitutes process-local memory instead of the user's
clipboard. Native access requires application keyboard focus; this is an API
guard, not a sandbox or an OS-wide clipboard confidentiality guarantee.

PollyWM validates standard pointer-drag origins and serials, owns icon scene
nodes and restores input when the wlroots drag ends. The SDL adapter copies
drop chunks into per-window bounded aggregates and synchronously dispatches
completed payloads into that window's DOM. Incoming files remain path strings,
not automatically authorized file access. Outgoing PollyUI drag sources,
clipboard persistence and full browser DataTransfer are separate work.

### Native multi-window runtime

Linux IME clients are separate processes with connection-bound input-method-v2
and virtual-keyboard capabilities, distinct from Shell privileges. The
compositor relays only eligible focused text-input-v3 state; sensitive fields
are excluded. Candidate surfaces use input-popup roles, preserve the editor's
keyboard focus and inherit compositor placement rather than managing windows.
Rime callbacks update copied C snapshots; JavaScript UI callbacks run only from
the normal runtime pump, never reentrantly inside SDL/Wayland dispatch.

Each native document owns its editor configuration and composition target.
Preedit is not committed application data. Ending composition and delivering
the text commit are ordered operations, and a focus change during the end
callback cannot redirect the commit to a different field. SDL input rectangles
are refreshed from computed layout; explicit editor focus/purpose changes
restart the native input session. SDL's current API does not expose surrounding
text; complex-text rendering remains separate from this protocol path.

Linux shapes directly with HarfBuzz over the Skia typeface's OpenType tables.
ICU resolves bidi runs and grapheme/line opportunities; fallback selects a font
for each grapheme, then contiguous font/script spans are shaped in visual order.
Glyph positions and cluster advances are reused by measurement, drawing and
editor geometry. Logical editing indices remain UTF-16, with cached ICU
boundaries preventing partial deletion of combining/emoji/Indic sequences.
Skia's own optional text modules remain disabled; the direct HarfBuzz build
also disables GLib/GObject/Cairo. Other platform renderers are unchanged.

Module evaluation promises are retained until they settle. A rejected module
or unfinished top-level await is a failed application/test, not a successful
return merely because QuickJS returned a Promise instead of `JS_EXCEPTION`.

The development SDL build tracks ownership of Wayland show/hide sync callbacks
through window teardown, including failed display connections. PollyUI does
not reach into opaque SDL structures or suppress that dependency's leaks.

One application now shares its QuickJS context, dispatcher and background
services across multiple native windows. Each window's `PuApp` binds a distinct
`PuBridge` document and input state to its native host callbacks. DOM methods
resolve the receiver's document; changing OS focus never swaps the global
`document`. Layout validity is cached per root using a shared mutation version,
so equally sized windows cannot accidentally reuse another root's geometry.
Each document strongly retains its body wrapper, preserving reconciler mount
state across repeated `document.body` reads. Other node wrappers retain their
weak-cache behavior.

Active windows retain their JavaScript handles. At a safe event-loop boundary,
closing removes the native window, invokes `onclose` once, clears its attached
DOM listeners/input references and releases native document ownership. JavaScript
references can retain a closed handle/document. Whole-runtime shutdown still
stops producers and sweeps native-held callbacks before destroying QuickJS.

SDL routes events by native window ID and retains its display connection while
the shared loop is running, including last-window replacement callbacks. Win32
uses each HWND's user data and one shared frame timer; destroying one HWND no
longer posts process-wide WM_QUIT. Application animation/async work is pumped
once per tick, not once per window. Each GPU window selects its own context
before rendering or releasing resources.

For the desktop, PollyWM remains a separate process. The initial PollyShell can
share several surfaces in one runtime; this does not require settings, file
management or system services to share that process.

Linux layer windows own their Wayland surface and import it into SDL. The
connection is held across the whole application session, including creation
failures before the first window and replacement of the last window. The role
is configured before initializing its renderer, so even the first submitted
buffer has the correct size. SDL handles fractional scaling through its own
viewport objects; PollyWM advertises the corresponding standard protocols.
Role destruction precedes renderer/SDL destruction, and the owned Wayland
surface is released afterward. SDL's normal ordinary-window path is unchanged.
External-role teardown performs a bounded sync before SDL/surface destruction,
so queued input-leave events can release references while the surface is live.
This also avoids the destroyed-object reference leak in libwayland-client 1.25.0
exposed by repeatedly closing keyboard-focused overlays.

The opt-in Linux desktop-services module binds foreign-toplevel management on
that same SDL connection, without an extra public connection or GLib/GIO.
Native handles stage metadata until `done`, publish snapshots with runtime-local
monotonic IDs, and notify JavaScript once per UI pump. Protocol proxies and
callbacks are released before SDL disconnects and before QuickJS destruction.
The Shell renders the current workspace's window list on each output.
Management requests are asynchronous.

The chosen workspace model is deliberately one global group: four initial
workspaces, manual append/remove, persistent empty workspaces within a session,
and no automatic reordering or special fullscreen Spaces. Listing and workspace
operations use `ext-workspace-v1`; a restricted private extension associates
foreign-toplevel resources with workspace handles and queues window-family
moves on the same manager's `commit`. Requests are applied before one visibility/
focus reconciliation and a coherent event batch. Closed/remapped windows have
distinct map epochs so a queued move cannot target a later incarnation.

Workspace membership is independent of minimize/fullscreen state. Inactive
views remain mapped but scene-disabled, focus traversal is workspace-local,
and their popups are dismissed. Explicit activation switches workspace; moving
does not. Deletion migrates all views, including unmapped ones, to the previous
workspace or the next when deleting the first. At least one workspace remains.
Shell reconnect rebuilds handles from compositor state. PollyShell validates
and persists ordered names and active index, never protocol IDs. A version-2
private transaction stages bounded name messages and restores them atomically
only before ordinary applications or workspace changes. The trusted Shell's
deferred bootstrap toplevel is rebound before old workspace objects are freed.
Renaming/reordering retain identities and window membership. Invalid preference
documents are reported and preserved until explicit recovery; application/window
restoration and persistent protocol IDs remain outside this feature.

Window switching is a compositor-owned, modifier-held state machine. Its frozen
candidate list uses mapped-instance IDs, so closed/remapped views cannot be
activated through stale selections. The Shell opts into presentation and draws
a read-only preview without keyboard focus; release or serial-checked pointer
acceptance commits the selection. Presenter loss and workspace/focus changes
cancel it. Labels are bounded and native callbacks publish complete snapshots.
Shortcut defaults, key normalization and conflict rules are shared C code used
by both the native client and compositor. A full configuration is validated
before it is applied; the Shell persists only acknowledged maps and attempts
live rollback if saving fails. The capability has no executable-command action.

Output configuration uses `wlr-output-management` plus a restricted confirmation
guard. Complete snapshots are validated and tested before backend commit.
PollyShell owns bounded JSON startup profiles containing hardware identity and
geometry, not live protocol IDs. Exact unambiguous connector/make/model/serial
matching is required. The guard's one-shot startup claim survives Shell loss;
automatic restoration therefore cannot loop within one compositor session.
Only user-confirmed snapshots are persisted, and restored changes still require
the normal watchdog confirmation. Missing identities and corrupt profiles never
silently override the current output layout.
Since backend commits are not guaranteed atomic, failures attempt restoration
from a compositor-owned snapshot. Successful changes retain that snapshot and
a 15-second watchdog until the applying client confirms; client loss or output
topology changes abort the transaction. Saved mode dimensions are resolved
against live mode objects during restoration, avoiding stale mode pointers.
Recovery failure is explicit. Output publication is coalesced outside commits,
and `xdg-output` supplies logical geometry to ordinary clients.

PollyWM's optional-per-client decorations negotiate through `xdg-decoration`.
An explicit client-side preference is respected; non-negotiating clients are
not guessed to be undecorated. Frame state and metrics become visible only with
the matching xdg configure commit. Content coordinates remain the existing
window-geometry origin, with frame extents outside it; work areas are inset
before maximizing/fitting content. Fullscreen disables the frame.

Titlebars are bounded CPU buffers with Fontconfig/FreeType captions, separate
from application buffers, and retain wlroots buffer ownership semantics.
The compositor still does not link the UI engine. Shell JS loads and validates
versioned JSON and merges bounded user overrides. Private appearance protocol
v2 stages numeric decoration snapshots before committing them; per-view
current/pending value copies keep old configure state alive independently.
The generated C presets remain for bootstrap and legacy v1 callers, not as a
restriction on runtime theme IDs.

The full visual document travels through a size-checked sealed memfd instead of
a large Wayland string. PollyWM checks descriptor invariants and numeric bounds
without parsing JSON. Public opt-in observers receive coalesced notifications
and request a read-only snapshot; no management or filesystem authority is
granted. Apps validate the versioned document and may retain local overrides.

The Shell stages surfaces and decoded bitmap resources, persists selection and
requests native application. Rejection retires staged resources and restores
prior settings/catalog state, reporting any rollback failure explicitly.
Transport timeouts can leave commit acknowledgment uncertain and are reported
as such; rendering remains asynchronous, not a distributed atomic transaction.
See `desktop/THEMES.md` for the file layout, limits and application API.

### Deferred ⏸

- **JS on its own thread** (RN-old-bridge style). The industry moved away from
  it (Fabric/JSI) and our bridge is already synchronous/JSI-like; parallelism is
  served by Workers instead. Revisit only if real apps show main-thread jank.

---

## 11. Decisions

- **Host language:** C11; ANGLE/EGL + Skia GPU live in the one `extern "C"` C++
  shim (§3).
- **Skia:** aseprite/skia m124 prebuilt (full C++ API via our own shim).
- **GPU backend:** **ANGLE (GLES → D3D11)** — works without native GL drivers;
  raster (CPU) fallback. (Native WGL GL was tried first; ANGLE is the keeper.)
- **Layout/script units:** JS authors in **logical pixels**; numbers are px,
  strings carry `%`/`auto`/colors; the renderer scales logical→physical by the
  monitor DPI.
- **Project name:** **PollyUI**.
