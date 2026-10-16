# GUI SDK selection controls

The Naive factories in `sdk/js/naive.mjs` use the existing SDK light/dark palette,
not desktop theme presets. Selection is controlled: render the new `value` or
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

## Input typography and selection foreground

`NInput({ fontSize })` accepts a finite 8–64 logical-pixel size; omitting it keeps
the existing `size` mapping. The same size feeds painting, measurement, caret,
selection and composition geometry.

`createTextInput({ selectionTextColor })`, its `setAppearance` method, and
`NInput({ selectionTextColor })` optionally set selected glyph foreground.
Omitting the field preserves the original SDK painting. The existing
`selectionColor` remains the highlight background. Desktop opt-in consumers map
the optional RGB `colors.selectionText` token through their shared appearance
helper; legacy themes without it use `colors.text`. Neutral/non-opt-in consumers
do not load or infer a desktop palette.

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
