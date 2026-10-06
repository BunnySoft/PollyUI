import { createDesktopShell } from './desktop/shell/shell.mjs';
import { AUDIO_PREFERENCES_KEY } from './desktop/shell/audio-preferences.mjs';
const stage = application.arguments[0], surfaces = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let shell, serial = 0;
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + message + ' ' + JSON.stringify(desktop.audioState())); await delay(10); }
}
async function signal(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1, anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => marker.closed, title);
}
async function click(id) {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const surface = surfaces.findLast(item => !item.window.closed && item.window.document.getElementById(id));
  const node = surface?.window.document.getElementById(id);
  check(node?.offsetWidth > 0, 'audio preference control laid out: ' + id);
  const body = surface.window.document.body.firstChild;
  let rect = node.getBoundingClientRect(), bounds = surface.window.document.body.getBoundingClientRect();
  if (rect.y + rect.height > bounds.y + bounds.height || rect.y < bounds.y) {
    body.scrollTop = Math.max(0, Number(body.scrollTop) + rect.y - bounds.y);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    rect = node.getBoundingClientRect();
  }
  check(rect.y + rect.height / 2 >= bounds.y && rect.y + rect.height / 2 < bounds.y + bounds.height,
    'audio preference control is inside its scroll viewport: ' + id);
  await signal(`fixture-click ${++serial} ${Math.floor(rect.x + rect.width / 2)} ${Math.floor(rect.y + rect.height / 2)} 0 ${surface.title}`);
}
const node = name => desktop.audioState().nodes.find(node => node.name === name);
const saved = () => JSON.parse(localStorage.getItem(AUDIO_PREFERENCES_KEY));
async function run() {
  if (stage === 'damaged') localStorage.setItem(AUDIO_PREFERENCES_KEY, '{broken');
  shell = createDesktopShell({ host: {
    close: () => window.close(), displays: () => window.displays(),
    create(options) { const surface = window.create(options); surfaces.push({ title: options.title, window: surface }); return surface; },
  } }).start();
  await until(() => desktop.audioState().ready && node('Polly-Test-A')?.volume != null &&
    node('Polly-Test-Source')?.muted != null, 'real private audio nodes ready');
  shell.showAudio(shell.getState().outputs[0]);
  if (stage === 'save') {
    await click('shell-audio-lower-' + node('Polly-Test-A').id);
    await until(() => localStorage.getItem(AUDIO_PREFERENCES_KEY) &&
      saved().devices.some(node => node.name === 'Polly-Test-A' && Math.abs(node.volume - 0.9) < 0.01), 'confirmed speaker volume persisted');
    await click('shell-audio-default-' + node('Polly-Test-B').id);
    await until(() => saved().preferredSink === 'Polly-Test-B', 'confirmed device selection persisted');
    await click('shell-audio-lower-' + node('Polly-Test-Source').id);
    await until(() => saved().devices.some(node => node.name === 'Polly-Test-Source' && Math.abs(node.volume - 0.9) < 0.01), 'microphone volume persisted');
    await click('shell-audio-mute-' + node('Polly-Test-Source').id);
    await until(() => saved().devices.find(node => node.name === 'Polly-Test-Source')?.muted === true, 'microphone mute persisted');
    await click('shell-audio-default-' + node('Polly-Test-Source').id);
    await until(() => saved().preferredSource === 'Polly-Test-Source', 'recording device persisted');
    check(saved().devices.every(node => !('id' in node) && !('revision' in node) && !('instance' in node)),
      'saved audio data contains only names/classes and chosen settings');
  } else if (stage === 'damaged') {
    check(localStorage.getItem(AUDIO_PREFERENCES_KEY) === '{broken', 'damaged audio preference is not overwritten');
    await click('shell-audio-forget-settings');
    await until(() => localStorage.getItem(AUDIO_PREFERENCES_KEY) === null, 'native recovery click committed');
    check(localStorage.getItem(AUDIO_PREFERENCES_KEY) === null, 'native recovery explicitly removes invalid preferences');
  } else if (stage === 'missing') {
    const before = localStorage.getItem(AUDIO_PREFERENCES_KEY);
    check(!node('Polly-Test-B') && desktop.audioState().defaultSink === node('Polly-Test-A').id,
      'missing saved output leaves the private policy fallback available');
    await until(() => node('Polly-Test-Source').muted &&
      Math.abs(node('Polly-Test-A').volume - 0.9) < 0.01, 'remaining endpoint settings restored');
    check(localStorage.getItem(AUDIO_PREFERENCES_KEY) === before && saved().preferredSink === 'Polly-Test-B',
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
