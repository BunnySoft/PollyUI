import { render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { displaysView } from './desktop/apps/settings/ui/displays.mjs';
import { readDisplayDraft } from './desktop/apps/settings/ui/display-inputs.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const pixels = node => {
  const r = node.getBoundingClientRect(), values = [];
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++)
    values.push(host.pixel(r.x + x, r.y + y));
  return values;
};
export function checkDisplayFieldAppearance(directory, verify = false) {
  check(host.width === 800 && host.height === 600, 'Fixed unscaled 800x600 GUI fixture');
  for (const id of ['server2003', 'modern']) {
    render(null, document.body);
    const theme = getDesktopTheme(id), inputs = new Map(), applied = [];
    const draft = { serial: 7, heads: [{ id: 1, name: 'Controlled display UI', enabled: true,
      width: 1920, height: 1080, refresh: 60000, scale: 1, x: 0, y: 0, transform: 0, modes: [] }] };
    const scene = current => {
      render(displaysView(current, document, draft, inputs, () => {},
        () => applied.push(readDisplayDraft(draft, inputs)), () => {}), document.body);
      host.render();
    };
    scene(theme);
    const input = inputs.get('shell-output-1-width'), root = input.root;
    const r = root.getBoundingClientRect();
    const first = { border: root.style.borderColor, radius: Number(root.style.borderRadius),
      rect: [r.x, r.y, r.width, r.height], value: input.value, caret: input.getCaret(),
      padding: [Number(root.style.paddingLeft), Number(root.style.paddingTop)],
      fontSize: Number(root.childNodes[1].style.fontSize) };
    const initialPixels = pixels(root);
    check(host.save(directory + '\\' + id + '-first.png'), 'Save actual first Settings field');
    scene(theme);
    const refreshed = { border: root.style.borderColor, radius: Number(root.style.borderRadius) };
    const refreshedPixels = pixels(root);
    check(host.save(directory + '\\' + id + '-repaint.png'), 'Save actual same-theme repaint');
    const changedPixels = initialPixels.reduce((count, color, at) => count + Number(color !== refreshedPixels[at]), 0);
    if (verify) {
      check(first.border.toLowerCase() === theme.colors.border.toLowerCase() &&
        first.radius === theme.button.radius, 'First field uses the same existing theme mapping as repaint');
      check(first.fontSize === theme.layout.fontSize && first.padding.every(value => value === 7),
        'Existing font role and padding remain unchanged');
      check(changedPixels === 0, 'Same-theme repaint does not correct or alter first-frame field pixels');
    }
    root.focus(); input.selectAll(); host.render();
    const selection = input.getSelection(), caret = input.getCaret();
    const next = getDesktopTheme(id === 'server2003' ? 'modern' : 'server2003');
    scene(next);
    check(inputs.get('shell-output-1-width') === input && document.activeElement === root,
      'Retheme retains actual input object, node and focus');
    check(input.value === '1920' && input.getCaret() === caret &&
      JSON.stringify(input.getSelection()) === JSON.stringify(selection),
    'Retheme preserves the existing value, caret and selection');
    check(root.style.borderColor.toLowerCase() === next.colors.border.toLowerCase() &&
      Number(root.style.borderRadius) === next.button.radius, 'Retheme consumes the selected theme mapping');
    check(root.firstChild.childNodes.length > 0 &&
      root.firstChild.firstChild.style.backgroundColor.toLowerCase() === next.colors.selection.toLowerCase() &&
      root.childNodes[2].style.backgroundColor.toLowerCase() === next.colors.text.toLowerCase(),
    'Focused actual selection and caret consume the existing theme colors');
    host.text('2560'); host.render();
    check(input.value === '2560' && readDisplayDraft(draft, inputs).heads[0].width === 2560 &&
      readDisplayDraft(draft, inputs).heads[0].refresh === 60000, 'Actual SDK text input and display draft roundtrip remain intact');
    const apply = document.getElementById('shell-output-apply').getBoundingClientRect();
    host.mouse('mousedown', apply.x + apply.width / 2, apply.y + apply.height / 2);
    host.mouse('mouseup', apply.x + apply.width / 2, apply.y + apply.height / 2);
    host.mouse('click', apply.x + apply.width / 2, apply.y + apply.height / 2); host.render();
    check(applied.length === 1 && applied[0].heads[0].width === 2560, 'Existing Apply callback records one correct draft, without invoking a display backend');
    root.blur(); host.render();
    check(root.firstChild.childNodes.length === 0 && root.childNodes[2].style.backgroundColor === 'transparent',
      'Blur clears actual selection/caret paint without discarding the value');
    console.log('DISPLAY_FIELD_APPEARANCE ' + JSON.stringify({ theme: id, viewport: [800, 600], scale: 1,
      first, refreshed, expected: { border: theme.colors.border, radius: theme.button.radius },
      changedPixels, roundtripWidth: applied[0].heads[0].width, selectionBeforeRetheme: selection }));
  }
  console.log(verify ? 'PASS: actual Settings first/repaint field parity and retained editing roundtrip' :
    'BASELINE: actual first-frame versus repaint differences, no after assertions');
}
