import { h } from './gui/sdk/js/reconciler.mjs';
import { NSwitch, NCheckbox, NRadioGroup, NTabs, NSelect, NMenu } from './gui/sdk/js/naive.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';
import { surfaceStyle, surfacePaint, surfaceDetail, surfaceEvents, bevel } from './desktop/shared/ui/surface-primitives.mjs';
import { isLuna, lunaButtonPaint, lunaButtonDetail, lunaVisualEvents } from './desktop/shared/ui/luna-primitives.mjs';

const appearances = new WeakMap();
const find = (node, part) => node.props?.className === 'n-selection-' + part ? node :
  node.children?.map(child => find(child, part)).find(Boolean);
const fill = { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none' };
function decorateSelection(theme, vnode, context) {
  const { kind, disabled } = context, style = surfaceStyle(theme);
  const marker = find(vnode, kind === 'switch' ? 'knob' : 'marker');
  if (marker && style === 'classic' && kind !== 'radio') {
    const detail = bevel(theme, { inset: kind === 'checkbox' });
    for (const edge of detail.children) edge.props.className += ' n-selection-' + edge.props.className;
    marker.children.push(detail);
  }
  if (marker && (style === 'aqua' || style === 'luna')) marker.children.push(h('view', {
    className: 'n-selection-gloss', 'aria-hidden': 'true', style: { ...fill, bottom: '50%',
      borderRadius: theme.button.radius, backgroundColor: theme.colors.light, opacity: style === 'aqua' ? 0.4 : 0.2 } }));
  if (marker?.children.length) {
    const glyph = marker.children.find(child => child.props?.className === 'n-selection-glyph');
    if (glyph) { marker.children = marker.children.filter(child => child !== glyph); marker.children.push(glyph); }
  }
  vnode.children = vnode.children.filter(child => child.props?.className !== 'n-selection-focus');
  // Keep the existing detail/ring/Canvas ancestry and lifecycle, including the
  // shared Classic/Luna phase, owner subscription and weak finalizer contracts.
  const luna = isLuna(theme);
  vnode.children.push(luna ? lunaButtonDetail(theme, 'tool', disabled) : surfaceDetail(theme, { quiet: true, disabled }));
  const events = luna ? lunaVisualEvents(theme, { disabled }) : surfaceEvents(theme, { quiet: true, disabled });
  for (const [key, callback] of Object.entries(events)) {
    const original = vnode.props[key];
    vnode.props[key] = arg => { original?.(arg); callback(arg); };
  }
}

export function selectionAppearance(theme) {
  let appearance = appearances.get(theme);
  if (appearance) return appearance;
  const c = theme.colors, style = surfaceStyle(theme), classic = style === 'classic', luna = isLuna(theme);
  const fontSize = themeTextSize(theme), height = theme.layout.buttonHeight;
  const markerSize = Math.max(12, Math.min(18, fontSize + 2));
  appearance = {
    revision: style,
    colors: { primary: c.accent, card: c.surface, body: c.body, text: c.text, textSecondary: c.muted,
      textDisabled: c.muted, border: c.border, solidText: c.accentText, railOff: c.body,
      selected: c.selection, selectedText: c.selectionText ?? c.text, focus: c.focus,
      hover: c.selection, pressed: theme.button.to, trackBg: c.body },
    metrics: { fontSize, markerSize, radioDot: Math.max(4, Math.floor(markerSize / 2)),
      radius: theme.button.radius, gap: theme.layout.controlGap, switchWidth: Math.round(height * 1.8),
      switchHeight: height, knobSize: height - 6, switchPadding: 3, controlHeight: height,
      optionHeight: Math.max(height, fontSize + 10), menuHeight: Math.max(height, fontSize + 10),
      paddingX: theme.layout.buttonPaddingX, popupPadding: theme.layout.borderWidth + 2,
      popupGap: Math.max(0, theme.layout.borderWidth - 1), tabGap: theme.layout.controlGap,
      panePadding: theme.layout.contentPadding, disabledOpacity: theme.layout.disabledOpacity },
    decorate: (vnode, context) => decorateSelection(theme, vnode, context),
    paint: state => {
      const { kind, checked, selected, disabled, hovered, pressed, focused, active, metrics: m } = state;
      const entry = kind === 'menuitem' || kind === 'option';
      const highlighted = !disabled && (selected || hovered || active);
      const face = luna ? lunaButtonPaint(theme, { pressed, hovered, disabled, selected: false, focused }) :
        surfacePaint(theme, { pressed, hovered, disabled, focused });
      const text = disabled ? c.muted : entry && highlighted ? c.selectionText ?? c.text : c.text;
      const root = { opacity: disabled ? m.disabledOpacity : 1, backgroundColor: 'transparent',
        gradientFrom: 'transparent', gradientTo: 'transparent', borderWidth: 0, borderRadius: theme.button.radius };
      if (kind === 'select' || kind === 'tab') Object.assign(root, face, {
        borderWidth: 1, backgroundColor: disabled ? c.body : kind === 'tab' && selected ? c.surface : face.backgroundColor,
        borderColor: focused ? c.focus : hovered ? c.accent : c.border });
      if (entry) Object.assign(root, { backgroundColor: disabled ? 'transparent' : pressed ? c.accent :
        highlighted ? c.selection : 'transparent', gradientFrom: 'transparent', gradientTo: 'transparent' });
      if (kind === 'switch') Object.assign(root, { borderWidth: 1,
        borderColor: focused ? c.focus : disabled ? c.border : hovered ? c.accent : c.border,
        borderRadius: classic ? 0 : luna ? theme.button.radius : m.switchHeight / 2,
        backgroundColor: disabled ? c.body : checked ? c.accent : c.body });
      const markerRadius = Math.min(theme.button.radius, Math.floor(m.markerSize / 4));
      const marker = { borderRadius: kind === 'radio' ? m.markerSize / 2 : markerRadius,
        borderWidth: 1, borderColor: disabled ? c.border : hovered || focused ? c.accent : c.border,
        backgroundColor: disabled ? c.body : checked && kind !== 'radio' && !classic && !luna ? c.accent : c.surface,
        gradientFrom: 'transparent', gradientTo: 'transparent' };
      if ((style === 'aqua' || luna) && !disabled) Object.assign(marker, {
        gradientFrom: checked && kind !== 'radio' && !luna ? c.accent : c.surface,
        gradientTo: pressed ? c.body : theme.button.to });
      return { root, marker, knob: { borderRadius: classic ? 0 : luna ? theme.button.radius : m.knobSize / 2,
        backgroundColor: disabled ? c.body : pressed ? theme.button.to : theme.button.from,
        borderWidth: 1, borderColor: disabled ? c.border : c.dark,
        gradientFrom: classic ? c.body : theme.button.from, gradientTo: classic ? c.body : theme.button.to },
      glyph: kind === 'radio' ? { backgroundColor: disabled ? c.muted : classic ? c.text : c.accent } :
        { color: disabled ? c.muted : classic || luna ? c.text : c.accentText },
      label: { color: text }, icon: { color: text }, arrow: { color: disabled ? c.muted : c.text },
      underline: { backgroundColor: disabled ? c.border : selected ? c.accent : 'transparent' },
      active: { borderColor: c.focus, opacity: !disabled && active ? 1 : 0 },
      gloss: { opacity: disabled || pressed ? 0 : style === 'aqua' ? 0.4 : 0.2 } };
    },
  };
  Object.freeze(appearance.colors); Object.freeze(appearance.metrics); Object.freeze(appearance);
  appearances.set(theme, appearance);
  return appearance;
}

export const themedSwitch = (theme, props) => NSwitch({ ...props, appearance: selectionAppearance(theme) });
export const themedCheckbox = (theme, props, label) => NCheckbox({ ...props, appearance: selectionAppearance(theme) }, label);
export const themedRadioGroup = (theme, props) => NRadioGroup({ ...props, appearance: selectionAppearance(theme) });
export const themedTabs = (theme, props) => NTabs({ ...props, appearance: selectionAppearance(theme) });
export const themedSelect = (theme, props) => NSelect({ ...props, appearance: selectionAppearance(theme) });
export const themedMenu = (theme, props) => NMenu({ ...props, appearance: selectionAppearance(theme) });
