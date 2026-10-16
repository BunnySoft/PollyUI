import { createDisplayPage } from './desktop/apps/settings/ui/display-page.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
export function checkDisplayScalePresets(directory) {
  check(host.width === 800 && host.height === 600, 'Fixed 800x600 native GUI fixture');
  const page = createDisplayPage(), commands = [];
  let theme = getDesktopTheme('server2003'), busy = false, paints = 0;
  let snapshot = { version: 1, available: true, error: '', status: 'Controlled display UI; no output backend',
    serial: 7, pendingToken: 0, remainingMs: 0, outcome: 0, message: '',
    heads: [{ id: 1, name: 'Controlled display', make: 'Fixture', model: 'Screen', serialNumber: 'one',
      description: 'Native GUI fixture', enabled: true, width: 1920, height: 1080, refresh: 60000,
      scale: 1.25, x: 0, y: 0, transform: 0, adaptiveSync: false, modes: [] }] };
  const paint = () => {
    paints++; page.paint(document.body, theme, snapshot, busy, (...args) => commands.push(args), paint);
  };
  const find = id => document.getElementById(id);
  const preset = percent => find('shell-output-1-scale-' + percent);
  const selected = percent => {
    for (const value of [100, 150, 200])
      check(preset(value).getAttribute('aria-checked') === String(value === percent), 'Actual radio preset truth ' + value);
  };
  const click = node => {
    const rect = node.getBoundingClientRect();
    check(rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 &&
      rect.x + rect.width <= host.width && rect.y + rect.height <= host.height, 'Control is visible');
    host.mouse('mousedown', rect.x + rect.width / 2, rect.y + rect.height / 2);
    host.mouse('mouseup', rect.x + rect.width / 2, rect.y + rect.height / 2);
    host.mouse('click', rect.x + rect.width / 2, rect.y + rect.height / 2); host.render();
  };
  try {
    paint(); host.render(); selected(null);
    const input = find('shell-output-1-scale');
    check(preset(100).getAttribute('role') === 'radio' &&
      find('shell-output-1-scale-presets').getAttribute('role') === 'radiogroup',
    'Production presets expose actual radio/group semantics');
    click(preset(100)); selected(100);
    check(input.textContent === '1', 'Actual pointer selects factor 1');
    click(preset(150)); selected(150);
    check(input.textContent === '1.5', 'Actual pointer selects factor 1.5');
    preset(200).focus(); host.key('Enter', 'keydown', { text: false }); host.render(); selected(150);
    host.key(' ', 'keydown', { text: false }); host.render(); selected(200);
    check(input.textContent === '2' && commands.length === 0, 'Space selects a radio draft; Enter does not select or apply');
    host.key('ArrowLeft', 'keydown', { text: false }); host.render(); selected(150);
    check(document.activeElement === preset(150) && input.textContent === '1.5', 'Arrow navigation selects and focuses within the group');
    host.key('End', 'keydown', { text: false }); host.render(); selected(200);
    click(input); host.key('a', 'keydown', { ctrlKey: true });
    const before = paints;
    host.text('1.25'); host.render(); selected(null);
    check(paints === before + 1, 'One native text edit causes one repaint');
    check(find('shell-output-1-scale') === input && document.activeElement === input, 'Typing retains the actual input and focus');
    host.key('Home'); host.key('ArrowRight', 'keydown', { shiftKey: true }); host.render();
    const caret = input.childNodes[2].style.left, ranges = input.firstChild.childNodes.map(node =>
      [node.style.left, node.style.width]);
    check(ranges.length > 0, 'Actual keyboard selection is painted');
    theme = getDesktopTheme('modern'); paint(); host.render();
    check(find('shell-output-1-scale') === input && document.activeElement === input &&
      input.textContent === '1.25' && input.firstChild.childNodes.length === ranges.length,
    'Retheme preserves actual input, text, focus and selection');
    host.text('1'); host.render();
    check(input.textContent === '1.25', 'Retheme preserves the selected character range across theme font-size changes');
    check(input.style.borderColor.toLowerCase() === theme.colors.border.toLowerCase(), 'Retained input consumes the new theme');
    click(find('shell-output-1-scale-up')); selected(150);
    click(find('shell-output-1-scale-up')); selected(null);
    check(input.textContent === '1.75', 'Original custom increment remains available');
    click(preset(200)); selected(200);
    busy = true; paint(); host.render();
    const disabled = preset(150), beforeBusy = paints;
    check(disabled.getAttribute('aria-disabled') === 'true' && disabled.tabIndex === -1, 'Actual busy semantics');
    click(disabled); disabled.focus();
    for (const key of ['Enter', ' ', 'ArrowRight', 'Home', 'End']) host.key(key, 'keydown', { text: false });
    host.render();
    check(paints === beforeBusy && commands.length === 0 && input.textContent === '2', 'Busy factory disables pointer, Space and radio navigation');
    busy = false; paint(); host.render(); click(preset(150)); selected(150);
    check(host.save(directory + '\\display-scale-150.png'), 'Save native percentage selector page');
    click(find('shell-output-apply'));
    check(commands.length === 1 && commands[0][0] === 'ApplyDisplays' &&
      JSON.parse(commands[0][1]).heads[0].scale === 1.5, 'One Apply uses the exact factor through the existing display contract');
    snapshot = { ...snapshot, pendingToken: 99, remainingMs: 15000 }; paint(); host.render();
    check(!preset(150) && /trusted confirmation.*15 seconds/.test(document.body.textContent), 'Existing trusted pending-only surface');
    snapshot = { ...snapshot, pendingToken: 0, serial: 8 }; paint(); host.render(); selected(null);
    check(find('shell-output-1-scale') !== input && find('shell-output-1-scale').textContent === '1.25',
      'Pending/serial transition retires the draft and input');
    console.log('DISPLAY_SCALE_UI ' + JSON.stringify({ viewport: [host.width, host.height],
      presets: [100, 150, 200], appliedScale: JSON.parse(commands[0][1]).heads[0].scale,
      customScale: 1.25, retainedCaret: caret, retainedSelection: ranges,
      themes: ['server2003', 'modern'], nativeOutputScaleTest: false }));
    console.log('PASS: actual native Settings scale pointer/keyboard, custom input, retained retheme, busy and Apply payload');
  } finally { page.detach(); }
}
