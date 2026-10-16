import { h, render } from './gui/sdk/js/reconciler.mjs';
import { startMenuView } from './desktop/shell/start-menu.mjs';
import { programsPlacement, categoryEntries, programCategoryId } from './desktop/shell/programs-menu.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { verticalScrollMetrics } from './gui/sdk/js/scrollbar.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const get = id => document.getElementById(id);
const settle = () => { host.render(); host.render(); host.render(); host.render(); };
const wait = () => new Promise(resolve => setTimeout(resolve, 60));
const box = node => {
  const rect = node.getBoundingClientRect();
  return [rect.x, rect.y, rect.width, rect.height];
};
const point = node => {
  let [x, y, width, height] = box(node), right = x + width, bottom = y + height;
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    const [px, py, pw, ph] = box(parent);
    x = Math.max(x, px); y = Math.max(y, py); right = Math.min(right, px + pw); bottom = Math.min(bottom, py + ph);
  }
  check(right > x && bottom > y, node.id + ' has an exposed actual hitbox');
  return [x + (right - x) / 2, y + (bottom - y) / 2];
};

export async function checkClassicPrograms(directory) {
  let theme = getDesktopTheme('server2003'), width = 384, height = 480, open = false, placement;
  let entries = Array.from({ length: 30 }, (_, index) => ({
    id: 'app' + index, name: 'Registered application ' + index,
    categories: index === 0 ? ['Utility', '\u6587\u6863'] : index === 2 ? [] : [index % 2 ? 'Utility' : '\u6587\u6863'],
    ...(index === 1 ? { unavailable: 'Not installed' } : {}),
  }));
  const launched = [], pinned = [];
  const geometries = [];
  let slots = [];
  let view = 'all', category = null, epoch = 0;
  let query = '', error = '', refreshes = 0, closes = 0, logouts = 0, revision = 0;
  const members = () => view === 'categories' ? [] : view === 'category' ? categoryEntries(entries, category) : entries;
  const active = id => open && members().some(entry => entry.id === id && !entry.unavailable);
  const change = (next, focus = '') => {
    if (next) placement = programsPlacement(get('shell-applications'), get('shell-all-programs'), theme.layout.menuRowHeight ?? 32);
    if (open !== next) epoch++;
    open = next;
    if (!next) { slots = []; view = 'all'; category = null; }
    mount();
    if (focus) requestAnimationFrame(() => {
      if (open !== next) return;
      const node = focus === 'trigger' ? get('shell-all-programs') :
        Array.from(get('shell-program-list').childNodes).find(item => item.tabIndex >= 0) ?? get('shell-program-back');
      node?.focus();
    });
  };
  const navigate = (next, tag = null, focus = 'first') => {
    view = next; category = next === 'category' ? tag : null; epoch++; slots = [];
    mount();
    get('shell-program-list').scrollTop = 0;
    const generation = epoch;
    requestAnimationFrame(() => {
      if (!open || generation !== epoch) return;
      const target = focus === 'first' ? get('shell-program-list').childNodes.find(item => item.tabIndex >= 0) : get(focus);
      (target ?? get('shell-program-back'))?.focus();
    });
  };
  function mount(enabled = true) {
    render(h('view', { style: { width: '100%', height: '100%', backgroundColor: '#608090' } },
      h('view', { style: { width, height } },
        startMenuView(theme, entries, query, value => { query = value; mount(); },
          id => launched.push(id), () => refreshes++, () => closes++, error, () => logouts++,
          { has: id => pinned.includes(id), add: id => pinned.push(id), remove: id => pinned.splice(pinned.indexOf(id), 1) },
          enabled ? { open, placement, change, slots, view, category, epoch, navigate,
            launch: id => { if (active(id)) launched.push(id); },
            pin: id => {
              if (!open || !members().some(entry => entry.id === id)) return;
              if (pinned.includes(id)) pinned.splice(pinned.indexOf(id), 1); else pinned.push(id);
            },
          } : null))),
    document.body);
    settle();
  }
  const click = node => {
    host.mouse('mousemove', ...point(node)); host.mouse('mousedown', ...point(node));
    host.mouse('mouseup', ...point(node)); host.mouse('click', ...point(node)); settle();
  };
  const key = name => { host.key(name, 'keydown', { text: false }); settle(); };
  const save = name => check(host.save(directory + '\\classic-programs-' + name + '.png'), 'Save ' + name);
  mount(false);
  check(!get('shell-all-programs'), 'Record existing flat Classic surface without Programs consumer');
  save('existing-flat');
  mount();
  check(get('shell-start-links') && get('shell-app-search') && get('shell-app-app29') &&
    get('shell-app-pin-app29') && get('shell-app-logout'), 'Programs preserves real root controls');
  const trigger = get('shell-all-programs');
  click(trigger); await wait(); settle();
  check(open && get('shell-program-menu'), 'Actual trigger pointer opens Programs, even after hover');
  const menu = get('shell-program-menu'), root = get('shell-applications');
  const inside = () => {
    const [x, y, w, h] = box(get('shell-program-menu')), [rx, ry, rw, rh] = box(root);
    check(x >= rx && y >= ry && x + w <= rx + rw && y + h <= ry + rh, 'Programs remains within actual RootMenu input bounds');
  };
  inside();
  geometries.push({ width, height, style: 'two-column', root: box(root), submenu: box(menu) });
  host.mouse('mousemove', ...point(get('shell-program-app0'))); settle();
  check(open, 'Pointer crosses from trigger into submenu without premature close');
  get('shell-program-back').focus(); key('ArrowUp');
  check(document.activeElement === get('shell-program-pin-app29'), 'Up from menu header selects last enabled command');
  key('Home');
  check(document.activeElement === get('shell-program-app0'), 'Home selects first real enabled entry');
  key('ArrowDown');
  check(document.activeElement === get('shell-program-pin-app0'), 'Down visits real Pin action');
  key('ArrowDown');
  check(document.activeElement === get('shell-program-pin-app1'), 'Arrow navigation skips unavailable launch');
  const disabled = get('shell-program-app1'), beforeDisabled = launched.length;
  disabled.focus(); key('Enter');
  check(launched.length === beforeDisabled && disabled.tabIndex === -1 &&
    disabled.getAttribute('aria-description') === 'Not installed', 'Unavailable entry keeps reason and cannot launch');
  key('End');
  check(document.activeElement === get('shell-program-pin-app29') &&
    Number(get('shell-program-list').scrollTop) > 0, 'End scrolls to last real command');
  key('Tab');
  check(document.activeElement === get('shell-program-back'), 'Tab from final command reaches the bounded header Back');
  key('Tab');
  check(document.activeElement === get('shell-program-categories'), 'Tab reaches the new Categories header entry');
  key('Tab');
  check(document.activeElement === get('shell-program-app0'), 'Tab returns to real list without underlying root commands');
  host.key('Tab', 'keydown', { text: false, shiftKey: true }); settle();
  check(document.activeElement === get('shell-program-categories'), 'Reverse Tab includes Categories');
  host.key('Tab', 'keydown', { text: false, shiftKey: true }); settle();
  check(document.activeElement === get('shell-program-back'), 'Reverse Tab includes Back');
  host.key('Tab', 'keydown', { text: false, shiftKey: true }); settle();
  check(document.activeElement === get('shell-program-pin-app29'), 'Reverse Tab wraps inside submenu');
  key('ArrowUp'); key('Enter');
  check(launched.length === 1 && launched[0] === 'app29', 'Enter invokes correct registered ID exactly once');
  click(get('shell-program-app29'));
  check(launched.length === 2 && launched[1] === 'app29', 'Pointer invokes correct registered ID exactly once');
  key('End'); key('Enter');
  check(pinned.length === 1 && pinned[0] === 'app29', 'Program Pin calls existing shortcut service once');
  const retained = get('shell-program-app29'), scroll = get('shell-program-list').scrollTop;
  revision++; mount();
  theme = { ...theme, colors: { ...theme.colors, focus: '#804020' } }; mount();
  check(open && get('shell-program-app29') === retained && get('shell-program-list').scrollTop === scroll,
    'Clock-equivalent reconcile and retheme preserve open path, DOM and scroll');
  error = 'Shortcut service refused the request'; mount(); await wait(); settle();
  check(get('shell-program-error').offsetHeight > 0 && get('shell-program-app29') === retained,
    'Existing business error is visible inside submenu without rebuilding commands');
  error = ''; mount(); await wait(); settle();
  key('Escape'); await wait(); settle();
  check(!open && document.activeElement === trigger, 'Escape closes only submenu and restores trigger focus');
  key('ArrowRight'); await wait(); settle();
  check(open, 'Right opens submenu from restored trigger');
  key('ArrowLeft'); await wait(); settle();
  check(!open && document.activeElement === trigger, 'Left restores parent focus');
  key('ArrowRight'); await wait(); settle();
  click(get('shell-program-back')); await wait(); settle();
  check(!open && document.activeElement === trigger, 'Visible Back pointer restores parent menu');
  key('ArrowRight'); await wait(); settle();
  const list = get('shell-program-list');
  host.scroll(...point(list), 10000); settle();
  check(Number(list.scrollTop) === verticalScrollMetrics(list).maximum, 'Actual wheel reaches Programs end');
  host.scroll(...point(list), -10000); settle();
  check(Number(list.scrollTop) === 0, 'Reverse wheel clamps to beginning');
  save('open');
  const held = get('shell-program-app0');
  host.mouse('contextmenu', ...point(held), { button: 2 }); settle();
  check(launched.length === 2, 'Right click never invokes a launch callback');
  host.mouse('mousemove', ...point(held)); host.mouse('mousedown', ...point(held)); settle();
  const heldPaint = [held.style.backgroundColor, held.style.borderColor].join(':');
  mount();
  check(get('shell-program-app0') === held &&
    [held.style.backgroundColor, held.style.borderColor].join(':') === heldPaint,
    'Unchanged retained update preserves held control paint and identity');
  entries.reverse();
  theme = { ...theme, colors: { ...theme.colors, selection: '#204080', accentText: '#f0f0f0' } };
  mount();
  check(open && get('shell-program-app0') === held && held.style.backgroundColor === theme.colors.selection &&
    held.querySelector('.theme-command-label').style.color === (theme.colors.selectionText ?? theme.colors.accentText),
    'Live catalog reorder and immutable retheme retain the held ID and repaint its current state');
  entries.reverse(); mount();
  host.mouse('mouseup', ...point(held)); host.mouse('click', ...point(held)); settle();
  check(launched.length === 3 && launched[2] === 'app0', 'Retained held command releases into its original ID once');
  const stale = get('shell-program-app0');
  const stalePoint = point(stale), staleCount = launched.length;
  host.mouse('mousemove', ...stalePoint); host.mouse('mousedown', ...stalePoint); settle();
  entries = entries.filter(entry => entry.id !== 'app0'); mount();
  check(!get('shell-program-app0') && stale.tabIndex === -1 && stale.style.pointerEvents === 'none',
    'Removed registry row becomes inert instead of reusing another application ID');
  host.mouse('mouseup', ...stalePoint); host.mouse('click', ...stalePoint); settle();
  check(launched.length === staleCount, 'Held removed registry row cannot release into a different application');
  if (!open) { get('shell-all-programs').focus(); key('ArrowRight'); await wait(); settle(); }
  key('Home'); key('Enter');
  check(pinned.at(-1) === 'app1' && launched.length === staleCount, 'Refresh navigation never launches stale unavailable ID');
  host.mouse('mousemove', ...point(get('shell-program-pin-app1')));
  host.mouse('mousedown', ...point(get('shell-program-pin-app1')));
  host.mouse('mousecancel', ...point(get('shell-program-pin-app1'))); settle(); await wait();
  check(!open, 'Pointer cancellation closes submenu and clears held state');
  get('shell-all-programs').focus(); key('ArrowRight'); await wait(); settle();
  host.mouse('mousemove', ...point(get('shell-program-app2'))); settle();
  host.mouse('mousemove', width + 5, 10); settle();
  check(!open, 'Leaving real root bounds closes submenu, not merely entering its child');
  get('shell-app-search').focus(); host.text('application 2'); settle();
  check(query === 'application 2' && get('shell-app-app29'), 'Existing Search remains editable and filters actual root apps');
  click(get('shell-app-refresh')); click(get('shell-app-close')); click(get('shell-app-logout'));
  check(refreshes === 1 && closes === 1 && logouts === 1, 'Original Refresh/Close/logout remain actual pointer actions');
  query = ''; mount();
  get('shell-all-programs').focus(); key('ArrowRight'); await wait(); settle();
  click(get('shell-program-categories')); await wait(); settle();
  check(view === 'categories' && get(programCategoryId('\u6587\u6863')) && get(programCategoryId(null)),
    'Actual header pointer opens real Unicode metadata tags and Uncategorized');
  inside();
  save('categories');
  get(programCategoryId('Utility')).focus(); key('ArrowRight'); await wait(); settle();
  check(view === 'category' && get('shell-program-app29') && !get('shell-program-app2'),
    'Category ArrowRight shows only its real exact members');
  save('category-utility');
  key('End');
  check(document.activeElement === get('shell-program-pin-app29') && Number(get('shell-program-list').scrollTop) > 0,
    'Long category leaves preserve last real command focus reveal');
  key('Escape'); await wait(); settle();
  check(view === 'categories' && document.activeElement === get(programCategoryId('Utility')),
    'Leaf Escape returns to its real category command');
  click(get(programCategoryId(null))); await wait(); settle();
  check(get('shell-program-app2') && !get('shell-program-app29'), 'Uncategorized uses real entries without tags');
  click(get('shell-program-all')); await wait(); settle();
  check(view === 'all' && get('shell-program-app29'), 'All applications header bypasses categories without losing original rows');
  key('Escape'); await wait(); settle();
  for (const [nextWidth, nextHeight, style] of [[260, 180, 'two-column'], [180, 140, 'legacy']]) {
    width = nextWidth; height = nextHeight;
    theme = { ...getDesktopTheme('server2003'), panel: { ...theme.panel, menuStyle: style } };
    mount(); get('shell-all-programs').focus(); key('ArrowRight'); await wait(); settle();
    inside(); key('End');
    const last = get('shell-program-pin-app29');
    click(last);
    check(open, 'Narrow/short Programs retains usable actual last-item hitbox');
    geometries.push({ width, height, style, root: box(root), submenu: box(get('shell-program-menu')), last: box(last) });
    save(style + '-' + width);
    key('Escape'); await wait(); settle();
  }
  get('shell-all-programs').focus(); key('ArrowRight'); await wait(); settle(); key('End');
  entries = []; mount(); await wait(); settle();
  check(get('shell-program-list').childNodes.length === 1, 'Empty actual registry reports no applications, not fake programs');
  check(Number(get('shell-program-list').scrollTop) === 0 &&
    document.activeElement === get('shell-program-back'), 'Live empty registry clamps old scroll and recovers keyboard focus');
  key('Home'); key('End'); key('Escape'); await wait(); settle();
  check(!open, 'Empty submenu keyboard closes safely');
  console.log('CLASSIC_PROGRAMS ' + JSON.stringify({ geometries, launched, pinned, revision, refreshes, closes, logouts }));
  console.log('PASS: actual Classic Programs bounded pointer/keyboard, metadata categories/back/header Tab, scroll, disabled/empty/stale registry, retained state and real shortcut callbacks');
}

export async function checkNativeClassicPrograms() {
  const theme = getDesktopTheme('server2003'), noop = () => {};
  const records = [];
  for (const [width, height, style] of [[384, 480, 'two-column'], [180, 140, 'legacy']]) {
    const child = window.create({ title: 'Classic.Programs.' + style, width, height });
    const owner = child.document;
    let open = false, placement;
    const state = { slots: [], launch: noop, pin: noop, change: noop };
    function paint() {
      const original = globalThis.document;
      globalThis.document = owner;
      try {
        render(startMenuView({ ...theme, panel: { ...theme.panel, menuStyle: style } },
          Array.from({ length: 30 }, (_, index) => ({ id: 'app' + index, name: 'Application ' + index })),
          '', noop, noop, noop, noop, '', noop, { has: () => false, add: noop, remove: noop },
          { ...state, open, placement }), owner.body);
      } finally { globalThis.document = original; }
    }
    try {
      paint(); await new Promise(resolve => setTimeout(resolve, 150));
      const root = owner.getElementById('shell-applications'), trigger = owner.getElementById('shell-all-programs');
      placement = programsPlacement(root, trigger, theme.layout.menuRowHeight ?? 32);
      open = true; paint(); await new Promise(resolve => setTimeout(resolve, 150));
      const menu = owner.getElementById('shell-program-menu'), list = owner.getElementById('shell-program-list');
      check(root.offsetWidth === owner.body.offsetWidth && root.offsetHeight === owner.body.offsetHeight,
        'Real native child input document and RootMenu surface have identical dimensions');
      const [x, y, w, h] = box(menu), [rx, ry, rw, rh] = box(root);
      check(x >= rx && y >= ry && x + w <= rx + rw && y + h <= ry + rh,
        'Native child Programs never paints outside actual client input bounds');
      const last = owner.getElementById('shell-program-app29');
      last.focus(); await new Promise(resolve => setTimeout(resolve, 100));
      const target = last.getBoundingClientRect(), viewport = list.getBoundingClientRect();
      check(target.y >= viewport.y && target.y + target.height <= viewport.y + viewport.height,
        'Native child long-list focus reveals last actual application');
      records.push({ style, client: [owner.body.offsetWidth, owner.body.offsetHeight],
        root: box(root), submenu: box(menu), last: box(last), scroll: list.scrollTop });
    } finally { child.close(); }
  }
  console.log('CLASSIC_PROGRAMS_NATIVE_BOUNDS ' + JSON.stringify(records));
  console.log('PASS: real native child Programs root/input dimensions and clipped submenu focus (not compositor outside-dismiss certification)');
}
