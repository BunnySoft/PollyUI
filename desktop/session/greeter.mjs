import { createTextInput } from './gui/sdk/js/textinput.mjs';
import { createGreeterController } from './desktop/session/greeter-controller.mjs';

window.close();
const surfaces = new Map();
let renderedScreen = '';
const clear = () => {
  for (const surface of surfaces.values()) for (const field of Object.values(surface.fields)) {
    field.root.cancelComposition();
    field.value = '';
  }
};
const controller = createGreeterController({
  backend: graphicalAuth,
  clear,
  changed: render,
  leave: () => { clear(); window.quit(); },
});
graphicalAuth.onProgress = phase => controller.progress(phase);

function label(doc, text, size = 16) {
  const node = doc.createElement('view');
  node.textContent = text;
  Object.assign(node.style, { color: '#ffffff', fontSize: size });
  return node;
}

function button(doc, text, action) {
  const node = label(doc, text);
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  Object.assign(node.style, { backgroundColor: '#245dc9', padding: 12, borderRadius: 8 });
  node.addEventListener('click', action);
  node.addEventListener('keydown', event => {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); action(); }
  });
  return node;
}

function build(display, screen) {
  const native = window.create({
    title: 'PollyDesktop sign in', output: display.id, layer: 'overlay',
    anchors: ['top', 'bottom', 'left', 'right'], width: 0, height: 0,
    keyboard: 'exclusive', exclusiveZone: -1,
  });
  const doc = native.document;
  Object.assign(doc.body.style, {
    backgroundColor: '#101820', padding: 20, gap: 10,
    justifyContent: 'center', alignItems: 'center', overflow: 'scroll',
  });
  const card = doc.createElement('view');
  Object.assign(card.style, { gap: 8, width: Math.max(1, Math.min(420, display.width - 40)) });
  doc.body.appendChild(card);
  card.appendChild(label(doc, screen === 'setup' ? 'Welcome to PollyDesktop' : 'PollyDesktop', 28));
  const status = label(doc, '', 15);
  status.id = 'greeter-status';
  Object.assign(status.style, { maxWidth: Math.max(1, Math.min(420, display.width - 40)), marginBottom: 6 });
  status.setAttribute('role', 'status');
  card.appendChild(status);
  const fields = {};
  if (screen === 'setup' || screen === 'login') {
    const definitions = screen === 'setup' ? [
      ['polly', 'polly account password'], ['pollyConfirm', 'Confirm polly password'],
      ['root', 'Root maintenance password (not a desktop login)'], ['rootConfirm', 'Confirm root maintenance password'],
    ] : [['polly', 'polly account password']];
    for (const [name, text] of definitions) {
      card.appendChild(label(doc, text, 15));
      const input = createTextInput({ document: doc, password: true,
        width: Math.max(1, Math.min(420, display.width - 40)), fontSize: 18, padding: 10,
        background: '#ffffff', color: '#101820' });
      input.root.setAttribute('aria-label', text);
      input.root.id = 'greeter-password-' + name;
      fields[name] = input;
      card.appendChild(input.root);
    }
  }
  const submit = () => {
    const state = controller.state();
    if (state.screen === 'error') { controller.refresh(); return; }
    const values = {};
    for (const [name, input] of Object.entries(fields)) values[name] = input.value;
    controller.submit(values);
  };
  const primary = button(doc, screen === 'setup' ? 'Set passwords and continue' :
    screen === 'error' ? 'Retry' : 'Sign in', submit);
  const cancel = button(doc, 'Cancel', () => controller.cancel());
  primary.id = 'greeter-submit';
  cancel.id = 'greeter-cancel';
  card.appendChild(primary);
  if (screen !== 'loading' && screen !== 'error') card.appendChild(cancel);
  doc.body.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); submit(); }
    if (event.key === 'Escape') { event.preventDefault(); controller.cancel(); }
  });
  native.onclose = () => {
    clear();
    if (surfaces.get(display.id)?.window === native) { controller.close(); window.quit(); }
  };
  return { window: native, fields, status, primary, cancel };
}

function render(state = controller.state()) {
  const displays = window.displays();
  const recreate = state.screen !== renderedScreen;
  if (recreate) clear();
  for (const [id, surface] of surfaces) {
    if (recreate || !displays.some(display => display.id === id)) {
      surfaces.delete(id);
      surface.window.onclose = null;
      surface.window.close();
    }
  }
  renderedScreen = state.screen;
  for (const display of displays) if (!surfaces.has(display.id)) surfaces.set(display.id, build(display, state.screen));
  for (const surface of surfaces.values()) {
    surface.status.textContent = state.message;
    surface.primary.tabIndex = state.busy ? -1 : 0;
    surface.primary.setAttribute('aria-disabled', String(state.busy));
    surface.primary.style.opacity = state.busy ? 0.5 : 1;
    const cancellable = !state.busy || state.cancellable;
    surface.cancel.tabIndex = cancellable ? 0 : -1;
    surface.cancel.setAttribute('aria-disabled', String(!cancellable));
    surface.cancel.style.opacity = cancellable ? 1 : 0.5;
    for (const field of Object.values(surface.fields)) {
      field.root.tabIndex = state.busy ? -1 : 0;
      field.root.setAttribute('aria-disabled', String(state.busy));
      if (state.busy) { field.root.blur(); field.value = ''; }
    }
  }
  if (recreate) {
    const first = surfaces.values().next().value;
    (first?.fields.polly?.root ?? first?.primary)?.focus();
  }
}

controller.refresh();
setInterval(() => render(), 250);
