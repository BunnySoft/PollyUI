import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { videoWallpaperPreferences, videoWallpaperCover } = await import('./desktop/shared/ui/video-wallpaper.mjs');
const { wallpaperPreferences } = await import('./desktop/shared/ui/procedural-wallpaper.mjs');
const { createVideoWallpaper } = await import('./desktop/shell/video-wallpaper.mjs');
const { memoryConfiguration } = await import('./desktop/tests/configuration-memory.mjs');
const { parseAppearance } = await import('./desktop/client/settings-contract.mjs');
const { BUILTIN_THEME_CATALOG } = await import('./desktop/shell/themes.mjs');
const video = { path: '/home/user/original.mp4', loop: true, paused: false };

test('local video policy rejects URLs, traversal and ambiguous fields and survives other wallpaper modes', () => {
  for (const patch of [{ path: 'https://example.invalid/a.mp4' }, { path: '/tmp/../a.mp4' },
    { path: '/tmp/a\n.mp4' }, { loop: 1 }, { paused: null }, { volume: 1 }])
    assert.throws(() => videoWallpaperPreferences({ ...video, ...patch }));
  const configuration = memoryConfiguration();
  for (const mode of ['video', 'theme', 'aurora']) {
    const policy = wallpaperPreferences({ mode, reducedMotion: false, video });
    configuration.update({ theme: { ...configuration.snapshot.theme, wallpaper: policy } });
    assert.deepEqual(configuration.snapshot.theme.wallpaper.video, video);
  }
  configuration.close();
  assert.deepEqual(videoWallpaperCover(64, 48, 1280, 720),
    { x: 0, y: -120, width: 1280, height: 960 });
  assert.deepEqual(videoWallpaperCover(1920, 1080, 800, 1280),
    { x: -738, y: 0, width: 2276, height: 1280 });
  assert.throws(() => videoWallpaperCover(0, 48, 1280, 720));
});

function fixture(available = true) {
  let policy = { mode: 'video', reducedMotion: false, video: { ...video } }, visible = true;
  const calls = [], reports = [], windows = [{ closed: false }, { closed: false }];
  const state = { available, ready: false, paused: false, ended: false, width: 0, height: 0,
    frames: 0, loop: 0, key: '', error: '' };
  const previous = () => calls.push(['previous']);
  const native = { onVideoWallpaperChanged: previous,
    videoWallpaperState: () => ({ ...state }),
    startVideoWallpaper(path, loop, targets) { calls.push(['start', path, loop, targets]); state.key = 'native-key'; },
    stopVideoWallpaper() { calls.push(['stop']); state.ready = false; state.key = ''; },
    pauseVideoWallpaper(value) { calls.push(['pause', value]); state.paused = value; },
    setVideoWallpaperTargets(values) { calls.push(['targets', values]); } };
  const controller = createVideoWallpaper({ native, preferences: () => policy, active: () => visible,
    changed: () => calls.push(['changed']), report: value => reports.push(value) });
  controller.start(); controller.setTargets(windows); controller.sync();
  return { controller, native, state, windows, calls, reports, previous,
    policy: value => { policy = value; }, visible: value => { visible = value; } };
}

test('video pause, reduced motion and visibility reuse native source ownership without frame callbacks', () => {
  const f = fixture();
  f.state.ready = true; f.state.width = 64; f.state.height = 48;
  assert.deepEqual(f.controller.view(), { key: 'native-key', width: 64, height: 48 });
  for (const policy of [{ mode: 'video', reducedMotion: false, video: { ...video, paused: true } },
    { mode: 'video', reducedMotion: true, video }]) {
    f.policy(policy); f.controller.sync(); assert.equal(f.state.paused, true);
  }
  f.policy({ mode: 'video', reducedMotion: false, video });
  f.visible(false); f.controller.activity(); assert.equal(f.state.paused, true);
  f.visible(true); f.controller.activity(); assert.equal(f.state.paused, false);
  f.controller.retire(f.windows[0]);
  assert.deepEqual(f.calls.filter(call => call[0] === 'targets').at(-1)[1], [f.windows[1]]);
  f.controller.setTargets([]); assert.equal(f.state.paused, true);
  f.controller.setTargets([f.windows[1]]); assert.equal(f.state.paused, false);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  f.state.ended = true;
  const count = f.calls.length;
  f.controller.activity(); assert.equal(f.calls.length, count);
  f.controller.stop();
  assert.equal(f.native.onVideoWallpaperChanged, f.previous);
  assert.deepEqual(f.reports, []);
});

test('video decode and target failures restore static art once and never retry without explicit reset', () => {
  for (const targetFailure of [false, true]) {
    const f = fixture();
    if (targetFailure) {
      f.native.setVideoWallpaperTargets = () => { throw new Error('retired native target'); };
      f.controller.retire(f.windows[0]);
    } else {
      f.state.error = 'invalid encoded contents'; f.native.onVideoWallpaperChanged();
    }
    for (let index = 0; index < 10; index++) { f.controller.sync(); f.controller.activity(); }
    assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
    assert.equal(f.reports.length, 1);
    assert.match(f.controller.snapshot().error, /static theme restored/);
    assert.equal(f.controller.view(), null);
    f.state.error = ''; f.controller.reset(); f.controller.sync();
    assert.equal(f.calls.filter(call => call[0] === 'start').length, 2);
    f.policy({ mode: 'theme', reducedMotion: false, video });
    f.controller.sync(); assert.equal(f.controller.view(), null);
    f.controller.stop();
  }
  const unavailable = fixture(false);
  assert.equal(unavailable.controller.snapshot().videoAvailable, false);
  assert.equal(unavailable.calls.some(call => call[0] === 'start'), false);
  assert.match(unavailable.reports[0], /excludes the optional/);
  unavailable.controller.stop();
});

test('Settings requires a complete bounded playback capability with permanently muted audio', () => {
  const appearance = { version: 1, revision: 1, catalogRevision: 1,
    themeId: BUILTIN_THEME_CATALOG.themes[0].id, catalog: BUILTIN_THEME_CATALOG,
    themeFilesEnabled: false, themeFilesAvailable: true, status: '', error: '',
    build: { version: 'fixture', revision: 'unknown', sourceDirty: null },
    wallpaper: { mode: 'video', video, reducedMotion: false, available: true, reason: '', error: '',
      videoAvailable: true, videoReason: '', playback: { ready: true, paused: false, ended: false,
        width: 64, height: 48, frames: 12, loop: 1, muted: true } } };
  const parse = wallpaper => parseAppearance(JSON.stringify({ ...appearance, wallpaper }));
  assert.deepEqual(parse(appearance.wallpaper).wallpaper.video, video);
  for (const patch of [{ muted: false }, { width: 1281 }, { height: 721 }, { frames: -1 },
    { width: 0 }, { paused: 1 }, { url: '/tmp/a.mp4' }])
    assert.throws(() => parse({ ...appearance.wallpaper, playback: { ...appearance.wallpaper.playback, ...patch } }));
  const incomplete = { ...appearance.wallpaper }; delete incomplete.videoReason;
  assert.throws(() => parse(incomplete));
});
