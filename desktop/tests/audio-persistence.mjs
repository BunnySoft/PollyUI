import { createSettingsFixtureClient } from './desktop/tests/settings-probe.mjs';
import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { checkDamagedConfiguration } from './desktop/tests/configuration-damage.mjs';
const stage = application.arguments[0], surfaces = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let shell, settingsFixture;
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + message + ' ' + JSON.stringify(desktop.audioState())); await delay(10); }
}
async function signal(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1, anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => marker.closed, title);
}
async function click(id) { return settingsFixture.click(id); }
const node = name => desktop.audioState().nodes.find(node => node.name === name);
const saved = () => shell.configuration.snapshot.audio;
async function run() {
  if (stage === 'damaged') {
    checkDamagedConfiguration();
    console.log('PASS: audio persistence ' + stage);
    await signal('fixture-success'); window.quit(); return;
  }
  settingsFixture = createSettingsFixtureClient(signal);
  shell = createDesktopShell({ settingsFactory: settingsFixture.factory, host: {
    close: () => window.close(), displays: () => window.displays(),
    create(options) { const surface = window.create(options); surfaces.push({ title: options.title, window: surface }); return surface; },
  } }).start();
  await until(() => desktop.audioState().ready && node('Polly-Test-A')?.volume != null &&
    node('Polly-Test-Source')?.muted != null, 'real private audio nodes ready');
  await shell.showAudio(shell.getState().outputs[0]);
  if (stage === 'save') {
    await click('shell-audio-lower-' + node('Polly-Test-A').id);
    await until(() => saved() &&
      saved().devices.some(node => node.name === 'Polly-Test-A' && Math.abs(node.volume - 0.9) < 0.01), 'confirmed speaker volume persisted');
    await click('shell-audio-default-' + node('Polly-Test-B').id);
    await until(() => saved().preferredSink === 'Polly-Test-B', 'confirmed device selection persisted');
    await click('shell-audio-lower-' + node('Polly-Test-Source').id);
    await until(() => saved().devices.some(node => node.name === 'Polly-Test-Source' && Math.abs(node.volume - 0.9) < 0.01), 'microphone volume persisted');
    await click('shell-audio-mute-' + node('Polly-Test-Source').id);
    await until(() => saved().devices.find(node => node.name === 'Polly-Test-Source')?.muted === true, 'microphone mute persisted');
    if (desktop.audioState().defaultSource === node('Polly-Test-Source').id) {
      await click('shell-audio-default-' + node('Polly-Test-Other-Source').id);
      await until(() => saved().preferredSource === 'Polly-Test-Other-Source', 'alternative recording device acknowledged');
    }
    await click('shell-audio-default-' + node('Polly-Test-Source').id);
    await until(() => saved().preferredSource === 'Polly-Test-Source', 'recording device persisted');
    check(saved().devices.every(node => !('id' in node) && !('revision' in node) && !('instance' in node)),
      'saved audio data contains only names/classes and chosen settings');
  } else if (stage === 'missing') {
    const before = JSON.stringify(saved());
    check(!node('Polly-Test-B') && desktop.audioState().defaultSink === node('Polly-Test-A').id,
      'missing saved output leaves the private policy fallback available');
    await until(() => node('Polly-Test-Source').muted &&
      Math.abs(node('Polly-Test-A').volume - 0.9) < 0.01, 'remaining endpoint settings restored');
    check(JSON.stringify(saved()) === before && saved().preferredSink === 'Polly-Test-B',
      'fallback never overwrites the absent saved output preference');
  } else {
    const muted = stage !== 'unmuted';
    await until(() => Math.abs(node('Polly-Test-A').volume - 0.9) < 0.01 &&
      Math.abs(node('Polly-Test-Source').volume - 0.9) < 0.01 &&
      node('Polly-Test-Source').muted === muted &&
      desktop.audioState().preferredSink === 'Polly-Test-B' &&
      desktop.audioState().preferredSource === 'Polly-Test-Source', 'preferences restored into a fresh PipeWire core');
    check(desktop.audioState().defaultSink === node('Polly-Test-B').id, 'saved output selected using its current runtime ID');
    if (stage === 'unmute') {
      await click('shell-audio-mute-' + node('Polly-Test-Source').id);
      await until(() => saved().devices.find(node => node.name === 'Polly-Test-Source')?.muted === false,
        'explicit microphone unmute becomes durable');
    }
  }
  console.log('PASS: audio persistence ' + stage);
  await signal('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => { console.error('FAIL: ' + String(error)); shell?.stop(); window.quit(); });
