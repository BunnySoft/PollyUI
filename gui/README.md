# GUI SDK selection controls

The Naive factories in `sdk/js/naive.mjs` default to the existing SDK light/dark
palette. They do not import desktop presets. Selection is controlled: render the new `value` or
`checked` supplied by a callback; the factory never mutates caller props, options
or panes. Focus/navigation state is local and does not move a control's hitbox.

| Factory | Controlled contract | Keyboard |
| --- | --- | --- |
| `NSwitch` | `value`, `onUpdate(boolean)`, `disabled` | Tab enters; Space toggles. Enter is not a toggle. |
| `NCheckbox` | `checked`, `onChange(boolean)`, `disabled` | Tab enters; Space toggles. |
| `NRadioGroup` | `value`, `options: [{value,label,disabled?}]`, `onUpdate(value)`, `disabled` | One roving Tab stop; arrows wrap through enabled radios and select; Home/End select first/last enabled; Space selects. |
| `NTabs` | `value`, `panes: [{name,label,content,disabled?}]`, `onUpdate(name)`, `disabled` | One roving Tab stop; Left/Right and Home/End focus and select; Enter/Space select a nonselected tab. The controlled pane supplies the content. |
| `NSelect` | `value`, `options: [{value,label,disabled?}]`, `onUpdate(value)`, `disabled` | Enter/Space or Up/Down opens; arrows and Home/End navigate enabled options; Enter/Space commits; Escape cancels; Tab closes and leaves normally. |
| `NMenu` | `value`, `items: [{key,label,icon?,disabled?}]`, `onUpdate(key)`, `disabled` | One roving Tab stop; Up/Down (Left/Right in `mode: "horizontal"`) and Home/End move focus; Enter/Space activates. |

Group and individual disabled entries cannot activate and are excluded from Tab/
arrow navigation. A programmatic focus is not forcibly moved when a caller
disables a control; disabled focus paint is cleared. Pointer activation accepts
only the primary button. Mapped radio/tab/menu/Select options bind the gesture
to the value at pointer-down: deleting, disabling or changing that slot while
held cancels it, rather than activating the replacement value. Held Space/Enter does not emit repeated activations.
Arrows may repeat. Checked/selected/disabled state is exposed through the
corresponding roles and ARIA attributes; an icon-only switch or Select can be
named with `aria-label`. `id` is supported on each factory.

Enabled controls use a paint-only focus layer and the existing Select focus
border, with no new palette or native painting. Default unhovered/unfocused
light/dark pixels and dimensions are preserved. Existing callbacks, including a
menu or primary-clicked tab/radio reporting its current item, remain usable;
tab/radio keyboard navigation does not emit a redundant change for the already
selected item.

## Per-instance selection appearance

The six factories accept an optional `appearance` object. Omitting it preserves
the previous light/dark palette, geometry and default unhovered/unfocused pixels.
It does not call `useTheme`, so different controls/windows can retain different
appearances at the same time.

```js
NCheckbox({
  checked, onChange,
  appearance: {
    colors: { primary: '#0a246a', text: '#000000', border: '#808080', focus: '#000000' },
    metrics: { fontSize: 11, markerSize: 13, radius: 0 }
  }
}, 'Enabled');
```

`colors` projects the SDK palette (`primary`, `card`, `body`, `text`,
`textSecondary`, `textDisabled`, `solidText`, `border`, `railOff`, `trackBg`, and
the other existing semantic status colors), plus `selected`, `selectedText`,
`focus`, `hover`, `pressed`. Values must be nonempty bounded CSS color strings.
`metrics` projects `fontSize`, `markerSize`, `radioDot`, `radius`, `gap`,
`switchWidth`, `switchHeight`, `knobSize`, `switchPadding`, `controlHeight`,
`optionHeight`, `menuHeight`, `paddingX`, `popupPadding`, `popupGap`,
`popupMaxHeight`, `tabGap`, `panePadding`, `disabledOpacity`. Metrics are finite
and bounded; contradictory knob/rail, dot/marker or font/row geometry fails.
The same option height/gap/padding drives popup placement, scroll limits and
active-row reveal, rather than only changing a painted outer border.

Two optional generic adapter hooks support existing application-owned painters:
`decorate(vnode, {kind, checked?, selected?, active?, disabled})` adds paint-only
parts at authoring time, without replacing the control's role or handlers;
`paint(state)` returns styles for `root` or named `.n-selection-<part>` descendants
(`marker`, `knob`, `glyph`, `label`, `arrow`, `icon`, `underline`, `active`, or
adapter-added parts). State includes the same context, `hovered`, `pressed`,
actual `focused`, `disabled`, and resolved `colors`/`metrics`. The SDK chains
existing events/lifecycles, retains the gesture identity and controlled callbacks,
and does not contain platform-name branches. A bounded string `revision` joins
colors/metrics in the appearance signature when an adapter changes its face
without changing those values. Hooks must not add timers, mutate caller data or
replace the keyboard/portal controller.

`desktop/shared/ui/selection-controls.mjs` is the single desktop adapter. It
projects the existing six themes, reuses Classic bevels and the current
Classic/Luna Canvas focus ownership/lifecycle, and supplies the existing
Luna/Aqua highlight/gloss and Fluent flat-face treatment. Desktop
`themedCheckbox`, `themedSwitch`, `themedRadioGroup`, `themedTabs`, `themedSelect`
and `themedMenu` remain ordinary controlled SDK factories. Old systems without a
native switch receive a **Polly-themed switch**, not a claimed original OS
control. Original font-rendered marker art is retained; this is not certification
against qualified raw OS screenshots.

Settings Displays uses a named checked checkbox for the existing enabled draft
field, and Audio uses a named mute switch. Space now controls those roles (not
button Enter); stable IDs, primary-only activation, busy/null-capability guards,
output Apply/confirmation policy and audio generation/revision/instance checks
are unchanged. Audio stays at the acknowledged value and saves only after the
existing service policy observes acknowledgement.
The shared Settings card and those two consumer cards use the single desktop
`panel-appearance.mjs` passive surface projection. Classic bevels own their
outside pixels without a second generic border; titles, child controls and
transaction handlers keep their existing APIs.

## Desktop default-action appearance

Shared desktop `button(id, text, theme, action, selected, extraStyle, options)`
keeps its original six arguments and accepts an optional seventh
`{ defaultAction: true }`. `desktopCommand` accepts the same boolean in its
existing named options. Omitted/false leaves the previous appearance unchanged;
invalid types and unknown option keys are rejected.

This opt-in adds only passive, pointer-transparent, accessibility-hidden
decoration from existing theme tokens. Classic gives its raised/sunken bevel an
independent outside outline; Luna and the other faces use an accent edge while
retaining their existing highlight, gloss and focus paint. Disabled controls
suppress the cue. Selected/checked truth, `aria-pressed`, content geometry,
caller opacity, focus ownership and activation routing do not change. Only the
existing display **Keep** and Files **confirm** actions opt in; this is not a
global Enter handler, focus migration policy or an OS-default pulse animation.

## Select overlay lifecycle

Keep the existing `NOverlayHost()` as the final child of a viewport-filling,
untranslated app root, and use the existing reactive `createApp` rendering
contract. Select still uses the window-local `openPopup` portal, not a native
popup or a compositor grab.

Focus remains on the `combobox`; `aria-activedescendant` identifies the
highlighted listbox option. An open popup consumes the latest rendered value,
options, disabled state and callback. Updating a parent must still render the
factory, just as for other controlled components. Removing, reusing or
type-replacing its trigger closes the popup instead of activating a stale
option. Escape, commit and backdrop close restore a still-attached, enabled
trigger; Tab, disabling or removing it does not steal focus back. Public
`closePopup` also runs the Select's private, idempotent cleanup.

Long lists use the existing scroll viewport, capped to the available document
space. Keyboard navigation reveals the active row after a bounded two-rAF layout
measurement; there is no timer, frame loop or new layout/owner API. Narrow option
labels clip within the configured row. An empty list shows an inert `No options`
state and cannot emit a value.

An open native Select observes only its owning window's geometry through the
existing `Document.defaultView` / `Window.observeState` contract. Pure host
resize therefore remeasures placement and height even without a parent update;
close/leave removes the subscription. Two measurement frames and, if placement
changed, two post-portal layout frames complete one resize. A viewport shorter
than one row can only show a partial row; it is not reported as a full-row reveal.

## Focused checks

Run the actual GUI tests from the repository root with a raster-enabled
`pollyui-playground`:

```text
pollyui-playground --test gui/tests/selection-basic.mjs
pollyui-playground --test gui/tests/selection-controls.mjs
pollyui-playground --test gui/tests/selection-gestures.mjs
pollyui-playground --test gui/tests/naive3.mjs
```

`tests/selection-appearance.mjs` exports bounded actual factory checks for
default light/dark pixels, visible-focus/blur crops and a native owner-runner
adapter check. The native 1/1.5/2 check injects private `WM_DPICHANGED` test
messages; it is not a change to monitor settings or OS/compositor qualification.
These contracts do not claim OS-exact six-theme checkbox/radio art, a native
accessibility bridge, typeahead, nested menus or a native popup grab.
The desktop `selection-theme-controls-render.mjs` state sheet and
`selection-settings-render.mjs` consumers exercise instance isolation, open
portal retheme/metrics and the real Settings policies. The small
`selection-theme-native.mjs` owner-runner check covers sub-row host resize and
closed-owner collection; it does not qualify a hardware/compositor backend.

## Input typography and selection foreground

`measureText(text, size, weight, family)` and, where present,
`layoutText(text, size, weight, family)` accept an optional fourth literal family
name. Each supporting function exposes readonly/nonconfigurable
`supportsFontFamily: true`. Omitted family keeps the original metric path;
Linux complex text still uses the native full-string shaping/layout implementation.
The SDK rejects an explicit family before mutation if either installed provider
lacks that declaration; it never infers support from a function ignoring extra
arguments. This is capability support, not proof that an arbitrary face is
installed: use a locally installed family. Existing platform font fallback is
unchanged, and no font resources are loaded or installed.

`createTextInput({ fontFamily })`, `setAppearance({ fontFamily })`,
`NInput({ fontFamily })` and selection-control `appearance.fontFamily` opt in per
instance. Names use the same bounded 128-UTF-16-unit literal rule as captions:
Unicode family names are permitted, but paths, URLs, resource syntax, fallback
lists and controls are not. Geometry caches include family/weight; painting,
click hit-testing, caret, preedit, selected ranges and full-string selected ink
share the same family. A family update preserves the retained input/value and
selection. Explicit `fontFamily: undefined` clears an earlier opt-in; other
partial appearance updates leave the current family alone. Open Select portals
consume the latest family without affecting another instance or global SDK theme.

`NInput({ fontSize })` accepts a finite 8–64 logical-pixel size; omitting it keeps
the existing `size` mapping. The same size feeds painting, measurement, caret,
selection and composition geometry.

`createTextInput({ maxLength })` optionally bounds the committed value to a
non-negative safe-integer count of Unicode code points. Initial `value` and
programmatic assignments truncate at the existing text-index boundary; assignments
keep their original end-caret/cleared-selection semantics. Interactive insertion,
selection replacement and clipboard/IME commits share the existing insertion
path: only inserted text is trimmed to the remaining budget, preserving the
unselected suffix and insertion caret. Transient IME preedit is not committed
value. Omitting the option keeps the previous unbounded behavior.

`createTextInput({ selectionTextColor })`, its `setAppearance` method, and
`NInput({ selectionTextColor })` optionally set selected glyph foreground.
Omitting the field preserves the original SDK painting. The existing
`selectionColor` remains the highlight background. Desktop opt-in consumers map
the optional RGB `colors.selectionText` token through their shared appearance
helper; legacy themes without it use `colors.text`. Neutral/non-opt-in consumers
do not load or infer a desktop palette.
Desktop quiet commands and selected shortcut captions/status also consume that
same optional foreground token, including the explicitly marked strokes of
original monochrome fallback art. Missing tokens retain each consumer's prior
fallback. Normal/non-quiet button faces and bitmap icon content are not
recolored by the selection token.

The selection painter reuses the **native DOM full-string renderer** within
the actual visual selection ranges. It does not separately shape substrings or
use Canvas outlined text, so combining/kerning, native bidi runs and available
color emoji stay on the original rendering path. Each clipped range first
replaces the underlying glyph pixels with the input/selection background; white
glyphs are not simply drawn over old black antialiasing.

Decorative full-string copies are `aria-hidden` and `pointerEvents: none`.
`input.value` and the original text node retain the actual value. As with other
DOM decorations, aggregate `root.textContent` can include these hidden copies;
use the input API/controlled value for editing or persistence. Password copies
contain only the displayed mask; active composition suppresses selection copies.
Blur removes the extra layer. There are no owner-window caches, frame loops or
new native APIs in this painter.

`gui/tests/selection-text.mjs` compares full and partial selections against the
same native-font DOM reference, including a present color glyph, combining text,
mixed RTL input, secure masks, controlled IME and unchanged unselected pixels.
Its log records whether the runner actually supplies native `layoutText`;
mixed text on a runner without it does not certify ICU/bidi behavior.

## Per-instance vertical scrollbar appearance

`createVerticalScrollbar({ viewport, track, thumb, isCurrent, appearance })`
retains the existing single geometry, drag/capture, page, wheel and keyboard
controller. Omit `appearance` for unchanged caller-owned styling, no decoration
nodes or arrows, the 28px minimum thumb and the existing 42px keyboard step.
The caller supplies the scrollbar role/label and updates the controller after
layout, content or scroll changes; the controller starts no timer or frame loop.
Composing keyboard events neither scroll nor cancel capture, and are not consumed.

Optional `onScroll(value)` synchronously reports a changed, clamped numeric
`viewport.scrollTop` after an update, including keyboard, capture and external
scroll changes. It must be a function or omitted, and is validated before any
listeners attach. Construction, unchanged updates and stopped controllers never
notify. Consumers may update virtual rows and call `update()` synchronously;
reentrant updates coalesce without a notification loop. Callback exceptions
propagate, with mouseup capture still released. This callback is independent of
appearance painting and does not sample or observe application data.

An optional appearance contains `metrics`, `paint(state, parts)` and
`decorate(parts)`. Metrics are bounded logical-pixel values: `width`,
`thumbInset`, `minThumbHeight` (default 28), `arrowSize` (default 0), and
`stepSize` (default 42). `paint` returns surface styles for `track`, `thumb`,
`decrement` and `increment`, never geometry. State reports hovered/held part,
dragging, keyboard focus, disabled, actual overflow and start/end boundaries.
`decorate` owns only passive content inside the provided detail slots and may
return cleanup. The focus slot is the detail wrapper for the existing
Canvas -> ring -> detail -> control ancestry, not a new focus controller.

`setAppearance(value)` rethemes the same viewport/track/thumb and preserves
active thumb capture. `setAppearance(undefined)` restores the original surface
styles and removes owned arrows/decorations. Unchanged appearance/state/bounds
updates do not notify paint or rewrite styles. Real track bounds changes notify
the existing focus painter without a frame loop. `stop()` releases capture, unregisters
listeners and disposes decorations. `step(-1|1)` uses the same clamped step as
arrow regions and ArrowUp/ArrowDown; arrows never acquire a second input owner.
Tiny themed rails retain truthful overflow and arrow/keyboard access even when
no thumb travel fits; short content still hides/disables the rail.
Surface `track.opacity` is preserved while enabled and gated to zero when hidden;
restored overflow restores that surface opacity. Captured retheme/resize reanchors
the pointer in the new arrow lane without scrolling a stationary pointer.
Invalid initial appearance configuration is rejected before listeners attach;
failed initial paint/decoration rolls back owned listeners, nodes, styles and
accessibility state and rethrows the original error.

`verticalScrollMetrics` optionally accepts a third argument
`{ minThumbHeight, startInset, endInset }`; `top` includes the start inset and
travel excludes both arrow regions. Existing two-argument calls are unchanged.
The SDK imports no desktop palette. Desktop's single
`desktop/shared/ui/scrollbar-appearance.mjs` adapter derives its surfaces from
theme tokens, namespaces passive bevels, and reuses existing Classic/Luna focus
painting. Its end-arrow policy is not a claim of exact original-OS layouts.
Its `full` (default) and `overlay` variants share that policy; `overlay` keeps
Files' existing 10px footprint without shrinking its rows or metadata columns.
Unknown variants reject explicitly.

## Native event listener mutation

Each node's dispatch phase visits its registrations in order, at most once.
Listeners added during that phase wait for a later phase; registrations removed
before their turn are skipped. Removing and readding the same function creates
a new registration. Duplicate registrations remain distinct, and
`removeEventListener` removes only the first matching type/function registration.
Nested dispatch has its own boundary; an ancestor starts its phase only when
the existing dynamic bubble walk reaches it.

`stopPropagation` allows the remaining same-node listeners;
`stopImmediatePropagation` also stops that phase. `preventDefault` remains visible
without suppressing listeners. Exceptions are explicitly reported and do not
silently suppress subsequent listeners. Registration allocation or identity
exhaustion throws rather than claiming success while dropping a callback.

## Native Wayland window contract

`gui-wayland-window-contract` requires `PU_BUILD_DESKTOP`, `PU_BUILD_LAUNCHER`
and `PU_DESKTOP_SERVICES`: the fixture starts the production `pollyui --decorator`
as an independent windowless renderer. The playground remains a pure GUI client.
Without the launcher/services this SSD input contract is explicitly not registered;
bare compositor/CSD operation does not supply interactive server-side frames.

The original normal, tooltip, no-dialog, native-lifetime and close-tree modes keep
their assertions and deadlines. Resize and caption clicks wait on the existing
decoration readiness fence and a presented button box. Resize coordinates come from
the current client geometry and decoration inset, inside the real border rather
than on its exclusive outer edge. No hit-test search, fixed sleep, fallback painter
or global activation click-through is used.
