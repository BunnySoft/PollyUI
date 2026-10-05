import { createDesktopShell } from './desktop/shell/shell.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
async function until(predicate, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await delay(10); }
  throw new Error('Timed out: ' + message + ' ' + JSON.stringify(desktop.audioState()));
}
let shell, serial = 0;
const surfaces = [], exits = new Map(), reports = [];
async function signal(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => marker.closed, title);
}
async function click(id) {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const surface = surfaces.findLast(item => !item.window.closed && item.window.document.getElementById(id));
  const node = surface?.window.document.getElementById(id);
  check(node?.offsetWidth > 0, 'native audio control laid out: ' + id);
  const rect = node.getBoundingClientRect();
  await signal(`fixture-click ${++serial} ${Math.floor(rect.x + rect.width / 2)} ${Math.floor(rect.y + rect.height / 2)} 0 ${surface.title}`);
}
async function run() {
  const [mode, executable, script] = application.arguments;
  if (mode === 'denied') {
    window.create({ title: 'Public audio control denial', width: 100, height: 80 });
    let denied = false;
    try { desktop.startAudio(); } catch { denied = true; }
    check(denied, 'public Wayland application cannot acquire Shell audio-policy APIs');
    window.quit(); return;
  }
  desktop.onExit = event => exits.set(event.pid, event.status);
  shell = createDesktopShell({ report: value => { reports.push(value); console.error(value); }, host: {
    close: () => window.close(), displays: () => window.displays(),
    create(options) { const result = window.create(options); surfaces.push({ title: options.title, window: result }); return result; },
  } }).start();
  const node = name => desktop.audioState().nodes.find(item => item.name === name);
  await until(() => desktop.audioState().ready && node('Polly-Test-A')?.volume != null &&
    (mode !== 'initial' || node('Polly-Test-B')?.volume != null),
    'real PipeWire endpoint discovery');
  if (mode === 'initial') {
    const publicClient = desktop.spawnApplication([executable, '--desktop', script, 'denied'], '', 'audio-public');
    await until(() => exits.has(publicClient), 'public audio API probe');
    check(exits.get(publicClient) === 0, 'audio policy APIs require the trusted Shell connection');
    check(desktop.audioState().defaultSink === node('Polly-Test-A').id, 'own policy chooses highest-priority output');
    shell.showAudio(shell.getState().outputs[0]);
    const initial = node('Polly-Test-A');
    let invalidVolume = false;
    try { desktop.setAudioVolume(initial.id, initial.revision, 2); } catch { invalidVolume = true; }
    check(invalidVolume, 'desktop volume controls do not amplify above 100 percent');
    await click('shell-audio-lower-' + initial.id);
    await until(() => Math.abs(node('Polly-Test-A').volume - 0.9) < 0.01, 'native volume reaches PipeWire');
    let stale = false;
    try { desktop.setAudioMute(initial.id, initial.revision, true); } catch { stale = true; }
    check(stale, 'stale audio controls are rejected');
    await click('shell-audio-mute-' + initial.id);
    await until(() => node('Polly-Test-A').muted, 'native mute state');
    await click('shell-audio-mute-' + initial.id);
    await until(() => !node('Polly-Test-A').muted, 'native unmute state');
    const helper = executable.slice(0, executable.lastIndexOf('/')) + '/polly-audio-stream-test';
    const pid = desktop.spawnApplication([helper], '', 'audio-stream-fixture');
    await until(() => desktop.audioState().routes >= 2 && node('Polly-Test-Stream')?.state === 'running', 'automatic playback routes');
    const second = node('Polly-Test-B');
    desktop.setDefaultAudio(second.id, second.revision);
    await until(() => desktop.audioState().defaultSink === second.id && desktop.audioState().connections.length === 2 &&
      desktop.audioState().connections.every(link => link.inputNode === second.id),
      'default output changes and routes reconcile');
    desktop.stopAudio();
    await delay(200);
    desktop.startAudio();
    await until(() => desktop.audioState().ready && desktop.audioState().defaultSink === second.id &&
      desktop.audioState().connections.length === 2 && node('Polly-Test-Stream')?.state === 'running',
      'policy client reconnect preserves active stream routes');
    check(desktop.audioState().connections.every(link => link.inputNode === second.id),
      'existing managed links are reused after policy reconnect');
    const removed = desktop.spawnApplication(['/usr/bin/pw-cli', 'destroy', String(second.id)], '', 'audio-output-remove');
    await until(() => exits.has(removed) && !node('Polly-Test-B'), 'output removal');
    check(exits.get(removed) === 0, 'fixture removes only its private virtual output');
    await until(() => desktop.audioState().connections.length === 2 &&
      desktop.audioState().connections.every(link => link.inputNode === node('Polly-Test-A').id),
      'active playback falls back after output loss');
    await until(() => exits.has(pid), 'actual stream processing', 40000);
    check(exits.get(pid) === 0, 'independent PipeWire stream processed audio');
    await until(() => !node('Polly-Test-Stream') && desktop.audioState().routes === 0, 'stream and route cleanup');
    const capture = desktop.spawnApplication([helper, 'capture'], '', 'audio-capture-fixture');
    await until(() => desktop.audioState().routes === 2 && node('Polly-Test-Capture')?.state === 'running', 'automatic capture routes');
    check(desktop.audioState().connections.every(link => link.outputNode === node('Polly-Test-Source').id),
      'capture routes originate at the selected synthetic source');
    await until(() => exits.has(capture), 'actual capture processing', 40000);
    check(exits.get(capture) === 0, 'independent PipeWire capture stream received audio buffers');
    await until(() => desktop.audioState().routes === 0, 'capture cleanup');
    const mono = desktop.spawnApplication([helper, 'mono'], '', 'audio-mono-fixture');
    await until(() => exits.has(mono), 'mono playback adapter processing', 40000);
    check(exits.get(mono) === 0, 'mono playback is adapted to the selected stereo device');
    await until(() => desktop.audioState().routes === 0, 'mono stream cleanup');
    for (const mode of ['manual', 'missing']) {
      const isolated = desktop.spawnApplication([helper, mode], '', 'audio-explicit-' + mode);
      await until(() => exits.has(isolated), 'explicit stream routing policy: ' + mode);
      check(exits.get(isolated) === 0 && desktop.audioState().routes === 0, 'policy honors ' + mode + ' routing');
    }
  } else check(desktop.audioState().preferredSink === 'Polly-Test-B' &&
    desktop.audioState().defaultSink === node('Polly-Test-A').id, 'preference and fallback survive Shell restart');
  check(reports.length === 0 && !desktop.audioState().error, 'audio policy has no errors');
  await signal('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell?.stop(); window.quit();
});
