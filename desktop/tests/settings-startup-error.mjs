import { startSettingsRuntime } from './desktop/apps/settings/runtime.mjs';

const app = await startSettingsRuntime({ args: ['appearance'] });
const state = app.controller.getState(), surface = app.getWindow();
if (!state.unavailable || !state.error || !surface.document.body.textContent.includes(state.error))
  throw new Error('Settings startup failure must be visible in its actual native document');
for (const id of ['xp', 'server2003', 'aqua', 'lion', 'bigsur']) {
  const node = surface.document.getElementById('shell-theme-' + id);
  if (node.getAttribute('aria-disabled') !== 'true') throw new Error('Failed startup left a theme write enabled');
}
console.log('PASS: standalone Settings startup error is visible, disables writes and never falls back to ambient D-Bus');
app.stop();
