import { createDesktopShell } from './desktop/tests/configured-shell.mjs';

const [mode] = application.arguments;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let shell;
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Wallpaper deadline: ' + message);
    await delay(10);
  }
}
async function signal(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => marker.closed, title);
}
function backgrounds() { return shell.getSurfaces().filter(surface => surface.kind === 'wallpaper'); }
async function run() {
  const reports = [];
  shell = createDesktopShell({ report: message => reports.push(message),
    settingsFactory: () => ({ close() {}, exited() {}, getState: () => ({ pid: 0, connected: false, error: '' }) }),
  }).start();
  check(desktop.backgroundActivityCapability() === true, 'compositor provides owned scene visibility events');
  if (mode === 'initial') check(shell.setWallpaper({ mode: 'aurora', reducedMotion: false }), 'Aurora starts through typed preferences');
  else {
    check(shell.configuration.snapshot.theme.wallpaper?.mode === 'aurora', 'Aurora preference survives a new Shell PID');
    check(shell.configuration.snapshot.theme.wallpaper?.reducedMotion === true, 'reduced motion survives a new Shell PID');
  }
  await until(() => backgrounds().length === 2 && backgrounds().every(surface =>
    surface.wallpaperAnimation?.stats.frames > 0), 'both actual background canvases have painted');
  const target = backgrounds()[0], other = backgrounds()[1];
  const animation = target.wallpaperAnimation;
  const targetName = 'PollyShell.wallpaper.' + target.output;
  check(animation.stats.width * animation.stats.height <= 230400, 'actual native Canvas backing respects its pixel budget');
  const layers = target.window.document.getElementById('shell-desktop').childNodes;
  check(layers.findIndex(node => node.id === 'shell-wallpaper-motion') <
    layers.findIndex(node => node.id === 'shell-desktop-icons'),
    'animation remains behind the desktop icons and selection overlay');
  if (mode === 'initial') {
    await signal('fixture-wallpaper-frame 1 ' + targetName);
    const covering = window.create({ title: 'Wallpaper.Opaque', output: target.output, layer: 'overlay',
      width: 0, height: 0, anchors: ['top', 'bottom', 'left', 'right'], keyboard: 'none', exclusiveZone: -1 });
    covering.document.body.style.backgroundColor = '#123456';
    await until(() => !animation.stats.active && !animation.stats.pending, 'opaque full-output coverage stops the animation timer');
    const stopped = animation.stats.frames, running = other.wallpaperAnimation.stats.frames;
    await delay(180);
    check(animation.stats.frames === stopped, 'fully occluded wallpaper does not draw');
    check(other.wallpaperAnimation.stats.frames > running, 'another output continues independently');
    covering.close();
    await until(() => animation.stats.active && animation.stats.frames > stopped, 'exposing the background resumes drawing');
    const translucent = window.create({ title: 'Wallpaper.Translucent', output: target.output, layer: 'overlay',
      width: 0, height: 0, anchors: ['top', 'bottom', 'left', 'right'], keyboard: 'none', exclusiveZone: -1,
      transparent: true });
    translucent.document.body.style.backgroundColor = '#12345680';
    await delay(180);
    const visible = animation.stats.frames;
    await delay(180);
    check(animation.stats.active && animation.stats.frames > visible,
      'translucent full-output coverage does not incorrectly pause wallpaper');
    translucent.close();
    await signal('fixture-desktop-lock-long');
    await until(() => backgrounds().every(surface => !surface.wallpaperAnimation?.stats.pending),
      'real session lock pauses every background');
    const locked = backgrounds().map(surface => surface.wallpaperAnimation.stats.frames);
    await delay(180);
    check(backgrounds().every((surface, index) => surface.wallpaperAnimation.stats.frames === locked[index]),
      'locked backgrounds perform no scheduled drawing');
    await signal('fixture-desktop-unlocked');
    await until(() => backgrounds().every(surface => surface.wallpaperAnimation.stats.active),
      'explicit protocol unlock resumes background activity');
    await signal('fixture-wallpaper-output 0 ' + targetName);
    await until(() => animation.stats.disposed || !animation.stats.active, 'disabled output stops its drawing');
    await delay(180);
    check(!animation.stats.pending, 'disabled output retains no animation timer');
    await signal('fixture-wallpaper-output 1 ' + targetName);
    await until(() => backgrounds().length === 2 && backgrounds().every(surface =>
      surface.wallpaperAnimation?.stats.active), 'reenabled outputs regain active backgrounds');
    await until(() => !shell.getState().materialError &&
      shell.getSurfaces().filter(surface => surface.kind === 'panel').every(surface => surface.backdropActive),
    'existing regional taskbar material is re-registered after output recreation');
    check(shell.setWallpaper({ mode: 'aurora', reducedMotion: true }), 'reduced motion is acknowledged and saved');
  }
  await until(() => backgrounds().every(surface => surface.wallpaperAnimation?.stats.reducedMotion &&
    !surface.wallpaperAnimation.stats.pending), 'still Aurora has no recurring timer');
  const current = backgrounds()[0];
  current.window.capture(application.cacheDir + '/wallpaper-still-' + mode + '.png');
  await signal('fixture-wallpaper-frame 0 PollyShell.wallpaper.' + current.output);
  if (mode === 'reload') {
    const held = current.wallpaperAnimation;
    check(shell.setWallpaper({ mode: 'theme', reducedMotion: true }), 'static theme restoration is acknowledged');
    check(held.stats.disposed && !held.stats.pending && held.stats.width * held.stats.height === 0,
      'static restoration releases the native Canvas backing and timers');
    check(backgrounds().every(surface => !surface.wallpaperAnimation && !surface.wallpaperWatch),
      'static restoration releases native visibility watches');
  }
  if (reports.length) console.log('WALLPAPER_REPORTS=' + JSON.stringify(reports));
  const expected = mode === 'initial' ? ['[shell] Shell taskbar backdrop retired; solid material required'] : [];
  check(JSON.stringify(reports) === JSON.stringify(expected),
    'only explicit output-recipient retirement is reported, with regional material subsequently recovered');
  console.log('PASS: native procedural wallpaper ' + mode + ' complete');
  await signal('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + error.stack);
  shell?.stop(); window.quit();
});
