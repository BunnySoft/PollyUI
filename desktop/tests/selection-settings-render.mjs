import { render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { createDisplayPage } from './desktop/apps/settings/ui/display-page.mjs';
import { audioSettingsView } from './desktop/apps/settings/ui/audio.mjs';
import { createAudioPolicy } from './desktop/shell/audio-policy.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const settle = async () => { for (let i = 0; i < 3; i++) { await Promise.resolve(); host.render(); } };
const key = async name => { host.key(name, 'keydown', { text: false }); await settle(); };
const click = async (node, button = 0) => {
  const r = node.getBoundingClientRect();
  check(r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.right <= host.width && r.bottom <= host.height,
    'Actual Settings control is inside the viewport');
  for (const type of ['mousedown', 'mouseup', 'click']) {
    host.mouse(type, r.x + r.width / 2, r.y + r.height / 2, { button }); await settle();
  }
};
export async function checkSelectionSettings(directory) {
  check(host.width === 800 && host.height === 600, 'Bounded actual Settings consumer viewport');
  const page = createDisplayPage(), commands = [];
  let current = getDesktopTheme('server2003'), busy = false, paints = 0;
  let snapshot = { version: 1, available: true, error: '', status: 'Controlled display service',
    serial: 7, pendingToken: 0, remainingMs: 0, outcome: 0, message: '',
    heads: [{ id: 1, name: 'Fixture display', make: 'Fixture', model: 'Screen', serialNumber: 'one',
      description: 'Actual GUI with controlled display domain', enabled: true, width: 1920, height: 1080,
      refresh: 60000, scale: 1, x: 0, y: 0, transform: 0, adaptiveSync: false, modes: [] }] };
  const paint = () => { paints++; page.paint(document.body, current, snapshot, busy,
    (...args) => commands.push(args), paint); };
  const find = id => document.getElementById(id);
  paint(); await settle();
  let enabled = find('shell-output-1-enabled');
  check(enabled.getAttribute('role') === 'checkbox' && enabled.getAttribute('aria-checked') === 'true' &&
    enabled.getAttribute('aria-label') === 'Enable Fixture display', 'Displays enable is a real named checked checkbox, not a pressed text button');
  enabled.focus(); await key('Enter');
  check(find('shell-output-1-width') && commands.length === 0, 'Checkbox Enter does not silently preserve the former button semantics');
  await key(' ');
  check(find('shell-output-1-enabled').getAttribute('aria-checked') === 'false' && !find('shell-output-1-width') && commands.length === 0,
    'Space edits enabled draft only; no output transaction is sent');
  enabled = find('shell-output-1-enabled'); await click(enabled);
  check(find('shell-output-1-width') && find('shell-output-1-enabled').getAttribute('aria-checked') === 'true',
    'One primary pointer action re-enables the same output draft');
  const beforeBusy = paints;
  busy = true; paint(); await settle();
  enabled = find('shell-output-1-enabled');
  check(enabled.getAttribute('aria-disabled') === 'true' && enabled.tabIndex === -1,
    'Existing busy disable traversal includes the new checkbox role');
  enabled.focus(); await key(' '); await click(enabled);
  check(paints === beforeBusy + 1 && find('shell-output-1-width'), 'Busy checkbox cannot edit the draft or dispatch an action');
  busy = false; paint(); await settle();
  const retained = find('shell-output-1-enabled'); retained.focus();
  current = getDesktopTheme('xp'); paint(); await settle();
  check(find(retained.id) === retained && document.activeElement === retained &&
    retained.getAttribute('aria-checked') === 'true' && retained.querySelector('.luna-focus-paint'),
    'Consumer retheme keeps stable checkbox identity, selection and real Luna focus');
  check(host.save(directory + '/settings-displays-checkbox.png'), 'Save the real Displays selection consumer');
  await click(find('shell-output-apply'));
  check(commands.length === 1 && commands[0][0] === 'ApplyDisplays' &&
    JSON.parse(commands[0][1]).serial === 7 && JSON.parse(commands[0][1]).heads[0].enabled === true,
    'One actual Apply preserves enabled/id/draft serial through the existing transaction contract');
  snapshot = { ...snapshot, pendingToken: 9, remainingMs: 15000 }; paint(); await settle();
  check(!find('shell-output-1-enabled') && /trusted confirmation.*15 seconds/.test(document.body.textContent),
    'Existing trusted confirmation/deadline surface is unchanged');
  page.detach(); render(null, document.body);

  const sound = { ready: true, revision: 4, generation: 3, error: '', defaultSink: 11, defaultSource: null,
    preferredSink: '', preferredSource: '', nodes: [{ id: 11, revision: 2, instance: 'fixture-instance', name: 'fixture-speaker',
      description: 'Fixture speaker', class: 'Audio/Sink', state: 'idle', volume: 0.5, muted: false }] };
  const operations = [], writes = [];
  let saved = null, pageBusy = false;
  const native = { audioAvailable: true, startAudio() {}, stopAudio() {}, audioState: () => JSON.parse(JSON.stringify(sound)),
    setAudioMute: (...args) => operations.push(args),
    setAudioVolume() { throw new Error('Unexpected volume operation'); }, setDefaultAudio() { throw new Error('Unexpected default operation'); } };
  const configuration = { get snapshot() { return { audio: saved }; },
    update(value) { writes.push(value); saved = JSON.parse(JSON.stringify(value.audio)); } };
  const interval = globalThis.setInterval, clear = globalThis.clearInterval, clock = {};
  // The production acknowledgement policy owns a repeating 200ms clock; keep
  // that clock controlled because headless input helpers drain real timers.
  globalThis.setInterval = (callback, ms) => { check(ms === 200, 'Only the existing audio acknowledgement clock is controlled'); return clock; };
  globalThis.clearInterval = id => { if (id !== clock) clear(id); };
  const reports = [];
  const policy = createAudioPolicy({ native, configuration, report: message => { reports.push(message); console.error(message); } });
  const payloads = [];
  const audioPaint = () => {
    render(audioSettingsView(current, policy.snapshot(), pageBusy, (member, argument) => {
      check(member === 'AudioAction', 'Actual mute uses the original AudioAction domain');
      payloads.push(JSON.parse(argument)); policy.action(argument); audioPaint();
    }), document.body);
  };
  try {
    policy.start(); current = getDesktopTheme('modern'); audioPaint(); await settle();
    let mute = find('shell-audio-mute-11');
    check(mute.getAttribute('role') === 'switch' && mute.getAttribute('aria-checked') === 'false' &&
      mute.getAttribute('aria-label') === 'Mute Fixture speaker', 'Audio mute is a real named controlled switch');
    mute.focus(); current = getDesktopTheme('server2003'); audioPaint(); await settle();
    const sameThemeDOM = find(mute.id) === mute && document.activeElement === mute;
    check(sameThemeDOM && mute.querySelector('.classic-focus-paint'), 'Stable audio retheme retains the live switch DOM/focus');
    mute.focus(); await key(' ');
    // The existing busy-status row changes sibling positions, so reacquire
    // its stable ID rather than claiming a keyed remount contract.
    mute = find('shell-audio-mute-11');
    check(operations.length === 1 && JSON.stringify(operations[0]) === JSON.stringify([11, 2, true]) &&
      payloads[0].generation === 3 && payloads[0].revision === 2 && payloads[0].instance === 'fixture-instance' &&
      writes.length === 0 && mute.getAttribute('aria-checked') === 'false' &&
      mute.getAttribute('aria-disabled') === 'true',
      'Space sends once with unchanged identity guards, stays unchecked/busy and does not save before acknowledgement');
    await key(' '); await click(mute);
    check(operations.length === 1 && writes.length === 0, 'Busy/null-capability paths cannot issue duplicate mute operations');
    sound.nodes[0].muted = true; sound.nodes[0].revision++; sound.revision++;
    audioPaint(); await settle();
    mute = find('shell-audio-mute-11');
    check(mute.getAttribute('aria-checked') === 'true' &&
      mute.getAttribute('aria-disabled') === 'false' && writes.length === 1 &&
      saved.devices[0].muted === true, 'Actual acknowledgement updates controlled switch and persists once through the original policy');
    pageBusy = true; audioPaint(); await settle();
    mute = find('shell-audio-mute-11');
    await click(mute); check(operations.length === 1, 'Settings request busy also disables mute');
    pageBusy = false; sound.nodes[0].muted = null; audioPaint(); await settle();
    mute = find('shell-audio-mute-11');
    check(mute.getAttribute('aria-disabled') === 'true' && mute.tabIndex === -1, 'Unavailable/null mute capability remains disabled');
    mute.focus(); await key(' '); await click(mute, 2);
    check(operations.length === 1, 'Null capability cannot be activated by keyboard or non-primary pointer');
    check(host.save(directory + '/settings-audio-switch.png'), 'Save the real Audio selection consumer');
    console.log('THEMED_SETTINGS_SELECTION ' + JSON.stringify({ display: { role: 'checkbox', applied: commands.length,
      serial: JSON.parse(commands[0][1]).serial, enabled: JSON.parse(commands[0][1]).heads[0].enabled, deadlineMs: 15000 },
    audio: { role: 'switch', operations: operations.length, payload: payloads[0], savedAfterAck: writes.length,
      sameDOMOnRetheme: sameThemeDOM, disabledNull: true },
    scope: 'Actual GUI factories and production audio acknowledgement policy with controlled native/domain dependencies; no hardware mutation' }));
  } finally {
    policy.stop(); globalThis.setInterval = interval; globalThis.clearInterval = clear;
    document.activeElement?.blur(); render(null, document.body);
  }
  check(reports.length === 0, 'No acknowledgement or persistence errors were hidden by the fixture');
}
