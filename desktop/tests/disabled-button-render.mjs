import { h, render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { desktopCommand } from './desktop/shared/ui/presentation.mjs';
import { audioSettingsView } from './desktop/apps/settings/ui/audio.mjs';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const snapshot = {
  available: true, ready: true, busy: false, generation: 1, revision: 1,
  status: 'Controlled UI state; no audio service is invoked', error: '',
  defaultSink: 11, defaultSource: null,
  nodes: [{ id: 11, instance: 'fixture-output', revision: 1, class: 'Audio/Sink',
    name: 'fixture-output', description: 'Playback output', state: 'running', volume: 1, muted: false }],
};
const rect = node => {
  const box = node.getBoundingClientRect();
  return [box.x, box.y, box.width, box.height];
};
const pixels = node => {
  const [left, top, width, height] = rect(node), result = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    result.push(host.pixel(left + x, top + y));
  return result;
};
const changed = (a, b) => a.reduce((count, color, index) => count + Number(color !== b[index]), 0);
const mouse = (kind, node) => {
  const [x, y, width, height] = rect(node);
  host.mouse(kind, x + width / 2, y + height / 2); host.render();
};

export function checkDisabledButtons(directory, verify = false) {
  check(host.width === 800 && host.height === 600, 'Fixed unscaled 800x600 fixture');
  for (const id of verify ? ['server2003', 'xp', 'server2003-opacity'] : ['server2003', 'xp']) {
    const base = getDesktopTheme(id === 'server2003-opacity' ? 'server2003' : id);
    const theme = id === 'server2003-opacity' ?
      { ...base, layout: { ...base.layout, disabledOpacity: 0.37 } } : base;
    const commands = [];
    const scene = (unavailable, current = theme) => {
      const state = { ...snapshot, nodes: snapshot.nodes.map(node => ({ ...node, muted: unavailable ? null : false })) };
      render(h('view', { style: { width: '100%', height: '100%', backgroundColor: current.colors.body } },
        h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0 } },
          audioSettingsView(current, state, false, (...args) => commands.push(args))),
        desktopCommand('fixture-disabled-selected', 'Selected unavailable', current,
          () => { throw new Error('Disabled command activated'); },
          { selected: true, enabled: false, style: { width: 220, flexShrink: 0 } })), document.body);
      host.render();
    };
    scene(false);
    const find = key => document.getElementById(key);
    const disabled = find('shell-audio-raise-11');
    check(disabled.getAttribute('aria-disabled') === 'true' && disabled.tabIndex === -1,
      'Real Settings Audio wrapper declares disabled semantics');
    const normal = pixels(disabled), opacity = Number(disabled.style.opacity);
    const commandOpacity = Number(find('fixture-disabled-selected').style.opacity);
    check(host.save(directory + '\\' + id + '-normal.png'), 'Save normal state');
    mouse('mousemove', disabled);
    const hovered = pixels(disabled), hoverOpacity = Number(disabled.style.opacity);
    check(host.save(directory + '\\' + id + '-disabled-hover.png'), 'Save disabled hover');
    mouse('mousedown', disabled);
    const held = pixels(disabled);
    mouse('mouseup', disabled); mouse('click', disabled);
    check(commands.length === 0, 'Disabled actual Settings button does not dispatch a business command');
    const enabled = find('shell-audio-mute-11');
    enabled.focus(); host.render();
    mouse('mousedown', enabled);
    scene(true);
    const retained = find('shell-audio-mute-11');
    check(retained === enabled, 'Disabled reconciliation retains the actual Settings button node');
    const disabledPixels = pixels(retained);
    const disabledFocus = retained.querySelector('.theme-focus-ring') || retained.querySelector('.luna-focus-ring');
    const disabledFocusOpacity = disabledFocus ? Number(disabledFocus.style.opacity) : null;
    mouse('mousemove', retained);
    const disabledHovered = pixels(retained);
    mouse('mouseup', retained); mouse('click', retained);
    check(commands.length === 0, 'Disabling a held button prevents a late business action');
    scene(true, { ...theme, colors: { ...theme.colors } });
    const rethemed = pixels(retained);
    check(find('shell-audio-mute-11') === retained && document.activeElement === retained,
      'Disabled retheme retains node and existing focus policy');
    scene(false);
    mouse('mousemove', enabled);
    const bevel = enabled.querySelector('.bevel-top');
    const hot = disabled.querySelector('.luna-hot-ring');
    const result = { theme: id, consumer: 'actual Settings audioSettingsView + shared desktopCommand',
      viewport: [host.width, host.height], scale: 1, disabled: rect(disabled),
      disabledOpacity: theme.layout.disabledOpacity, opacity, commandOpacity, hoverOpacity,
      hoverChangedPixels: changed(normal, hovered), heldChangedPixels: changed(normal, held),
      transitionHoverChangedPixels: changed(disabledPixels, disabledHovered),
      disabledRethemeChangedPixels: changed(disabledPixels, rethemed), disabledFocusOpacity,
      raisedEdge: bevel?.style.backgroundColor ?? null, expectedRaisedEdge: theme.colors.light,
      selected: find('fixture-disabled-selected').getAttribute('aria-pressed') };
    if (verify) {
      check(opacity === theme.layout.disabledOpacity && hoverOpacity === opacity &&
        commandOpacity === opacity, 'Configured disabled opacity survives both factories and hover');
      check(result.hoverChangedPixels === 0 && result.heldChangedPixels === 0 &&
        result.transitionHoverChangedPixels === 0 && result.disabledRethemeChangedPixels === 0,
      'Disabled buttons keep exactly the same actual pixels during pointer input and retheme');
      check(disabledFocusOpacity === 0, 'Disabled reconciliation clears stale focus visuals without changing focus policy');
      check(result.selected === 'true', 'Disabled selection truth remains exposed');
      if (bevel) check(result.raisedEdge.toLowerCase() === theme.colors.light.toLowerCase(), 'Re-enabled button does not inherit an obsolete held bevel');
      if (hot) check(Number(hot.style.opacity) === 0, 'Disabled Luna button has no stale hot ring');
    }
    const callsBefore = commands.length;
    mouse('mousedown', enabled); mouse('mouseup', enabled); mouse('click', enabled);
    check(commands.length === callsBefore + 1, 'Re-enabled actual Settings button activates exactly once');
    check(document.activeElement === enabled, 'Reconciliation and input preserve the button focus');
    console.log('DISABLED_BUTTON_STATE ' + JSON.stringify(result));
    console.log(verify ? 'PASS: actual disabled state, held-capability transition, selection/focus and one action' :
      'BASELINE: disabled pointer pixel differences recorded without after assertions');
  }
}
