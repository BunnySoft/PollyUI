import { h } from './gui/sdk/js/reconciler.mjs';
import { button as themedButton } from './desktop/shared/ui/button.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';
import { horizontal, scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { themedSwitch } from './desktop/shared/ui/selection-controls.mjs';
import { panelAppearance, panelDetail } from './desktop/shared/ui/panel-appearance.mjs';

export function audioSettingsView(theme, snapshot, busy, command) {
  const label = (value, size = 12) => h('view', { style: { color: theme.colors.text,
    fontSize: themeTextSize(theme, size), flexShrink: 0 } }, value);
  function button(id, text, action, enabled = true) {
    enabled = enabled && !busy && !snapshot.busy;
    const node = themedButton(id, text, theme, () => { if (enabled) return action(); }, false,
      { height: theme.layout.choiceHeight, opacity: enabled ? 1 : theme.layout.disabledOpacity });
    node.props.tabIndex = enabled ? 0 : -1; node.props['aria-disabled'] = String(!enabled);
    return node;
  }
  function change(node, operation, value = null) {
    return command('AudioAction', JSON.stringify({ generation: snapshot.generation, id: node.id,
      revision: node.revision, instance: node.instance, operation, value }));
  }
  const rank = node => node.class === 'Audio/Sink' ? 0 : node.class.startsWith('Audio/Source') ? 1 : 2;
  const nodes = [...snapshot.nodes].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return h('view', { id: 'shell-audio-settings', style: { width: '100%', height: '100%', minHeight: 0,
    padding: theme.layout.contentPadding, gap: theme.layout.contentGap, overflow: 'scroll',
    backgroundColor: theme.colors.body }, onWheel: scrollDesktop },
    h('view', { style: { ...horizontal, gap: 8 } }, label('Audio (PipeWire)', 18),
      button('shell-audio-retry', 'Refresh / retry', () => command('RefreshAudio'))),
    label(snapshot.status, 10),
    snapshot.error ? h('view', { role: 'alert' }, label(snapshot.error)) : null,
    snapshot.busy || busy ? h('view', { role: 'status' }, label('Waiting for actual service acknowledgement and preference save...')) : null,
    button('shell-audio-forget-settings', 'Forget saved audio settings',
      () => command('ForgetAudio', JSON.stringify({ generation: snapshot.generation, revision: snapshot.revision })), snapshot.available),
    !snapshot.ready ? label('The private audio service is not ready. No host audio daemon is substituted.') : null,
    snapshot.ready && !nodes.length ? label('No audio endpoints are available.') : null,
    snapshot.ready && snapshot.defaultSink === null ? label('No playback output is available.') : null,
    snapshot.ready && snapshot.defaultSource === null ? label('No recording input is available.') : null,
    snapshot.preferredSink && !nodes.some(node => node.name === snapshot.preferredSink) ?
      label('Preferred output is unavailable; using an available fallback.') : null,
    snapshot.preferredSource && !nodes.some(node => node.name === snapshot.preferredSource) ?
      label('Preferred input is unavailable; using an available fallback.') : null,
    nodes.map(node => h('view', { style: { ...panelAppearance(theme, 'card'), flexShrink: 0 } },
      label(node.description, 14), label(node.class + ' - ' + node.state),
      label(node.volume === null ? 'Volume control unavailable' : 'Volume: ' + Math.round(node.volume * 100) + '%'),
      h('view', { style: { ...horizontal, gap: 6, flexShrink: 0 } },
        button('shell-audio-lower-' + node.id, node.volume > 1 ? 'Set to 100%' : '-10%',
          () => change(node, 'volume', Math.min(1, Math.max(0, node.volume - 0.1))), snapshot.ready && node.volume !== null),
        button('shell-audio-raise-' + node.id, '+10%', () => change(node, 'volume', Math.min(1, node.volume + 0.1)),
          snapshot.ready && node.volume !== null && node.volume < 1),
        h('view', { style: { ...horizontal, gap: theme.layout.controlGap } },
          themedSwitch(theme, { id: 'shell-audio-mute-' + node.id, value: node.muted === true,
            'aria-label': 'Mute ' + node.description, disabled: busy || snapshot.busy || !snapshot.ready || node.muted === null,
            onUpdate: muted => change(node, 'mute', muted) }), label('Mute'))),
      node.class === 'Audio/Sink' || node.class.startsWith('Audio/Source') ?
        button('shell-audio-default-' + node.id,
          snapshot.defaultSink === node.id || snapshot.defaultSource === node.id ? 'Selected default' : 'Use as default',
          () => change(node, 'default'), snapshot.ready && snapshot.defaultSink !== node.id && snapshot.defaultSource !== node.id) : null,
      panelDetail(theme, 'card'))));
}
