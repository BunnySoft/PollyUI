import { subscribeDesktopTheme } from './desktop/client/theme.mjs';

function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
function rejects(action, message) {
  let failed = false;
  try { action(); } catch { failed = true; }
  check(failed, message);
}
const updates = [];
let binding;
try {
  binding = subscribeDesktopTheme(state => updates.push(state), { overrides: { colors: { accent: '#112233' } } });
  check(binding.getState().ready && binding.getState().theme.id === 'file-theme', 'ordinary application reads the published theme');
  rejects(() => desktop.readThemeFiles(), 'read-only subscription grants no private theme-file access');
  rejects(() => desktop.configureAppearance(binding.getState().theme), 'read-only subscription grants no appearance-management authority');
  const app = window.create({ title: 'Theme subscriber ready', width: 260, height: 120 });
  window.close();
  const label = app.document.createElement('view');
  label.textContent = 'Opt-in application theme';
  label.style.color = binding.getState().theme.colors.accent;
  app.document.body.appendChild(label);
  const deadline = Date.now() + 15000;
  while (binding.getState().theme.window.titleFrom !== '#28744d') {
    if (Date.now() > deadline) throw new Error('Theme subscription did not receive a changed document');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  check(binding.getState().theme.window.titleHeight === 56 && binding.getState().theme.colors.accent === '#112233',
    'ordinary application receives same-ID updates while keeping its own override');
  check(updates.length >= 2, 'theme subscription receives actual compositor updates');
} finally {
  binding?.stop();
  window.quit();
}
