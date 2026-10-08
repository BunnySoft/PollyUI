import { createTextInput } from './js/textinput.mjs';
import { h } from './js/reconciler.mjs';
import { themeTextSize } from './desktop/shell/theme-layout.mjs';

export function displayField(owner, inputs, head, field, theme, width = 78) {
  const id = 'shell-output-' + head.id + '-' + field;
  const fontSize = themeTextSize(theme, 12);
  const existing = inputs.get(id);
  if (existing) existing.setAppearance({ color: theme.colors.text, background: theme.colors.surface,
    selectionColor: theme.colors.selection, borderColor: theme.colors.border,
    borderRadius: theme.button.radius, fontSize });
  return h('view', { style: { width, height: fontSize + 16, flexShrink: 0 }, onMount: node => {
    let input = inputs.get(id);
    if (!input) {
      input = createTextInput({ document: owner, value: field === 'refresh' ? head[field] / 1000 : head[field],
        width, fontSize, padding: 7, purpose: 'number', color: theme.colors.text, background: theme.colors.surface,
        selectionColor: theme.colors.selection });
      input.root.id = id;
      input.root.setAttribute('role', 'textbox');
      input.root.setAttribute('aria-label', head.name + ' ' + field);
      inputs.set(id, input);
    }
    node.appendChild(input.root);
  } });
}

export function setDisplayField(inputs, head, field, value) {
  head[field] = value;
  const input = inputs.get('shell-output-' + head.id + '-' + field);
  if (input) input.value = field === 'refresh' ? value / 1000 : value;
}

export function readDisplayDraft(draft, inputs) {
  return { serial: draft.serial, heads: draft.heads.map(head => {
    if (!head.enabled) return { ...head };
    const result = { ...head };
    for (const field of ['width', 'height', 'refresh', 'scale', 'x', 'y']) {
      const input = inputs.get('shell-output-' + head.id + '-' + field);
      if (!input || !String(input.value).trim()) throw new Error('Enter a value for ' + field);
      const number = Number(input.value);
      if (!Number.isFinite(number)) throw new Error('Invalid display value: ' + field);
      result[field] = field === 'refresh' ? Math.round(number * 1000) : number;
    }
    return result;
  }) };
}
