import { h, render } from './gui/sdk/js/reconciler.mjs';
import { BUILTIN_THEME_CATALOG, getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { applyThemeOverrides } from './desktop/shared/ui/theme-schema.mjs';
import { panelView } from './desktop/shell/views.mjs';
import { desktopCommand } from './desktop/shared/ui/presentation.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const pixels = () => {
  const result = [];
  for (let y = 0; y < host.height; y++) for (let x = 0; x < host.width; x++) result.push(host.pixel(x, y));
  return result;
};
const changed = (a, b) => a.reduce((n, value, i) => n + Number(value !== b[i]), 0);

export function checkMacMenubarStates(directory, verify = true) {
  check(host.width === 400 && host.height === 100, 'Unscaled 400x100 menubar fixture');
  for (const [id, painted] of [['aqua', true], ['lion', false], ['bigsur', false], ['lion', true], ['bigsur', true]]) {
    render(h('view', {}), document.body);
    const theme = painted && id !== 'aqua' ? applyThemeOverrides(BUILTIN_THEME_CATALOG,
      JSON.stringify({ schemaVersion: 1, themes: { [id]: { button: { surfaceStyle: 'aqua' } } } }))
      .themes.find(item => item.id === id) : getDesktopTheme(id);
    const name = id + (painted && id !== 'aqua' ? '-painted' : '');
    let activated = 0;
    const scene = () => {
      render(h('view', { style: { width: '100%', height: '100%', backgroundColor: '#406080' } },
        h('view', { style: { width: '100%', height: theme.layout.menuBarHeight } },
          panelView(theme, '10:31', () => { activated++; }, '', () => {})),
        desktopCommand('ordinary-button', 'Ordinary button', theme, () => {},
          { style: { position: 'absolute', left: 20, top: 50, width: 160 } })), document.body);
      host.render();
    };
    scene();
    const menu = document.getElementById('shell-menu');
    const button = document.getElementById('ordinary-button');
    const bounds = menu.getBoundingClientRect(), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    const radii = {};
    const state = name => {
      host.render();
      radii[name] = Number(menu.style.borderRadius);
      if (verify) check(radii[name] === 0, 'Menu item stays square during ' + name);
      if (['normal', 'hover', 'focus'].includes(name))
        check(host.save(directory + '\\' + id + (painted ? '-painted' : '') + '-menubar-' + name + '.png'),
          'Save actual ' + name + ' menubar');
      return pixels();
    };
    const normal = state('normal');
    host.mouse('mousemove', x, y);
    state('hover');
    host.mouse('mousemove', 390, 90);
    const leave = state('leave');
    menu.focus();
    state('focus');
    host.mouse('mousedown', x, y);
    state('pressed');
    host.mouse('mouseup', x, y);
    host.mouse('click', x, y);
    state('click');
    check(activated === 1 && document.activeElement === menu, 'One actual click activates once and preserves focus');
    scene();
    check(document.getElementById('shell-menu') === menu, 'Reconciliation retains the menu node');
    state('reconciled');
    host.mouse('mousemove', 390, 90);
    menu.blur();
    const restored = state('blur');
    if (verify) check(changed(normal, leave) === 0 && changed(normal, restored) === 0,
      'Leave and blur restore all original scene pixels');
    button.focus(); host.render();
    check(Number(button.style.borderRadius) === theme.button.radius, 'Ordinary Aqua buttons retain configured roundness');
    console.log('MAC_MENUBAR ' + JSON.stringify({ name, theme: theme.id, viewport: [400, 100], scale: 1,
      menu: [bounds.x, bounds.y, bounds.width, bounds.height], radii, activated,
      leaveChangedPixels: changed(normal, leave), restoredChangedPixels: changed(normal, restored),
      ordinaryButtonRadius: Number(button.style.borderRadius) }));
    document.activeElement?.blur(); host.mouse('mousemove', 390, 90); host.render();
  }
  console.log(verify ? 'PASS: actual square Mac menubar state painting, leave/blur restoration and one click' :
    'BASELINE: actual Mac menubar state radius and pixels recorded');
}
