import { h, render } from './gui/sdk/js/reconciler.mjs';
import { DESKTOP_THEMES } from './desktop/shell/themes.mjs';
import { panelView, dockView, applicationsView, button } from './desktop/shell/views.mjs';
import * as layout from './desktop/shell/theme-layout.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const rectangle = node => node ? [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight] : null;
const action = () => {};
const entries = [
  { id: 'org.pollyui.settings', name: 'Settings', comment: 'System settings', keywords: ['preferences'] },
  { id: 'org.pollyui.files', name: 'Files', comment: 'Browse files', keywords: ['folders'] },
  { id: 'org.pollyui.terminal', name: 'Terminal', comment: 'Command line', keywords: ['console'] },
  { id: 'org.pollyui.processes', name: 'Processes', comment: 'System processes', keywords: ['tasks'] },
];
const windows = [{ id: 1, appId: 'org.pollyui.files', title: 'Documents', active: true },
  { id: 2, appId: 'org.pollyui.terminal', title: 'Terminal', minimized: true }];

export function captureThemeComponents(directory) {
  check(host.width === 1280 && host.height === 900, 'Capture requires an unscaled 1280x900 surface');
  for (const theme of DESKTOP_THEMES) {
    const dock = theme.panel.kind === 'dock';
    const width = Math.min(theme.layout.menuWidth, host.width - 24);
    const height = Math.min(theme.layout.menuHeight, host.height - theme.panel.height - 24);
    const top = dock ? theme.layout.menuBarHeight + 8 : host.height - theme.panel.height - height - theme.layout.menuGap;
    const dockWidth = dock ? layout.dockSurfaceWidth ?
      layout.dockSurfaceWidth(theme, windows.length, host.width) :
      theme.layout.dockBaseWidth + windows.length * (theme.layout.dockWindowWidth + theme.layout.windowGap) : 0;
    const menuLeft = theme.panel.surfaceStyle === 'fluent' ? (host.width - width) / 2 : 12;
    render(h('view', { style: { width: '100%', height: '100%', position: 'relative',
      backgroundColor: theme.desktop.from } },
      h('view', { style: { position: 'absolute', left: 16, top: dock ? 42 : 16,
        fontSize: 12, color: '#ffffff', pointerEvents: 'none' } },
        'Actual PollyUI component fixture - not a native desktop capture'),
      h('view', { id: 'fixture-menu', style: { position: 'absolute', left: menuLeft, top, width, height } },
        applicationsView(theme, entries, '', action, action, action, action, '', action)),
      h('view', { id: 'fixture-control', style: { position: 'absolute', right: 24, top: 70,
        width: 120, height: theme.layout.buttonHeight } }, button('fixture-button', 'OK', theme, action)),
      h('view', { style: { position: 'absolute', left: 0, right: 0,
        [dock ? 'top' : 'bottom']: 0, height: dock ? theme.layout.menuBarHeight : theme.panel.height } },
        panelView(theme, '10:31 AM', action, '', action, windows, action, action,
          { name: 'Workspaces', open: action }, { count: 1, open: action })),
      dock ? h('view', { id: 'fixture-dock', style: { position: 'absolute',
        left: (host.width - dockWidth) / 2, bottom: theme.panel.inset, width: dockWidth, height: theme.panel.height } },
        dockView(theme, action, action, action, windows, action, action)) : null), document.body);
    host.render();
    document.activeElement?.blur();
    host.render();
    const element = id => document.getElementById(id);
    check(element('shell-panel').offsetHeight === (dock ? theme.layout.menuBarHeight : theme.panel.height),
      theme.id + ' actual panel height differs from the catalog');
    const file = directory + '\\components-' + theme.id + '-1280x900.png';
    check(host.save(file), 'Cannot save actual component evidence: ' + file);
    console.log('GEOMETRY ' + JSON.stringify({ theme: theme.id, viewport: [1280, 900], scale: 1,
      menu: rectangle(element('shell-applications')), panel: rectangle(element('shell-panel')),
      dock: rectangle(element('shell-dock')), launcher: rectangle(element('shell-menu')),
      task: rectangle(element('shell-window-1')), search: rectangle(element('shell-app-search')),
      button: rectangle(element('fixture-button')), file }));
    const buttonNode = element('fixture-button');
    buttonNode.focus(); host.render();
    check(document.activeElement === buttonNode, 'Themed button lost keyboard focus');
    const x = buttonNode.offsetLeft + buttonNode.offsetWidth / 2;
    const y = buttonNode.offsetTop + buttonNode.offsetHeight / 2;
    host.mouse('mousemove', x, y); host.mouse('mousedown', x, y); host.render();
    host.mouse('mouseup', x, y); host.render();
    check(document.activeElement === buttonNode, 'Pointer state painting changed keyboard focus');
  }

  console.log('PASS: actual six-theme component bytes and layout, focus and pointer state paths');
}

export function checkDockOverflow() {
  const theme = DESKTOP_THEMES.find(item => item.id === 'lion');
  const normalWidth = layout.dockSurfaceWidth(theme, windows.length, 1280);
  render(h('view', { style: { width: normalWidth, height: theme.panel.height } },
    dockView(theme, action, action, action, windows, action, action)), document.body);
  host.render();
  const normalFixed = ['shell-dock-applications', 'shell-dock-settings', 'shell-dock-about']
    .map(id => document.getElementById(id));
  check(normalWidth === 319 && document.getElementById('shell-dock').offsetWidth === 319,
    'The ordinary two-window Dock must include all root and window-strip gaps');
  check(normalFixed.every((node, i) => node.offsetWidth === 56 &&
    (!i || node.offsetLeft - normalFixed[i - 1].offsetLeft === 58)),
  'Ordinary fixed Dock actions must retain their slot width and spacing');
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: 'Window ' + (i + 1) }));
  let activated = 0;
  const width = layout.dockSurfaceWidth(theme, many.length, 320);
  render(h('view', { style: { width, height: theme.panel.height } },
    dockView(theme, action, action, action, many, id => { activated = id; }, action)), document.body);
  host.render();
  const get = id => document.getElementById(id);
  const strip = get('shell-dock-windows'), last = get('shell-window-20');
  check(strip.offsetWidth > 0 && strip.offsetWidth < 2 * theme.layout.dockWindowWidth,
    'Clamped Dock must give window slots a bounded, nonzero scroll viewport');
  const fixed = ['shell-dock-applications', 'shell-dock-settings', 'shell-dock-about'].map(get);
  const positions = fixed.map(rectangle);
  check(fixed.every(node => node.offsetLeft >= 0 && node.offsetLeft + node.offsetWidth <= width),
    'Fixed Dock actions must remain visible when window slots overflow');
  const x = strip.offsetLeft + strip.offsetWidth / 2, y = strip.offsetTop + 20;
  host.scroll(x, y, 100000); host.render();
  check(Number(strip.scrollLeft) > 0, 'Actual wheel dispatch must scroll the window strip');
  const visibleLeft = last.offsetLeft - Number(strip.scrollLeft);
  console.log('DOCK_OVERFLOW ' + JSON.stringify({ strip: rectangle(strip), scrollLeft: strip.scrollLeft,
    last: rectangle(last), bounds: last.getBoundingClientRect(), visibleLeft }));
  check(visibleLeft >= strip.offsetLeft && visibleLeft + last.offsetWidth <= strip.offsetLeft + strip.offsetWidth,
    'The last running window must be fully reachable after horizontal scrolling');
  host.mouse('mousedown', visibleLeft + last.offsetWidth / 2, last.offsetTop + 20);
  host.mouse('mouseup', visibleLeft + last.offsetWidth / 2, last.offsetTop + 20);
  host.mouse('click', visibleLeft + last.offsetWidth / 2, last.offsetTop + 20); host.render();
  check(activated === 20, 'The reached window must retain actual pointer activation');
  host.scroll(x, y, -100000); host.render();
  check(Number(strip.scrollLeft) === 0, 'Reverse wheel dispatch must return to the first window');
  last.focus(); host.render();
  check(document.activeElement === last && Number(strip.scrollLeft) > 0,
    'Keyboard focus must reveal an offscreen window slot');
  check(fixed.every((node, i) => JSON.stringify(rectangle(node)) === JSON.stringify(positions[i])),
    'Scrolling and focus must not move or shrink the fixed Dock actions');
  console.log('PASS: actual clamped Dock wheel reachability, pointer activation, focus reveal and fixed actions');
}

export function captureServer2003Reference(directory) {
  check(host.width === 640 && host.height === 480, 'Server reference fixture requires an unscaled 640x480 surface');
  const theme = DESKTOP_THEMES.find(item => item.id === 'server2003');
  const height = layout.applicationMenuHeight(theme, host.height);
  let launched = '';
  const menu = (apps = entries) => applicationsView(theme, apps, '', action, id => { launched = id; }, action, action, '', action);
  render(h('view', { style: { width: '100%', height: '100%', position: 'relative',
    backgroundColor: theme.desktop.from } },
    h('view', { style: { position: 'absolute', left: 0, bottom: theme.panel.height,
      width: theme.layout.menuWidth, height } }, menu()),
    h('view', { style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: theme.panel.height } },
      panelView(theme, '5:05 PM', action, '', action, windows, action, action))),
  document.body);
  host.render(); document.activeElement?.blur(); host.render();
  const get = id => document.getElementById(id);
  check(get('shell-applications').offsetWidth === theme.layout.menuWidth &&
    get('shell-applications').offsetHeight === theme.layout.menuHeight,
    'Two-column menu must use measured preferred dimensions without changing screen resolution');
  check(get('shell-start-profile').offsetHeight === 40 && get('shell-start-links').offsetWidth === 184,
    'Classic header/gray second column geometry must match configured measurements');
  check(host.save(directory + '\\server2003-two-column-640x480.png'), 'Cannot save Server 2003 component evidence');
  console.log('SERVER_GEOMETRY ' + JSON.stringify({
    viewport: [640, 480], scale: 1, menu: rectangle(get('shell-applications')),
    header: rectangle(get('shell-start-profile')), links: rectangle(get('shell-start-links')),
    footer: rectangle(get('shell-start-footer')), panel: rectangle(get('shell-panel')),
    app: rectangle(get('shell-app-org.pollyui.settings')),
  }));
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'fixture-' + i, name: 'Application ' + i,
    comment: '', keywords: [] }));
  const lowHeight = layout.applicationMenuHeight(theme, 240);
  render(h('view', { style: { width: 380, height: lowHeight } }, menu(many)), document.body);
  host.render();
  const list = get('shell-start-apps'), last = get('shell-app-fixture-19');
  const footer = get('shell-start-footer'), search = get('shell-app-search');
  check(list.offsetHeight > 0 && footer.offsetTop + footer.offsetHeight <= lowHeight &&
    search.offsetTop + search.offsetHeight <= footer.offsetTop,
  'Small-height menu must retain visible search/footer and a real scrolling app viewport');
  host.scroll(list.offsetLeft + 30, list.offsetTop + list.offsetHeight / 2, 100000); host.render();
  const bounds = last.getBoundingClientRect();
  console.log('SERVER_SMALL ' + JSON.stringify({ height: lowHeight, list: rectangle(list),
    scrollTop: list.scrollTop, last: bounds, search: rectangle(search), footer: rectangle(footer) }));
  host.mouse('mousedown', bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  host.mouse('mouseup', bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  host.mouse('click', bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); host.render();
  check(launched === 'fixture-19', 'The final application must remain scrollable and actually launchable');
  search.focus(); host.render();
  check(document.activeElement === search, 'Search retains actual focus in the small-height layout');
  console.log('PASS: Server Classic two-column component dimensions, low-height scrolling, launch and focus');
}

export function captureClassicBorders(directory, verify = false) {
  check(host.width === 640 && host.height === 480, 'Classic border fixture requires unscaled 640x480');
  const theme = DESKTOP_THEMES.find(item => item.id === 'server2003');
  const placement = layout.applicationMenuPlacement(theme, host.width);
  const width = placement.width ?? Math.min(theme.layout.menuWidth, host.width - theme.layout.screenInset * 2);
  const height = layout.applicationMenuHeight(theme, host.height);
  const menuLeft = placement.margins.left ?? 0, menuBottom = placement.margins.bottom;
  const activations = [];
  render(h('view', { style: { width: '100%', height: '100%', position: 'relative',
    backgroundColor: theme.desktop.from } },
    h('view', { style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: theme.panel.height } },
      panelView(theme, '5:05 PM', action, '', action, windows, id => activations.push(id), action)),
    h('view', { style: { position: 'absolute', left: menuLeft, bottom: menuBottom, width, height } },
      applicationsView(theme, entries, '', action, action, action, action, '', action))),
  document.body);
  host.render(); document.activeElement?.blur(); host.render();
  const get = id => document.getElementById(id);
  const descendants = node => [node, ...node.childNodes.flatMap(descendants)];
  const iconFor = task => descendants(task).find(node => Number(node.style?.width) === 16 &&
    Number(node.style?.height) === 16);
  const panel = get('shell-panel'), first = get('shell-window-1'), second = get('shell-window-2');
  const firstIcon = iconFor(first), secondIcon = iconFor(second);
  check(firstIcon && secondIcon, 'Task icons must retain real 16px slots');
  const geometry = {
    viewport: [640, 480], panel: rectangle(panel), menu: rectangle(get('shell-applications')),
    header: rectangle(get('shell-start-profile')), links: rectangle(get('shell-start-links')),
    footer: rectangle(get('shell-start-footer')), activeTask: rectangle(first), inactiveTask: rectangle(second),
    activeIcon: rectangle(firstIcon), inactiveIcon: rectangle(secondIcon),
    taskTopGap: first.offsetTop - panel.offsetTop,
    taskBottomGap: panel.offsetTop + panel.offsetHeight - first.offsetTop - first.offsetHeight,
    activeIconLeftInset: firstIcon.offsetLeft - first.offsetLeft,
    inactiveIconLeftInset: secondIcon.offsetLeft - second.offsetLeft,
    activeIconTopGap: firstIcon.offsetTop - panel.offsetTop,
    inactiveIconTopGap: secondIcon.offsetTop - panel.offsetTop,
  };
  check(host.save(directory + '\\normal-640x480.png'), 'Cannot save Classic border comparison frame');
  const blank = () => [host.pixel(first.offsetLeft + 130, first.offsetTop + 4),
    host.pixel(first.offsetLeft + 130, first.offsetTop + first.offsetHeight - 5)];
  const probes = { normal: blank() };
  const edges = task => [host.pixel(task.offsetLeft + 130, task.offsetTop),
    host.pixel(task.offsetLeft + 130, task.offsetTop + 1),
    host.pixel(task.offsetLeft + 130, task.offsetTop + task.offsetHeight - 2),
    host.pixel(task.offsetLeft + 130, task.offsetTop + task.offsetHeight - 1)];
  const edgeProbes = { active: edges(first), inactive: edges(second) };
  host.mouse('mousemove', first.offsetLeft + 130, first.offsetTop + 10); host.render();
  probes.hover = blank();
  host.mouse('mousedown', first.offsetLeft + 130, first.offsetTop + 10); host.render();
  probes.pressed = blank();
  check(activations.length === 0, 'Painting a press must not activate a task');
  host.mouse('mouseup', first.offsetLeft + 130, first.offsetTop + 10);
  host.mouse('click', first.offsetLeft + 130, first.offsetTop + 10); host.render();
  check(activations.length === 1 && activations[0] === 1, 'Actual task click must remain connected exactly once');
  second.focus(); host.render();
  check(document.activeElement === second, 'Task keyboard focus must remain connected');
  if (verify) {
    check(theme.panel.taskTexture === 'stipple' ? second.querySelector('.classic-task-paint') !== null :
      second.querySelector('.theme-focus-ring').style.opacity === '1' &&
        host.pixel(second.offsetLeft + second.offsetWidth - 7, second.offsetTop + 3) === '#000000',
    'Removing the generic outline must retain an actual visible keyboard focus indicator');
  }
  host.mouse('mousemove', second.offsetLeft + 130, second.offsetTop + 10);
  host.mouse('mousedown', second.offsetLeft + 130, second.offsetTop + 10); host.render();
  const heldIcon = rectangle(secondIcon);
  edgeProbes.pressedInactive = edges(second);
  host.mouse('mousemove', 630, 0); host.render();
  const releasedIcon = rectangle(secondIcon);
  edgeProbes.cancelledInactive = edges(second);
  host.mouse('mouseup', 630, 0);
  if (verify) {
    check(geometry.taskTopGap === 4 && geometry.taskBottomGap === 2 &&
      first.offsetHeight === 22 && firstIcon.offsetWidth === 16, 'Classic chrome and task/icon insets differ');
    check(geometry.inactiveIconLeftInset === 3 && geometry.activeIconLeftInset === 4,
      'Active/sunken and inactive task content must retain their measured inner offsets');
    check(heldIcon[0] === releasedIcon[0] + 1 && heldIcon[1] === releasedIcon[1] + 1,
      'Pointer cancellation must retire the visual content offset without moving the hitbox');
    check(theme.panel.taskTexture === 'stipple' ?
      Object.values(probes).every(value => JSON.stringify(value) === JSON.stringify(probes.normal)) :
      Object.values(probes).every(([top, bottom]) => top === bottom),
    'Classic task material must not drift back to a gradient on hover or press');
    check(JSON.stringify(edgeProbes.active) === JSON.stringify(['#404040', '#808080', '#D4D0C8', '#FFFFFF']) &&
      JSON.stringify(edgeProbes.inactive) === JSON.stringify(['#FFFFFF', '#D4D0C8', '#808080', '#404040']) &&
      JSON.stringify(edgeProbes.pressedInactive) === JSON.stringify(edgeProbes.active) &&
      JSON.stringify(edgeProbes.cancelledInactive) === JSON.stringify(edgeProbes.inactive),
    'Actual two-layer task edges must not be overwritten by a generic outline');
    check(get('shell-applications').offsetLeft === 2 && get('shell-applications').offsetTop === 12 &&
      get('shell-applications').offsetHeight === 444, 'Menu must align its three-pixel frame with the reference');
    const narrow = layout.applicationMenuPlacement(theme, 320);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: 'narrow-' + i, name: 'Application ' + i,
      comment: '', keywords: [] }));
    let launched = '';
    render(h('view', { style: { position: 'absolute', left: narrow.margins.left, top: 0,
      width: narrow.width, height: layout.applicationMenuHeight(theme, 240) } },
      applicationsView(theme, many, '', action, id => { launched = id; }, action, action)), document.body);
    host.render();
    const narrowMenu = get('shell-applications'), list = get('shell-start-apps');
    check(narrowMenu.offsetLeft === 2 && narrowMenu.offsetLeft + narrowMenu.offsetWidth <= 320,
      'Menu width must account for the new inset without overflowing a narrow output');
    host.scroll(list.offsetLeft + 30, list.offsetTop + list.offsetHeight / 2, 100000); host.render();
    const last = get('shell-app-narrow-19').getBoundingClientRect();
    host.mouse('mousedown', last.x + last.width / 2, last.y + last.height / 2);
    host.mouse('mouseup', last.x + last.width / 2, last.y + last.height / 2);
    host.mouse('click', last.x + last.width / 2, last.y + last.height / 2); host.render();
    check(launched === 'narrow-19', 'Last app must remain reachable in the narrow, low-height menu');
  }

  console.log('CLASSIC_BORDERS ' + JSON.stringify({ geometry, probes, edgeProbes, activations, heldIcon, releasedIcon }));
  console.log(verify ? 'PASS: actual Classic border/task spacing, flat state paint, cancellation, focus and single activation' :
    'BASELINE: frozen Classic frame/states captured; new geometry/flat assertions are not applied');
}

export async function captureClassicMaterial(directory, verify = false) {
    check(host.width === 800 && host.height === 600, 'Material fixture requires original 800x600 guest-sized bounds');
    const original = DESKTOP_THEMES.find(item => item.id === 'server2003');
    const appWindows = [
      { id: 1, title: 'Untitled - Notepad', active: false },
      { id: 2, title: 'Command Prompt', active: true },
    ];
    const activations = [];
    const scene = async (theme = original, selected = 2) => {
      const placement = layout.applicationMenuPlacement(theme, host.width);
      render(h('view', { style: { width: '100%', height: '100%', position: 'relative',
        backgroundColor: theme.desktop.from } },
        h('view', { style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: theme.panel.height } },
          panelView(theme, '6:08 AM', action, '', action,
            appWindows.map(window => ({ ...window, active: window.id === selected })),
            id => activations.push(id), action)),
        h('view', { style: { position: 'absolute', left: placement.margins.left ?? 0,
          bottom: placement.margins.bottom, width: placement.width ?? theme.layout.menuWidth,
          height: layout.applicationMenuHeight(theme, host.height) } },
          applicationsView(theme, entries, '', action, action, action, action, '', action))),
      document.body);
      await Promise.resolve(); host.render();
    };
    await scene();
    const get = id => document.getElementById(id);
    const task = id => get('shell-window-' + id);
    const canvas = id => task(id).querySelector('.classic-task-paint');
    const block = id => {
      const node = task(id), pixels = [];
      for (let y = 8; y < 12; y++) for (let x = 130; x < 134; x++)
        pixels.push(host.pixel(node.offsetLeft + x, node.offsetTop + y));
      return pixels;
    };
    const expected = [original.colors.body.toUpperCase(), original.colors.light.toUpperCase()].sort();
    const geometry = { viewport: [800, 600], taskbar: rectangle(get('shell-panel')),
      activeTask: rectangle(task(2)), inactiveTask: rectangle(task(1)),
      menu: rectangle(get('shell-applications')), header: rectangle(get('shell-start-profile')),
      links: rectangle(get('shell-start-links')), footer: rectangle(get('shell-start-footer')) };
    const normal = block(2);
    check(host.save(directory + '\\classic-material-800x600.png'), 'Cannot save the actual material frame');
    const verifyChecker = pixels => {
      check(JSON.stringify([...new Set(pixels)].sort()) === JSON.stringify(expected), 'Selected task must use the two theme colors');
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
        check(pixels[y * 4 + x] === pixels[((y + 1) % 4) * 4 + (x + 1) % 4] &&
          pixels[y * 4 + x] !== pixels[y * 4 + (x + 1) % 4], 'Actual task pixels must repeat at one-pixel checker spacing');
    };
    if (verify) {
      verifyChecker(normal);
      check(task(2).querySelectorAll('canvas').length === 1 && task(1).querySelectorAll('canvas').length === 1,
        'Each task must use one paint-only canvas, not a DOM point grid');
      check(canvas(2).style.pointerEvents === 'none' && canvas(2).getAttribute('aria-hidden') === 'true',
        'The texture must not own pointer or accessibility focus');
    }
    const rect = task(2).getBoundingClientRect(), x = rect.x + 130, y = rect.y + 10;
    host.mouse('mousemove', x, y); host.render();
    const hover = block(2);
    host.mouse('mousedown', x, y); host.render();
    const pressed = block(2);
    check(activations.length === 0, 'Painting selected task press must not activate it');
    host.mouse('mouseup', x, y); host.mouse('click', x, y); host.render();
    check(activations.length === 1 && activations[0] === 2, 'Task click must activate exactly once');
    task(2).focus(); host.render();
    check(document.activeElement === task(2), 'The task retains ordinary keyboard focus');
    const focusPixels = Array.from({ length: 8 }, (_, i) =>
      host.pixel(rect.x + 124 + i, rect.y + 3));
    console.log('CLASSIC_FOCUS_PROBE ' + JSON.stringify({ focusPixels, task: rect,
      canvas: canvas(2).getBoundingClientRect(),
      backing: Array.from(canvas(2).getContext('2d').getImageData(124, 3, 8, 1).data) }));
    if (verify) {
      verifyChecker(hover); verifyChecker(pressed);
      check(focusPixels.includes('#000000') && focusPixels.some(value => value !== '#000000'),
        'Focused task must paint a real dashed, not solid, focus edge');
      host.mouse('mousedown', task(1).offsetLeft + 130, task(1).offsetTop + 10); host.render();
      check(canvas(1).getContext('2d').getImageData(30, 10, 1, 1).data[3] === 0,
        'Temporary press on an inactive task must not paint selected stipple');
      host.mouse('mousecancel', task(1).offsetLeft + 130, task(1).offsetTop + 10);
      host.mouse('mouseup', task(1).offsetLeft + 130, task(1).offsetTop + 10); host.render();
      await scene(original, 0);
      check(canvas(2).getContext('2d').getImageData(30, 10, 1, 1).data[3] === 0,
        'Selected-to-inactive reconciliation must clear the old texture');
      await scene();
      task(2).focus(); host.render();
      const retained = task(2);
      for (const body of ['#dedbd3', '#e4e1d9', original.colors.body]) {
        const theme = { ...original, colors: { ...original.colors, body } };
        await scene(theme);
        check(task(2) === retained && document.activeElement === retained,
          'Palette changes must retain the task hitbox and keyboard focus');
        check(document.body.querySelectorAll('.classic-task-paint').length === 2,
          'Palette changes must not accumulate attached texture nodes');
        const values = canvas(2).getContext('2d').getImageData(30, 10, 2, 2).data;
        const colors = [];
        for (let i = 0; i < 16; i += 4)
          colors.push('#' + Array.from(values.slice(i, i + 3)).map(value => value.toString(16).padStart(2, '0')).join(''));
        check(colors.includes(body.toLowerCase()) && colors.includes(original.colors.light.toLowerCase()),
          'Palette changes must replace cached tile colors');
      }
      const flat = { ...original, panel: { ...original.panel, taskTexture: 'flat' } };
      await scene(flat);
      check(document.body.querySelectorAll('.classic-task-paint').length === 0,
        'Flat opt-out must retire all task texture canvases');
    }
    console.log('CLASSIC_MATERIAL ' + JSON.stringify({ geometry, normal, hover, pressed,
      focusPixels, activations, verified: verify }));
    console.log(verify ? 'PASS: actual stipple, dotted focus, selection/press/palette lifecycle and unchanged task activation' :
      'BASELINE: actual flat task material captured without after-style assertions');
  }
