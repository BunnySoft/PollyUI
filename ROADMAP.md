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

The headless test suite (`pollyui --test tests/<name>`) currently covers **179
assertions** across rendering, layout, DOM, events, runtime, networking,
persistence, and the JS framework layer (Vue reactivity + components).

---

## Engines & pipeline

| Feature | Status | Notes |
|---|---|---|
| HostEngine — Win32 window, event loop, resize | ✅ | `src/host/win32` |
| Per-monitor **DPI awareness** (logical px → physical) | ✅ | `WM_DPICHANGED`, scale in render + hit-test |
| ScriptEngine — QuickJS-ng VM | ✅ | runs `.js`/`.mjs`, error reporting |
| Model — retained DOM tree, refcounted lifetimes | ✅ | `src/model/node.c` |
| Bridge — JS ⇄ native, wrapper cache + GC finalizers | ✅ | verified by refcounts |
| LayoutEngine — Yoga Flexbox | ✅ | `src/layout` |
| RenderEngine — Skia | ✅ | full paint set below |
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
| Borders (width/color) | ✅ | `borderWidth`/`borderColor` |
| Border-radius (rounded corners) | ✅ | `borderRadius`; clips bg/border/image |
| Box shadows (blurred) | ✅ | `shadowColor`/`Blur`/`X`/`Y` |
| Gradients (linear) | ✅ | `gradientFrom`/`gradientTo`/`gradientDir` |
| Images (load + draw, cached) | ✅ | `backgroundImage`, scaled + clipped |
| Element opacity / alpha | ✅ | `opacity` (subtree layer) |
| Transforms (translate/rotate/scale) | ✅ | about center; paint-space |
| Clipping / `overflow:hidden` | ✅ | clips children to the box |
| Scrolling (`overflow:scroll`/`auto`) | ✅ | scrollTop/Left + wheel + clamp |
| `z-index` | 🟡 | paint = tree order; no explicit z |
| Radial gradients, filters/blur regions | 🛠 | |

## Text

| Feature | Status | Notes |
|---|---|---|
| Text rendering (Skia + DirectWrite) | ✅ | measured into layout |
| `measureText(str, fontSize, weight?)` | ✅ | |
| Inherited `fontSize` / `color` | ✅ | from parent element |
| **Font weight (bold) + style (italic)** | ✅ | `fontWeight`/`fontStyle` |
| **Multi-line text** (embedded `\n`) | ✅ | measure + draw per line |
| **Word-wrap to a width** | ✅ | greedy word wrap; measure + paint agree |
| **`text-align`** (left/center/right) | ✅ | per-line within the box |
| **Blinking, movable caret** (text field) | ✅ | `js/textfield.js`, `tests/caret.js` |
| **Text selection + click-to-position caret** | ✅ | `js/textinput.mjs` (drag-select, edit) |
| IME (CJK / emoji composition) | 🛠 | |
| Custom font families | 🛠 | default face only |

## Layout (Yoga)

| Feature | Status | Notes |
|---|---|---|
| `flexDirection`, `flexGrow`, `flexShrink` | ✅ | |
| `flexBasis` (px/%/auto) | ✅ | |
| `flexWrap` | ✅ | |
| `justifyContent`, `alignItems`, `alignSelf`, `alignContent` | ✅ | incl. space-between/around |
| `gap` | ✅ | |
| `width`/`height` + `min/max` (px, %, auto) | ✅ | |
| Per-edge `padding` / `margin` | ✅ | all + L/R/T/B |
| `position: absolute` + `top/left/right/bottom` | ✅ | overlapping views |
| `display:none` (hide without removing) | ✅ | collapses + skipped in paint |
| `aspect-ratio` | 🛠 | |

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
| `setAttribute`/`getAttribute`/`has`/`remove` | ✅ | generic attribute map |
| `id`, `className`, `classList` (add/remove/toggle/contains) | ✅ | |
| `getElementById`, `querySelector(All)` | ✅ | `#id` / `.class` / tag / `*` |
| `scrollTop` / `scrollLeft` | ✅ | reflected to scroll state |
| `offsetLeft/Top/Width/Height`, `getBoundingClientRect()` | ✅ | computed layout geometry |
| `innerHTML`, complex CSS selectors | 🛠 | |

## Events / input

| Feature | Status | Notes |
|---|---|---|
| Click (hit-test + **bubbling**), click-to-focus | ✅ | |
| `mousedown` / `mouseup` / `mousemove` | ✅ | carries clientX/Y |
| `mouseenter` / `mouseleave` (hover) | ✅ | non-bubbling |
| `wheel` + default scrolling | ✅ | nearest scroll container |
| Keyboard `keydown` + `keyup`, **Tab** focus cycling | ✅ | DOM key names |
| `focus` / `blur` events | ✅ | non-bubbling |
| **`preventDefault` / `stopPropagation` / `stopImmediate`** | ✅ | + `defaultPrevented` |
| `dblclick`, `contextmenu`, drag, touch | 🛠 | |

## Script runtime

| Feature | Status | Notes |
|---|---|---|
| `console.*` | ✅ | log/info → stdout, warn/error → stderr |
| `setTimeout` / `clearTimeout`, promises/microtasks | ✅ | |
| `setInterval` / `clearInterval` | ✅ | |
| **`requestAnimationFrame` / `cancelAnimationFrame`** | ✅ | per-frame, ms timestamp |
| **ES modules** (`import`/`export`, `.mjs`) | ✅ | loader + normalize |
| **`localStorage`** (persistent key/value) | ✅ | file-backed, survives restarts |
| **`fetch`** (Promise; http/https + file://) | ✅ | WinHTTP on a thread; Response text()/json() |

## Concurrency

| Feature | Status | Notes |
|---|---|---|
| `Worker` (separate JS context per thread, postMessage/onmessage) | ✅ | JSON messages |
| `computeAsync(n, cb)` — native bg work → UI callback | ✅ | |
| UI-thread **dispatcher** (BeginInvoke-style marshal) | ✅ | `src/core/dispatch` |
| Worker transferables / SharedArrayBuffer, nested workers | 🛠 | |
| Thread pool + native async **I/O** (file/network) | 🛠 | one-thread-per-task now |
| JS (main DOM) on its own thread | ⏸ | superseded by JSI + Workers |

## Styling system

| Feature | Status | Notes |
|---|---|---|
| Imperative `el.style.x = y` | ✅ | |
| Inheritance (fontSize/color/weight/style) | ✅ | text inherits from parent |
| **CSS-ish stylesheets + selectors** (`js/css.mjs`) | ✅ | tag/.class/#id/*, descendant, specificity |
| Units beyond px/% (`em`/`rem`/`vh`/`vw`) | 🛠 | |
| Pseudo-states (`:hover`/`:active`/`:focus`), theme variables | 🛠 | |

## Animation

| Feature | Status | Notes |
|---|---|---|
| `requestAnimationFrame` driving | ✅ | per-frame, ms timestamp |
| **Tween + easing library** (`js/anim.mjs`) | ✅ | `animate()`, 8 easings, delay, promise |
| Declarative CSS-like transitions (style triggers) | 🛠 | tween API done; auto-on-change pending |

## Higher-level

| Feature | Status | Notes |
|---|---|---|
| **Vue-style reactivity + Composition API** (`js/vue.mjs`) | ✅ | ref/reactive/computed/watch, createApp/setup |
| **React-style reconciler** (virtual DOM, `js/reconciler.mjs`) | ✅ | h()/render()/mount(), diff + components |
| **Naive UI-style component library** (`js/naive.mjs`) | ✅ | Button/Card/Input/Switch/Tag/Checkbox/Radio/Slider/Tabs/Progress/Alert/Modal + light & dark themes |
| **CSS engine** (`js/css.mjs`) | ✅ | stylesheet + selector cascade |
| **Tween/animation** (`js/anim.mjs`) | ✅ | rAF-driven, easings |
| **Text input** (selection + editing, `js/textinput.mjs`) | ✅ | click/drag-select; clipboard/IME pending |
| More components (Select dropdown, Tooltip, DatePicker, Table…) | 🟡 | broad set done; long tail pending |

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
| **Headless test harness** (`--test`; click/mouse/scroll/key/render(ts)/flush/pixel/save) | ✅ | deterministic, 122 assertions |
| No-console release build (`PU_WINDOWED`) | ✅ | |
| In-process symbolized crash handler (DbgHelp) | ✅ | |
| CMake + Ninja + clang-cl; fetch/vendor deps | ✅ | |
| CI running the test suite | 🛠 | |
| JS bundler (assets), hot reload, inspector | 🛠 | |
| Packaging / installer | 🛠 | |

---

### Suggested next steps

1. **macOS host port** (then Linux) — the last big architectural piece; everything above Host is portable.
2. **Accessibility** — semantic tree → UI Automation / AT-SPI / NSAccessibility.
3. **Text**: custom font families, IME (CJK/emoji composition), clipboard.
4. **More Naive UI components** (Select dropdown, Tooltip, DatePicker, Table, Pagination) + form validation.
