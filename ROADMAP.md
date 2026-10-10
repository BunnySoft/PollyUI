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

Platform column: **Win** = Windows. Windows and macOS hosts are available;
Linux has an experimental SDL3 EGL/GLES/raster path with Fontconfig fonts and a native
Alpine/musl build, libcurl HTTP and XDG app data. Native Rime and complex Linux
text are implemented; detailed GPU qualification, advanced IME/text extensions
and the macOS HTTP backend remain separate.
See README and `desktop/README.md` for current platform boundaries.

**Current desktop candidate:** Debian 13 trixie amd64 from a debootstrap minbase
rootfs. Corrected Mesa passes the graphical memory gate; alpha.5-r2 has passed
UEFI VM preflight and user-reported physical boot/basic operation. Detailed
per-device and endurance evidence is separate. Keep the Alpine fallback and do
not turn all future features into current release gates.
See [base selection and maintenance](./docs/desktop-base-maintenance.md).

For PollyOS, use the [technical overview](./docs/POLLYOS.md) and the
**[historical deferred-work ledger](./docs/POLLYOS-BACKLOG.md)**. The ledger maps
the original 45 desktop milestones, theme/release review and second-stage A–G
to explicit remaining subitems, decisions and subsequently completed work.
This file also contains broader PollyUI framework work, which is not automatically
a PollyOS release requirement.

The headless test suite (`pollyui --test tests/<name>`) currently covers **283
assertions** across rendering, layout, DOM, events, runtime, networking,
persistence, and the JS framework layer (Vue reactivity, ~86 components, the SFC
compiler, and a Fluent control pack).

Cross-platform plan in **[docs/PORTING.md](./docs/PORTING.md)** (SDL3 desktop+
mobile backend, bare embedded-Linux/Wayland/DRM). The Host layer is the only
platform-specific code; the surface-creation seam is already abstracted.

---

## SysRT implementation task plan

Native mappings for files, processes and sockets are implemented on the declared
ABI profiles. Desktop policy remains above them. Keep the next steps small:
prove one complete execution/service path before adding broad API coverage.

| ID | Priority | Task | State / first acceptance | Prerequisites |
|---|---|---|---|---|
| RT-01 | P0 | Generic asynchronous native calls | First closed loop implemented: worker -> owning dispatcher -> Promise; scalar/CString inputs, scalar results, explicit errors and joined shutdown. Broader support stays staged | Existing FFI/dispatcher |
| RT-02 | P0 | Native memory/resource ownership | First closed loop implemented: managed async leases plus explicit adoption with byte extent and void(pointer) releaser; alias/GC/close retention. Borrowed views and fallible handle destructors remain staged | RT-01 for async leases |
| RT-03 | P0 | Native callbacks | First target integrated: scoped same-thread synchronous scalar callbacks, explicit exceptions/thread rejection and teardown. Data-pointer callbacks and retained/asynchronous registrations remain staged | RT-01, RT-02 |
| RT-04 | P0 | ABI metadata generation | First target integrated: deterministic Linux x86_64 statx layout/file constants from native headers, with generator --check and target/type guards. Other domains/targets remain staged | Independent |
| RT-05 | P1 | IPC/D-Bus SDK | First two-process loop integrated: explicit-address JS client/service, zero-wait noarg/u/b/s/o calls and fixed scalar replies, diagnostics, single-use request replies and stable cancel/close/deadlines. Setup/name claim synchronous; application authorization, containers/subscriptions remain staged | RT-01, RT-02; RT-03 only for callback-based routes |
| RT-06 | P1 | Real desktop capability migration | First service integrated: user theme-file/resource policy is JS over native files, with Shell authorization, lifecycle and rollback preserved; old C bridge removed. Bitmap decoding stays a generic GUI mechanism | Native files; RT-05 for D-Bus-based services |
| RT-07 | P1 | Independent Settings/application boundary | First app integrated: Appearance/About in an independent process/realm behind narrow IPC, daemon PID/UID and current-generation checks; Displays/Network/Audio/Keyboard retain explicit Shell-panel entry points. Relocatable single-instance launch; no private Shell connection inheritance or lost controls | RT-06, bidirectional IPC |
| RT-08 | P1 | Application configuration/state | In progress: application-specific typed JSON configuration for Shell preferences over native files; one-time conversion of existing Shell preferences only when the new file is absent, preserving the original. No arbitrary storage quota or change to other apps' legacy storage | Existing native file API |
| RT-09 | P2 | Additional platforms/protocols | Deferred: Windows filesystem and DNS/HTTP/TLS only when the next real use case needs them | Relevant mechanism above |

RT-01 does not promise cancellation of arbitrary native calls: accepted work
finishes before VM destruction. RT-02 adds flat managed-buffer arguments; unknown
external pointers, pointer vectors/results, callbacks and thread-local error observers
remain excluded. A Promise
does not make every OS API safe to call from another thread.

## Engines & pipeline

| Feature | Status | Notes |
|---|---|---|
| HostEngine — Win32 window, event loop, resize | ✅ | `gui/src/host/win32`; smooth live-resize (double-pump + authoritative size) |
| **Frameless window / custom title bar** | ✅ | `WM_NCCALCSIZE`+`WM_NCHITTEST`; keeps resize/snap; `appRegion:drag` |
| **JS `window` controls** (minimize/maximize/close/setFrameless/setBackdrop) | ✅ | global `window` object in the windowed app |
| **Mica / Acrylic backdrop** (Win11 DWM) | 🟡 | `DwmSetWindowAttribute` set; visible Mica needs a transparent surface |
| Per-monitor **DPI awareness** (logical px → physical) | ✅ | `WM_DPICHANGED`, scale in render + hit-test |
| **Surface seam abstraction** (`create_gpu`/`create_metal`) | ✅ | opaque native handle; ready for SDL3/macOS/Linux |
| ScriptEngine — QuickJS-ng VM | ✅ | runs `.js`/`.mjs`, error reporting |
| Model — retained DOM tree, refcounted lifetimes | ✅ | `gui/src/model/node.c` |
| Bridge — JS ⇄ native, wrapper cache + GC finalizers | ✅ | verified by refcounts |
| LayoutEngine — Yoga Flexbox | ✅ | `gui/src/layout` |
| RenderEngine — Skia | ✅ | full paint set below |
| Event loop — pump + run-loop, async-aware | ✅ | `gui/src/script` |

## Rendering backend

| Feature | Status | Notes |
|---|---|---|
| **GPU: Skia Ganesh → ANGLE → D3D11** | ✅ | the standard Windows GPU path |
| Raster (CPU) surface + `StretchDIBits` fallback | ✅ | also used by headless tests |
| Linux CPU raster + SDL3 presentation | ✅ | native Skia m124 build, Fontconfig/FreeType; not a Linux Skia GPU backend |
| macOS GPU (Metal / ANGLE) | 🛠 | with the macOS host port |
| Linux Skia GLES backend | 🟡 | SDL-owned EGL/GLES 3; llvmpipe verified, hardware qualification pending |
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
| **Per-glyph font fallback** (symbols + emoji) | ✅ | substitutes a system face for missing glyphs |
| **Multi-line text** (embedded `\n`) | ✅ | measure + draw per line |
| **Word-wrap to a width** | ✅ | greedy word wrap; measure + paint agree |
| **`text-align`** (left/center/right) | ✅ | per-line within the box |
| **Blinking, movable caret** (text field) | ✅ | `gui/sdk/js/textfield.js`, `gui/tests/caret.js` |
| **Text selection + click-to-position caret** | ✅ | `gui/sdk/js/textinput.mjs` (drag-select, edit) |
| IME (CJK / emoji composition) | 🛠 | |
| **Font families** (`fontFamily`) | 🟡 | monospace→Consolas, serif→Georgia; arbitrary loaded faces pending |
| **Gradient-filled text** (`textGradientFrom/To`) | ✅ | |

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
| Structured input + committed text | ✅ | key/code/modifiers/repeat, textinput.data, Shift+Tab, pointer buttons, two-axis wheels; physical device/IME qualification remains separate |
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
| **`fetch`** (Promise; http/https + file://) | ✅ | WinHTTP / Linux libcurl; method/body/headers, text()/json(), bounded request shutdown |

## Concurrency

| Feature | Status | Notes |
|---|---|---|
| `Worker` (separate JS context per thread, postMessage/onmessage) | ✅ | JSON messages |
| `computeAsync(n, cb)` — native bg work → UI callback | ✅ | |
| UI-thread **dispatcher** (BeginInvoke-style marshal) | ✅ | `shared/dispatch` |
| Worker transferables / SharedArrayBuffer, nested workers | 🛠 | |
| Thread pool + native async **I/O** (file/network) | 🛠 | one-thread-per-task now |
| JS (main DOM) on its own thread | ⏸ | superseded by JSI + Workers |

## Styling system

| Feature | Status | Notes |
|---|---|---|
| Imperative `el.style.x = y` | ✅ | |
| Inheritance (fontSize/color/weight/style) | ✅ | text inherits from parent |
| **CSS-ish stylesheets + selectors** (`gui/sdk/js/css.mjs`) | ✅ | tag/.class/#id/*, descendant, specificity |
| **Engine-level `:hover` / `:focus`** (`hoverStyle`/`focusStyle`) | ✅ | `PU_STATE_*` flags; per-property override; repaint-only (no relayout) |
| **Light & dark themes** (`useTheme`) | ✅ | runtime theme switch |
| Desktop theme configuration | ✅ | Versioned JSON, bounded local bitmaps, user overrides, explicit reload/restore, runtime decoration snapshots and opt-in app subscriptions. See `desktop/THEMES.md`. Existing layout parameters are configurable; arbitrary templates, automatic file watching and new compositor effects remain separate work. |
| Units beyond px/% (`em`/`rem`/`vh`/`vw`) | 🛠 | |
| `:active`, full theme-variable system | 🛠 | |

## Animation

| Feature | Status | Notes |
|---|---|---|
| `requestAnimationFrame` driving | ✅ | per-frame, ms timestamp |
| **Tween + easing library** (`gui/sdk/js/anim.mjs`) | ✅ | `animate()`, 8 easings, delay, promise |
| **Declarative transitions** (`transition` prop) | ✅ | reconciler tweens changed numbers/px/hex-colors; per-prop filter; re-target cancels in-flight |
| **`<Transition>` enter/leave** (`gui/sdk/js/transition.mjs`) | ✅ | onMount/onLeave reconciler hooks; leave defers DOM detach until tween ends |

## Higher-level

| Feature | Status | Notes |
|---|---|---|
| **Vue-style reactivity + Composition API** (`gui/sdk/js/vue.mjs`) | ✅ | ref/reactive/computed/watch, createApp/setup |
| **React-style reconciler** (virtual DOM, `gui/sdk/js/reconciler.mjs`) | ✅ | h()/render()/mount(), diff + components |
| **Vue SFC compiler** (`gui/sdk/js/sfc.mjs`) | ✅ | `<template>/<script>/<style>` → component; v-if/v-for/:bind/@event, interpolation, ref auto-unwrap, **slots**, stateless tag form + attribute fallthrough |
| **Custom element tags** (`defineTag`, `gui/sdk/js/pollyui.mjs`) | ✅ | author by name: `h('button',…)` / `h('fluent-card',…)`; auto-registers all `N*` as kebab tags |
| **Fluent / WinUI control pack** (`gui/sdk/js/fluent.mjs`) | ✅ | 8 SFC controls: card/button/infobar/toggle/hyperlink/badge/progressbar/expander |
| **WinUI 3 Gallery demo** (`gui/sdk/js/winui.mjs`) | ✅ | frameless + Mica, NavigationView, 5 populated pages (Home/Basic input/Collections/Dialogs/Styles); Naive theme retinted Fluent so all 85 components look native |
| **MS Store / Fluent demo** (`gui/examples/playground/msstore.mjs`) | ✅ | responsive card grid, auto-advancing hero, custom draggable title bar |
| **Naive UI-style component library** (`gui/sdk/js/naive.mjs`) | ✅ | **~86 components** — full Naive UI parity (+ NForm/createForm validation, NTable, dialog API): inputs (Input/Number/Select/Cascader/TreeSelect/AutoComplete/Mention/DatePicker/TimePicker/ColorPicker/Slider/Switch/Checkbox/Radio/Rate/Upload/Transfer/DynamicInput/DynamicTags), data (DataTable+sort/select/VirtualList/Tree/List/Descriptions/Timeline/Calendar/Statistic/Avatar/Badge/Image/Carousel/Code/GradientText/Ellipsis/Time/Countdown), feedback (Modal/Drawer/Popconfirm/Popover/Popselect/Tooltip/Message/Notification/LoadingBar/Alert/Result/Spin/Skeleton/Progress), nav (Menu/Tabs/Steps/Pagination/Breadcrumb/Anchor/Affix/BackTop/Dropdown), layout (Layout/Grid/Flex/Space/Card/Divider/Collapse/Watermark/Scrollbar), Typography/Icon/ButtonGroup/Empty/ConfigProvider — plus a portal layer, form validation, light & dark themes |
| **CSS engine** (`gui/sdk/js/css.mjs`) | ✅ | stylesheet + selector cascade |
| **Tween/animation** (`gui/sdk/js/anim.mjs`) | ✅ | rAF-driven, easings |
| **Text input** (selection + editing, `gui/sdk/js/textinput.mjs`) | ✅ | click/drag-select; clipboard/IME pending |
| Per-glyph font fallback + font-family + gradient text | ✅ | symbols/emoji, monospace/serif, gradient-filled text |

## Accessibility

| Feature | Status | Notes |
|---|---|---|
| Semantic tree → UI Automation / AT-SPI / NSAccessibility | 🛠 | screen-reader support |

## Performance

| Feature | Status | Notes |
|---|---|---|
| **Skip-when-clean layout** (cache; skip Yoga when only render-only state changed) | ✅ | scroll/hover/fade frames: layout 8ms → ~0 (3.6× per-frame) |
| **Repaint gating** (no repaint when nothing changed) | ✅ | idle ~0% CPU; events repaint only on real change |
| True per-subtree incremental layout (persistent Yoga + reset-aware styles) | 🛠 | helps layout-*changing* animations |
| Display-list / dirty-region rendering, compositor-thread animation | 🛠 | the WinUI-class render path |
| True idle (no 60 Hz frame-timer wakeups when idle) | 🛠 | |

## Tooling & infra

| Feature | Status | Notes |
|---|---|---|
| **Headless test harness** (`--test`; click/mouse/scroll/key/render(ts)/flush/pixel/save) | ✅ | deterministic, **283 assertions**; `PU_TEST_W/H` viewport, `PU_PERF` tracing |
| No-console release build (`PU_WINDOWED`) | ✅ | |
| In-process symbolized crash handler (DbgHelp) | ✅ | |
| CMake + Ninja + clang-cl; fetch/vendor deps | ✅ | |
| CI running the test suite | 🛠 | |
| JS bundler (assets), hot reload, inspector | 🛠 | |
| Packaging / installer | 🛠 | |

---

### Suggested next steps

1. **True per-subtree incremental layout** — persistent Yoga tree + reset-aware
   style application; unblocks layout-changing animations and the compositor path.
   (Needs a broadened layout test corpus first.)
2. **SDL3 host backend** — one backend for Linux/macOS/iOS/Android (see PORTING.md);
   then the **Skia Metal** surface path for Apple, and a **transparent surface** so
   real Mica/Acrylic shows.
3. **Dirty-region / display-list rendering + compositor-thread animation** — the
   WinUI-class render path (60fps motion at scale).
4. **Accessibility** — semantic tree → UI Automation / AT-SPI / NSAccessibility.
5. **Text**: custom font families beyond the built-ins, IME (CJK/emoji), clipboard.
