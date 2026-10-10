import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./root-loader.mjs', import.meta.url);
const { createDesktopShell, SHELL_THEME_KEY } = await import('../shell/shell.mjs');
const { getDesktopTheme } = await import('../shell/themes.mjs');
const { DECORATION_METRICS, DECORATION_COLORS, parseThemeFile } = await import('../shell/theme-schema.mjs');
const { waitForSessionReady } = await import('../shell/health.mjs');

// Per-document DOM and transaction stubs; no native geometry or rendering claim.
class Node {
  constructor(ownerDocument, type = 'view') {
    Object.assign(this, { ownerDocument, type, childNodes: [], parentNode: null, style: {},
      attributes: new Map(), listeners: new Map(), id: '', tabIndex: -1,
      offsetWidth: 800, offsetHeight: 600, scrollLeft: 0, scrollTop: 0 });
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    const adopt = child => { child.ownerDocument = this.ownerDocument; child.childNodes.forEach(adopt); };
    adopt(node);
    this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, node);
    return node;
  }
  removeChild(node) {
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(type, callback) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), callback]);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return descendants(this).filter(node => selector.startsWith('.') ?
      node.className?.split(' ').includes(selector.slice(1)) :
      selector.startsWith('#') ? node.id === selector.slice(1) : node.type === selector);
  }
  focus() {
    this.ownerDocument.activeElement?.blur();
    this.ownerDocument.activeElement = this;
    for (const callback of this.listeners.get('focus') || []) callback({ currentTarget: this });
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
    for (const callback of this.listeners.get('blur') || []) callback({ currentTarget: this });
  }
}
function descendants(node) { return [node, ...node.childNodes.flatMap(descendants)]; }
function document() {
  const owner = {
    activeElement: null,
    createElement: type => new Node(owner, type),
    createTextNode: nodeValue => Object.assign(new Node(owner, '#text'), { nodeValue }),
    getElementById: id => descendants(owner.body).find(node => node.id === id) || null,
  };
  owner.body = owner.createElement('view');
  return owner;
}
globalThis.document = document();

function encode(theme) {
  const window = theme.window;
  const luna = window.surfaceStyle === 'luna';
  const flags = Number(window.controls === 'left') | Number(window.controlShape === 'round') << 1 |
    Number(window.texture === 'pinstripe') << 2 | Number(window.gradientDir === 'horizontal') << 3 |
    ['sans-serif', 'serif', 'monospace'].indexOf(window.fontFamily) << 4 |
    Number(window.glyphsOnHoverOnly) << 6 | ['left', 'center', 'right'].indexOf(window.textAlign) << 7 |
    Number(luna) << 9;
  return [luna ? 2 : 1, flags,
    ...DECORATION_METRICS.map(([, token, , , scale]) => Math.round(window[token] * scale)),
    ...DECORATION_COLORS.map(token => 0xff000000 + parseInt(window[token].slice(1), 16))];
}
function schemaRejection(schema, message = 'Unsupported or out-of-range appearance data') {
  return Object.assign(new Error('Appearance preparation failed: ' + message), {
    code: 'ERR_APPEARANCE_SCHEMA_REJECTED', appearanceSchema: schema, compositorMessage: message,
  });
}
function fixture(t, { maximumSchema = 2, initialTheme = 'xp', failure = null } = {}) {
  const created = [], attempts = [], reports = [], saves = [];
  const preferences = new Map(initialTheme === null ? [] : [[SHELL_THEME_KEY, initialTheme]]);
  const storage = {
    getItem: key => preferences.get(key) ?? null,
    setItem(key, value) { saves.push([key, value]); preferences.set(key, value); },
    removeItem(key) { saves.push([key, null]); preferences.delete(key); },
  };
  const host = {
    close() {},
    displays: () => [1, 2].map(id => ({ id, x: (id - 1) * 800, y: 0, width: 800, height: 600 })),
    create(options) {
      const surface = { options, closed: false, document: document(),
        close() { if (!this.closed) { this.closed = true; this.onclose?.(); } } };
      created.push(surface);
      return surface;
    },
  };
  const backend = {
    maximumSchema, failure, committed: null,
    sessionServices: () => ({ inputMethod: 'disabled' }),
    configureAppearance(theme) {
      const words = encode(theme);
      attempts.push({ theme, words });
      if (this.failure) throw this.failure(words);
      const validHeader = words[0] <= this.maximumSchema &&
        !(words[1] & ~(words[0] === 1 ? 511 : 1023));
      const validBounds = DECORATION_METRICS.every(([, , minimum, maximum, scale], index) =>
        words[index + 2] >= minimum * scale && words[index + 2] <= maximum * scale);
      assert.equal(words.length, 2 + DECORATION_METRICS.length + DECORATION_COLORS.length);
      if (!validHeader || !validBounds) throw schemaRejection(words[0]);
      this.committed = parseThemeFile(JSON.stringify({ schemaVersion: 1, theme }));
    },
  };
  const shell = createDesktopShell({ host, storage, native: backend, report: message => reports.push(message) });
  t.after(() => shell.stop());
  return { shell, host, storage, backend, created, attempts, reports, saves, preferences };
}

test('startup without a saved theme applies the default without inventing a preference', t => {
  const f = fixture(t, { initialTheme: null });
  f.shell.start();
  assert.equal(f.preferences.has(SHELL_THEME_KEY), false);
  assert.equal(f.saves.length, 0);
  assert.equal(f.shell.getState().themeId, 'xp');
});

test('startup applies Luna once through the current configuration API', async t => {
  const f = fixture(t);
  f.shell.start();
  assert.deepEqual(f.attempts.map(item => item.words[0]), [2]);
  assert.ok(f.attempts[0].words[1] & 512);
  assert.equal(f.backend.committed.window.surfaceStyle, 'luna');
  assert.equal(f.reports.length, 0);
  assert.equal(f.shell.getSurfaces().length, 4);
  await waitForSessionReady({ shell: f.shell, native: f.backend, report() {} });
  f.shell.refresh(true);
  assert.equal(f.attempts.length, 1);
});

test('generic themes use their own supported data, not a downgraded Luna snapshot', t => {
  assert.equal(getDesktopTheme('xp').window.surfaceStyle, 'luna');
  const f = fixture(t, { initialTheme: 'server2003' });
  f.shell.start();
  assert.deepEqual(f.attempts.map(item => item.words[0]), [1]);
  assert.deepEqual(f.backend.committed, getDesktopTheme('server2003'));
  assert.equal(f.reports.length, 0);
});

test('rejected theme selection preserves the committed snapshot, live surfaces and preference', t => {
  const f = fixture(t, { maximumSchema: 1, initialTheme: 'server2003' });
  f.shell.start();
  const surfaces = f.shell.getSurfaces().map(item => item.window);
  const snapshot = f.backend.committed;
  assert.equal(f.shell.selectTheme('xp'), false);
  assert.deepEqual(f.attempts.map(item => item.words[0]), [1, 2]);
  assert.equal(f.backend.committed, snapshot);
  assert.equal(f.preferences.get(SHELL_THEME_KEY), 'server2003');
  assert.equal(f.shell.getState().themeId, 'server2003');
  assert.match(f.shell.getState().error, /Could not apply\/save appearance/);
  assert.ok(surfaces.every(surface => !surface.closed));
  assert.ok(f.shell.getSurfaces().every(item => surfaces.includes(item.window)));
});

test('recovered backend accepts an explicit theme selection after rejection', t => {
  const f = fixture(t, { maximumSchema: 1, initialTheme: 'server2003' });
  f.shell.start();
  assert.equal(f.shell.selectTheme('xp'), false);
  f.backend.maximumSchema = 2;
  assert.equal(f.shell.selectTheme('xp'), true);
  assert.equal(f.backend.committed.window.surfaceStyle, 'luna');
  assert.equal(f.shell.getState().error, '');
  assert.deepEqual(f.attempts.map(item => item.words[0]), [1, 2, 2]);
});

for (const [name, failure] of [
  ['missing acknowledgement', new Error('Appearance preparation failed: no compositor acknowledgment')],
  ['transport loss', new Error('Appearance preparation failed: connection lost')],
  ['commit uncertainty', new Error('Cannot confirm appearance commit; compositor state may have changed')],
  ['commit rejection', new Error('Appearance commit rejected: No matching prepared appearance')],
  ['unstructured lookalike', new Error('Appearance preparation failed: Unsupported or out-of-range appearance data')],
  ['unrelated structured error', Object.assign(schemaRejection(2), { code: 'ERR_SOMETHING_ELSE' })],
  ['unsupported Luna data', schemaRejection(2)],
  ['unsupported schema', schemaRejection(2, 'Unsupported appearance schema')],
  ['schema 1 rejection', schemaRejection(1)],
  ['other compositor reason', schemaRejection(2, 'Appearance descriptor is not sealed')],
]) {
  test('startup fails without a compatibility retry on ' + name, t => {
    const f = fixture(t, { failure: () => failure });
    assert.throws(() => f.shell.start(), error => error === failure);
    assert.equal(f.attempts.length, 1);
    assert.equal(f.backend.committed, null);
    assert.equal(f.shell.getState().running, false);
    assert.equal(f.shell.getSurfaces().length, 0);
    assert.ok(f.created.every(surface => surface.closed));
    assert.equal(f.saves.length, 0);
  });
}

test('generic startup rejection also fails without retrying a different appearance', t => {
  const genericFailure = new Error('Appearance preparation failed: generic rejected');
  const f = fixture(t, { initialTheme: 'server2003', failure: () => genericFailure });
  assert.throws(() => f.shell.start(), error => error === genericFailure);
  assert.deepEqual(f.attempts.map(item => item.words[0]), [1]);
  assert.equal(f.shell.getState().running, false);
  assert.equal(f.backend.committed, null);
  assert.ok(f.created.every(surface => surface.closed));
  assert.equal(f.saves.length, 0);
});
