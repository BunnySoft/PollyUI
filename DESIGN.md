# PollyUI — Design

> A cross-platform UI framework: write UI in JavaScript, lay it out with
> Flexbox, render it with Skia, run it natively on Windows, macOS, and Linux.

Status: **design / pre-implementation**. This document is the contract we agree
on before writing the engine. It will evolve, but the layering and the
JS↔native boundary defined here should stay stable.

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

- **MVP: single-threaded.** Host event loop, JS, layout, and paint all run on
  the UI thread. Simplest correct thing; good enough to prove the pipeline.
- **Future:** move JS to its own thread with a lock-free command queue to a
  render/UI thread (the React-Native / Lynx model). The Model becomes the
  shared structure mutated on the JS thread and snapshotted for the render
  thread. Designed-for but not built at MVP. The dirty-flag + display-list
  split in §5 is chosen to make this migration mechanical.

---

## 8. Dependencies & how we get them

| Dep | Role | Acquisition |
|---|---|---|
| **QuickJS-ng** | JS engine | **Vendored** in `third_party/quickjs` (handful of C files; trivial to build). Maintained fork of Bellard's QuickJS. |
| **Yoga** | Flexbox | CMake `FetchContent` from facebook/yoga. Used via its **first-class C API** (`YGNode*`) — no binding layer. |
| **Skia** | 2D GPU renderer | **Prebuilt binaries** via a `tools/fetch_skia.*` script (e.g. JetBrains skia-pack / google prebuilts). Building from source needs depot_tools/GN and is slow — avoided. Driven through **our own `extern "C"` shim** (`src/render/skia_c.cpp`, the sole `.cpp` in the tree) compiled against Skia's headers — see §3. |
| **Platform** | window/GPU | OS SDKs: Win32 + ANGLE/OpenGL (Windows); Cocoa + Metal (macOS); X11/Wayland + GL (Linux). |

Build system: **CMake** (≥3.24) with presets per platform. Language: **C11**
for everything except `skia_c.cpp` (C++, the Skia shim). Skia is the only
heavyweight dependency; everything else builds from a clean checkout.

---

## 9. Repo layout

```
pollyui/
├─ CMakeLists.txt          # top-level build
├─ CMakePresets.json       # win/mac/linux presets
├─ DESIGN.md               # this file
├─ README.md
├─ .gitignore
├─ cmake/                  # FetchContent + find scripts
├─ tools/                  # fetch_skia, dev scripts
├─ third_party/            # vendored quickjs (+ fetched yoga/skia at build)
├─ src/
│  ├─ core/                # app, frame loop, geometry, color, result types (.c/.h)
│  ├─ host/                # HostEngine (platform)
│  │  ├─ win32/            # MVP target
│  │  ├─ mac/  linux/      # later
│  ├─ render/              # Skia backend: skia_c.cpp shim (C++) + painter (.c)
│  ├─ layout/              # Yoga integration (C API), style→Yoga mapping
│  ├─ model/               # node (tagged union), document, style
│  ├─ script/              # QuickJS VM wrapper, console, timers, rAF
│  ├─ bridge/              # JSClassID defs, wrapper cache, qjs_* bindings
│  └─ main.c               # wires Host + Script + Model + Render
├─ js/                     # example apps (hello.js, flex-demo.js)
└─ tests/                  # unit tests (layout, model, bridge)
```

---

## 10. Milestones (Windows-first vertical slice)

Each milestone is independently demoable and committed.

- **M0 — Window + Skia clear.** Win32 window + GPU surface; Skia clears to a
  color; resize works. *Proves Host + Render.*
- **M1 — Embed QuickJS.** Run a `.js` file, `console.log`, error reporting,
  timers. *Proves Script.*
- **M2 — DOM + bindings.** `document`, `createElement('view')`, `style`,
  `appendChild`, wrapper cache + lifetimes. *Proves Bridge + Model.*
- **M3 — Layout + paint boxes.** Each Element gets a Yoga node; layout pass;
  Skia paints background rects at computed boxes. *Proves Layout + Render of the
  DOM.* → first visible JS-driven UI.
- **M4 — Text.** `text` nodes, Skia text shaping/paint, color/font props.
- **M5 — Events + animation.** Input → hit-test → `addEventListener` dispatch;
  `requestAnimationFrame`. *Proves the full interactive loop.*
- **M6 — Port Host.** macOS (Cocoa/Metal), then Linux (X11/Wayland). Everything
  above Host is unchanged.

**Later:** React-style reconciler on top of the DOM API; styling sugar;
multi-window; JS-on-own-thread; accessibility; images; gradients/shadows.

---

## 11. Decisions

Confirmed:

- **Host language:** C11; single `extern "C"` C++ Skia shim (§3).
- **Skia seam:** our own shim (not `sk4d`) for full Skia API access.
- **M0 render path:** **raster first** — CPU `SkSurface` blitted to the window,
  no GPU-context glue — then add the ANGLE/GL GPU backend immediately after.
  Separates windowing from GPU so the first pixel is cheap.
- **Project name:** **PollyUI**.

Still open (confirm as we build):

1. **Windows GPU backend (post-raster):** ANGLE (GLES→D3D, portable,
   Skia-friendly) vs native D3D. *Leaning ANGLE/GL for cross-platform parity.*
2. **Skia prebuilt distribution:** which one to standardize on.
3. **Style value types:** numbers as px; strings for `'auto'`/percent/colors —
   confirm the coercion rules.
