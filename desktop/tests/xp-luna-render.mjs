import { h, render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme } from './desktop/shell/themes.mjs';
import { panelView } from './desktop/shell/views.mjs';
import { lunaButtonPaint, lunaButtonDetail, lunaVisualEvents } from './desktop/shell/luna-primitives.mjs';

const theme = getDesktopTheme('xp');
function check(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
  console.log('PASS: ' + message);
}
const samples = ['normal', 'hover', 'pressed', 'disabled', 'focus'];
const sample = (name, index) => {
  const disabled = name === 'disabled';
  return h('view', { id: 'luna-' + name, role: 'button', tabIndex: disabled ? -1 : 0,
    'aria-disabled': String(disabled), style: {
      position: 'absolute', left: 12 + index * 85, top: 50, width: 73, height: 21,
      borderWidth: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
      ...lunaButtonPaint(theme, { disabled }),
    }, ...(disabled ? {} : lunaVisualEvents(theme)) },
    lunaButtonDetail(theme, 'button', disabled),
    h('view', { style: { fontSize: 11, color: disabled ? theme.colors.muted : theme.colors.text,
      pointerEvents: 'none' } }, 'OK'));
};
const panel = panelView(theme, '10:31 AM', () => {}, '', () => {}, [
  { id: 1, title: 'Sample window', active: true },
], () => {}, () => {}, { name: 'Workspaces', open() {} }, { count: 0, open() {} });
render(h('view', { style: { width: '100%', height: '100%', position: 'relative',
  backgroundColor: theme.colors.body } },
  h('view', { style: { position: 'absolute', left: 12, top: 12, fontSize: 13, color: '#000000' } },
    'Luna primitive fixture - NOT a compositor screenshot'),
  samples.map(sample),
  h('view', { style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: theme.panel.height } }, panel)),
document.body);
host.render();
const get = name => document.getElementById('luna-' + name);
const point = node => [node.offsetLeft + node.offsetWidth / 2, node.offsetTop + node.offsetHeight / 2];
for (const name of samples) {
  const node = get(name);
  check(node.offsetWidth === 73 && node.offsetHeight === 21, name + ' uses unscaled reference button geometry');
}
const hover = get('hover');
host.mouse('mousemove', ...point(hover)); host.render();
check(hover.querySelector('.luna-hot-ring').style.opacity === '1', 'text center enters the button hover target');
check(host.pixel(hover.offsetLeft + 2, hover.offsetTop + 10) === '#EFB73B', 'hover paints a warm inner ring');
const pressed = get('pressed');
host.mouse('mousemove', ...point(pressed)); host.render();
const before = host.pixel(pressed.offsetLeft + 5, pressed.offsetTop + 4);
host.mouse('mousedown', ...point(pressed)); host.render();
check(pressed.style.gradientFrom === theme.button.to, 'pointer press reverses the gradient');
check(host.pixel(pressed.offsetLeft + 5, pressed.offsetTop + 4) !== before, 'press changes actual rendered pixels');
host.mouse('mouseup', ...point(pressed)); host.render();
check(pressed.style.gradientFrom === theme.button.from, 'release restores the normal gradient');
const focused = get('focus');
focused.focus(); host.render();
check(focused.querySelector('.luna-focus-ring').style.opacity === '1', 'keyboard focus indicator is visible');
const dot = focused.querySelector('.luna-focus-ring').firstChild.firstChild;
check(host.pixel(dot.offsetLeft, dot.offsetTop) === '#000000', 'focus indicator paints actual dotted ink');
const disabled = get('disabled');
check(host.pixel(disabled.offsetLeft + 5, disabled.offsetTop + 10) === '#ECE9D8', 'disabled uses an opaque dialog face');
check(document.getElementById('shell-menu').offsetWidth === 97, 'original Polly launcher uses reference width');
check(document.getElementById('shell-window-1').offsetHeight === 26, 'task button fits the 30 pixel taskbar');
check(document.getElementById('shell-panel').offsetHeight === 30, 'taskbar height is rendered, not just stored');
check(host.save('build/xp-luna-primitives-' + host.width + 'x' + host.height + '.png'), 'primitive evidence saved');
console.log('PASS: actual PollyUI Luna primitive pixels; native compositor acceptance remains separate');
