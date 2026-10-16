const states = new WeakMap();
const metricDefaults = Object.freeze({ fontSize: 14, markerSize: 18, radioDot: 8, radius: 3, gap: 8,
  switchWidth: 40, switchHeight: 22, knobSize: 18, switchPadding: 2,
  controlHeight: 34, optionHeight: 32, menuHeight: 40, paddingX: 12,
  popupPadding: 4, popupGap: 2, popupMaxHeight: 240, tabGap: 24, panePadding: 16, disabledOpacity: 0.5 });
const metricLimits = { fontSize: [8, 64], markerSize: [8, 64], radioDot: [2, 48], radius: [0, 64],
  gap: [0, 64], switchWidth: [16, 160], switchHeight: [12, 80], knobSize: [4, 76], switchPadding: [0, 16],
  controlHeight: [16, 128], optionHeight: [16, 128], menuHeight: [16, 128], paddingX: [0, 64],
  popupPadding: [0, 32], popupGap: [0, 32], popupMaxHeight: [32, 1024], tabGap: [0, 64],
  panePadding: [0, 64], disabledOpacity: [0, 1] };
export function selectionAppearance(value, theme) {
  const colors = { ...theme, selected: theme.primary + '1f', selectedText: theme.primary,
    focus: theme.primary, hover: theme.primary + '14', pressed: theme.primary + '2e' };
  if (value === undefined) return { colors, metrics: metricDefaults, signature: JSON.stringify(colors), custom: false };
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['colors', 'metrics', 'paint', 'decorate', 'revision'].includes(key)))
    throw new TypeError('Invalid selection appearance');
  const metrics = { ...metricDefaults };
  for (const [group, target, allowed] of [['colors', colors, colors], ['metrics', metrics, metricLimits]]) {
    const source = value[group];
    if (source === undefined) continue;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Invalid selection ' + group);
    for (const [key, entry] of Object.entries(source)) {
      if (!Object.hasOwn(allowed, key) || key === 'name') throw new TypeError('Unknown selection ' + group + ': ' + key);
      if (group === 'colors') {
        if (typeof entry !== 'string' || !entry.length || entry.length > 64) throw new TypeError('Invalid selection color: ' + key);
      } else {
        const [min, max] = metricLimits[key];
        if (!Number.isFinite(entry) || entry < min || entry > max) throw new RangeError('Invalid selection metric: ' + key);
      }
      target[key] = entry;
    }
  }
  if (metrics.knobSize + metrics.switchPadding * 2 > metrics.switchHeight ||
      metrics.switchWidth < metrics.switchHeight || metrics.radioDot >= metrics.markerSize ||
      metrics.optionHeight < metrics.fontSize || metrics.controlHeight < metrics.fontSize ||
      metrics.menuHeight < metrics.fontSize)
    throw new RangeError('Selection metrics do not fit the control geometry');
  for (const key of ['paint', 'decorate'])
    if (value[key] !== undefined && typeof value[key] !== 'function') throw new TypeError('Invalid selection ' + key);
  if (value.revision !== undefined && (typeof value.revision !== 'string' || value.revision.length > 256))
    throw new TypeError('Invalid selection appearance revision');
  return { colors, metrics, paint: value.paint, decorate: value.decorate, custom: true,
    signature: JSON.stringify([colors, metrics, value.revision]) };
}

function paint(node, appearance, context, change = {}) {
  const disabled = context.disabled || node.getAttribute('aria-disabled') === 'true';
  const state = states.get(node) || { hovered: false, pressed: false, focused: false };
  Object.assign(state, change, { focused: node.ownerDocument?.activeElement === node });
  if (disabled) Object.assign(state, { hovered: false, pressed: false, focused: false });
  states.set(node, state);
  const c = appearance.colors;
  const styles = appearance.paint ? appearance.paint({ ...context, ...state, disabled,
    colors: c, metrics: appearance.metrics }) : {
    root: { opacity: disabled ? appearance.metrics.disabledOpacity : 1 },
    label: { color: disabled ? c.textDisabled : context.selected ? c.selectedText : c.text },
    marker: { borderColor: state.focused ? c.focus : state.hovered ? c.primary : c.border },
  };
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)) throw new TypeError('Selection paint must return part styles');
  for (const [part, style] of Object.entries(styles)) {
    const nodes = part === 'root' ? [node] : node.querySelectorAll('.n-selection-' + part);
    for (const target of nodes) Object.assign(target.style, style);
  }
}

export function selectionSkin(vnode, appearance, context) {
  if (!appearance.custom) return vnode;
  if (appearance.decorate) appearance.decorate(vnode, context);
  const props = vnode.props;
  for (const [name, change] of Object.entries({ onMouseenter: { hovered: true }, onMouseleave: { hovered: false, pressed: false },
    onMousedown: { pressed: true }, onMouseup: { pressed: false }, onMousecancel: { hovered: false, pressed: false },
    onLostmousecapture: { pressed: false }, onFocus: {}, onBlur: { pressed: false } })) {
    const original = props[name];
    props[name] = event => {
      original?.(event);
      if (name !== 'onMousedown' || event.button === 0) paint(event.currentTarget, appearance, context, change);
    };
  }
  for (const name of ['onMount', 'onUpdate']) {
    const original = props[name];
    props[name] = node => { original?.(node); paint(node, appearance, context); };
  }
  return vnode;
}
