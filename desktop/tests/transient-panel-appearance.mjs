import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
register('./root-loader.mjs', import.meta.url);
const { applicationHost } = await import('./application-host.mjs');
const { getDesktopTheme } = await import('../shared/ui/themes.mjs');
const { panelAppearance } = await import('../shared/ui/panel-appearance.mjs');
const { createNetworkSettings } = await import('../apps/settings/ui/network.mjs');
const { displayConfirmationView } = await import('../shell/views.mjs');
const descendants = node => [node, ...(node.children || []).flatMap(descendants)];

test('network adds a dialog frame only to its undecorated layer and keeps embedded credential slots stable', async t => {
  const host = applicationHost(t);
  host.displays = () => [{ id: 1, width: 800, height: 600 }];
  let theme = getDesktopTheme('server2003');
  const state = { ready: true, revision: 3, operation: '', refreshing: false,
    authentication: { id: 7, kind: 'username-password', network: 'fixture', username: 'fixture-user' },
    devices: [], networks: [], error: '' };
  const native = { startNetwork() {}, stopNetwork() {}, networkState: () => JSON.parse(JSON.stringify(state)),
    replyNetworkAuthentication(id, username, password) {
      assert.equal(id, state.authentication.id);
      assert.equal(username, null); assert.equal(password, null);
    } };
  const network = createNetworkSettings({ native, host, theme: () => theme,
    report: message => assert.fail(message) });
  t.after(() => network.stop());
  const surface = network.show(1), doc = surface.document;
  assert.equal(surface.layer, 'overlay');
  const panel = doc.getElementById('shell-network-settings'), password = doc.getElementById('shell-network-password');
  assert.equal(panel.style.borderWidth, '0');
  assert.ok(panel.querySelector('.bevel-face-top'), 'the owned layer, not an ordinary decorated app, receives the dialog frame');
  assert.equal(password.style.width, '100%');
  assert.equal(password.style.maxWidth, '420');
  network.detach();
  state.authentication = { id: 8, kind: 'username-password', network: 'fixture', username: 'fixture-user' };
  const embedded = host.create({ title: 'Ordinary decorated Settings app' });
  network.attach(embedded, embedded.document.body);
  const form = embedded.document.getElementById('shell-network-settings');
  assert.equal(form.style.borderWidth, undefined);
  assert.equal(form.querySelector('.bevel-face-top'), null);
  const input = embedded.document.getElementById('shell-network-password'), slot = input.parentNode;
  state.operation = 'connect'; state.refreshing = true; native.onNetworkChanged();
  theme = getDesktopTheme('modern'); network.refresh();
  assert.equal(embedded.document.getElementById('shell-network-password'), input);
  assert.equal(input.parentNode, slot, 'status insertions/retheme do not move native credential wrappers');
  assert.equal(embedded.document.getElementById('shell-network-content').style.borderRadius, String(theme.button.radius));
});

test('display confirmation adopts the passive dialog/scroll contract without consuming transaction callbacks', () => {
  for (const id of ['server2003', 'modern']) {
    const theme = getDesktopTheme(id), keep = () => {}, revert = () => {};
    const tree = displayConfirmationView(theme, 14500, keep, revert), expected = panelAppearance(theme, 'dialog');
    assert.equal(tree.props.style.borderWidth, expected.borderWidth);
    assert.equal(tree.props.style.padding, expected.padding);
    assert.equal(tree.props.style.borderRadius, expected.borderRadius);
    assert.equal(tree.props.style.overflow, 'scroll');
    assert.equal(typeof tree.props.onWheel, 'function');
    assert.ok(descendants(tree).some(node => node.props?.nodeValue?.includes('15 seconds')));
    assert.equal(descendants(tree).filter(node => node.props?.role === 'button').length, 2);
    assert.equal(tree.children.at(-1)?.props?.className === 'theme-bevel', id === 'server2003');
  }
});
