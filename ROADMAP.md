# PollyUI — Feature Matrix & Roadmap

One view of what's built and what's planned. For the architecture, see
[DESIGN.md](./DESIGN.md); §10 there has the prose version of this.

**Status legend**

| | Meaning |
|---|---|
| ✅ | Implemented (committed, with a demo and/or headless test) |
| 🟡 | Partial — works, but a subset of the full feature |
| 🛠 | Planned |
| ⏸ | Deferred (deliberately not doing now) |

Platform column: **Win** = Windows. macOS/Linux are 🛠 across the board (the
Host layer is the only platform-specific code; everything above it is portable).

---

## Engines & pipeline

| Feature | Status | Notes |
|---|---|---|
| HostEngine — Win32 window, event loop, resize | ✅ | `src/host/win32` |
| Per-monitor **DPI awareness** (logical px → physical) | ✅ | `WM_DPICHANGED`, scale in render + hit-test |
| ScriptEngine — QuickJS-ng VM | ✅ | runs `.js`, error reporting |
| Model — retained DOM tree, refcounted lifetimes | ✅ | `src/model/node.c` |
| Bridge — JS ⇄ native, wrapper cache + GC finalizers | ✅ | verified by refcounts |
| LayoutEngine — Yoga Flexbox | ✅ | `src/layout` |
| RenderEngine — Skia | ✅ | rects + text |
| Event loop — pump + run-loop, async-aware | ✅ | `src/script` |

## Rendering backend

| Feature | Status | Notes |
|---|---|---|
| **GPU: Skia Ganesh → ANGLE → D3D11** | ✅ | the standard Windows GPU path |
| Raster (CPU) surface + `StretchDIBits` fallback | ✅ | also used by headless tests |
| macOS GPU (Metal / ANGLE) | 🛠 | with the macOS host port |
| Linux GPU (GL / ANGLE) | 🛠 | with the Linux host port |
| Official ANGLE binaries for distribution | 🛠 | today staged from installed Chrome/Edge |

## Paint / visuals

| Feature | Status | Notes |
|---|---|---|
| Background-color fills | ✅ | `#rgb`/`#rrggbb[aa]`/named colors |
| Borders (width/color) | 🛠 | |
| Border-radius (rounded corners) | 🛠 | |
| Box shadows | 🛠 | |
| Gradients (linear/radial) | 🛠 | |
| Images (load + draw) | 🛠 | |
| Element opacity / alpha | 🛠 | |
| Transforms (translate/rotate/scale) | 🛠 | |
| Clipping / `overflow:hidden` | 🛠 | |
| Scrolling (`overflow:scroll`) | 🛠 | |
| `z-index` | 🟡 | paint = tree order; no explicit z |

## Text

| Feature | Status | Notes |
|---|---|---|
| Text rendering (Skia + DirectWrite default font) | ✅ | measured into layout |
| `measureText(str, fontSize)` exposed to JS | ✅ | |
| Inherited `fontSize` / `color` | ✅ | from parent element |
| **Blinking, movable caret** (text field) | ✅ | `js/textfield.js`, `tests/caret.js` |
| Multi-line text / wrapping | 🛠 | measure is single-line today |
| Text selection + click-to-position caret | 🛠 | needs text hit-testing |
| IME (CJK / emoji composition) | 🛠 | |
| `text-align`, font family/weight/style | 🛠 | only default face/weight now |
| Line-height, letter-spacing, ellipsis | 🛠 | |

## Layout (Yoga)

| Feature | Status | Notes |
|---|---|---|
| `flexDirection`, `flexGrow` | ✅ | |
| `flexWrap` | ✅ | |
| `justifyContent`, `alignItems` | ✅ | |
| `width`/`height` — px, %, auto | ✅ | |
| Per-edge `padding` / `margin` | ✅ | all + L/R/T/B |
| `position: absolute` + `top/left/right/bottom` | ✅ | overlapping views |
| `gap` | 🛠 | |
| `min/max-width`, `min/max-height`, `aspect-ratio` | 🛠 | |
| `flex-basis`, `flex-shrink`, `alignSelf`, `alignContent` | 🛠 | |
| `display:none` (hide without removing) | 🛠 | |

## DOM / bridge API

| Feature | Status | Notes |
|---|---|---|
| `createElement` / `createTextNode` / `body` | ✅ | |
| `el.style.*` (exotic object) | ✅ | string values |
| `appendChild` / `removeChild` / `insertBefore` | ✅ | |
| parent/first/last/next/prev, `childNodes` | ✅ | |
| `nodeType`, `tagName`, `textContent` | ✅ | |
| `addEventListener` / `removeEventListener` | ✅ | |
| `tabIndex`, `focus()` / `blur()`, `document.activeElement` | ✅ | |
| `setAttribute`/`getAttribute`, `classList`, `dataset` | 🛠 | |
| `getElementById` / `querySelector` | 🛠 | |
| `innerHTML` | 🛠 | |

## Events / input

| Feature | Status | Notes |
|---|---|---|
| Click (hit-test + **bubbling**), click-to-focus | ✅ | |
| Keyboard `keydown` (DOM key names), **Tab** focus cycling | ✅ | |
| `focus` / `blur` events | ✅ | |
| `mousedown`/`up`/`move`, `mouseenter`/`leave`/hover | 🛠 | |
| `keyup`, `dblclick`, `wheel`/scroll, `contextmenu`, drag | 🛠 | |
| `preventDefault` / `stopPropagation`, capture phase | 🛠 | |
| Pointer / touch events | 🛠 | |

## Script runtime

| Feature | Status | Notes |
|---|---|---|
| `console.*` | ✅ | log/info → stdout, warn/error → stderr |
| `setTimeout` / `clearTimeout`, promises/microtasks | ✅ | |
| `setInterval` | 🛠 | |
| **`requestAnimationFrame`** + tween/easing API | 🛠 | next up — cheap on GPU |
| ES modules (`import`/`export`) | 🛠 | single-file eval today |
| `fetch` / networking | 🛠 | |
| `localStorage` / persistence | 🛠 | |

## Concurrency

| Feature | Status | Notes |
|---|---|---|
| `Worker` (separate JS context per thread, postMessage/onmessage) | ✅ | JSON messages |
| `computeAsync(n, cb)` — native bg work → UI callback | ✅ | |
| UI-thread **dispatcher** (BeginInvoke-style marshal) | ✅ | `src/core/dispatch` |
| Worker transferables / SharedArrayBuffer, nested workers | 🛠 | |
| Thread pool + native async **I/O** (file/network) | 🛠 | one-thread-per-task now |
| Forceful worker termination | 🛠 | cooperative today |
| JS (main DOM) on its own thread | ⏸ | RN-old-bridge model; superseded by JSI + Workers |

## Styling system

| Feature | Status | Notes |
|---|---|---|
| Imperative `el.style.x = y` | ✅ | |
| CSS-ish stylesheets + selectors | 🛠 | |
| Cascade / inheritance beyond fontSize/color | 🛠 | |
| Units beyond px/% (`em`/`rem`/`vh`/`vw`) | 🛠 | |
| Pseudo-states (`:hover`/`:active`/`:focus`), theme variables | 🛠 | |

## Higher-level

| Feature | Status | Notes |
|---|---|---|
| React-style reconciler (virtual DOM / JSX) on the DOM API | 🛠 | optional, in JS |
| Standard component library (buttons, inputs, lists…) | 🟡 | demos exist; not packaged |
| Full text-input widget (selection + clipboard + IME) | 🛠 | caret done; rest planned |

## Accessibility

| Feature | Status | Notes |
|---|---|---|
| Semantic tree → UI Automation / AT-SPI / NSAccessibility | 🛠 | screen-reader support |

## Performance

| Feature | Status | Notes |
|---|---|---|
| Persist + dirty-track the Yoga tree | 🛠 | rebuilt every frame today |
| Display-list / layer caching, subtree relayout | 🛠 | |
| True idle (no 60 Hz frame-timer wakeups when idle) | 🛠 | |

## Tooling & infra

| Feature | Status | Notes |
|---|---|---|
| **Headless test harness** (`--test`, host.click/key/pixel/save) | ✅ | deterministic |
| No-console release build (`PU_WINDOWED`) | ✅ | |
| In-process symbolized crash handler (DbgHelp) | ✅ | |
| CMake + Ninja + clang-cl; fetch/vendor deps | ✅ | |
| CI running the test suite | 🛠 | |
| JS bundler (modules/assets), hot reload, inspector | 🛠 | |
| Packaging / installer | 🛠 | |

---

### Suggested next steps

1. **`requestAnimationFrame` + animation demo** — small, high-impact, shows off the GPU.
2. **macOS host port** (then Linux) — the last big architectural piece.
3. **Borders / border-radius / shadows** — the biggest visual-fidelity gap for real UIs.
4. **Text selection + full text-input widget** — completes the input story.
