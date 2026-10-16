import { h } from './gui/sdk/js/reconciler.mjs';
import { button } from './desktop/shared/ui/button.mjs';
import { desktopText, scrollDesktop } from './desktop/shared/ui/presentation.mjs';
const row = { flexDirection: 'row', alignItems: 'center' };
import { displayField, setDisplayField } from './desktop/apps/settings/ui/display-inputs.mjs';
import { themedCheckbox } from './desktop/shared/ui/selection-controls.mjs';
import { panelAppearance, panelDetail } from './desktop/shared/ui/panel-appearance.mjs';
export function displaysView(theme, owner, draft, inputs, repaint, apply, close, error = '', profile = null) {
  const label = (value, color = theme.colors.text, size = theme.layout.fontSize, extra = {}) =>
    desktopText(value, color, size, extra);
  const field = (head, name, width) => displayField(owner, inputs, head, name, theme, width,
    name === 'scale' ? repaint : null);
  return h('view', { id: 'shell-displays', style: {
    width: '100%', height: '100%', minHeight: 0, padding: theme.layout.contentPadding,
    gap: theme.layout.contentGap, backgroundColor: theme.colors.body,
  } },
  h('view', { style: { ...row, gap: theme.layout.controlGap, flexWrap: 'wrap' } },
    desktopText('Connected displays', theme.colors.text, theme.layout.headingFontSize,
      { fontWeight: 600, flexShrink: 1, minWidth: 0 }),
    h('view', { style: { flexGrow: 1 } }), button('shell-output-apply', 'Apply', theme, apply),
    button('shell-output-close', 'Close', theme, close)),
  h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll',
    gap: theme.layout.contentGap }, onWheel: scrollDesktop },
    draft.heads.map(head => h('view', { style: { ...panelAppearance(theme, 'card'), flexShrink: 0 } },
    h('view', { style: { ...row, gap: theme.layout.controlGap, flexWrap: 'wrap' } },
      label(head.name, theme.colors.text, theme.layout.fontSize, { flexShrink: 1, minWidth: 0 }),
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
      h('view', { style: { ...row, gap: theme.layout.windowGap, flexWrap: 'wrap' } }, label('Scale'),
        [1, 1.5, 2].map(scale => button('shell-output-' + head.id + '-scale-' + scale * 100, scale * 100 + '%', theme,
          () => { setDisplayField(inputs, head, 'scale', scale); repaint(); },
          Number(inputs.get('shell-output-' + head.id + '-scale')?.value ?? head.scale) === scale)),
        label('Custom'), field(head, 'scale', 62),
        button('shell-output-' + head.id + '-scale-up', '+', theme, () => {
          const value = Number(inputs.get('shell-output-' + head.id + '-scale')?.value);
          setDisplayField(inputs, head, 'scale', Math.min(4, (Number.isFinite(value) ? value : head.scale) + 0.25));
          repaint();
        }),
        button('shell-output-' + head.id + '-rotate', String((head.transform & 3) * 90) + ' deg', theme,
          () => { head.transform = (head.transform & 4) | ((head.transform + 1) & 3); repaint(); })),
      h('view', { style: { ...row, gap: theme.layout.windowGap, flexWrap: 'wrap' } }, label('X'), field(head, 'x'),
        label('Y'), field(head, 'y')),
      h('view', { style: { ...row, gap: theme.layout.windowGap, flexWrap: 'wrap' } }, label('Refresh Hz'), field(head, 'refresh'),
        label('0 = auto', theme.colors.muted, theme.layout.statusFontSize)),
    ] : label('Enable this display to edit its configuration.', theme.colors.muted, theme.layout.statusFontSize,
      { minWidth: 0 }),
    panelDetail(theme, 'card')))),
  label('Keep changes within 15 seconds or they revert.', theme.colors.muted, theme.layout.statusFontSize, { minWidth: 0 }),
  profile ? label(profile.status, theme.colors.muted, theme.layout.statusFontSize, { minWidth: 0 }) : null,
  profile ? button('shell-output-forget-profile', 'Forget saved layout', theme, profile.forget) : null,
  error ? label(error, theme.colors.text, theme.layout.fontSize, { minWidth: 0 }) : null);
}
