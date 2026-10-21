import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { createSettingsFixtureClient } from './desktop/tests/settings-probe.mjs';

const [mode, , , fixtures] = application.arguments;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let shell;
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Video wallpaper deadline: ' + message);
    await delay(10);
  }
}
async function run() {
  const reports = [];
  async function signal(title) {
    const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
      anchors: ['top', 'right'], exclusiveZone: -1 });
    await until(() => marker.closed, title);
  }
  const settings = createSettingsFixtureClient(signal);
  shell = createDesktopShell({ settingsFactory: settings.factory, report: message => {
    reports.push(message); console.error('VIDEO_REPORT: ' + message);
  } }).start();
  const nativeState = () => desktop.videoWallpaperState();
  const policy = path => ({ mode: 'video', reducedMotion: false,
    video: { path: fixtures + '/' + path, loop: true, paused: false } });
  check(nativeState().available === true, 'actual runtime includes the optional native decoder');
  if (mode === 'initial') check(shell.setWallpaper(policy('colors.mp4')), 'local video selection is saved without JavaScript frame bytes');
  else {
    check(shell.configuration.snapshot.theme.wallpaper.mode === 'video', 'video preference survives a new Shell PID');
    check(shell.configuration.snapshot.theme.wallpaper.video.paused, 'paused preference survives a new Shell PID');
  }
  await shell.showSystemSettings(shell.getState().outputs[0]);
  if (mode === 'reload') {
    await until(() => nativeState().paused, 'restored paused policy reaches initialized worker');
    await delay(200);
    check(!nativeState().ready && nativeState().frames === 0,
      'paused Shell restart retains static art and publishes no video frame before explicit Play');
    await settings.click('settings-wallpaper-video-pause');
    await until(() => !shell.configuration.snapshot.theme.wallpaper.video.paused, 'actual Play control resumes a saved paused source');
  }
  await until(() => nativeState().ready && !nativeState().paused, 'first actual native decoded frame');
  const appearance = await settings.query({ op: 'state' });
  check(appearance.appearance.wallpaper.playback.muted === true &&
    appearance.appearance.wallpaper.videoAvailable, 'Settings reports native video capability and permanently disabled audio');
  await settings.close({ disconnect: false });
  await signal('fixture-video-live');
  await until(() => nativeState().loop >= 1, 'actual native decoder loops');
  if (mode === 'initial') {
    await shell.showSystemSettings(shell.getState().outputs[0]);
    await settings.click('settings-wallpaper-video-pause');
    await until(() => shell.configuration.snapshot.theme.wallpaper.video.paused, 'actual Pause control publishes preference');
    await until(() => nativeState().paused, 'native worker acknowledges pause');
    const frames = nativeState().frames, key = nativeState().key;
    await delay(200);
    check(nativeState().frames === frames, 'paused worker performs no uncredited frame work');
    await signal('fixture-video-still');
    await settings.click('settings-wallpaper-video-pause');
    await until(() => !shell.configuration.snapshot.theme.wallpaper.video.paused, 'actual Play control publishes preference');
    await until(() => !nativeState().paused && nativeState().frames > frames, 'native playback resumes on its existing timeline');
    check(nativeState().key === key, 'pause/resume does not restart the decoder or replace source ownership');
    await settings.close();
    await signal('fixture-desktop-lock-long');
    await until(() => nativeState().paused, 'real session lock pauses native decode');
    const locked = nativeState().frames;
    await delay(200);
    check(nativeState().frames === locked, 'no frames are decoded/published while locked');
    await signal('fixture-desktop-unlocked');
    await until(() => !nativeState().paused && nativeState().frames > locked, 'explicit unlock resumes playback');
    await signal('fixture-video-remove-output');
    await until(() => shell.getState().outputs.length === 1 && nativeState().ready && !nativeState().paused,
      'surviving output remains attached to the native video source');
    await signal('fixture-video-live');
    await until(() => !shell.getState().materialError &&
      shell.getSurfaces().filter(surface => surface.kind === 'panel').every(surface => surface.backdropActive),
    'regional taskbar material recovers after output removal');
    const paused = shell.configuration.snapshot.theme.wallpaper;
    check(shell.setWallpaper({ ...paused, video: { ...paused.video, paused: true } }), 'paused source is persisted for the next Shell');
    await until(() => nativeState().paused, 'persisted pause reaches the worker');
  } else {
    await shell.showSystemSettings(shell.getState().outputs[0]);
    await settings.click('settings-wallpaper-choose-video');
    await until(async () => !!await settings.query({ op: 'dialog' }), 'real ordinary-parent video chooser');
    const previousPath = shell.configuration.snapshot.theme.wallpaper.video.path;
    await settings.key(1);
    await until(async () => !await settings.query({ op: 'dialog' }), 'actual Escape cancels the video chooser');
    check(shell.configuration.snapshot.theme.wallpaper.video.path === previousPath,
      'cancelled real chooser preserves selected video and native playback');
    await settings.click('settings-wallpaper-choose-video');
    let dialog, entry;
    await until(async () => {
      dialog = await settings.query({ op: 'dialog' });
      entry = dialog?.entries.find(item => item.caption.endsWith('colors.webm'));
      return !!entry;
    }, 'actual filtered file listing contains the original WebM fixture');
    await settings.query({ op: 'capture', name: 'video-file-chooser.png' });
    await settings.click(entry.id);
    await settings.click(dialog.id + '-accept');
    await until(() => shell.configuration.snapshot.theme.wallpaper.video.path.endsWith('/colors.webm'),
      'actual file chooser publishes the selected native source');
    await settings.click('settings-wallpaper-video-loop');
    await until(() => !shell.configuration.snapshot.theme.wallpaper.video.loop, 'actual Loop control disables repetition');
    await settings.close();
    await until(() => nativeState().ready && nativeState().ended, 'non-looping native source ends explicitly');
    const last = nativeState().frames;
    await delay(200);
    check(nativeState().ready && nativeState().frames === last, 'last decoded frame remains after end, without a restart loop');
    await signal('fixture-video-still');
    check(shell.setWallpaper(policy('malformed.mp4')), 'invalid contents enter explicit asynchronous validation');
    await until(() => shell.getState().wallpaper.error.includes('Video wallpaper stopped'),
      'decoder failure is reported in the real wallpaper settings state');
    check(!nativeState().ready && shell.configuration.snapshot.theme.wallpaper.video.path.endsWith('malformed.mp4'),
      'decode failure restores static art but retains saved user intent');
    const count = reports.length;
    await delay(1200);
    check(reports.length === count, 'failed file is not automatically retried on the Shell clock');
    check(shell.setWallpaper({ mode: 'theme', reducedMotion: false }), 'static theme recovery applies explicitly');
    check(!nativeState().ready && nativeState().key === '', 'static recovery releases native image ownership');
  }
  const expected = reports.filter(message => message !== '[shell] Shell taskbar backdrop retired; solid material required');
  check(mode === 'initial' ? expected.length === 0 :
    expected.length === 1 && expected[0].startsWith('[shell] Video wallpaper stopped; static theme restored.'),
  'video lifecycle reports only admitted output retirement or the explicit invalid-file failure');
  console.log('PASS: native video wallpaper ' + mode + ' complete');
  await signal('fixture-success'); shell.stop(); window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + error + '\n' + error.stack);
  shell?.stop(); window.quit();
});
