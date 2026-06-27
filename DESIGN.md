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
- No multi-window, no accessibility tree, no animation timeline at MVP (planned,
  see §10).

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
lives in `src/bridge`. Mixing "host" and "bridge" is a common confusion — we
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
  `extern "C"` C++ shim** (`src/render/skia_c.cpp`) exposing just the draw calls
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
- A UI-thread **dispatcher** (`src/core/dispatch`) is the marshal-to-UI
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
| **Skia** | 2D GPU renderer | **Prebuilt** (aseprite/skia m124) via `tools/fetch_skia.ps1` (gitignored). Driven through **our `extern "C"` shim** (`src/render/skia_c.cpp`) compiled against Skia's headers — see §3. |
| **ANGLE** | GLES → D3D11 | `libEGL`/`libGLESv2`/`d3dcompiler_47` (x64), **dynamically loaded** at runtime — no import lib. Staged next to the exe by `tools/fetch_angle.ps1` (from an installed Chrome/Edge). |
| **Platform** | window/GPU | Win32 + ANGLE (Windows, done); Cocoa + Metal/ANGLE (macOS) and X11/Wayland + GL/ANGLE (Linux) — planned (§10). |

Build system: **CMake** (≥3.25) + Ninja + **clang-cl** (against an installed
MSVC SDK), presets in `CMakePresets.json` (`win-clang`, `win-clang-windowed`).
Language: **C11** for everything except `skia_c.cpp` (C++ — the Skia + ANGLE
shim). Skia is the only heavyweight dependency.

---

## 9. Repo layout

```
pollyui/
├─ CMakeLists.txt          # top-level build
├─ CMakePresets.json       # win-clang, win-clang-windowed (no-console)
├─ DESIGN.md               # this file
├─ README.md
├─ tools/                  # build.ps1, fetch_skia.ps1, fetch_angle.ps1
├─ third_party/            # quickjs + yoga (vendored); skia (fetched, gitignored)
├─ src/
│  ├─ core/                # thread (mutex/cond/thread), dispatch (UI marshal queue)
│  ├─ host/win32/          # HostEngine: window, DPI, input, frame pump (mac/linux: planned)
│  ├─ render/              # skia_c.cpp shim (C++: Skia + ANGLE/EGL) + render.c (paint walk)
│  ├─ layout/              # Yoga integration (C API), style→Yoga mapping
│  ├─ model/               # node.c (tagged-union tree, lifetimes, hit-test, listeners)
│  ├─ script/              # QuickJS VM: console, timers, event loop + pump
│  ├─ bridge/              # Node JSClass, wrapper cache, document, events, focus, measureText
│  ├─ concurrency/         # async.c — Worker + computeAsync
│  └─ main.c               # wires it together; --test harness; crash handler
├─ js/                     # demos: components, counter, textfield, threads, m0..m5
└─ tests/                  # headless tests: smoke, keyboard, workers, caret
```

---

## 10. Status — implemented vs planned

The Windows-first vertical slice is **complete and working**. Features are
committed with runnable demos (`js/*.js`) and deterministic headless tests
(`tests/*.js`, run via `pollyui --test`) — **101 assertions** at present.

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

**JS framework layer** (in `js/`, on the DOM API) — a **CSS stylesheet +
selector engine** (`css.mjs`), a **React-style reconciler** (`reconciler.mjs`:
`h`/`render`/`mount`, function components, minimal diffing), an **rAF tween
library** (`anim.mjs`), and a **text input** with selection + editing
(`textinput.mjs`).

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
- **Text:** custom font families, **IME** (CJK/emoji), clipboard.
- **Reconciler hooks** (`useState`-style state) + a packaged component library.
- **Perf** (persist + dirty-track the Yoga tree, multi-window) and CSS units
  (`em`/`rem`/`vh`/`vw`) + pseudo-states.

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
