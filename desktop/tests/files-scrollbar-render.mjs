import { createFilesApp } from './desktop/apps/files/app.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { verticalScrollMetrics } from './gui/sdk/js/scrollbar.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const settle = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); host.render(); } };
const rect = node => {
  const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
};
const mouse = (type, x, y, extra = {}) => host.mouse(type, x, y, extra);
const click = (x, y) => { mouse('mousedown', x, y); mouse('mouseup', x, y); mouse('click', x, y); };
function crop(node) {
  const [x, y, width, height] = rect(node), result = [];
  for (let py = y; py < y + height; py++)
    for (let px = x; px < x + width; px++) result.push(host.pixel(px, py));
  return result;
}
async function proveSizeInk(row, track) {
  const cell = row.childNodes[3], text = cell.firstChild;
  const [x, y, width, height] = rect(text), trackBox = rect(track);
  check(cell.textContent.includes('KiB') && x + width <= trackBox[0], 'The real long Size text crop ends before the overlay footprint');
  const shown = crop(text);
  track.style.opacity = '0'; await settle();
  check(JSON.stringify(crop(text)) === JSON.stringify(shown), 'Showing the themed rail changes zero pixels of actual Size text');
  const reference = document.createElement('view');
  reference.setAttribute('aria-hidden', 'true');
  Object.assign(reference.style, { position: 'absolute', left: x, top: y, width, height,
    fontFamily: cell.style.fontFamily, fontSize: cell.style.fontSize, color: cell.style.color,
    backgroundColor: row.style.backgroundColor, pointerEvents: 'none' });
  reference.appendChild(document.createTextNode(cell.textContent));
  document.body.appendChild(reference); await settle();
  check(JSON.stringify(crop(text)) === JSON.stringify(shown),
    'Actual Size glyph pixels match an unclipped full-string native DOM reference, without masks or font tolerance');
  document.body.removeChild(reference); track.style.opacity = '1'; await settle();
  return { caption: cell.textContent, crop: [x, y, width, height], changedPixelsWhenShown: 0, fullStringReferenceExact: true };
}
export async function checkFilesScrollbars(directory, verify = true) {
  let theme = getDesktopTheme('server2003'), revision = 1, subscriptions = 0, tick;
  const entry = index => ({ path: '/fixture/row-' + String(index).padStart(3, '0') + '.txt', type: 'file',
    name: 'row-' + String(index).padStart(3, '0') + '.txt', identity: 'row:' + index,
    bytes: 12345, mtimeMs: 1700000000000, permissions: '0600', uid: 1000, gid: 1000, readable: true, writable: true });
  const records = Array.from({ length: 128 }, (_, index) => entry(index));
  const files = { version: 1, implementation: 'desktop-files-v1', overwrite: true, textObservation: 'sha256-v1',
    maxEntries: 1024, maxTextBytes: 1048576,
    locations: () => ({ home: '/fixture', documents: '/fixture', downloads: '/fixture', desktop: '/fixture' }),
    listDirectory: path => ({ version: 1, path, identity: '/fixture:1', entries: records, complete: true }),
    stat: path => records.find(item => item.path === path) || { ...entry(0), path, name: 'fixture', type: 'directory', identity: '/fixture:1' },
    createDirectory() { throw new Error('Unexpected write'); }, rename() { throw new Error('Unexpected rename'); },
    readText() { throw new Error('Unexpected read'); }, observeText() { throw new Error('Unexpected read'); },
    writeText() { throw new Error('Unexpected write'); }, replaceText() { throw new Error('Unexpected write'); } };
  const native = { fileSystem: files, startThemeSubscription() { subscriptions++; }, stopThemeSubscription() {},
    desktopThemeState: () => ({ available: true, ready: true, revision,
      document: JSON.stringify({ schemaVersion: 1, theme }) }) };
  const surface = { document, closed: false, close() { this.closed = true; this.onclose?.(); } };
  const interval = globalThis.setInterval, clear = globalThis.clearInterval, token = {};
  globalThis.setInterval = (callback, ms) => {
    check(ms === 100 && !tick, 'Only the existing single Files layout clock is controlled');
    tick = callback; return token;
  };
  globalThis.clearInterval = value => { if (value !== token) clear(value); };
  const app = createFilesApp({ host: { create: () => surface, close() {} }, native,
    reportError: message => { throw new Error(message); } });
  const node = name => document.getElementById('files-' + name);
  const update = async id => { theme = getDesktopTheme(id); revision++; native.onDesktopThemeChanged(); await settle(); tick(); await settle(); };
  const metrics = () => {
    const arrow = node('scrollbar').querySelector('.scrollbar-decrement');
    const inset = arrow ? arrow.offsetHeight : 0;
    return verticalScrollMetrics(node('list'), node('scrollbar').offsetHeight, { startInset: inset, endInset: inset });
  };
  const samples = [];
  let retainedPaint = null;
  try {
    app.start(); await settle();
    for (const id of ['server2003', 'xp', 'modern', 'aqua']) {
      await update(id);
      const track = node('scrollbar'), thumb = node('scroll-thumb'), list = node('list');
      const rows = list.childNodes.filter(child => child.getAttribute('role') === 'option');
      const boxes = { track: rect(track), list: rect(list), firstRow: rect(rows[0]),
        columns: rows[0].childNodes.map(rect) };
      check(rows.length === 128 && boxes.firstRow[3] === 42, 'Real Files rows retain their original continuous 42px geometry');
      check(Number(thumb.style.height) >= 28 && track.getAttribute('aria-disabled') === 'false',
        'Actual Files scrollbar follows real overflowing content');
      if (verify) check(track.querySelector('.scrollbar-track-detail'), 'Real Files binds the sole desktop scrollbar adapter');
      document.activeElement?.blur(); await settle();
      check(host.save(directory + '\\' + id + '-rest.png'), 'Save whole actual Files resting frame');
      const sizeInk = verify ? await proveSizeInk(rows[0], track) : null;
      const [x, y, width, height] = boxes.track, cx = x + width / 2;
      track.focus(); host.key('Home', 'keydown', { text: false }); await settle();
      if (verify) {
        const arrow = track.querySelector('.scrollbar-increment');
        if (arrow) {
          const [ax, ay, aw, ah] = rect(arrow);
          click(ax + aw / 2, ay + ah / 2); await settle();
          check(list.scrollTop === 42 && !track.hasMouseCapture(), 'Real themed Files arrow uses the existing one-row step');
          host.key('Home', 'keydown', { text: false }); await settle();
        }
      }
      const m = metrics();
      const endArrow = track.querySelector('.scrollbar-increment');
      click(cx, y + height - (endArrow ? endArrow.offsetHeight : 0) - 2); await settle();
      check(list.scrollTop === list.offsetHeight, 'Real Files page region stops before the measured end-arrow lane');
      host.key('Home', 'keydown', { text: false }); await settle();
      host.scroll(cx, y + m.top + 5, 96); await settle();
      check(list.scrollTop === 96 && Number(track.getAttribute('aria-valuenow')) === 96,
        'Real Files track wheel uses the common viewport and immediately synchronizes its value');
      host.key('Home', 'keydown', { text: false }); await settle();
      const [lx, ly, lw, lh] = rect(list);
      host.scroll(lx + lw / 2, ly + lh / 2, 120); await settle(); tick(); await settle();
      check(list.scrollTop === 120 && Number(track.getAttribute('aria-valuenow')) === 120,
        'Existing Files list wheel is observed by the same scrollbar through its existing update clock');
      track.focus(); host.key('Home', 'keydown', { text: false }); await settle();
      mouse('mousedown', cx, y + m.top + 5);
      mouse('mousemove', cx, y + m.top + 5, { buttons: 1 });
      mouse('mouseup', cx, y + m.top + 5); await settle();
      check(list.scrollTop === 0, 'Real Files arrow-lane no-motion press/move/release preserves the exact viewport value');
      mouse('mousedown', cx, y + m.top + 5);
      check(track.hasMouseCapture(), 'Real Files native thumb gesture captures only its original track');
      mouse('mousemove', host.width + 30, host.height + 30, { buttons: 1 });
      mouse('mouseup', host.width + 30, host.height + 30); await settle();
      check(list.scrollTop === metrics().maximum && !track.hasMouseCapture(), 'Actual Files outside drag clamps and releases at the real bottom');
      check(Number(track.getAttribute('aria-valuenow')) === Number(list.scrollTop), 'Actual Files accessibility value follows the same viewport');
      host.key('Home', 'keydown', { text: false }); host.key('PageDown', 'keydown', { text: false }); await settle();
      check(list.scrollTop === list.offsetHeight, 'Files page key scrolls one measured viewport, not a copied app geometry');
      host.key('ArrowDown', 'keydown', { text: false }); await settle();
      check(list.scrollTop === list.offsetHeight + 42, 'Files keyboard step remains 42 after theming');
      host.key('Home', 'keydown', { text: false }); await settle();
      mouse('mousedown', cx, y + metrics().top + 5);
      mouse('mousecancel', 0, 0);
      mouse('mousemove', cx, y + height, { buttons: 1 }); mouse('mouseup', cx, y + height); await settle();
      check(list.scrollTop === 0 && !track.hasMouseCapture(), 'Real Files capture cancellation rejects late themed thumb motion');
      const row = rows[0], ink = row.childNodes.slice(1).map(child => child.style.color);
      const next = id === 'modern' ? 'server2003' : 'modern';
      track.focus(); await update(next);
      check(node('scrollbar') === track && node('scroll-thumb') === thumb && document.activeElement === track,
        'Real Files retheme keeps track/thumb DOM and keyboard focus');
      const rethemedList = rect(list);
      check(rect(row)[3] === 42 && rethemedList[0] === boxes.list[0] && rethemedList[2] === boxes.list[2] &&
        row.childNodes.every((child, index) => rect(child)[2] === boxes.columns[index][2]),
        'Scrollbar retheme preserves row height and list/column widths; header height still follows its own theme');
      await update(id);
      app.controller.filter('row-000'); await settle();
      check(track.style.opacity === '0' && track.getAttribute('aria-disabled') === 'true' &&
        Number(list.scrollTop) === 0, 'Actual Files filtering hides a fitted rail and clamps the original viewport');
      app.controller.filter(''); await settle(); tick(); await settle();
      check(track.getAttribute('aria-disabled') === 'false', 'Actual Files clearing the filter restores overflow without a new controller');
      samples.push({ id, boxes, maximum: metrics().maximum, originalMetadataInk: ink, sizeInk });
    }
    if (verify) {
      app.controller.select(records[0].path, records[0].identity); await settle();
      const row = node('entry-0'), track = node('scrollbar'), identity = app.controller.getState().selection.identity;
      track.focus(); host.key('ArrowDown', 'keydown', { text: false }); await settle();
      check(app.controller.getState().selection.identity === identity, 'Scrollbar keys do not replace the selected FileRow business identity');
      await update('modern');
      check(node('entry-0') === row && row.getAttribute('aria-selected') === 'true' && rect(row)[3] === 42 &&
        row.childNodes.slice(1).every(cell => cell.style.color === theme.colors.selectionText),
        'The existing selected-row ink and 42px row survive scrollbar retheme unchanged');
      const thumb = node('scroll-thumb'), b = track.getBoundingClientRect(), x = b.x + b.width / 2;
      const y = b.y + metrics().top + 5;
      mouse('mousemove', x, y); await settle();
      check(thumb.style.backgroundColor === theme.colors.text, 'Real Files thumb has its modern hover surface before retained paint');
      app.controller.sortBy('size'); await settle(); tick(); await settle();
      check(node('scrollbar') === track && node('scroll-thumb') === thumb && document.activeElement === track &&
        thumb.style.backgroundColor === theme.colors.text, 'Same-theme focused App paint does not let VNode fields reset the hover surface to idle');
      mouse('mousedown', x, y); await settle();
      check(track.hasMouseCapture() && thumb.style.backgroundColor === theme.colors.accent, 'Real Files held thumb consumes its held surface');
      app.controller.sortBy('modified'); await settle(); tick(); await settle();
      check(!track.hasMouseCapture() && document.activeElement === track && thumb.style.backgroundColor === theme.colors.text,
        'Same-theme held App paint keeps the original generation-cancel policy and repaints the real hover surface, not stale idle');
      mouse('mouseup', x, y); await settle();
      await app.controller.refresh(); await settle(); tick(); await settle();
      check(node('scrollbar') === track && node('scroll-thumb') === thumb && track.getAttribute('aria-disabled') === 'false',
        'Actual same-theme refresh restores the same themed controller after its original loading guard');
      track.focus(); await settle();
      const ring = track.querySelector('.theme-focus-ring');
      check(ring && Number(ring.style.opacity) === 1, 'Keyboard focus remains visibly available after retained same-theme refresh');
      retainedPaint = { theme: theme.id, hover: theme.colors.text, held: theme.colors.accent,
        sameDOM: true, generationCancelsHeld: true, refreshFocusVisible: true };
    }
    check(subscriptions === 1, 'Scrollbar retheme adds no theme subscription or application timer');
    console.log('FILES_SCROLLBAR_PASS ' + JSON.stringify({ verify, viewport: [host.width, host.height], samples, subscriptions, retainedPaint,
      scope: 'Actual Files factory and native GUI input with bounded memory FS; same controller, row ink/42px/columns unchanged; no host data or OS scrollbar qualification' }));
  } finally { app.stop(); globalThis.setInterval = interval; globalThis.clearInterval = clear; }
}
