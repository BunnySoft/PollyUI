import { h, render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { dockSurfaceWidth } from './desktop/shared/ui/theme-layout.mjs';
import { panelView, dockView } from './desktop/shell/views.mjs';
import { windowTasks } from './desktop/shell/window-groups.mjs';
import { windowGroupMenu } from './desktop/shell/window-group-menu.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const get = id => document.getElementById(id);
const settle = () => { for (let i = 0; i < 4; i++) host.render(); };
const box = node => {
  const { x, y, width, height } = node.getBoundingClientRect();
  return [x, y, width, height];
};
const point = node => {
  let [x, y, width, height] = box(node), right = x + width, bottom = y + height;
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    const [px, py, pw, ph] = box(parent);
    if (parent.style.overflow !== 'scroll' && parent.style.overflow !== 'hidden') continue;
    x = Math.max(x, px); y = Math.max(y, py); right = Math.min(right, px + pw); bottom = Math.min(bottom, py + ph);
  }
  check(right > x && bottom > y, node.id + ' has a visible actual hitbox');
  return [x + (right - x) / 2, y + (bottom - y) / 2];
};
const appId = 'org.pollyui.group-fixture';
const openerId = 'shell-window-app-' + appId;
const documents = count => Array.from({ length: count }, (_, index) => ({
  id: 10 + index, appId, title: 'Actual fixture document ' + (index + 1),
  active: index === 0, minimized: index === 1, workspaceId: 7,
}));
const extras = [
  { id: 100, appId: 'different.application', title: 'Different application', workspaceId: 7 },
  { id: 101, appId: '', title: 'Unknown first', workspaceId: 7 },
  { id: 102, title: 'Unknown second', workspaceId: 7 },
];
const catalog = [{ id: appId, name: 'Fixture application' }];

export function checkWindowGroups(directory) {
  check(host.width === 800 && host.height === 600, '800x600 actual raster host at test scale 1.0');
  let theme = getDesktopTheme('modern'), windows = [...documents(3), ...extras];
  let open = false, epoch = 0, slots = [], clock = '10:31', menuWidth = 380, menuHeight = 360;
  const calls = [], contexts = [], fixed = [], records = [];
  const tasks = () => windowTasks(windows, theme.panel.taskGrouping, catalog);
  const close = focus => { open = false; epoch++; paint(); if (focus) get(openerId)?.focus(); };
  function show(id) {
    const task = tasks().find(item => item.id === id);
    if (!task?.grouped) { contexts.push(id); return; }
    open = !open; epoch++; slots = []; paint();
    if (open) get('shell-group-list').firstChild.firstChild.focus();
  }
  function primary(id) {
    const task = tasks().find(item => item.id === id);
    if (task.grouped && task.count > 1) { show(id); return; }
    const window = task.grouped ? task.windows[0] : task;
    calls.push([theme.panel.kind === 'dock' && task.grouped ? 'activateWindow' :
      window.active && !window.minimized ? 'minimizeWindow' : 'activateWindow', window.id]);
  }
  function paint() {
    const items = tasks(), currentEpoch = epoch, group = items.find(item => item.id === 'app-' + appId);
    const width = dockSurfaceWidth(theme, items.length, host.width);
    render(h('view', { style: { width: '100%', height: '100%', backgroundColor: '#406080' } },
      h('view', { style: { position: 'absolute', top: 8, left: 0,
        width: theme.panel.kind === 'dock' ? width : host.width, height: theme.panel.height } },
        theme.panel.kind === 'dock' ?
          dockView(theme, () => fixed.push('settings'), () => fixed.push('about'), () => fixed.push('apps'),
            items, primary, show) :
          panelView(theme, clock, () => fixed.push('apps'), '', () => fixed.push('settings'), items, primary, show)),
      open && group ? h('view', { id: 'fixture-root-menu', style: {
        position: 'absolute', left: 16, top: 110, width: menuWidth, height: menuHeight },
        onKeydown: event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        } },
        windowGroupMenu(theme, group, { slots, close: () => close(true), action: (id, action) => {
          if (!open || epoch !== currentEpoch || !windows.some(window => window.id === id && window.appId === appId))
            return false;
          calls.push([action, id]); close(false); return true;
        } })) : null), document.body);
  }
  const click = (node, button = 0) => {
    const location = point(node);
    host.mouse('mousemove', ...location); host.mouse('mousedown', ...location, { button });
    host.mouse('mouseup', ...location, { button });
    host.mouse(button === 2 ? 'contextmenu' : 'click', ...location, { button }); settle();
  };
  const key = (name, options = {}) => { host.key(name, 'keydown', { text: false, ...options }); settle(); };
  const save = name => check(host.save(directory + '\\groups-' + name + '.png'), 'Save ' + name);
  const bounded = () => {
    const root = get('fixture-root-menu'), group = get('shell-window-group');
    check(JSON.stringify(box(root)) === JSON.stringify(box(group)), 'Chooser exactly fits its actual input container');
    const [x, y, w, height] = box(get('shell-group-list'));
    const [rx, ry, rw, rh] = box(root);
    check(x >= rx && y >= ry && x + w <= rx + rw && y + height <= ry + rh,
      'Scrollable real rows stay inside RootMenu bounds');
  };

  for (const id of ['modern', 'bigsur']) {
    render(h('view', {}), document.body);
    theme = getDesktopTheme(id); windows = [...documents(3), ...extras]; open = false; paint(); settle();
    const opener = get(openerId), list = get(id === 'modern' ? 'shell-window-list' : 'shell-dock-windows');
    check(list.childNodes.length === 4 && opener.getAttribute('aria-label').includes('3 windows') &&
      opener.getAttribute('aria-pressed') === 'true', id + ' four display tasks expose the real multi-window count/active state');
    if (id === 'bigsur') {
      check(get('shell-dock-viewport').offsetWidth === dockSurfaceWidth(theme, 4, host.width),
        'Native Dock surface width uses four display tasks, not six source windows');
      check(['shell-dock-applications', 'shell-dock-settings', 'shell-dock-about'].every(get),
        'Three original fixed Dock actions remain');
    }
    click(opener); bounded();
    check(open && get('shell-group-activate-11').getAttribute('aria-label').startsWith('[min]'),
      id + ' actual pointer opens actual minimized-member list');
    key('Home'); key('ArrowDown'); key('ArrowRight'); key('ArrowDown');
    check(document.activeElement === get('shell-group-activate-11'), 'Arrows navigate real member commands');
    key('Enter');
    check(!open && JSON.stringify(calls.at(-1)) === '["activateWindow",11]', 'Enter selects the exact minimized window once');
    opener.focus(); key('Enter'); bounded();
    key('End'); key('Tab');
    check(document.activeElement === get('shell-group-activate-10'), 'Tab wraps inside chooser');
    key('Tab', { shiftKey: true });
    check(document.activeElement === get('shell-group-menu-close'), 'Reverse Tab remains bounded');
    key('Escape');
    check(!open && document.activeElement === opener, 'Escape returns focus to its still-live application task');
    click(opener, 2);
    check(open, 'Actual secondary pointer also opens the real group list');
    const retained = get('shell-group-activate-11'), listNode = get('shell-group-list');
    clock = '10:32'; paint(); settle();
    theme = { ...theme, colors: { ...theme.colors, focus: '#804020' } }; paint(); settle();
    check(get(openerId) === opener && get('shell-group-activate-11') === retained && get('shell-group-list') === listNode,
      'Clock-equivalent update and immutable retheme retain real task/row DOM');
    save(id);
    records.push({ theme: id, displayTasks: list.childNodes.length, sourceWindows: windows.length,
      opener: box(opener), menu: box(get('shell-window-group')) });
    click(retained);
    check(JSON.stringify(calls.at(-1)) === '["activateWindow",11]', 'Actual member pointer selects its original ID');

    windows = [documents(1)[0]]; paint(); settle();
    const before = calls.length;
    click(get(openerId));
    check(calls.length === before + 1 && calls.at(-1)[0] === (id === 'modern' ? 'minimizeWindow' : 'activateWindow'),
      id + ' single active window has its documented click behavior');
  }

  render(h('view', {}), document.body);
  theme = getDesktopTheme('modern'); windows = [...documents(20), ...extras]; open = false; paint(); settle();
  click(get(openerId)); key('End'); key('ArrowUp');
  const last = get('shell-group-close-29'), list = get('shell-group-list');
  const [lx, ly, lw, lh] = box(last), [vx, vy, vw, vh] = box(list);
  check(document.activeElement === last && Number(list.scrollTop) > 0 &&
    lx >= vx && ly >= vy && lx + lw <= vx + vw && ly + lh <= vy + vh,
    'End/Up reveals the final real window command with an actual visible hitbox');
  const scroll = list.scrollTop;
  clock = '10:33'; paint(); settle();
  check(list.scrollTop === scroll, 'Clock paint does not reset long-list scroll');
  host.scroll(...point(list), -100000); settle();
  check(Number(list.scrollTop) === 0, 'Reverse actual wheel reaches beginning');
  paint(); settle();
  check(Number(list.scrollTop) === 0, 'Clock paint does not undo a manual scroll away from focus');
  host.scroll(...point(list), 100000); settle();
  check(Number(list.scrollTop) > 0, 'Actual wheel reaches final real window');
  save('long-list');
  records.push({ theme: 'modern-long', menu: box(get('shell-window-group')), last: box(last), scroll: list.scrollTop });
  menuHeight = 180; menuWidth = 260; paint(); settle(); bounded();
  get('shell-group-activate-29').focus(); settle();
  const short = box(get('shell-group-activate-29')), shortList = box(list);
  check(short[1] >= shortList[1] && short[1] + short[3] <= shortList[1] + shortList[3],
    'Short live viewport reveals the focused command, even when a whole member row is taller');
  save('short-list');
  records.push({ theme: 'modern-short', menu: box(get('shell-window-group')),
    last: short, viewport: shortList, scroll: list.scrollTop });
  menuHeight = 360; menuWidth = 380; paint(); settle();
  key('Home');
  let held = get('shell-group-activate-10'), location = point(held), before = calls.length;
  host.mouse('mousemove', ...location); host.mouse('mousedown', ...location); settle();
  windows = windows.filter(window => window.id !== 10).reverse(); paint(); settle();
  check(!get('shell-group-activate-10') && get('shell-group-list').firstChild.tabIndex === -1,
    'Held removed window leaves an inert stable slot');
  host.mouse('mouseup', ...location); host.mouse('click', ...location); settle();
  check(calls.length === before && open, 'Held removed row cannot activate its former neighbor');
  key('Home');
  held = get('shell-group-activate-11'); location = point(held);
  host.mouse('mousemove', ...location); host.mouse('mousedown', ...location); settle();
  windows.reverse(); catalog[0].name = 'Renamed exact catalog entry'; paint(); settle();
  theme = { ...theme, colors: { ...theme.colors, selection: '#204080' } }; paint(); settle();
  check(get('shell-group-activate-11') === held, 'Held surviving row stays bound across reorder/retheme');
  host.mouse('mouseup', ...location); host.mouse('click', ...location); settle();
  check(calls.length === before + 1 && calls.at(-1)[1] === 11, 'Held surviving row releases to original ID once');

  click(get(openerId)); key('Home'); key('ArrowDown');
  held = get('shell-group-minimize-11'); location = point(held); before = calls.length;
  host.mouse('mousemove', ...location); host.mouse('mousedown', ...location); settle();
  windows = windows.map(window => window.id === 11 ? { ...window, minimized: false } : window); paint(); settle();
  host.mouse('mouseup', ...location); host.mouse('click', ...location); settle();
  check(calls.length === before && open, 'Held Restore must not retarget the updated Minimize action');
  key('Escape');
  held = get(openerId); location = point(held);
  host.mouse('mousemove', ...location); host.mouse('mousedown', ...location); settle();
  windows = windows.filter(window => window.appId !== appId); paint(); settle();
  host.mouse('mouseup', ...location); host.mouse('click', ...location); settle();
  check(calls.length === before && !open, 'Held task cannot become a different application after source removal');

  theme = getDesktopTheme('xp'); windows = [...documents(3), ...extras]; paint(); settle();
  check(!get(openerId) && get('shell-window-list').childNodes.length === 6,
    'Legacy negative: exact same app IDs remain separate Window.id tasks');
  click(get('shell-window-10'));
  check(JSON.stringify(calls.at(-1)) === '["minimizeWindow",10]', 'Legacy active click retains minimize');
  click(get('shell-window-11'), 2);
  check(contexts.at(-1) === 11 && !open, 'Legacy context retains original per-window interface');
  save('legacy-negative');
  console.log('WINDOW_GROUP_GUI ' + JSON.stringify({ records, calls, contexts,
    proof: 'actual GUI renderer and input against nonempty appId fixture snapshots; not compositor/MRU certification' }));
  console.log('PASS: Modern/Big Sur grouped slots, chooser pointer/keyboard, count-width, long-list reveal, held target guards and XP negative');
}

export async function checkNativeWindowGroupBounds() {
  const records = [];
  for (const [id, width, height] of [['modern', 380, 360], ['bigsur', 260, 180]]) {
    const child = window.create({ title: 'Polly.WindowGroup.' + id, width, height });
    const owner = child.document, theme = getDesktopTheme(id);
    const group = windowTasks(documents(20), 'applications', catalog)[0];
    const original = globalThis.document;
    try {
      globalThis.document = owner;
      render(windowGroupMenu(theme, group, { slots: [], action: () => {}, close: () => {} }), owner.body);
    } finally { globalThis.document = original; }
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      const root = owner.getElementById('shell-window-group'), list = owner.getElementById('shell-group-list');
      check(root.offsetWidth === owner.body.offsetWidth && root.offsetHeight === owner.body.offsetHeight,
        'Real native child input document exactly bounds group menu');
      const last = owner.getElementById('shell-group-activate-29');
      last.focus(); await new Promise(resolve => setTimeout(resolve, 100));
      const [x, y, w, h] = box(last), [vx, vy, vw, vh] = box(list);
      check(x >= vx && y >= vy && x + w <= vx + vw && y + h <= vy + vh,
        'Real native child focus reveals final actual group member inside input bounds');
      records.push({ theme: id, client: [owner.body.offsetWidth, owner.body.offsetHeight],
        root: box(root), last: box(last), scroll: list.scrollTop });
    } finally { child.close(); }
  }
  console.log('WINDOW_GROUP_NATIVE_BOUNDS ' + JSON.stringify(records));
  console.log('PASS: actual native child group-menu client bounds and last-member focus (not new popup/outside-dismiss authority)');
}
