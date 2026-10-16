import { h, render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { button } from './desktop/shared/ui/button.mjs';
import { desktopCommand } from './desktop/shared/ui/presentation.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const rgb = color => color.toLowerCase();
const settle = () => { host.render(); host.render(); host.render(); };
export function checkCommonButtons(verify = false) {
  const results = [];
  for (const id of ['server2003', 'xp', 'modern']) {
    let theme = getDesktopTheme(id), disabled = false, calls = 0;
    const scene = () => {
      const node = button('common-button', 'Button', theme, () => { if (!disabled) calls++; }, true,
        { width: 140, height: 30, opacity: 0.73 });
      node.props['aria-disabled'] = String(disabled);
      render(h('view', { style: { padding: 20, gap: 20 } }, node,
        desktopCommand('common-command', 'Command', theme, () => calls++,
          { enabled: !disabled, style: { width: 140, height: 30, opacity: 0.61 } })), document.body);
      settle();
    };
    const point = node => { const r = node.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
    const mouse = (name, node, extra = {}) => { host.mouse(name, ...point(node), extra); settle(); };
    scene();
    const node = document.getElementById('common-button'), command = document.getElementById('common-command');
    mouse('mousedown', node, { button: 2 }); mouse('mouseup', node, { button: 2 }); mouse('click', node, { button: 2 });
    const nonPrimary = calls;
    node.focus(); host.key('Enter', 'keydown', { text: false, repeat: true }); settle();
    command.focus(); host.key(' ', 'keydown', { text: false, repeat: true }); settle();
    const repeats = calls - nonPrimary;
    mouse('mousemove', command); mouse('mousedown', command);
    const heldFrom = command.style.gradientFrom;
    theme = { ...theme, button: { ...theme.button, from: '#e0c090', to: '#706050' },
      colors: { ...theme.colors, focus: '#b02080', light: '#fbf0da' } };
    scene();
    const rethemeFrom = command.style.gradientFrom;
    mouse('mousecancel', command);
    const canceledFrom = command.style.gradientFrom;
    command.focus(); scene();
    const focus = command.querySelector('.theme-focus-ring') || command.querySelector('.luna-focus-ring');
    const focusOpacity = focus ? Number(focus.style.opacity) : null;
    mouse('mousedown', command);
    const heldAgain = command.style.gradientFrom;
    command.__listeners.lostmousecapture({ currentTarget: command }); settle();
    const lostFrom = command.style.gradientFrom;
    host.mouse('mousemove', 0, 0); settle(); mouse('mousemove', command);
    theme = { ...theme, colors: { ...theme.colors, focus: '#306090' } }; scene();
    const hoveredRing = command.querySelector('.luna-hot-ring');
    if (verify && hoveredRing) check(Number(hoveredRing.style.opacity) === 1, 'Immutable retheme keeps the live Luna hover ring');
    disabled = true; scene(); const beforeDisabled = calls;
    mouse('mousedown', node); mouse('mouseup', node); mouse('click', node);
    disabled = false; scene();
    const result = { id, nonPrimary, repeats, heldFrom, rethemeFrom, canceledFrom, focusOpacity, heldAgain, lostFrom,
      sameDOM: document.getElementById('common-command') === command, selected: node.getAttribute('aria-pressed'),
      opacity: [Number(node.style.opacity), Number(command.style.opacity)], disabledCalls: calls - beforeDisabled };
    if (verify) {
      check(nonPrimary === 0 && repeats === 0, 'Shared activation rejects non-primary and repeated keys');
      check(rgb(rethemeFrom) !== rgb(heldFrom) && rgb(canceledFrom) !== rgb(rethemeFrom),
        'Retheme preserves held state with new palette and cancellation releases it');
      check(heldAgain !== lostFrom, 'Lost mouse capture clears the held paint');
      check(focusOpacity === 1 && result.sameDOM && result.selected === 'true' &&
        result.opacity[0] === 0.73 && result.opacity[1] === 0.61 && result.disabledCalls === 0,
        'Retheme preserves focus/selection/caller opacity and disabled guard');
    }
    results.push(result);
    render(null, document.body);
  }
  console.log('COMMON_BUTTON_CONTRACT ' + JSON.stringify({ verify, results }));
}
