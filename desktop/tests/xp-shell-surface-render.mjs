import { h, render } from './gui/sdk/js/reconciler.mjs';
import { DESKTOP_THEMES } from './desktop/shared/ui/themes.mjs';
import { panelView, applicationsView } from './desktop/shell/views.mjs';
import { applicationMenuHeight, applicationMenuPlacement } from './desktop/shared/ui/theme-layout.mjs';
import { parseThemeFile } from './desktop/shared/ui/theme-schema.mjs';
import { windowTasks } from './desktop/shell/window-groups.mjs';
import { programsPlacement } from './desktop/shell/programs-menu.mjs';
import { startMenuView } from './desktop/shell/start-menu.mjs';
import { parseLocalUserProfile } from './desktop/shared/user-profile.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const rect = node => [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight];
const get = id => document.getElementById(id);
const point = node => [node.offsetLeft + node.offsetWidth / 2, node.offsetTop + node.offsetHeight / 2];
const xp = DESKTOP_THEMES.find(theme => theme.id === 'xp');
const entries = [
  { id: 'org.pollyui.files', name: 'Files' },
  { id: 'org.pollyui.settings', name: 'Settings' },
  { id: 'unavailable', name: 'Unavailable', unavailable: 'Not installed' },
  ...Array.from({ length: 10 }, (_, i) => ({ id: 'app' + i, name: 'Application ' + i })),
];
export function checkXpShellSurface(directory, expectFixed = true, quickLaunchImages = null) {
  let opens = 0, toggles = 0, launches = 0, pins = 0, closed = 0, refreshed = 0, loggedOut = 0, query = '';
  const action = () => {};
  function mount(theme, width, height) {
    const menuHeight = applicationMenuHeight(theme, height), placement = applicationMenuPlacement(theme, width);
    render(h('view', { style: { position: 'relative', width, height, backgroundColor: theme.desktop.from } },
      h('view', { id: 'xp-menu-host', style: { position: 'absolute', left: placement.margins.left,
        bottom: placement.margins.bottom, width: placement.width, height: menuHeight } },
      applicationsView(theme, entries, query, value => { query = value; }, () => launches++,
        () => refreshed++, () => closed++, '', () => loggedOut++,
        { has: () => false, add: () => pins++, remove: action })),
      h('view', { style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: theme.panel.height } },
        panelView(theme, '10:31 AM', () => opens++, '', action,
          [{ id: 1, title: 'Active window', active: true }, { id: 2, title: 'Inactive window' }],
          () => toggles++, action, { name: 'Workspaces', open: action }, { count: 1, open: action },
          { items: [{ id: 'sample', title: 'Tray', status: 'Active' }], activate: action, scroll: action }))),
    document.body);
    host.render();
  }
  const capture = name => check(host.save(directory + '\\xp-shell-' + name + '.png'), 'Save ' + name);
  const click = node => {
    host.mouse('mousemove', ...point(node)); host.mouse('mousedown', ...point(node));
    host.mouse('mouseup', ...point(node)); host.mouse('click', ...point(node)); host.render();
  };
  mount(xp, 800, 600);
  check(get('shell-panel').offsetHeight === 30 && get('shell-menu').offsetWidth === 97 &&
    get('shell-window-1').offsetHeight === 26, 'Adopted 30/97/26 actual geometry');
  check(get('shell-start-profile').offsetHeight === 64 && get('shell-start-footer').offsetHeight === 42,
    'Header/footer retain adopted heights');
  console.log('XP_SURFACE ' + JSON.stringify({ scene: 'normal', panel: rect(get('shell-panel')),
    launcher: rect(get('shell-menu')), task: rect(get('shell-window-1')), tray: rect(get('shell-notification-area')),
    clock: rect(get('shell-clock')), menu: rect(get('shell-applications')), header: rect(get('shell-start-profile')),
    links: rect(get('shell-start-links')), footer: rect(get('shell-start-footer')) }));
  capture('normal');
  get('shell-app-close').focus(); host.render();
  check(Number(get('shell-start-links').scrollTop) === 0, 'Normal-height focus does not scroll');
  document.activeElement?.blur(); host.render();
  const launcher = get('shell-menu'), p = point(launcher);
  const normal = host.pixel(launcher.offsetLeft + 4, launcher.offsetTop + 15);
  host.mouse('mousemove', ...p); host.render(); capture('hover');
  check(host.pixel(launcher.offsetLeft + 4, launcher.offsetTop + 15) !== normal, 'Launcher actual hover tint');
  host.mouse('mousedown', ...p); host.render(); capture('held');
  check(launcher.querySelector('.luna-launcher-tint').style.backgroundColor === '#000000', 'Launcher held tint');
  host.mouse('mousemove', 790, 10); host.mouse('mouseup', 790, 10); host.render();
  check(opens === 0 && launcher.querySelector('.luna-launcher-tint').style.opacity === '0', 'Cancel restores paint without activation');
  click(launcher); check(opens === 1, 'Launcher single pointer activation');
  click(get('shell-window-2')); check(toggles === 1, 'Inactive task single activation');
  const task = get('shell-window-1'); task.focus(); host.render();
  check(task.querySelector('.luna-focus-ring').style.opacity === '1', 'Task focus remains visible');
  click(get('shell-app-unavailable')); check(launches === 0, 'Unavailable app never activates');
  click(get('shell-app-org.pollyui.files')); check(launches === 1, 'App activates once');
  click(get('shell-app-pin-org.pollyui.files')); check(pins === 1, 'Pin remains connected');
  get('shell-app-search').focus(); host.key('x'); host.render();
  check(query === 'x' && document.activeElement?.id === 'shell-app-search', 'Search keeps real text input and focus');
  query = '';
  const custom = parseThemeFile(JSON.stringify({ schemaVersion: 1,
    theme: { ...xp, layout: { ...xp.layout, launcherWidth: 123 } } }));
  mount(custom, 800, 600);
  check(get('shell-menu').offsetWidth === (expectFixed ? 123 : 97), 'Configured launcher width consumed');
  click(get('shell-menu')); check(opens === 2, 'Custom launcher single activation');
  check(point(get('shell-menu'))[0] < get('shell-panel-settings').offsetLeft, 'Custom launcher and next hitbox do not overlap');
  capture('custom');
  mount(xp, 360, 260);
  const links = get('shell-start-links'), close = get('shell-app-close'), footer = get('shell-start-footer');
  const fixed = [rect(get('shell-start-profile')), rect(footer)];
  const beforeScroll = close.offsetTop - Number(links.scrollTop);
  host.scroll(...point(links), 10000); host.render();
  const visibleTop = close.offsetTop - Number(links.scrollTop);
  console.log('XP_SURFACE ' + JSON.stringify({ scene: 'narrow-low', menu: rect(get('shell-applications')),
    header: rect(get('shell-start-profile')), links: rect(links), close: rect(close), footer: rect(footer),
    scrollTop: links.scrollTop, beforeScroll, visibleTop }));
  if (expectFixed) {
    check(Number(links.scrollTop) > 0 && visibleTop >= links.offsetTop &&
      visibleTop + close.offsetHeight <= links.offsetTop + links.offsetHeight, 'Low-height links scroll fully into view');
    capture('narrow-low-scrolled');
    host.mouse('mousemove', links.offsetLeft + 20, visibleTop + close.offsetHeight / 2);
    host.mouse('mousedown', links.offsetLeft + 20, visibleTop + close.offsetHeight / 2);
    host.mouse('mouseup', links.offsetLeft + 20, visibleTop + close.offsetHeight / 2);
    host.mouse('click', links.offsetLeft + 20, visibleTop + close.offsetHeight / 2); host.render();
    check(closed === 1, 'Reached Close menu retains real activation');
    close.focus(); host.key('Enter', 'keydown', { text: false }); host.render();
    check(closed === 2, 'Reached Close menu keyboard activates once');
    for (const [id, count] of [['shell-start-settings', () => launches], ['shell-app-refresh', () => refreshed]]) {
      host.scroll(...point(links), -10000); host.render();
      const node = get(id), previous = count();
      click(node);
      check(count() === previous + 1, id + ' pointer activates once');
      node.focus(); host.key('Enter', 'keydown', { text: false }); host.render();
      check(count() === previous + 2, id + ' keyboard activates once');
    }
    host.scroll(...point(links), -10000); host.render();
    close.focus(); host.render();
    const revealedTop = close.offsetTop - Number(links.scrollTop);
    check(revealedTop >= links.offsetTop && revealedTop + close.offsetHeight <= links.offsetTop + links.offsetHeight,
      'Existing focus reveal scrolls the right column to Close menu');
    console.log('XP_FOCUS_REVEAL ' + JSON.stringify({ scrollTop: links.scrollTop, revealedTop }));
    close.focus(); host.render();
    check(Number(links.scrollTop) === 20, 'Repeated focus inside viewport does not jitter');
    host.key('Enter', 'keydown', { text: false }); host.render();
    check(closed === 3, 'Keyboard-revealed final command activates once');
    host.scroll(...point(links), -10000); host.render();
    check(Number(links.scrollTop) === 0, 'Reverse wheel clamps at zero');
    const apps = get('shell-start-apps'), oldLinksScroll = Number(links.scrollTop);
    host.scroll(...point(apps), 10000); host.render();
    check(Number(apps.scrollTop) > 0 && Number(links.scrollTop) === oldLinksScroll, 'App list scroll remains independent');
    get('shell-app-search').focus(); host.text('files'); host.render();
    check(query === 'files', 'Low-height Search remains reachable');
    const logout = get('shell-app-logout');
    click(logout); check(loggedOut === 1, 'Fixed footer remains reachable by pointer');
    check(JSON.stringify(fixed) === JSON.stringify([rect(get('shell-start-profile')), rect(footer)]),
      'Scrolling either column never moves header/footer');
    const tasks = get('shell-window-list'), last = get('shell-window-2');
    host.scroll(...point(tasks), 10000); host.render();
    const taskLeft = last.offsetLeft - Number(tasks.scrollLeft);
    check(Number(tasks.scrollLeft) > 0, 'Narrow task strip remains scrollable');
    const visibleLeft = Math.max(tasks.offsetLeft, taskLeft);
    const visibleRight = Math.min(tasks.offsetLeft + tasks.offsetWidth, taskLeft + last.offsetWidth);
    check(visibleRight > visibleLeft, 'Last task intersects its clipped viewport');
    const taskPoint = [(visibleLeft + visibleRight) / 2, last.offsetTop + 13];
    host.mouse('mousemove', ...taskPoint);
    host.mouse('mousedown', ...taskPoint);
    host.mouse('mouseup', ...taskPoint);
    host.mouse('click', ...taskPoint);
    host.render(); check(toggles === 2, 'Narrow scrolled task activates once');
  } else check(Number(links.scrollTop) === 0 && visibleTop + close.offsetHeight > links.offsetTop + links.offsetHeight,
    'Baseline reproduces clipped, unscrollable final right-column command');
  capture('narrow-low');
  const running = [{ id: 10, appId: 'org.pollyui.files', title: 'Running Files', active: true, workspaceId: 7 },
    { id: 11, appId: 'org.pollyui.files', title: 'Another Files window', workspaceId: 7 },
    { id: 12, title: 'Unknown app', workspaceId: 7 }];
  let tasks = windowTasks(running, xp.panel.taskGrouping, entries,
    ['org.pollyui.files', 'org.pollyui.settings'], 7);
  const quickCalls = [], windowCalls = [];
  const paintQuick = width => {
    render(h('view', { style: { width, height: 90, backgroundColor: xp.desktop.from } },
      h('view', { style: { width, height: xp.panel.height } },
        panelView(xp, '22:30', action, '', action, tasks, id => {
          const task = tasks.find(task => task.id === id);
          if (task.quickLaunch) quickCalls.push(task.catalogId);
          else windowCalls.push([task.active && !task.minimized ? 'minimize' : 'activate', task.id]);
        }, action, null, null, null, quickLaunchImages))), document.body);
    host.render();
  };
  render(h('view', {}), document.body); paintQuick(800);
  const quick = get('shell-window-pin-org.pollyui.files'), real = get('shell-window-10');
  check(quick.offsetWidth < real.offsetWidth && quick.offsetHeight === real.offsetHeight,
    'Quick Launch is a compact icon-only slot, not a full-width text task');
  check(quick.getAttribute('aria-label').includes('pinned launcher') &&
    !quick.getAttribute('aria-label').includes('not running'), 'Quick Launch labels do not deny existing windows');
  click(quick); click(real); click(get('shell-window-11'));
  check(JSON.stringify(quickCalls) === '["org.pollyui.files"]' &&
    JSON.stringify(windowCalls) === '[["minimize",10],["activate",11]]',
    'Actual XP pointer invokes one launcher independently and original per-window actions');
  capture('quick-launch-normal');
  tasks = windowTasks(running, xp.panel.taskGrouping, entries, entries.map(entry => entry.id), 7);
  paintQuick(360);
  const strip = get('shell-window-list'), lastTask = get('shell-window-12');
  lastTask.focus(); host.render();
  const shown = lastTask.getBoundingClientRect(), clip = strip.getBoundingClientRect();
  check(Number(strip.scrollLeft) > 0 && shown.x + shown.width > clip.x && shown.x < clip.x + clip.width,
    'Low-width focus reveals a real window after all Quick Launch pins');
  const firstQuick = get('shell-window-pin-org.pollyui.files');
  firstQuick.focus(); host.render();
  check(Number(strip.scrollLeft) === 0, 'Focus returns through the same viewport to the first launcher');
  host.key('Tab', 'keydown', { text: false }); host.render();
  check(document.activeElement === get('shell-window-pin-org.pollyui.settings'),
    'Native Tab traverses compact Quick Launch buttons');
  const stripBox = strip.getBoundingClientRect();
  host.scroll(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2, 10000); host.render();
  check(Number(strip.scrollLeft) > 0, 'The original horizontal wheel reaches later windows beyond Quick Launch');
  capture('quick-launch');
  render(h('view', { id: 'xp-programs-stage', style: { width: 360, height: 260 } }), document.body);
  const programStage = get('xp-programs-stage');
  let programsOpen = false, placement, programEpoch = 0, programSlots = [], programCalls = 0;
  const changePrograms = (next, focus = '') => {
    if (next) placement = programsPlacement(get('shell-applications'), get('shell-all-programs'),
      xp.layout.menuRowHeight ?? 32);
    programsOpen = next; programEpoch++;
    if (!next) programSlots = [];
    paintPrograms(); host.render();
    if (focus === 'trigger') get('shell-all-programs').focus();
    else if (focus) (get('shell-program-list').childNodes.find(node => node.tabIndex >= 0) ??
      get('shell-program-back')).focus();
  };
  function paintPrograms() {
    render(applicationsView(xp, entries, '', action, action, action, action, '', null, null, {
      open: programsOpen, placement, epoch: programEpoch, slots: programSlots, change: changePrograms,
      launch: id => { if (programsOpen && entries.some(entry => entry.id === id && !entry.unavailable)) programCalls++; },
    }), programStage);
  }
  paintPrograms(); host.render();
  const programTrigger = get('shell-all-programs');
  programTrigger.focus(); host.key('ArrowRight', 'keydown', { text: false });
  for (let i = 0; i < 4; i++) host.render();
  const programRoot = get('shell-program-menu'), startRoot = get('shell-applications');
  const pb = programRoot.getBoundingClientRect(), sb = startRoot.getBoundingClientRect();
  check(programsOpen && pb.x >= sb.x && pb.y >= sb.y &&
    pb.x + pb.width <= sb.x + sb.width && pb.y + pb.height <= sb.y + sb.height,
    'XP All Programs stays inside the actual existing Start client bounds');
  host.key('End', 'keydown', { text: false }); host.render();
  const programLast = get('shell-program-app9'), programList = get('shell-program-list');
  const pl = programLast.getBoundingClientRect(), pc = programList.getBoundingClientRect();
  check(document.activeElement === programLast && pl.y >= pc.y && pl.y + pl.height <= pc.y + pc.height,
    'XP Programs reveals the final real entry through the existing long-list path');
  host.key('Enter', 'keydown', { text: false }); host.render();
  check(programCalls === 1, 'XP All Programs actual keyboard activation executes one registered entry');
  host.key('Escape', 'keydown', { text: false }); host.render();
  check(!programsOpen && document.activeElement === programTrigger, 'XP All Programs Escape returns to its Start trigger');
  console.log('XP_PROGRAMS ' + JSON.stringify({ root: [sb.x, sb.y, sb.width, sb.height],
    menu: [pb.x, pb.y, pb.width, pb.height], programCalls, focusReturned: document.activeElement === programTrigger }));
  const profileName = '\u6797\u6d69 \ud83d\udc30 ' + '\u957f\u663e\u793a\u540d'.repeat(12);
  let displayProfile = parseLocalUserProfile('lin:x:1000:1000:' + profileName + ',Unused:/unused:/unused\n', 1000);
  let profileLaunches = 0;
  const paintProfile = () => {
    render(startMenuView(xp, entries, '', action, () => profileLaunches++, action, action,
      '', null, null, null, null, null, null, displayProfile), programStage);
    for (let i = 0; i < 4; i++) host.render();
  };
  paintProfile();
  const profileHeader = get('shell-start-profile'), profileSearch = get('shell-app-search'),
    profileApp = get('shell-app-org.pollyui.files');
  const headerBounds = profileHeader.getBoundingClientRect();
  check(headerBounds.height === 64 && get('shell-start-user-name').getAttribute('aria-label') === profileName,
    'Injected local Unicode display name keeps the 64px XP header and complete accessible name');
  for (const id of ['shell-start-user-name', 'shell-start-user-detail']) {
    const b = get(id).getBoundingClientRect();
    check(b.x >= headerBounds.x && b.y >= headerBounds.y && b.right <= headerBounds.right && b.bottom <= headerBounds.bottom,
      'Local name and UID remain clipped inside the original header bounds');
  }
  check(get('shell-start-user-detail').getAttribute('aria-label') === 'lin | UID 1000',
    'Only the injected actual username and numeric UID become secondary display metadata');
  check(host.save(directory + '\\xp-shell-local-profile.png'), 'Save local display profile');
  profileApp.focus();
  displayProfile = parseLocalUserProfile('', 1000); paintProfile();
  check(get('shell-start-user-name').getAttribute('aria-label') === 'User 1000' &&
    get('shell-start-user-detail').getAttribute('aria-label') === 'Local name unavailable',
    'Unavailable local record uses the known UID and a visible diagnostic instead of a guessed user');
  displayProfile = parseLocalUserProfile('', undefined); paintProfile();
  check(get('shell-start-user-name').getAttribute('aria-label') === 'User unavailable',
    'Unknown UID is not presented as root or a fabricated account');
  check(get('shell-start-profile') === profileHeader && get('shell-app-search') === profileSearch &&
    get('shell-app-org.pollyui.files') === profileApp && document.activeElement === profileApp,
    'Display snapshot changes retain the original header, root input, app control and current focus');
  click(profileApp);
  check(profileLaunches === 1, 'Original application pointer action still activates once with a display profile');
  displayProfile = null; paintProfile();
  check(!get('shell-start-user') && profileHeader.textContent.includes('PollyDesktop'),
    'Legacy profile-null view retains the original brand');
  console.log('XP_LOCAL_PROFILE ' + JSON.stringify({ header: rect(profileHeader), fullName: profileName,
    profileLaunches, sameSearch: get('shell-app-search') === profileSearch,
    scope: 'Injected local display snapshots and actual software GUI only; not Windows account, Linux passwd or authentication qualification' }));
  console.log('PASS: actual XP taskbar/Start surface geometry, states, actions, custom width and low-height reachability');
  console.log('XP_QUICK_LAUNCH ' + JSON.stringify({ quickCalls, windowCalls, pins: entries.length,
    scrollLeft: Number(strip.scrollLeft), firstLauncher: rect(firstQuick), lastWindow: rect(lastTask) }));
}
