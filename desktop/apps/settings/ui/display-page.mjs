import { h, render } from './gui/sdk/js/reconciler.mjs';
import { displaysView } from './desktop/apps/settings/ui/displays.mjs';
import { readDisplayDraft } from './desktop/apps/settings/ui/display-inputs.mjs';
import { displayDraft } from './desktop/client/settings-domains-contract.mjs';
import { desktopText } from './desktop/shared/ui/presentation.mjs';

export function createDisplayPage() {
  let draft = null, inputs = new Map(), root = null, mode = '', error = '';
  function reset() {
    for (const input of inputs.values()) { input.value = ''; input.root.blur(); input.root.parentNode?.removeChild(input.root); }
    inputs.clear(); draft = null; mode = ''; error = '';
    if (root) render(null, root);
  }
  return {
    detach() { reset(); root = null; },
    paint(container, theme, snapshot, busy, command, repaint) {
      root = container;
      const changed = draft && draft.serial !== snapshot.serial;
      if (changed || snapshot.pendingToken || !snapshot.available) reset();
      if (changed) error = 'Outputs changed; the old draft was discarded. Review the new values.';
      if (!snapshot.available || snapshot.pendingToken) {
        render(h('view', { id: 'settings-display-status', role: 'status', style: { padding: 16, gap: 12 } },
          desktopText(snapshot.pendingToken ? 'Display changes await trusted confirmation' : 'Displays unavailable', theme.colors.text, 18),
          desktopText(snapshot.pendingToken ? 'Use the trusted Keep / Revert prompt. Automatic rollback in ' +
            Math.ceil(snapshot.remainingMs / 1000) + ' seconds. Closing Settings does not confirm or reset that deadline.' :
            snapshot.status, theme.colors.muted, 14, { flexShrink: 1 })), root);
        return;
      }
      if (!draft) draft = { serial: snapshot.serial, heads: snapshot.heads.map(head => ({ ...head })) };
      const nextMode = JSON.stringify(draft.heads.map(head => [head.id, head.enabled]));
      if (nextMode !== mode) { render(null, root); mode = nextMode; }
      const tree = displaysView(theme, root.ownerDocument, draft, inputs, repaint,
        () => {
          try {
            const value = JSON.stringify(displayDraft(readDisplayDraft(draft, inputs)));
            error = ''; command('ApplyDisplays', value);
          } catch (failure) { error = String(failure.message || failure); repaint(); }
        }, () => {},
        error || snapshot.error,
        { status: snapshot.status, forget: () => command('ForgetDisplayProfile', snapshot.serial) });
      function disable(node) {
        if (node.props?.id === 'shell-output-close') { node.props.style.display = 'none'; node.props.tabIndex = -1; }
        if (busy && ['button', 'checkbox'].includes(node.props?.role)) { node.props['aria-disabled'] = 'true'; node.props.tabIndex = -1;
          node.props.onClick = node.props.onKeydown = () => {}; }
        node.children?.forEach(disable);
      }
      disable(tree); render(tree, root);
    },
  };
}
