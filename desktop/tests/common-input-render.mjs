import { h, render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { displayField } from './desktop/apps/settings/ui/display-inputs.mjs';
import { createNetworkSettings } from './desktop/apps/settings/ui/network.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const fieldAppearance = root => ({ color: root.childNodes[1].style.color, background: root.style.backgroundColor,
  border: root.style.borderColor, focus: root.style['focus:borderColor'], radius: Number(root.style.borderRadius),
  fontSize: Number(root.childNodes[1].style.fontSize), padding: Number(root.style.paddingLeft) });
export function checkCommonInputs(verify = false) {
  let current = getDesktopTheme('server2003');
  const inputs = new Map(), head = { id: 1, name: 'Fixture', width: 1920 };
  const paint = () => {
    render(h('view', { style: { padding: 20 } }, displayField(document, inputs, head, 'width', current)), document.body);
    host.render();
  };
  paint();
  const input = inputs.get('shell-output-1-width'), first = fieldAppearance(input.root);
  paint();
  check(JSON.stringify(first) === JSON.stringify(fieldAppearance(input.root)), 'Display initial appearance equals repaint');
  input.root.focus(); input.selectAll(); host.render();
  const selection = input.getSelection(), caret = input.getCaret();
  current = getDesktopTheme('modern'); paint();
  check(inputs.get('shell-output-1-width') === input && document.activeElement === input.root &&
    input.value === '1920' && input.getCaret() === caret &&
    JSON.stringify(input.getSelection()) === JSON.stringify(selection), 'Actual display editing identity survives retheme');
  const rethemed = fieldAppearance(input.root);
  if (verify) check(first.focus === getDesktopTheme('server2003').colors.focus && rethemed.focus === current.colors.focus,
    'Display focus color consumes the existing theme token on creation and retheme');
  host.compose('pending', 7, 0);
  current = getDesktopTheme('xp'); paint();
  check(input.value === '1920' && input.root.childNodes[1].textContent === 'pending',
    'Retheme keeps actual SDK preedit while preserving the committed value');
  host.text('2560'); host.render(); check(input.value === '2560', 'Actual display text editing remains intact');
  render(null, document.body);
  current = getDesktopTheme('modern');
  let authReply = 0;
  const snapshot = { ready: true, revision: 1, devices: [], networks: [],
    authentication: { id: 7, kind: 'username-password', username: 'fixture-user', network: 'fixture' } };
  const native = { startNetwork() {}, stopNetwork() {}, networkState: () => snapshot,
    replyNetworkAuthentication(id, username, password) {
      if (username === null && password === null) return;
      check(id === 7 && username.length > 0 && password.length > 0, 'Original auth payload is delivered without logging credentials');
      authReply++; snapshot.authentication = null;
    } };
  const network = createNetworkSettings({ native, host: {}, theme: () => current,
    report: message => { throw new Error(message); } });
  const surface = { window: { document, closed: false }, root: document.body };
  network.attach(surface.window, surface.root); host.render();
  const password = document.getElementById('shell-network-password');
  const authFirst = fieldAppearance(password);
  password.focus(); host.text('fixture-only-pass'); host.render();
  check(password.childNodes[1].textContent === '\u2022'.repeat(17), 'Credentials remain masked in the actual SDK field');
  host.key('a', 'keydown', { ctrlKey: true, text: false });
  const beforeMask = password.textContent;
  current = getDesktopTheme('xp'); network.refresh(); host.render();
  const authNext = fieldAppearance(password);
  check(document.getElementById(password.id) === password && document.activeElement === password &&
    password.textContent === beforeMask, 'Auth retheme preserves actual field, focus and masked selection content');
  if (verify) check(authFirst.focus === getDesktopTheme('modern').colors.focus && authNext.focus === current.colors.focus,
    'Credential focus color consumes the existing theme token');
  const button = document.getElementById('shell-network-auth-submit').getBoundingClientRect();
  host.mouse('mousedown', button.x + button.width / 2, button.y + button.height / 2);
  host.mouse('mouseup', button.x + button.width / 2, button.y + button.height / 2);
  host.mouse('click', button.x + button.width / 2, button.y + button.height / 2); host.render();
  check(authReply === 1 && !document.getElementById('shell-network-password'),
    'One real auth button action delivers the original fixture payload and clears credentials');
  console.log('COMMON_INPUT_APPEARANCE ' + JSON.stringify({ verify, display: { first, rethemed },
    credentials: { first: authFirst, rethemed: authNext, masked: true }, authReply,
    scope: 'Actual field consumers; no real display/network service or credential output' }));
  network.stop(); render(null, document.body);
}
