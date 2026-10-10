import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import { test } from 'node:test';

register('../../../tests/menu-host-loader.mjs', import.meta.url);
const { createTargetApp } = await import('../target-app.mjs');
const { createNativeTargetProvider } = await import('../logic/native-provider.mjs');
const { makeFixtureEnvelope, createFixtureProvider } = await import('./fixtures.mjs');

// The real reconciler is exercised against a bounded DOM/window mock, not SDL,
// compositor input, a physical screen or a trusted native enumerator.
class Node {
  constructor(ownerDocument, type) {
    Object.assign(this, { ownerDocument, type, childNodes: [], parentNode: null, style: {},
      attributes: new Map(), listeners: new Map(), id: '', tabIndex: -1,
      scrollTop: 0, offsetTop: 0, offsetHeight: 800, value: '' });
  }
  get textContent() { return this.type === '#text' ? this.value : this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.value = String(value); this.childNodes = []; }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node);
    const adopt = child => { child.ownerDocument = this.ownerDocument; child.childNodes.forEach(adopt); };
    adopt(node);
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    assert.ok(index >= 0);
    this.childNodes.splice(index, 0, node); node.parentNode = this; return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node); assert.ok(index >= 0);
    this.childNodes.splice(index, 1); node.parentNode = null; return node;
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) ?? []; listeners.push(callback); this.listeners.set(type, listeners);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== callback));
  }
}
const descendants = node => [node, ...node.childNodes.flatMap(descendants)];
function document() {
  const doc = {
    createElement: type => new Node(doc, type),
    createTextNode: value => Object.assign(new Node(doc, '#text'), { value: String(value) }),
    getElementById: id => descendants(doc.body).find(node => node.id === id) ?? null,
  };
  doc.body = doc.createElement('view'); return doc;
}
function event(type, extra = {}) {
  return { type, button: 0, key: '', preventDefault() {}, stopPropagation() {}, ...extra };
}
async function deliver(node, type = 'click', extra = {}) {
  assert.ok(node, 'Expected a rendered node');
  let result;
  for (const callback of [...(node.listeners.get(type) ?? [])])
    result = await callback(event(type, { currentTarget: node, target: node, ...extra }));
  return result;
}
async function settled() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function fixture(t, options = {}) {
  const previous = globalThis.document;
  globalThis.document = document();
  const windows = [], errors = [];
  let defaultClosed = 0;
  const host = {
    create(settings) {
      const window = { ...settings, document: document(), closed: false,
        close() { if (!this.closed) { this.closed = true; this.onclose?.(); } } };
      windows.push(window); return window;
    },
    close() { defaultClosed++; },
  };
  const app = createTargetApp({ host, reportError: message => errors.push(message), ...options }).start();
  t.after(() => { app.stop(); globalThis.document = previous; });
  const doc = app.getWindow().document;
  return { app, host, errors, windows, doc, find: id => doc.getElementById(id),
    defaultClosed: () => defaultClosed, text: () => doc.body.textContent };
}

test('default ordinary native view is honest, readonly and never auto-enumerates', async t => {
  const f = fixture(t);
  assert.equal(f.windows.length, 1);
  assert.equal(f.defaultClosed(), 1);
  assert.equal(f.windows[0].layer, undefined);
  assert.equal(f.windows[0].inputPopup, undefined);
  assert.equal(f.app.controller.getState().phase, 'unavailable');
  assert.match(f.text(), /Native helper integration pending/);
  assert.match(f.text(), /No host devices were enumerated/);
  assert.match(f.text(), /writeAuthorized=false/);
  assert.match(f.text(), /public Live root password grants NO target-write permission/);
  assert.match(f.text(), /destroy the partition table and all existing disk data/);
  assert.equal(f.find('installer-refresh').getAttribute('aria-disabled'), 'true');
  assert.equal(f.find('installer-refresh').tabIndex, -1);
  assert.equal(f.find('installer-confirm'), null);
  await deliver(f.find('installer-refresh'), 'keydown', { key: 'Enter' });
  assert.equal(f.app.controller.getState().phase, 'unavailable');
  assert.deepEqual(f.errors, []);
});

test('mock reports render excluded entries/reasons, identity/source/capacity/scope without preselection', async t => {
  const f = fixture(t, { provider: createFixtureProvider(), synthetic: true });
  await settled();
  assert.equal(f.app.controller.getState().phase, 'ready');
  assert.equal(f.app.controller.getState().selection, null);
  assert.match(f.text(), /SYNTHETIC MOCK SNAPSHOTS ONLY/);
  assert.match(f.text(), /WD_BLACK SN770 2TB/);
  assert.match(f.text(), /Samsung SSD 990 PRO 4TB/);
  assert.match(f.text(), /SanDisk SDSSDXPS480G/);
  assert.match(f.text(), /active-root/);
  assert.match(f.text(), /active-boot/);
  assert.match(f.text(), /active-source/);
  assert.match(f.text(), /protected-model/);
  assert.match(f.text(), /FIXTURE-USB-001/);
  assert.match(f.text(), /1234567890abcdef/);
  assert.match(f.text(), /bytes \[0, 17179869184\)/);
  assert.match(f.text(), /\/dev\/sdb1/);
  assert.match(f.text(), /start512=2048/);
  assert.match(f.find('installer-downloaded-bytes').textContent, /1073741824 bytes/);
  assert.match(f.find('installer-memory-bytes').textContent, /1790967808 bytes.*not physical target capacity/);
  assert.match(f.find('installer-source-mapping').textContent, /Exact source mapping: true.*259:1.*pending/);
  assert.equal(f.find('installer-target-0-select').getAttribute('aria-disabled'), 'true');
  assert.equal(f.find('installer-target-2-select').getAttribute('aria-disabled'), 'false');
  assert.equal(f.find('installer-confirm'), null);
});

test('disabled target clicks/keyboard do nothing; eligible selection and acknowledgement work by keyboard', async t => {
  const f = fixture(t, { provider: createFixtureProvider() }); await settled();
  const before = f.app.controller.getState();
  await deliver(f.find('installer-target-0-select'));
  await deliver(f.find('installer-target-0-select'), 'keydown', { key: ' ' });
  assert.equal(f.app.controller.getState(), before);
  await deliver(f.find('installer-target-2-select'), 'keydown', { key: 'Enter' });
  assert.equal(f.app.controller.getState().phase, 'selected');
  assert.equal(f.find('installer-confirm').getAttribute('aria-disabled'), 'true');
  await deliver(f.find('installer-confirm'));
  assert.equal(f.app.controller.getState().phase, 'selected');
  await deliver(f.find('installer-acknowledge'), 'keydown', { key: ' ' });
  assert.equal(f.find('installer-acknowledge').getAttribute('aria-pressed'), 'true');
  assert.equal(f.find('installer-confirm').getAttribute('aria-disabled'), 'false');
  await deliver(f.find('installer-confirm'), 'keydown', { key: 'Enter' });
  assert.equal(f.app.controller.getState().phase, 'confirmed');
  assert.match(f.find('installer-confirmation-record').textContent, /UI-only confirmation.*writeAuthorized=false.*no authorization token/);
  await deliver(f.find('installer-onward'));
  assert.equal(f.app.controller.getState().phase, 'blocked');
  assert.equal(f.find('installer-confirmation-record'), null);
  assert.match(f.text(), /no writer, real user\/disk authorization/);
  assert.doesNotMatch(f.text(), /Installation succeeded|100%/);
});

test('retained callbacks cannot select/confirm replacement content after async refresh', async t => {
  const f = fixture(t, { provider: createFixtureProvider() }); await settled();
  const oldSelect = f.find('installer-target-2-select').listeners.get('click')[0];
  await deliver(f.find('installer-target-2-select'));
  await deliver(f.find('installer-acknowledge'));
  const oldConfirm = f.find('installer-confirm').listeners.get('click')[0];
  const oldAck = f.find('installer-acknowledge').listeners.get('click')[0];
  await deliver(f.find('installer-refresh'));
  await deliver(f.find('installer-target-2-select'));
  const current = f.app.controller.getState();
  assert.equal(oldSelect(event('click')).status, 'stale');
  assert.equal(oldAck(event('click')).status, 'stale');
  assert.equal((await oldConfirm(event('click'))).status, 'stale');
  assert.equal(f.app.controller.getState(), current);
  assert.equal(current.scopeAcknowledged, false);
  assert.equal(f.find('installer-confirm').getAttribute('aria-disabled'), 'true');
});

test('Escape/cancel/retry discard scope and cannot look like installation success', async t => {
  const f = fixture(t, { provider: createFixtureProvider() }); await settled();
  await deliver(f.find('installer-target-2-select'));
  await deliver(f.find('installer-acknowledge'));
  await deliver(f.find('installer-root'), 'keydown', { key: 'Escape' });
  assert.equal(f.app.controller.getState().phase, 'cancelled');
  assert.match(f.text(), /Cancelled.*Nothing was written/);
  assert.equal(f.find('installer-confirm'), null);
  assert.equal(f.find('installer-target-2-select').getAttribute('aria-disabled'), 'true');
  await deliver(f.find('installer-refresh'));
  assert.equal(f.app.controller.getState().phase, 'ready');
  assert.equal(f.app.controller.getState().selection, null);
});

test('unknown source bytes/storage remain unknown and block all target-selection controls', async t => {
  const input = makeFixtureEnvelope();
  input.source = { ...input.source, kind: 'unknown', description: 'Unresolved loop/overlay source',
    exactSourceMapping: false, kernelBasis: [], downloadedBytes: null, memoryLogicalBytes: null,
    reasons: [{ code: 'source-unresolved', message: 'Kernel source ancestry is not established' }] };
  const f = fixture(t, { provider: { readReport: async () => input } }); await settled();
  assert.equal(f.app.controller.getState().phase, 'ready');
  assert.match(f.text(), /source-unresolved.*Kernel source ancestry/);
  assert.match(f.find('installer-downloaded-bytes').textContent, /Unknown \(not zero\)/);
  assert.match(f.find('installer-memory-bytes').textContent, /Unknown \(not zero\)/);
  assert.match(f.text(), /Source storage is unknown\/unmapped/);
  assert.equal(f.find('installer-target-2-select').getAttribute('aria-disabled'), 'true');
  await deliver(f.find('installer-target-2-select'));
  assert.equal(f.app.controller.getState().selection, null);
});

test('null/ineligible entries and reason details render without replacement defaults', async t => {
  const input = makeFixtureEnvelope();
  const unknown = input.report.devices[4];
  unknown.model = unknown.identity.model = null;
  unknown.capacityBytes = unknown.identity.capacityBytes = unknown.clearingScope.endByteExclusive = null;
  unknown.identity.serial = unknown.identity.wwn = null; unknown.observation.kernel = null;
  unknown.reasons = [{ code: 'missing-stable-id', message: 'Obtain a real stable ID', detail: { missing: ['serial', 'wwn'] } }];
  const f = fixture(t, { provider: { readReport: async () => input } }); await settled();
  assert.match(f.find('installer-target-4-model').textContent, /Unknown model.*Unknown \(not zero\)/);
  assert.match(f.find('installer-target-4-identity').textContent, /Serial: Missing.*WWN: Missing/);
  assert.match(f.find('installer-target-4-reason-0').textContent, /missing-stable-id.*Evidence:.*serial.*wwn/);
  assert.equal(f.find('installer-target-4-select').getAttribute('aria-disabled'), 'true');
});

test('report failure is visible/logged, old inventory stale/disabled, retry explicitly resets selection', async t => {
  let calls = 0;
  const f = fixture(t, { provider: { readReport: async () => {
    if (++calls === 2) throw new Error('Fixture native report transport failed');
    return makeFixtureEnvelope('fixture-' + calls);
  } } });
  await settled(); await deliver(f.find('installer-target-2-select'));
  await deliver(f.find('installer-acknowledge')); await deliver(f.find('installer-confirm'));
  assert.equal(f.app.controller.getState().phase, 'error');
  assert.match(f.text(), /Fixture native report transport failed/);
  assert.equal(f.errors.length, 1);
  assert.equal(f.find('installer-target-2-select').getAttribute('aria-disabled'), 'true');
  assert.equal(f.find('installer-confirm'), null);
  await deliver(f.find('installer-refresh'));
  assert.equal(f.app.controller.getState().phase, 'ready');
  assert.equal(f.app.controller.getState().confirmation, null);
});

test('fresh report changing diskseq invalidates UI consent, with new reasons and no active confirm button', async t => {
  let calls = 0;
  const f = fixture(t, { provider: { readReport: async () => {
    const value = makeFixtureEnvelope('fixture-' + ++calls);
    if (calls > 1) value.report.devices[2].observation.kernel.diskseq++;
    return value;
  } } }); await settled();
  await deliver(f.find('installer-target-2-select')); await deliver(f.find('installer-acknowledge'));
  await deliver(f.find('installer-confirm'));
  assert.equal(f.app.controller.getState().phase, 'invalidated');
  assert.match(f.text(), /observation-changed.*diskseq/);
  assert.equal(f.find('installer-confirm'), null);
  assert.equal(f.app.controller.getState().writeAuthorized, false);
});

test('close during pending native/mock acquisition cancels state/listeners without late repaint', async t => {
  let complete, unsubscribed = 0;
  const pending = new Promise(resolve => { complete = resolve; });
  const f = fixture(t, { provider: { readReport: () => pending,
    subscribeInvalidation() { return () => { unsubscribed++; }; } } });
  await settled();
  assert.equal(f.app.controller.getState().phase, 'loading');
  const before = f.text();
  f.windows[0].close();
  assert.equal(f.app.controller.getState().phase, 'disposed');
  assert.equal(unsubscribed, 1);
  complete(makeFixtureEnvelope()); await settled();
  assert.equal(f.text(), before);
  assert.equal(f.app.getWindow(), null);
  f.app.stop(); assert.equal(unsubscribed, 1);
  assert.throws(() => f.app.start(), /cannot restart/);
});

test('theme cues are opt-in readonly, use real schema colors and unsubscribe on close', async t => {
  const catalog = JSON.parse(await readFile(new URL('../../../resources/themes/builtin.json', import.meta.url), 'utf8'));
  const theme = catalog.themes[0];
  let revision = 1, started = 0, stopped = 0, previousCalls = 0;
  const previous = () => { previousCalls++; };
  const native = {
    onDesktopThemeChanged: previous,
    desktopThemeState: () => ({ available: false, ready: true, revision, error: '',
      document: JSON.stringify({ schemaVersion: 1, theme }) }),
    startThemeSubscription() { started++; },
    stopThemeSubscription() { stopped++; },
    configureAppearance: assert.fail, readThemeFiles: assert.fail, spawnApplication: assert.fail,
  };
  const f = fixture(t, { native, optInTheme: true });
  assert.equal(started, 1);
  assert.deepEqual(f.errors, []);
  assert.equal(f.find('installer-root').style.backgroundColor, theme.colors.body);
  assert.equal(f.find('installer-title').style.color, theme.colors.text);
  theme.colors.text = '#123456'; revision++;
  native.onDesktopThemeChanged();
  assert.equal(f.find('installer-title').style.color, '#123456');
  assert.equal(previousCalls, 1);
  f.app.stop();
  assert.equal(stopped, 1);
  assert.equal(native.onDesktopThemeChanged, previous);
});

test('theme failure is visible and logged, not authority escalation or fake report success', t => {
  const f = fixture(t, { native: null, optInTheme: true });
  assert.equal(f.errors.length, 1);
  assert.match(f.text(), /Theme subscription error.*native --desktop API/);
  assert.equal(f.app.controller.getState().phase, 'unavailable');
  assert.equal(f.app.controller.getState().envelope, null);
  assert.equal(f.app.controller.getState().writeAuthorized, false);
});

test('explicit fixed provider drives the ordinary app view and stops on window close', async t => {
  let reads = 0, cancels = 0;
  const native = { installTargets: { protocolVersion: 1, transport: 'fixed-unprivileged-v1',
    readReport(...args) {
      assert.deepEqual(args, []); return Promise.resolve(makeFixtureEnvelope('native-shaped-' + ++reads));
    },
    cancel() { cancels++; },
  } };
  const provider = createNativeTargetProvider(native);
  const f = fixture(t, { provider, native }); await settled();
  assert.equal(reads, 1);
  assert.equal(f.app.controller.getState().phase, 'ready');
  assert.equal(f.app.controller.getState().selection, null);
  assert.match(f.text(), /FIXTURE-USB-001/);
  f.windows[0].close();
  await assert.rejects(provider.readReport({ purpose: 'refresh', requestId: 2,
    previousGeneration: null }), /stopped/);
  assert.equal(cancels, 0);
});

test('opted-in missing backend API error remains visible in the ordinary view', async t => {
  let error;
  try { createNativeTargetProvider(null); }
  catch (caught) { error = caught; }
  const f = fixture(t, { provider: { readReport: async () => { throw error; } } });
  await settled();
  assert.equal(f.app.controller.getState().phase, 'error');
  assert.match(f.text(), /Fixed native read-only.*missing or incompatible/);
  assert.equal(f.errors.length, 1);
  assert.equal(f.app.controller.getState().envelope, null);
});
