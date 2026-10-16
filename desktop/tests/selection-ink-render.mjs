import { h, render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { desktopCommand } from './desktop/shared/ui/presentation.mjs';
import { desktopView } from './desktop/shell/desktop-view.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const settle = () => { host.render(); host.render(); host.render(); };
const box = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
const sample = node => {
  const [x, y, width, height] = box(node), result = [];
  for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) result.push(host.pixel(x + dx, y + dy));
  return result;
};
export async function checkSelectionInk(directory, verify = true) {
  const themes = ['xp', 'server2003', 'aqua', 'lion', 'bigsur', 'modern'].map(getDesktopTheme);
  const source = document.createElement('canvas'); source.width = source.height = 36;
  const context = source.getContext('2d'); context.fillStyle = '#23a060'; context.fillRect(0, 0, 36, 36);
  context.fillStyle = '#ff8040'; context.fillRect(10, 10, 16, 16);
  const blob = await new Promise(resolve => source.toBlob(resolve));
  const bitmap = createBitmap(await blob.arrayBuffer(), 36 * 36), images = new Map([['bitmap', bitmap.key]]);
  const items = [{ id: 'fallback', name: 'Caption', x: 0, y: 0 }, { id: 'missing', name: 'Missing', x: 96, y: 0 },
    { id: 'bitmap', name: 'Bitmap', x: 192, y: 0 }];
  const entries = items.map(item => ({ ...item, ...(item.id === 'missing' ? { unavailable: 'Fixture missing application' } : {}) }));
  const state = { items, selected: new Set(), focused: 'fallback' };
  let calls = 0, current = themes[0], selected = false, enabled = true;
  const scene = () => {
    state.selected = new Set(selected ? items.map(item => item.id) : []);
    render(h('view', { style: { width: '100%', height: '100%', padding: 20, backgroundColor: current.colors.body, gap: 20 } },
      desktopCommand('ink-quiet', 'Quiet command', current, () => calls++,
        { icon: 'folder', selected, enabled, quiet: true, style: { width: 220, height: 32 } }),
      desktopCommand('ink-ordinary', 'Ordinary command', current, () => {},
        { icon: 'folder', selected: true, style: { width: 220, height: 32 } }),
      h('view', { style: { position: 'relative', width: 330, height: 110 } },
        desktopView(current, '', state, entries, '', images))), document.body);
    settle();
  };
  const find = id => document.getElementById(id);
  const row = id => find('shell-desktop-icon-' + id);
  const records = [];
  try {
    for (const theme of themes) {
      current = theme; selected = false; enabled = true; render(null, document.body); scene();
      const normal = sample(find('ink-quiet')), desktopNormal = sample(row('fallback').childNodes[1]);
      check(host.save(directory + '/normal-' + theme.id + '.png'), 'Save original unselected guard');
      selected = true; scene();
      const command = find('ink-quiet'), label = command.querySelector('.theme-command-label');
      const caption = row('fallback').childNodes[1], unavailable = row('missing').lastChild;
      const bitmapBox = row('bitmap').firstChild.getBoundingClientRect();
      const result = { id: theme.id, quiet: label.style.color, caption: caption.style.color,
        unavailable: unavailable.style.color, expected: theme.colors.selectionText, ordinary: find('ink-ordinary').querySelector('.theme-command-label').style.color,
        fallbackGlyph: row('fallback').firstChild.firstChild.style.borderColor,
        commandIcon: command.querySelector('.theme-icon-ink-border')?.style.borderColor,
        bitmapPixel: host.pixel(bitmapBox.x + 18, bitmapBox.y + 18), captionPixels: sample(caption).filter(color => color.toLowerCase() === theme.colors.selectionText).length,
        boxes: { command: box(command), caption: box(caption) } };
      if (verify) check(result.quiet === result.expected && result.caption === result.expected &&
        result.unavailable === result.expected && result.fallbackGlyph === result.expected && result.commandIcon === result.expected &&
        result.captionPixels > 0 && result.bitmapPixel === '#FF8040',
        'Quiet and desktop selection read the semantic foreground while bitmap content stays original');
      check(host.save(directory + '/selected-' + theme.id + '.png'), 'Save actual selected consumer');
      selected = false; scene(); host.mouse('mousemove', 799, 599); settle();
      check(JSON.stringify(sample(find('ink-quiet'))) === JSON.stringify(normal) &&
        JSON.stringify(sample(row('fallback').childNodes[1])) === JSON.stringify(desktopNormal),
        'Returning to normal restores unselected command and desktop pixels');
      const quiet = find('ink-quiet'), r = quiet.getBoundingClientRect();
      const states = [];
      for (const [phase, type] of [['hover', 'mousemove'], ['held', 'mousedown'], ['cancel', 'mousecancel'], ['leave', 'mousemove']]) {
        host.mouse(type, phase === 'leave' ? 799 : r.x + r.width / 2, phase === 'leave' ? 599 : r.y + r.height / 2); settle();
        const ink = quiet.querySelector('.theme-command-label').style.color;
        const background = host.pixel(r.right - 10, r.y + r.height / 2).toLowerCase();
        const expected = background === theme.colors.selection ? theme.colors.selectionText : theme.colors.text;
        const icon = quiet.querySelector('.theme-command-icon');
        const iconInk = icon?.querySelector('.theme-icon-ink-border')?.style.borderColor;
        const expectedIcon = background === theme.colors.selection ? theme.colors.selectionText : theme.colors.accent;
        if (verify) check(ink === expected && iconInk === expectedIcon,
          'Live semantic ink matches the real quiet background through ' + theme.id + '/' + phase);
        states.push({ phase, ink, background, iconInk });
      }
      result.states = states;
      records.push(result);
    }
    current = getDesktopTheme('server2003'); selected = false; scene();
    let command = find('ink-quiet');
    const mouse = name => { const r = command.getBoundingClientRect(); host.mouse(name, r.x + r.width / 2, r.y + r.height / 2); settle(); };
    mouse('mousemove'); mouse('mousedown');
    const custom = { ...current, colors: { ...current.colors, selectionText: '#e040d0' } };
    current = custom; scene();
    const held = command.querySelector('.theme-command-label').style.color;
    const heldIcon = command.querySelector('.theme-icon-ink-border')?.style.borderColor;
    mouse('mousecancel'); const canceled = command.querySelector('.theme-command-label').style.color;
    selected = true; scene(); enabled = false; scene();
    const disabled = command.querySelector('.theme-command-label').style.color, disabledTruth = command.getAttribute('aria-pressed');
    enabled = true; scene(); const retained = find('ink-quiet') === command;
    const count = calls;
    for (const type of ['mousedown', 'mouseup', 'click']) mouse(type);
    command.focus(); host.key('Enter', 'keydown', { text: false }); settle();
    if (verify) check(held === '#e040d0' && heldIcon === '#e040d0' && canceled === current.colors.text && disabled === current.colors.muted &&
      disabledTruth === 'true' && retained && calls === count + 2, 'Custom token and retained live states preserve disabled/selection/actions');
    const legacy = { ...current, colors: { ...current.colors } }; delete legacy.colors.selectionText;
    current = legacy; selected = true; scene();
    const missing = { quiet: command.querySelector('.theme-command-label').style.color,
      caption: row('fallback').childNodes[1].style.color, ordinary: find('ink-ordinary').querySelector('.theme-command-label').style.color,
      commandIcon: command.querySelector('.theme-icon-ink-border')?.style.borderColor,
      fallbackGlyph: row('fallback').firstChild.firstChild.style.borderColor };
    check(missing.quiet === legacy.colors.accentText && missing.caption === legacy.colors.text &&
      missing.ordinary === legacy.colors.accentText && missing.commandIcon === legacy.colors.accent &&
      missing.fallbackGlyph === legacy.colors.accent, 'Missing token retains each consumer legacy fallback, including ordinary Classic commands');
    console.log('SELECTION_INK_ACTUAL ' + JSON.stringify({ verify, records, custom: { held, canceled, disabled, disabledTruth, retained }, missing, calls }));
  } finally { document.activeElement?.blur(); render(null, document.body); bitmap.close(); }
}
