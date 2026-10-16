import { h } from './gui/sdk/js/reconciler.mjs';
import { button } from './desktop/shared/ui/button.mjs';
import { desktopCommand, desktopText, settingsCard, scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';
const row = { flexDirection: 'row', alignItems: 'center' };
const labelFor = theme => (value, color, size = 12) => h('view', { style: { color, fontSize: themeTextSize(theme, size), flexShrink: 0 } }, value);
import { displayField, setDisplayField } from './desktop/apps/settings/ui/display-inputs.mjs';
import { themedCheckbox } from './desktop/shared/ui/selection-controls.mjs';
import { panelAppearance, panelDetail } from './desktop/shared/ui/panel-appearance.mjs';
export function displaysView(theme, owner, draft, inputs, repaint, apply, close, error = '', profile = null) {
  const label = labelFor(theme);
  const field = (head, name, width) => displayField(owner, inputs, head, name, theme, width,
    name === 'scale' ? repaint : null);
  return h('view', { id: 'shell-displays', style: {
    width: '100%', height: '100%', minHeight: 0, padding: 8, gap: 16, backgroundColor: theme.colors.body,
  } },
  h('view', { style: { ...row, gap: theme.layout.controlGap, flexWrap: 'wrap' } }, desktopText('Connected displays', theme.colors.text, 16, { fontWeight: 600 }),
    h('view', { style: { flexGrow: 1 } }), button('shell-output-apply', 'Apply', theme, apply),
    button('shell-output-close', 'Close', theme, close)),
  h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', gap: 12 }, onWheel: scrollDesktop },
    draft.heads.map(head => h('view', { style: { ...panelAppearance(theme, 'card'), flexShrink: 0 } },
    h('view', { style: { ...row, gap: theme.layout.controlGap } }, label(head.name, theme.colors.text, 12),
      h('view', { style: { flexGrow: 1 } }),
      themedCheckbox(theme, { id: 'shell-output-' + head.id + '-enabled', checked: head.enabled,
        'aria-label': 'Enable ' + head.name, onChange: enabled => { head.enabled = enabled; repaint(); } }, 'Enabled')),
    head.enabled ? [
      h('view', { style: { ...row, gap: theme.layout.windowGap, flexWrap: 'wrap' } }, field(head, 'width'), label('x', theme.colors.text),
        field(head, 'height'),
        head.modes.length ? button('shell-output-' + head.id + '-mode', 'Mode', theme, () => {
          const width = Number(inputs.get('shell-output-' + head.id + '-width')?.value);
          const height = Number(inputs.get('shell-output-' + head.id + '-height')?.value);
          const found = head.modes.findIndex(mode => mode.width === width && mode.height === height);
          const mode = head.modes[(found + 1) % head.modes.length];
          for (const name of ['width', 'height', 'refresh']) setDisplayField(inputs, head, name, mode[name]);
        }) : null),
      h('view', { style: { ...row, gap: theme.layout.windowGap, flexWrap: 'wrap' } }, label('Scale', theme.colors.text, 11),
        [1, 1.5, 2].map(scale => button('shell-output-' + head.id + '-scale-' + scale * 100, scale * 100 + '%', theme,
          () => { setDisplayField(inputs, head, 'scale', scale); repaint(); },
          Number(inputs.get('shell-output-' + head.id + '-scale')?.value ?? head.scale) === scale)),
        label('Custom', theme.colors.text, 11), field(head, 'scale', 62),
        button('shell-output-' + head.id + '-scale-up', '+', theme, () => {
          const value = Number(inputs.get('shell-output-' + head.id + '-scale')?.value);
          setDisplayField(inputs, head, 'scale', Math.min(4, (Number.isFinite(value) ? value : head.scale) + 0.25));
          repaint();
        }),
        button('shell-output-' + head.id + '-rotate', String((head.transform & 3) * 90) + ' deg', theme,
          () => { head.transform = (head.transform & 4) | ((head.transform + 1) & 3); repaint(); })),
      h('view', { style: { ...row, gap: theme.layout.windowGap, flexWrap: 'wrap' } }, label('X', theme.colors.text, 11), field(head, 'x'),
        label('Y', theme.colors.text, 11), field(head, 'y')),
      h('view', { style: { ...row, gap: theme.layout.windowGap, flexWrap: 'wrap' } }, label('Refresh Hz', theme.colors.text, 11), field(head, 'refresh'),
        label('0 = auto', theme.colors.muted, 10)),
    ] : label('Enable this display to edit its configuration.', theme.colors.muted, 10),
    panelDetail(theme, 'card')))),
  label('Keep changes within 15 seconds or they revert.', theme.colors.muted, 10),
  profile ? label(profile.status, theme.colors.muted, 10) : null,
  profile ? button('shell-output-forget-profile', 'Forget saved layout', theme, profile.forget) : null,
  error ? label(error, theme.colors.text, 11) : null);
}
