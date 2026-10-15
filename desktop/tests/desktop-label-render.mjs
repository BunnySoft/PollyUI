import { h, render } from './gui/sdk/js/reconciler.mjs';
import { BUILTIN_THEME_CATALOG } from './desktop/shared/ui/themes.mjs';
import { desktopView } from './desktop/shell/desktop-view.mjs';
import { desktopArea } from './desktop/shell/desktop-shortcuts.mjs';
import { createDesktopInteraction, bindDesktopInteraction } from './desktop/shell/desktop-interactions.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const box = node => {
  const { x, y, width, height } = node.getBoundingClientRect();
  return { x, y, width, height };
};
const settle = () => { host.render(); host.render(); };
const names = ['Settings', 'Two line\napplication', 'A very long application name beyond its label',
  'Unicode \u4e2d\u6587 \ud83d\udcda e\u0301', 'Unavailable', 'Bitmap'];

export async function checkDesktopLabels(directory, verify = true) {
  check(host.width === 640 && host.height === 320, 'Unscaled 640x320 desktop-label fixture');
  const source = document.createElement('canvas');
  source.width = source.height = 36;
  const context = source.getContext('2d');
  context.fillStyle = '#2090e0'; context.fillRect(0, 0, 36, 36);
  context.fillStyle = '#ffe080'; context.fillRect(12, 12, 12, 12);
  const blob = await new Promise(resolve => source.toBlob(resolve));
  const bitmap = createBitmap(await blob.arrayBuffer(), 36 * 36);
  const entries = names.map((name, index) => ({ id: 'label-' + index, name,
    ...(index === 4 ? { unavailable: 'Fixture application unavailable' } : {}) }));
  const items = entries.map((entry, index) => ({ ...entry, x: 16 + index * 96, y: 32 }));
  const images = new Map([['label-5', bitmap.key]]);
  const get = id => document.getElementById('shell-desktop-icon-label-' + id);
  const label = id => get(id).childNodes[1];
  const pixels = node => {
    const bounds = box(node), data = [];
    for (let y = Math.ceil(bounds.y); y < Math.floor(bounds.y + bounds.height); y++)
      for (let x = Math.ceil(bounds.x); x < Math.floor(bounds.x + bounds.width); x++) data.push(host.pixel(x, y).toLowerCase());
    return data;
  };
  const click = (node, double = false) => {
    const bounds = box(node), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    for (const type of ['mousedown', 'mouseup', 'click', ...(double ? ['dblclick'] : [])])
      host.mouse(type, x, y, { detail: double ? 2 : 1 });
    settle();
  };
  try {
    for (const id of ['aqua', 'lion', 'bigsur', 'xp']) {
      render(h('view', {}), document.body); settle();
      host.mouse('mousemove', 639, 319);
      let theme = BUILTIN_THEME_CATALOG.themes.find(theme => theme.id === id);
      const launches = [], failures = [], saves = [];
      const paint = () => render(desktopView(theme, '', controller.state, entries, '', images), document.body);
      const controller = createDesktopInteraction({ changed: paint, save: values => saves.push(values),
        launch: key => launches.push(key), failure: error => failures.push(error.message) });
      controller.update(items, desktopArea(640, 320));
      const binding = bindDesktopInteraction(document.body, controller, error => { throw error; });
      try {
        paint(); settle();
        const geometry = items.map((_, index) => ({ icon: box(get(index)), label: box(label(index)) }));
        const normal = pixels(label(0));
        check(host.save(directory + '\\' + id + '-normal.png'), 'Save resting desktop labels');
        if (!verify) {
          console.log('DESKTOP_LABEL_BASELINE ' + JSON.stringify({ id, geometry,
            background: label(0).style.backgroundColor, capsulePixels: normal.filter(value => value === '#243348').length }));
          continue;
        }
        const shadowed = theme.icons.desktopLabelStyle === 'shadow';
        for (let i = 0; i < names.length; i++) {
          const node = label(i), foreground = node.lastChild;
          check(node.offsetHeight <= 44 && node.offsetWidth <= 86 && foreground.textContent === names[i],
            'Original label bounds and Unicode/newline text survive');
          if (shadowed) {
            const shadow = node.firstChild, a = box(shadow.firstChild), b = box(foreground);
            check(shadow.getAttribute('aria-hidden') === 'true' && shadow.style.pointerEvents === 'none' &&
              a.x === b.x && a.y === b.y + 1 && a.width === b.width && a.height === b.height,
            'Hidden noninteractive shadow uses the same native text wrap and one logical-pixel offset');
          }
        }
        check(shadowed ? !normal.includes('#243348') && normal.includes('#000000') && normal.includes('#ffffff') :
          normal.includes('#243348'), 'Real transparent shadow or compatibility capsule pixels');
        const bitmapBox = box(get(5).firstChild);
        check(host.pixel(bitmapBox.x + 18, bitmapBox.y + 18) === '#FFE080',
          'Registered original bitmap remains a 36px rendered consumer');
        host.mouse('mousemove', get(0).offsetLeft + 48, get(0).offsetTop + 2); settle();
        check(host.pixel(get(0).offsetLeft + 48, get(0).offsetTop).toLowerCase() === theme.colors.light,
          'Native hover still paints the existing light border');
        check(host.save(directory + '\\' + id + '-hover.png'), 'Save native hover');
        get(0).focus(); settle();
        check(document.activeElement === get(0), 'Native focus reaches the real option, never shadow text');
        check(host.pixel(get(0).offsetLeft + 48, get(0).offsetTop).toLowerCase() === theme.colors.focus,
          'Native focus retains the existing focus-border color');
        check(host.save(directory + '\\' + id + '-focus.png'), 'Save native focus');
        click(label(0));
        check(controller.state.selected.has('label-0') && launches.length === 0,
          'Real label single-click selects without launching');
        check(label(0).style.backgroundColor === theme.colors.selection &&
          label(0).style.color === theme.colors.text && label(0).childNodes.length === 1,
        'Selection keeps existing colors and removes decorative shadow');
        check(host.save(directory + '\\' + id + '-selected.png'), 'Save selected desktop labels');
        click(label(0), true);
        check(JSON.stringify(launches) === '["label-0"]', 'Real label double-click activates once');
        host.key('Enter'); settle();
        console.log('DESKTOP_LABEL_INPUT ' + JSON.stringify({ id, launches, focused: controller.state.focused,
          selected: [...controller.state.selected], nativeFocus: document.activeElement?.id }));
        check(JSON.stringify(launches) === '["label-0","label-0"]', 'Double-click and Enter each activate once');
        const drag = box(get(0));
        host.mouse('mousedown', drag.x + 40, drag.y + 40);
        host.mouse('mousemove', drag.x + 40, drag.y + 144, { buttons: 1 });
        host.mouse('mouseup', drag.x + 40, drag.y + 144); settle();
        check(controller.state.items[0].y === 120 && saves.length === 1, 'Existing logical group drag and persistence callback');
        host.mouse('mousedown', 8, 24);
        host.mouse('mousemove', 592, 119, { buttons: 1 });
        host.mouse('mouseup', 592, 119); settle();
        check(controller.state.selected.size === 5 && failures.length === 0, 'Existing marquee still intersects real icon boxes');
        check(get(4).getAttribute('aria-description') === 'Fixture application unavailable' &&
          get(4).getAttribute('aria-label') === 'Unavailable (unavailable)', 'Unavailable semantics remain truthful');
        controller.key({ key: 'Escape' }); paint(); settle();
        theme = { ...theme, icons: { ...theme.icons, desktopLabelStyle: 'capsule' } };
        paint(); settle();
        check(label(0).style.backgroundColor === '#243348' && label(0).childNodes.length === 1,
          'Explicit caller capsule override restores the original label');
        console.log('DESKTOP_LABEL_ACTUAL ' + JSON.stringify({ id, shadowed, geometry,
          normalShadowPixels: normal.filter(value => value === '#000000').length,
          launches, persisted: saves.length, unavailable: true, bitmap: [bitmapBox.width, bitmapBox.height] }));
      } finally { binding.stop(); }
    }
  } finally { bitmap.close(); }
  console.log(verify ? 'PASS: actual desktop-label styles, native wrapping, bitmap/fallback, selection and input' :
    'BASELINE: desktop labels use filled capsules before optional appearance support');
}
