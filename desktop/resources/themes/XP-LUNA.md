# Blue Luna: first visual batch

Target: Windows XP SP3, default blue Luna, normal-size typography at 96 DPI,
800 x 600 first, then supported output scaling. The public GUIdebook original
Windows XP screenshots in `xp-reference.json` establish a traceable *partial*
reference set. Their Service Pack and DPI metadata are not certified. Their
unscaled 30 px taskbar and 21 px caption buttons are the adopted geometry;
SP3 certification and reference captures for all interaction states remain
pending. Do not label this implementation 1:1.

## Rendering and rights

Only XP opts into `surfaceStyle: "luna"` in `window`, `button` and `panel`.
Missing options mean the original generic renderer. JSON schema 1 remains
backwards compatible. Numeric decoration schema 2 adds a bounded Luna flag,
without changing word counts, metrics, sealed documents or transaction rules.
An older compositor explicitly rejects that numeric schema rather than
silently drawing generic chrome. If that specific prepare rejection is confirmed
before the first committed Shell appearance, Shell tries one immutable generic
snapshot with real schema 1 and no Luna flag. It starts only after a confirmed
generic commit, displays a compatibility warning in the panel/settings, and
reports `warning`/`appearanceFallback` without rewriting the saved theme.
The legacy rejection message combines unsupported and out-of-range data;
the generic acceptance is required, never assumed. Other prepare failures,
lost acknowledgments and uncertain/rejected commits still fail explicitly.
Later theme requests never use the startup exception; unsupported Luna keeps
the prior snapshot and user preference. Other four presets retain their original data
and rendering path.

This batch adds a multi-band active/inactive title gradient, light caption
outlines and directional bevels, heavier close/minimize/maximize/restore marks,
caption text shadow, original generic document mark, and native pressed-state
painting using the compositor's existing press/release state. Native geometry,
hit testing and configure acknowledgments still use the same theme snapshot.
The two input-handler changes request repaint only; no activation policy changes.

Shell gains a 30 px multi-band taskbar, 97 px green Polly launcher, 26 px task
buttons with original document marks, compact original appearance/workspace/
notification symbols, a cyan notification area, 16 px tray icons and 11 px clock.
Menus/settings share rounded light buttons, warm inner hover rings, reversed
pressed gradients and dotted keyboard focus indicators. Search fields are
square. Existing opener IDs and actions remain unchanged.

All code, primitive drawings and symbols are original project work under the
repository license. Public screenshots are used locally for analysis only,
not copied into runtime assets or committed. No Bliss wallpaper, Windows logo,
Microsoft icon pack, Tahoma/Trebuchet font file, msstyles binary or proprietary
system resource is included. The existing independently drawn wallpaper is
retained and is an explicit fidelity gap, not a Bliss match.

## Reproduction

Small tests, without building a desktop:

```text
node desktop/tests/xp-luna-unit.mjs
node --test desktop/tests/xp-startup-compatibility.mjs
node desktop/tools/generate-decoration-themes.mjs --check
cc -std=c11 -Wall -Wextra -Wpedantic -Werror -Idesktop/shared desktop/tests/xp-luna-paint.c -lm -o /tmp/xp-luna-paint
/tmp/xp-luna-paint
/tmp/xp-luna-paint strip > /tmp/xp-title-strip.ppm
python3 desktop/tests/xp-luna-compare.py --reference <analysis-notepad.png> --paint-strip /tmp/xp-title-strip.ppm --output <evidence.json>
```

The paint-strip comparison measures only the actual native color helper, not
a native desktop, title text, clipping or a screenshot of a window. It reports
RGB mean absolute channel error, maximum channel error and changed pixel count
without a made-up acceptance threshold. The fixed 1 x 30 reference crop has no
text or icons; that deliberate exclusion is recorded, not silently masked.

Measured against the recorded Notepad strip, without resampling:

| Painter stage | Mean absolute RGB channel error | Maximum channel error | Changed pixels |
|---|---:|---:|---:|
| Fixed source before | 30.8444 | 82 | 30/30 |
| First Luna approximation | 3.0889 | 24 | 28/30 |
| Refined Luna painter | 1.0222 | 9 | 22/30 |

These numbers do not include text, icons, bevels, borders or a full window.
They are not a percentage-fidelity score. Original geometry was 36 px taskbar,
32 px title inset and 24 px caption controls; adopted geometry is 30/30/21 px.
Caption spacing changes from 4 to 2 px and ordinary Shell buttons from 28 to
21 px. Pixel geometry and visual states still require the native lane below.

The shared native validation lane must build the fixed implementation commit,
then run existing `desktop-integration`, `desktop-runtime-raster`/`-gl`,
`desktop-shell-raster`/`-gl`, `theme-configuration.mjs` and `desktop-appearance.mjs`
checks in its isolated source/build environment. Test names depend on the
existing CMake options. Also run `pollyui --test desktop/tests/xp-luna-render.mjs` for
actual PollyUI primitive state pixels (not compositor decoration acceptance).
For the startup fix, rerun `xp-startup-compatibility.mjs` against the combined
source and rebuild the native bridge. Its structured rejection marker is emitted
only for a matching, negative prepare reply with intact transport; ordinary
string lookalikes and schema 1 rejections are not compatibility signals.
Capture an 800 x 600 desktop with active and inactive
server-decorated windows, normal/hover/held-left-button captions, restored and
maximized windows, Shell menu/settings buttons and tray/clock. Repeat at 1.25,
1.5 and 2 output scaling; do not substitute a preview for compositor captures.
Compare full unscaled component crops with `xp-luna-compare.py --actual ...`
and both explicit crop boxes. It does no resampling or antialias/text masking.

## Remaining acceptance gaps

- Native scene screenshots and before/after full component comparisons are
  pending; unit/painter evidence does not certify native clipping or typography.
- Exact XP fonts and branded/application icons are not distributed. Generic
  system sans-serif and original marks differ visibly from XP.
- Native disabled caption controls and per-caption keyboard focus are not
  implemented; the current compositor exposes active/inactive, hover and press.
  Shell focus and disabled-paint primitives do not certify these native states.
- Reference hover/pressed state colors, Start menu two-column/profile layout,
  quick-launch behavior, system settings tabs, app-specific widget theming,
  scrollbar treatment and exact frame edge bevels remain incomplete.
- Real compositor shadows/blur and client-content rounding are not added.
  The XP preview now requests no artificial shadow. Third-party CSD remains
  application-owned; opt-in clients still choose which controls to adopt.
