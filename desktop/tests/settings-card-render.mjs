import { render } from './gui/sdk/js/reconciler.mjs';
import { settingsCard } from './desktop/shared/ui/presentation.mjs';
import { button } from './desktop/shared/ui/button.mjs';
import { getDesktopTheme, BUILTIN_THEME_CATALOG } from './desktop/shared/ui/themes.mjs';
import { panelAppearance } from './desktop/shared/ui/panel-appearance.mjs';
import { createSettingsApp } from './desktop/apps/settings/app.mjs';
import { createMaterialSource } from './desktop/shell/material-source.mjs';
import { parseMaterialSource, runtimeBuild } from './desktop/client/settings-contract.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
export function checkSettingsCardAdoption() {
  let calls = 0;
  const results = [];
  for (const id of ['server2003', 'modern']) {
    const theme = getDesktopTheme(id);
    render(settingsCard(theme, 'Card title', 'Original subtitle', [
      button('card-action', 'Original action', theme, () => calls++)], 'card-root'), document.body);
    host.render();
    const card = document.getElementById('card-root'), expected = panelAppearance(theme, 'card');
    check(Number(card.style.padding) === expected.padding && Number(card.style.gap) === expected.gap &&
      Number(card.style.borderWidth) === expected.borderWidth && Number(card.style.borderRadius) === expected.borderRadius,
      'Shared card shape and spacing come from the frozen panel projection');
    const r = card.getBoundingClientRect(), x = Math.floor(r.x + r.width / 2), y = Math.floor(r.y + r.height / 2);
    const edges = [host.pixel(x, r.y), host.pixel(x, r.bottom - 1), host.pixel(r.x, y), host.pixel(r.right - 1, y)];
    if (id === 'server2003') check(edges.join(':') === '#808080:#FFFFFF:#808080:#FFFFFF',
      'Actual card bevel alone owns all four outside edges');
    document.getElementById('card-action').focus();
    host.key(' ', 'keydown', { text: false }); host.render();
    check(calls === results.length + 1 && card.textContent.includes('Card title') && card.textContent.includes('Original subtitle'),
      'Passive panel decoration preserves the original children and one action');
    results.push({ id, padding: expected.padding, borderWidth: expected.borderWidth,
      radius: expected.borderRadius, edges, card: [r.x, r.y, r.width, r.height] });
  }

  document.activeElement?.blur(); render(null, document.body);
  console.log('SETTINGS_CARD_ADOPTION ' + JSON.stringify({ results, calls }));
}

export async function checkSettingsMaterialAdoption() {
  const intervals = globalThis.setInterval, clear = globalThis.clearInterval;
  const clocks = new Set(), observers = new Set(), reports = [];
  globalThis.setInterval = (callback, ms) => { const clock = { callback, ms }; clocks.add(clock); return clock; };
  globalThis.clearInterval = clock => { if (!clocks.delete(clock)) clear(clock); };
  const fixture = document.createElement('canvas'); fixture.width = 160; fixture.height = 96;
  const ink = fixture.getContext('2d');
  ink.fillStyle = '#ff0000'; ink.fillRect(0, 0, 80, 96); ink.fillStyle = '#0000ff'; ink.fillRect(80, 0, 80, 96);
  const blob = await new Promise(resolve => fixture.toBlob(resolve));
  const bitmap = createBitmap(await blob.arrayBuffer(), 160 * 96);
  let encodes = 0, reads = 0, sourceFailure = null;
  const projection = createMaterialSource({ document: () => document, bitmap: () => { encodes++; return bitmap; } });
  const modern = getDesktopTheme('modern');
  const theme = { ...modern, desktop: { ...modern.desktop, asset: 'original-fixture.png' } };
  const catalog = { ...BUILTIN_THEME_CATALOG, themes: BUILTIN_THEME_CATALOG.themes.map(value => value.id === theme.id ? theme : value) };
  let appearance = { version: 1, revision: 1, catalogRevision: 1, themeId: theme.id, catalog,
    themeFilesEnabled: true, themeFilesAvailable: true, status: '', error: '', build: runtimeBuild() };
  const display = { version: 1, available: true, error: '', status: '', serial: 1, pendingToken: 0, remainingMs: 0,
    outcome: 0, message: '', heads: [{ id: 1, name: 'Fixture', make: '', model: '', serialNumber: '',
      description: '', enabled: true, width: 1920, height: 1080, refresh: 60000, x: 0, y: 0,
      scale: 1, transform: 0, adaptiveSync: false, modes: [] }] };
  const state = { width: host.width, height: host.height, scale: 1, active: true };
  const surface = { document, state, closed: false, observeState(callback) {
    observers.add(callback); return () => observers.delete(callback);
  }, close() { this.closed = true; } };
  const client = { async call(member) {
    if (member === 'GetAppearance') return JSON.stringify(appearance);
    if (member === 'GetDisplays') return JSON.stringify(display);
    if (member === 'DetachPage') return;
    throw new Error('Unexpected Settings fixture method: ' + member);
  }, async getMaterialSource(snapshot) {
    reads++;
    if (sourceFailure) throw sourceFailure;
    return parseMaterialSource(JSON.stringify({ ...projection.read({ themeId: theme.id,
      revision: snapshot.revision, asset: bitmap.key }), generation: 1 }));
  }, close() {} };
  const settle = async () => {
    for (let i = 0; i < 8; i++) { await new Promise(resolve => setTimeout(resolve, 0)); host.render(); }
  };
  let app;
  try {
    app = createSettingsApp({ client, host: { create: () => surface, close() {} }, page: 'displays',
      report: error => reports.push(String(error)), optInMaterial: true }).start();
    await settle();
    const base = document.getElementById('settings-material-base'), root = document.getElementById('shell-system-settings');
    check(app.getMaterialState().ready && base === document.body.firstChild && root.style.backgroundColor === 'transparent',
      'The real production Settings app uses a bottommost ready opaque material, not just a sample helper');
    check(base.getAttribute('aria-hidden') === 'true' && base.style.pointerEvents === 'none',
      'Material cannot intercept Settings focus or input');
    const context = base.getContext('2d'), w = base.width, h = base.height;
    const left = [...context.getImageData(Math.floor(w / 8), Math.floor(h / 2), 1, 1).data];
    const right = [...context.getImageData(Math.floor(w * 7 / 8), Math.floor(h / 2), 1, 1).data];
    check(left[0] > right[0] + 15 && right[2] > left[2] + 15 &&
      [...context.getImageData(0, 0, w, h).data].every((v, i) => i % 4 !== 3 || v === 255),
    'Settings base contains the real committed bitmap colors and every pixel is opaque');
    const rightColor = '#' + right.slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('');
    check(host.pixel(host.width - 8, 8).toLowerCase() === rightColor,
      'Actual Settings composed output exposes the bitmap-derived underlay in the blank client header');
    const field = document.getElementById('shell-output-1-width'), slot = document.getElementById('settings-display-slot');
    field.focus(); host.key('a', 'keydown', { ctrlKey: true, text: false }); host.text('2560');
    host.key('Home', 'keydown', { text: false }); host.key('ArrowRight', 'keydown', { shiftKey: true, text: false });
    await settle();
    const before = field.textContent, pixels = node => {
      const r = node.getBoundingClientRect(), values = [];
      for (let y = Math.ceil(r.y); y < Math.floor(r.bottom); y++)
        for (let x = Math.ceil(r.x); x < Math.floor(r.right); x++) values.push(host.pixel(x, y));
      return JSON.stringify(values);
    };
    check(before.includes('2560') && document.activeElement === field, 'Actual retained Settings input edits through its original engine');
    const foreground = pixels(field), stats = JSON.stringify(app.getMaterialState().stats);
    for (let i = 0; i < 4; ++i) { await app.controller.refresh(); host.render(); }
    check(JSON.stringify(app.getMaterialState().stats) === stats && reads === 1 && encodes === 1,
      'Unchanged existing refresh/clock work does not read, decode, encode, blur or composite again');
    state.active = false; for (const listener of observers) listener(state); await settle();
    check(app.getMaterialState().stats.blurs === JSON.parse(stats).blurs &&
      app.getMaterialState().stats.composites === JSON.parse(stats).composites + 1,
    'Owner activation only recomposites the cached blur');
    check(document.getElementById(field.id) === field && document.getElementById(slot.id) === slot &&
      document.activeElement === field && field.textContent === before && pixels(field) === foreground,
    'Foreground input/selection/caret pixels, value, focus and right-content mount remain exactly unchanged');
    appearance = { ...appearance, revision: 2, catalog: { ...catalog, themes: catalog.themes.map(value =>
      value.id === theme.id ? { ...theme, window: { ...theme.window, clientMaterial: 'solid' } } : value) } };
    await app.controller.refresh(); await settle();
    check(!document.getElementById('settings-material-base') && root.style.backgroundColor === theme.colors.body &&
      document.getElementById(field.id) === field && field.textContent === before && document.activeElement === field,
    'Explicit solid override restores original Settings fill without replacing input or window');
    check(reports.length === 0, 'No Settings/material errors were hidden');
    const version = document.getElementById('settings-system-version'), footer = version.parentNode;
    const status = document.getElementById('settings-material-status');
    const versionText = version.textContent, footerPixels = pixels(footer);
    check(status.style.display === 'none' && status.parentNode === root, 'Opt-in status row is retained in normal layout while hidden');
    sourceFailure = new Error('Fixture material source failure. The original Settings version remains visible.');
    display.error = 'Existing display service error';
    appearance = { ...appearance, revision: 3, catalog };
    await app.controller.refresh(); await app.pages.refresh(); await settle();
    const statusBox = status.getBoundingClientRect(), footerBox = footer.getBoundingClientRect();
    const versionBox = version.getBoundingClientRect();
    check(document.getElementById('settings-system-version') === version && version.parentNode === footer &&
      document.getElementById('settings-material-status') === status && root.childNodes[1] === status &&
      root.childNodes[2] === footer && statusBox.height > 0 && statusBox.bottom <= footerBox.y &&
      footerBox.bottom <= host.height && versionBox.y >= footerBox.y && versionBox.height > 0 &&
      versionBox.bottom <= host.height && version.textContent === versionText && pixels(footer) === footerPixels,
    'Actual failed-material row stays above the same visible version/footer with no overlap or lost footer pixels');
    check(Number(status.firstChild.style.fontSize) === theme.layout.statusFontSize &&
      status.textContent.includes(sourceFailure.message) && document.body.textContent.includes(display.error) &&
      app.pages.getState().snapshot.error === display.error && reports.length === 1,
    'Error text uses the theme status font and never replaces the independent display service error');
    const failedReads = reads;
    for (let i = 0; i < 3; i++) { await app.controller.refresh(); host.render(); }
    check(reads === failedReads && reports.length === 1, 'Failed source is not retried by existing refreshes');
    appearance = { ...appearance, revision: 4, catalog: { ...catalog, themes: catalog.themes.map(value =>
      value.id === theme.id ? { ...theme, window: { ...theme.window, clientMaterial: 'solid' } } : value) } };
    await app.controller.refresh(); await settle();
    check(status.style.display === 'none' && status.textContent === '' &&
      document.getElementById('settings-system-version') === version && pixels(footer) === footerPixels,
    'Solid recovery hides and clears the same status row without replacing or covering the permanent footer');
    console.log('SETTINGS_MATERIAL_ADOPTION ' + JSON.stringify({ left, right, reads, encodes, idle: JSON.parse(stats),
      input: before, foregroundPixelIdentical: true, errorBox: [statusBox.y, statusBox.bottom],
      footerBox: [footerBox.y, footerBox.bottom], sameFooterPixels: true, failedSourceRetries: reads - failedReads,
      nativeScale: 1, scope: 'Actual GUI and production app; controlled scalar service/owner, not live Linux RPC' }));
  } finally {
    app?.stop(); projection.close(); bitmap.close(); fixture.width = fixture.height = 0;
    render(null, document.body); globalThis.setInterval = intervals; globalThis.clearInterval = clear;
  }
  check(observers.size === 0 && clocks.size === 0, 'Settings stop releases its material observer and existing clocks');
}
