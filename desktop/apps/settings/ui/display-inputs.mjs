import { createTextInput } from './gui/sdk/js/textinput.mjs';
import { h } from './gui/sdk/js/reconciler.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';

export function displayField(owner, inputs, head, field, theme, width = 78, onInput = null) {
  const id = 'shell-output-' + head.id + '-' + field;
  const fontSize = themeTextSize(theme, 12);
  const appearance = { color: theme.colors.text, background: theme.colors.surface,
    selectionColor: theme.colors.selection, borderColor: theme.colors.border,
    borderRadius: theme.button.radius, fontSize };
  const existing = inputs.get(id);
  if (existing) { existing.setAppearance(appearance); existing.onDisplayInput = onInput; }
  return h('view', { style: { width, height: fontSize + 16, flexShrink: 0 }, onMount: node => {
    let input = inputs.get(id);
    if (!input) {
      input = createTextInput({ document: owner, value: field === 'refresh' ? head[field] / 1000 : head[field],
        width, fontSize, padding: 7, purpose: 'number', color: theme.colors.text, background: theme.colors.surface,
        selectionColor: theme.colors.selection });
      input.setAppearance(appearance);
      input.root.id = id;
      input.root.setAttribute('role', 'textbox');
      input.root.setAttribute('aria-label', head.name + ' ' + field);
      inputs.set(id, input);
      const edited = () => { if (inputs.get(id) === input) input.onDisplayInput?.(); };
      input.root.addEventListener('textinput', edited);
      input.root.addEventListener('auxclick', event => { if (event.button === 1) edited(); });
      input.root.addEventListener('keydown', event => {
        if (['Backspace', 'Delete'].includes(event.key) ||
            ((event.ctrlKey || event.metaKey) && ['x', 'v'].includes(event.key.toLowerCase()))) edited();
      });
    }
    input.onDisplayInput = onInput;
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
