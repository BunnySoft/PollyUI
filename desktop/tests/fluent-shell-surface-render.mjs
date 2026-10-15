import { h, render } from './gui/sdk/js/reconciler.mjs';
import { DESKTOP_THEMES } from './desktop/shared/ui/themes.mjs';
import { parseThemeFile } from './desktop/shared/ui/theme-schema.mjs';
import { panelView, applicationsView } from './desktop/shell/views.mjs';
import { applicationMenuHeight } from './desktop/shared/ui/theme-layout.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const get = id => document.getElementById(id);
const rect = node => [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight];
const settle = () => { host.render(); host.render(); host.render(); host.render(); };
const delay = () => new Promise(resolve => setTimeout(resolve, 30));
function visibleBox(node) {
  let x = node.offsetLeft, y = node.offsetTop;
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    x -= Number(parent.scrollLeft); y -= Number(parent.scrollTop);
  }
  return [x, y, node.offsetWidth, node.offsetHeight];
}
const point = node => {
  const [x, y, w, h] = visibleBox(node);
  return [x + w / 2, y + h / 2];
};
const noop = () => {};
export async function checkFluentShellSurface(directory) {
  const theme = DESKTOP_THEMES.find(item => item.id === 'modern');
  let toggles = 0, contexts = 0, opens = 0, settings = 0, workspaces = 0, notifications = 0;
  let launches = 0, pins = 0, query = '';
  async function panel(width = 800, count = 2, current = theme, clock = '10:31 AM', tray = null) {
    render(h('view', { style: { width, height: 100, backgroundColor: '#608090' } },
      h('view', { style: { width, height: 48 } },
        panelView(current, clock, () => opens++, '', () => settings++,
          Array.from({ length: count }, (_, i) => ({ id: i + 1, title: 'Window ' + i, active: i === 0 })),
          () => toggles++, () => contexts++, { name: 'Workspaces', open: () => workspaces++ },
          { count: 0, open: () => notifications++ }, tray))), document.body);
    settle(); await delay(); settle();
  }
  const click = node => {
    host.mouse('mousemove', ...point(node)); host.mouse('mousedown', ...point(node));
    host.mouse('mouseup', ...point(node)); host.mouse('click', ...point(node)); settle();
  };
  const save = name => check(host.save(directory + '\\fluent-' + name + '.png'), 'Save actual ' + name);
  const fill = node => [node.style.backgroundColor, node.style.gradientFrom, node.style.gradientTo].join(':');
  const pixel = node => {
    const [x, y] = visibleBox(node);
    return host.pixel(x + 2, y + 12);
  };
  await panel();
  const active = get('shell-window-1'), inactive = get('shell-window-2');
  const normal = [fill(active), fill(inactive)];
  check(normal[0] === theme.button.from + ':transparent:transparent' &&
    normal[1] === 'transparent:transparent:transparent', 'Initial active and inactive task paint');
  const group = get('shell-centered-tasks');
  check(group.offsetLeft === 280 && group.offsetWidth === 240, '800px default group retains true center');
  save('normal-800');
  for (const node of [active, inactive]) {
    host.mouse('mousemove', ...point(node)); settle();
    check(node.style.backgroundColor === theme.colors.selection, 'Task hover uses existing selection color');
    check(pixel(node) === theme.colors.selection.toUpperCase(), 'Task hover actually paints the configured flat color');
    await panel(800, 2, theme, '10:32 AM');
    check(get(node.id) === node && node.style.backgroundColor === theme.colors.selection,
      'Clock reconciliation retains node and hover');
    host.mouse('mousedown', ...point(node)); settle();
    await panel(800, 2, theme, '10:33 AM');
    check(node.style.backgroundColor === theme.button.to, 'Held task survives reconciliation');
    check(pixel(node) === theme.button.to.toUpperCase(), 'Held task actually paints the configured flat color');
    host.mouse('mousemove', 790, 90); host.mouse('mouseup', 790, 90); settle();
    node.blur(); settle();
    check(fill(node) === normal[node === active ? 0 : 1], 'Leave/cancel restores original task face');
    check(pixel(node) === (node === active ? theme.button.from : theme.panel.from).toUpperCase(),
      'Canceled task restores original actual opaque/transparent pixels');
    node.focus(); settle();
    const ring = node.querySelector('.theme-focus-ring');
    check(ring && Number(ring.style.opacity) === 1 && ring.style.pointerEvents === 'none',
      'Task keyboard focus is paint-only and visible');
    const [rx, ry] = visibleBox(ring);
    check(host.pixel(rx + 5, ry) === theme.colors.focus.toUpperCase(), 'Focus border paints actual configured ink');
    await panel();
    check(Number(node.querySelector('.theme-focus-ring').style.opacity) === 1,
      'Retained focused task keeps its ring on clock repaint');
    node.blur(); settle();
    check(Number(ring.style.opacity) === 0 && fill(node) === normal[node === active ? 0 : 1],
      'Blur hides ring without changing selection face');
  }
  check(toggles === 0, 'Canceled task presses never activate');
  click(inactive); check(toggles === 1, 'One task click activates once');
  inactive.focus();
  host.key('Enter', 'keydown', { text: false }); settle();
  check(toggles === 2, 'Task Enter activates once');
  host.key('ContextMenu', 'keydown', { text: false }); settle();
  check(contexts === 1, 'Task context action is retained');
  check(active.getAttribute('aria-pressed') === 'true' && inactive.getAttribute('aria-pressed') === 'false',
    'Selection truth remains independent of hover/focus');
  check(active.lastChild.offsetWidth === 16 && inactive.lastChild.offsetWidth === 6, 'Running markers remain unchanged');
  save('tasks');
  const rethemed = { ...theme, colors: { ...theme.colors, selection: '#804020', focus: '#204080' } };
  host.mouse('mousemove', ...point(active)); settle();
  await panel(800, 2, rethemed);
  check(fill(active) === normal[0], 'Immutable theme replacement clears stale interaction state');
  host.mouse('mousemove', 790, 90); host.mouse('mousemove', ...point(active)); settle();
  check(pixel(active) === '#804020', 'Task variant consumes rethemed palette rather than preset RGB');
  for (const width of [360, 260]) {
    await panel(width, 6);
    const group = get('shell-centered-tasks'), strip = get('shell-window-list'), tray = get('shell-notification-area');
    check(group.offsetLeft >= 12 && group.offsetLeft + group.offsetWidth <= tray.offsetLeft - 4,
      'Task group never overlaps notification area');
    for (const [id, count] of [['shell-menu', () => opens], ['shell-panel-settings', () => settings],
      ['shell-workspaces', () => workspaces], ['shell-notifications', () => notifications]]) {
      const node = get(id), before = count();
      node.focus(); settle();
      const [x, , w] = visibleBox(node);
      check(x >= 12 && x + w <= (id === 'shell-notifications' ? width - 12 : tray.offsetLeft - 4),
        id + ' focus reveals complete fixed action');
      click(node); check(count() === before + 1, id + ' real hit invokes once');
    }
    const last = get('shell-window-6'); last.focus(); settle();
    const [x, , w] = visibleBox(last);
    check(x >= group.offsetLeft && x + w <= group.offsetLeft + group.offsetWidth,
      'Last task focus reveals nested task and group viewport');
    const before = toggles;
    click(last); check(toggles === before + 1, 'Narrow focused task actual pointer invokes once');
    const scroll = Number(strip.scrollLeft);
    last.focus(); settle();
    check(Number(strip.scrollLeft) === scroll, 'Repeated task focus does not jitter');
    const wheelPoint = () => {
      const [sx, sy, sw, sh] = visibleBox(strip);
      return [Math.max(sx, group.offsetLeft) + Math.min(sw, group.offsetWidth) / 2, sy + sh / 2];
    };
    host.scroll(...wheelPoint(), -10000); settle();
    check(Number(strip.scrollLeft) === 0, 'Task wheel clamps to the beginning');
    host.scroll(...wheelPoint(), 10000); settle();
    check(Number(strip.scrollLeft) > 0, 'Exposed strip wheel reaches last task');
    last.focus(); settle();
    const previousGroup = Number(group.scrollLeft);
    host.scroll(group.offsetLeft + 2, group.offsetTop + 20, -10000); settle();
    check(Number(group.scrollLeft) === 0, 'Group wheel reverses to fixed action start');
    if (previousGroup > 0) {
      host.scroll(group.offsetLeft + 2, group.offsetTop + 20, 10000); settle();
      check(Number(group.scrollLeft) >= previousGroup, 'Group wheel reaches task viewport when fixed slots overflow');
    }
    last.blur(); last.focus(); settle();
    console.log('FLUENT_SURFACE ' + JSON.stringify({ width, group: rect(group), strip: rect(strip),
      tray: rect(tray), clock: rect(get('shell-clock')), last: visibleBox(last),
      groupScroll: group.scrollLeft, taskScroll: strip.scrollLeft }));
    save('panel-' + width);
  }
  await panel(360, 6);
  get('shell-window-6').blur(); get('shell-window-6').focus(); settle();
  const retainedLast = get('shell-window-6');
  await panel(260, 6);
  const retainedGroup = get('shell-centered-tasks'), [lastX, , lastWidth] = visibleBox(retainedLast);
  check(get('shell-window-6') === retainedLast && document.activeElement === retainedLast &&
    lastX >= retainedGroup.offsetLeft && lastX + lastWidth <= retainedGroup.offsetLeft + retainedGroup.offsetWidth,
    'Focused retained task re-reveals after the narrower group layout actually settles');
  let trayCalls = 0;
  const trayData = { items: [{ id: 7, title: 'Tray item', status: 'Active' }],
    activate: () => trayCalls++, scroll: noop };
  await panel(360, 6, theme, '10:31 AM', trayData);
  const trayArea = get('shell-notification-area'), taskGroup = get('shell-centered-tasks');
  check(taskGroup.offsetLeft + taskGroup.offsetWidth <= trayArea.offsetLeft - theme.layout.panelGap,
    'Measured tray item width, not notification/clock estimate, reserves actual space');
  click(get('shell-tray-7')); check(trayCalls === 1, 'Real tray consumer still receives pointer action once');
  get('shell-window-6').focus(); settle();
  click(get('shell-window-6')); check(toggles === 5, 'Last task remains clickable with tray item present');
  console.log('FLUENT_TRAY ' + JSON.stringify({ group: rect(taskGroup), tray: rect(trayArea) }));
  const custom = parseThemeFile(JSON.stringify({ schemaVersion: 1,
    theme: { ...theme, layout: { ...theme.layout, launcherWidth: 60, windowButtonWidth: 52 } } }));
  await panel(800, 2, custom);
  check(get('shell-menu').offsetWidth === 60 && get('shell-window-1').offsetWidth === 52,
    'Unequal legal fixed/task slot sizes are consumed');
  check(Math.abs(get('shell-centered-tasks').offsetLeft + get('shell-centered-tasks').offsetWidth / 2 - 400) < 1,
    'Custom individual slot sizes remain truly centered');
  await panel(360, 6, custom);
  const customGroup = get('shell-centered-tasks'), customTray = get('shell-notification-area');
  check(customGroup.offsetLeft + customGroup.offsetWidth <= customTray.offsetLeft - custom.layout.panelGap,
    'Custom unequal slot group avoids actual larger notification slot');
  get('shell-window-6').focus(); settle();
  const customBefore = toggles; click(get('shell-window-6'));
  check(toggles === customBefore + 1, 'Custom narrow task revealed through both actual slot widths activates once');
  console.log('FLUENT_CUSTOM ' + JSON.stringify({ group: rect(customGroup), tray: rect(customTray),
    menu: rect(get('shell-menu')), task: visibleBox(get('shell-window-6')) }));
  const entries = Array.from({ length: 24 }, (_, i) => ({
    id: 'app' + i, name: 'App ' + i, ...(i === 1 ? { unavailable: 'Unavailable' } : {}),
  }));
  for (const [width, height] of [[640, 660], [360, 260]]) {
    render(h('view', { style: { width, height: applicationMenuHeight(theme, height) } },
      applicationsView(theme, entries, '', value => { query = value; }, () => launches++, noop, noop, '', noop,
        { has: () => false, add: () => pins++, remove: noop })), document.body);
    settle();
    const list = get('shell-start-apps'), last = get('shell-app-app23'), pin = get('shell-app-pin-app23');
    list.scrollTop = 0; settle();
    const fixed = [rect(get('shell-app-search')), rect(get('shell-start-footer'))];
    for (const [node, count] of [[last, () => launches], [pin, () => pins]]) {
      const before = count(); node.focus(); settle();
      const top = node.offsetTop - list.offsetTop, start = Number(list.scrollTop);
      check(start <= top + node.offsetHeight && start + list.offsetHeight > top, 'Focused grid control intersects viewport');
      if (node.offsetHeight <= list.offsetHeight)
        check(top >= start && top + node.offsetHeight <= start + list.offsetHeight, 'Control fully visible where it fits');
      else check(start === top, 'Oversized control aligns its start for maximum visibility');
      const heldScroll = Number(list.scrollTop); node.focus(); settle();
      check(Number(list.scrollTop) === heldScroll, 'Repeated grid focus never jitters');
      console.log('FLUENT_GRID_FOCUS ' + JSON.stringify({ width, id: node.id, scroll: heldScroll,
        control: visibleBox(node), list: rect(list) }));
      save('grid-focus-' + node.id + '-' + width);
      host.key('Enter', 'keydown', { text: false }); settle();
      check(count() === before + 1, 'Revealed grid keyboard action invokes once');
      if (height === 660) {
        click(node); check(count() === before + 2, 'Fully revealed grid pointer invokes once');
      }
    }
    check(get('shell-app-app1').tabIndex === -1 && get('shell-app-app1').getAttribute('aria-disabled') === 'true',
      'Unavailable grid app stays disabled');
    const disabled = get('shell-app-app1');
    disabled.focus(); settle();
    const launched = launches;
    host.key('Enter', 'keydown', { text: false }); settle();
    check(launches === launched, 'Unavailable app cannot invoke through keyboard');
    const [lx, ly, lw, lh] = visibleBox(list);
    if (height === 660) {
      host.scroll(lx + lw / 2, ly + lh / 2, -10000); settle();
      check(Number(list.scrollTop) === 0, 'Grid wheel reverse clamps at start');
      host.scroll(lx + lw / 2, ly + lh / 2, 10000); settle();
      check(Number(list.scrollTop) > 0, 'Grid wheel can still reach final nested row');
    } else {
      check(list.parentNode.parentNode.offsetHeight === 0, 'Record existing physically collapsed grid row');
      console.log('FLUENT_LIMIT: 180px menu has a 16px list in a collapsed row; focus scroll is bounded, not full pointer/wheel/footer fit');
    }
    get('shell-app-search').focus(); host.text('files'); settle();
    check(query === 'files', 'Search still accepts actual text');
    check(JSON.stringify(fixed) === JSON.stringify([rect(get('shell-app-search')), rect(get('shell-start-footer'))]),
      'Grid scroll never moves Search/footer');
    console.log('FLUENT_GRID ' + JSON.stringify({ width, height, viewport: rect(list),
      app: rect(last), pin: rect(pin), scrollTop: list.scrollTop, fixed }));
    save('grid-' + width);
    query = '';
  }
  console.log('PASS: actual Fluent task states/focus/reconcile, no tray overlap, narrow/custom slots and nested grid focus');
}

export async function checkNativeFluentPanel(directory) {
  const theme = DESKTOP_THEMES.find(item => item.id === 'modern');
  const wait = () => new Promise(resolve => setTimeout(resolve, 150));
  const scene = (shown = true) => h('view', { style: { width: '100%', height: 48 } },
    shown ? panelView(theme, '10:31 AM', noop, '', noop,
      [{ id: 1, title: 'Active', active: true }, { id: 2, title: 'Running' }], noop, noop,
      { name: 'Workspaces', open: noop }, { count: 0, open: noop }) : null);
  async function roundtrip() {
    const title = 'Fluent.panel.owner';
    const child = window.create({ title, width: 240, height: 140 });
    const owner = child.document, original = globalThis.document;
    let business = 0, replacement = 0;
    child.onstatechange = () => business++;
    globalThis.document = owner;
    try { render(scene(), owner.body); } finally { globalThis.document = original; }
    await wait();
    const panel = owner.getElementById('shell-panel'), group = owner.getElementById('shell-centered-tasks');
    const tray = owner.getElementById('shell-notification-area');
    const snapshot = () => ({ origin: panel.offsetLeft, panel: panel.offsetWidth,
      left: group.offsetLeft, width: group.offsetWidth, tray: rect(tray) });
    const before = snapshot(), records = [];
    const request = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame;
    const pending = new Set();
    let frames = 0, cancellations = 0;
    globalThis.requestAnimationFrame = callback => {
      const id = request(time => { pending.delete(id); frames++; callback(time); });
      pending.add(id); return id;
    };
    globalThis.cancelAnimationFrame = id => { if (pending.delete(id)) cancellations++; cancel(id); };
    try {
      for (const width of [680, 240, 680]) {
        frames = 0;
        ownerTest.resize(title, width, 140);
        // No render(), host.render(), VNode update or capture flush follows host resize.
        await wait();
        const after = snapshot();
        check(frames === 3 && pending.size === 0, 'Owner resize runs exactly bounded 2+1 layout/reveal frames');
        check(after.width > 0 && after.left >= after.origin + theme.layout.panelPaddingLeft &&
          after.left + after.width <= tray.offsetLeft - theme.layout.panelGap,
          'Host-only resize measures actual tray bounds relative to the native panel origin');
        if (width === 680) check(Math.abs(after.left + after.width / 2 -
          (after.origin + after.panel / 2)) <= 1, 'Host-only grow restores real screen-centered group');
        else check(after.width < 240, 'Host-only shrink restores tray-safe constrained group');
        records.push({ ...after, frames });
        await wait();
        check(frames === 3, 'No periodic or self-scheduling owner layout polling');
        child.onstatechange = () => replacement++;
      }
      check(business > 0 && replacement > 0, 'Panel observer coexists with original and later business handlers');
      child.capture(directory + '\\fluent-native-panel.png');
      frames = 0;
      globalThis.document = owner;
      try {
        render(scene(), owner.body);
        check(pending.size === 1, 'VNode update queues one bounded layout chain');
        render(scene(false), owner.body);
      } finally { globalThis.document = original; }
      check(pending.size === 0 && cancellations === 1, 'Panel leave cancels pending layout frame');
      await wait();
      check(frames === 0, 'Removed panel never executes a stale layout/reveal');
      ownerTest.resize(title, 420, 140);
      await wait();
      check(frames === 0, 'Panel leave unregisters owner subscription');
    } finally {
      globalThis.requestAnimationFrame = request;
      globalThis.cancelAnimationFrame = cancel;
      child.close();
    }
    console.log('NATIVE_FLUENT_PANEL ' + JSON.stringify({ before, after: records, business, replacement, cancellations }));
  }
  async function closedPanel() {
    let child = window.create({ title: 'Fluent.panel.collect', width: 360, height: 140 });
    let owner = child.document;
    const original = globalThis.document;
    globalThis.document = owner;
    try { render(scene(), owner.body); } finally { globalThis.document = original; }
    await wait();
    ownerTest.resize('Fluent.panel.collect', 680, 140);
    await wait();
    let panel = owner.getElementById('shell-panel');
    let group = owner.getElementById('shell-centered-tasks');
    check(Math.abs(group.offsetLeft + group.offsetWidth / 2 -
      (panel.offsetLeft + panel.offsetWidth / 2)) <= 1, 'GC fixture really registered and handled owner resize');
    const references = { panel: new WeakRef(panel), document: new WeakRef(owner), window: new WeakRef(child) };
    // Close while still subscribed; onLeave cannot mask a finalizer-held owner leak.
    child.close(); panel = null; group = null; owner = null; child = null;
    return references;
  }
  await roundtrip();
  const references = await closedPanel();
  for (let i = 0; i < 8; i++) { await new Promise(resolve => setTimeout(resolve, 30)); ownerTest.gc(); }
  const alive = Object.fromEntries(Object.entries(references).map(([name, weak]) => [name, Boolean(weak.deref())]));
  console.log('NATIVE_FLUENT_PANEL_GC ' + JSON.stringify(alive));
  check(Object.values(alive).every(value => !value), 'Closed subscribed panel, Document and window handle all collect');
  console.log('PASS: actual Fluent owner-only shrink/grow, handler coexistence, bounded frames, leave and closed-window GC');
}
