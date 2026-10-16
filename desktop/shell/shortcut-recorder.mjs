import { h, render } from './gui/sdk/js/reconciler.mjs';
import { themedText, desktopCommand } from './desktop/shared/ui/presentation.mjs';
import { shortcutFromEvent } from './desktop/shared/shortcuts.mjs';

export function createShortcutRecorder({ native, host, theme, report = console.error }) {
  let serial = 0, current = null;
  function cancel(owner, token) {
    if (!current || current.owner !== owner || current.token !== token) return false;
    const old = current; current = null;
    clearTimeout(old.timer);
    try { native.captureShortcuts(false); }
    finally { if (!old.window.closed) old.window.close(); }
    return true;
  }
  return Object.freeze({
    begin(owner, action, apply, failure) {
      if (current) throw new Error('Another shortcut recording is active');
      const output = host.displays()[0];
      if (!output) throw new Error('No output is available for trusted shortcut recording');
      const token = serial = (serial + 1) >>> 0 || 1;
      const surface = host.create({ title: 'PollyShell.shortcut-recording.' + token, output: output.id,
        layer: 'overlay', keyboard: 'exclusive', anchors: [], exclusiveZone: -1,
        width: Math.min(460, output.width), height: Math.min(190, output.height) });
      const item = { owner, action, token, window: surface, status: 'waiting-focus', timer: null };
      current = item;
      const end = () => cancel(owner, token);
      const fail = error => { try { end(); } finally { failure(error); } };
      surface.onclose = end;
      surface.ondeactivate = () => {
        if (current === item) { end(); failure(new Error('Shortcut recording cancelled because trusted focus was lost.')); }
      };
      surface.onactivate = () => {
        if (current !== item) return;
        try { native.captureShortcuts(true); item.status = 'recording'; }
        catch (error) { fail(error); }
      };
      surface.document.body.tabIndex = 0;
      surface.document.body.addEventListener('keydown', event => {
        if (current !== item || item.status !== 'recording' || !surface.active) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) { end(); return; }
        const binding = shortcutFromEvent(event);
        if (!binding) return;
        try { end(); apply(binding); } catch (error) { failure(error); }
      });
      const currentTheme = theme();
      render(h('view', { id: 'shell-shortcut-recording', style: { padding: 20, gap: 14,
        height: '100%', backgroundColor: currentTheme.colors.body } },
        themedText(currentTheme, 'Record shortcut: ' + action, currentTheme.colors.text, 18),
        themedText(currentTheme, 'Press the shortcut here. Escape, focus loss or closing Settings cancels.',
          currentTheme.colors.muted, 14, { flexShrink: 1 }),
        desktopCommand('shell-shortcut-recording-cancel', 'Cancel recording', currentTheme, end)), surface.document.body);
      surface.document.body.focus();
      item.timer = setTimeout(() => {
        if (current === item) {
          try { end(); } catch (error) { report('[shell] Cannot release shortcut capture: ' + String(error)); }
          failure(new Error('Shortcut recording timed out; no change was saved.'));
        }
      }, 30000);
      if (surface.active) surface.onactivate();
      return token;
    },
    snapshot(owner) {
      return current?.owner === owner ? { token: current.token, action: current.action, status: current.status } : null;
    },
    cancel,
    detach(owner) { if (current?.owner === owner) cancel(owner, current.token); },
    stop() { if (current) cancel(current.owner, current.token); },
  });
}
