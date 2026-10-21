import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { createBoundedAnimation } = await import('./desktop/shared/ui/animation.mjs');
const { wallpaperPreferences, createProceduralWallpaper } = await import('./desktop/shared/ui/procedural-wallpaper.mjs');
const { memoryConfiguration } = await import('./desktop/tests/configuration-memory.mjs');
const { parseAppearance } = await import('./desktop/client/settings-contract.mjs');
const { BUILTIN_THEME_CATALOG } = await import('./desktop/shell/themes.mjs');
const theme = BUILTIN_THEME_CATALOG.themes[0];

function clock() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule(callback, delay) { timers.set(++id, { callback, at: time + delay }); return id; },
    cancel(value) { timers.delete(value); },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      time = end;
    },
    get pending() { return timers.size; },
  };
}

test('animation caps its actual timer rate, cancels while hidden and does not advance across a pause', () => {
  const timer = clock(), frames = [];
  const animation = createBoundedAnimation({ ...timer, now: timer.now,
    schedule: timer.schedule, cancel: timer.cancel, paint: time => frames.push(time), onError: assert.fail });
  assert.equal(timer.pending, 0);
  animation.setState(true);
  timer.advance(1000);
  assert.equal(frames.length, 30, 'initial frame plus 29 timed frames, not a 60Hz hidden loop');
  assert.equal(timer.pending, 1);
  animation.setState(false);
  const count = frames.length, elapsed = frames.at(-1);
  timer.advance(60000);
  assert.equal(frames.length, count);
  assert.equal(timer.pending, 0);
  animation.setState(true);
  assert.equal(frames.at(-1), elapsed);
  animation.dispose();
  assert.equal(timer.pending, 0);
  assert.throws(() => animation.setState(true), /disposed/);
});

test('reduced motion paints one stable frame and a failed renderer never retries on a timer', () => {
  const timer = clock(), frames = [], errors = [];
  let broken = false;
  const animation = createBoundedAnimation({ now: timer.now, schedule: timer.schedule, cancel: timer.cancel,
    paint(time) { if (broken) throw new Error('draw failed'); frames.push(time); }, onError: error => errors.push(error) });
  animation.setState(true, true);
  timer.advance(10000);
  assert.deepEqual(frames, [0]);
  assert.equal(timer.pending, 0);
  animation.setState(false, true);
  animation.setState(true, true);
  assert.deepEqual(frames, [0, 0]);
  broken = true;
  animation.setState(true, false);
  timer.advance(10000);
  animation.invalidate();
  animation.setState(false);
  animation.setState(true);
  assert.equal(errors.length, 1);
  assert.equal(timer.pending, 0);
  assert.equal(animation.stats.failed, true);
  animation.dispose();
});

function canvasFixture() {
  const paths = [], errors = [];
  const context = { resetTransform() {}, fillRect() {}, beginPath() {}, moveTo() {},
    bezierCurveTo(...values) { paths.push(values); }, lineTo() {}, closePath() {}, fill() {},
    createLinearGradient: () => ({ addColorStop() {} }) };
  const canvas = { width: 0, height: 0, style: {}, setAttribute() {}, getContext: () => context };
  const mount = { appendChild(value) { value.parentNode = mount; },
    removeChild(value) { assert.equal(value, canvas); value.parentNode = null; } };
  const timer = clock();
  const wallpaper = createProceduralWallpaper({ document: { createElement: () => canvas }, mount,
    onError: error => errors.push(error), clock: { now: timer.now, schedule: timer.schedule, cancel: timer.cancel } });
  return { canvas, context, mount, wallpaper, timer, errors, paths };
}

test('procedural drawing stays bounded on large/wide/high-DPI outputs and releases its backing store', () => {
  const f = canvasFixture();
  for (const [width, height] of [[1920, 1080], [7680, 4320], [32768, 1], [1, 32768], [320, 240]]) {
    f.wallpaper.update({ theme, width, height, reducedMotion: false });
    assert.ok(f.canvas.width <= 640 && f.canvas.height <= 360);
    assert.ok(f.canvas.width * f.canvas.height <= 230400);
  }
  f.wallpaper.setActive(true);
  const before = f.paths.length;
  f.timer.advance(200);
  assert.ok(f.paths.length > before);
  assert.ok(f.paths.flat().every(Number.isFinite));
  f.wallpaper.setActive(false);
  assert.equal(f.timer.pending, 0);
  f.wallpaper.dispose();
  assert.equal(f.canvas.width * f.canvas.height, 0);
  assert.equal(f.canvas.parentNode, null);
  assert.deepEqual(f.errors, []);
});

test('paint failure removes the animated layer and reports the error once without a restart loop', () => {
  const f = canvasFixture();
  f.wallpaper.update({ theme, width: 1280, height: 720, reducedMotion: false });
  f.context.fillRect = () => { throw new Error('Canvas provider failed'); };
  f.wallpaper.setActive(true);
  f.timer.advance(10000);
  assert.equal(f.errors.length, 1);
  assert.equal(f.canvas.parentNode, null);
  assert.equal(f.canvas.width * f.canvas.height, 0);
  f.wallpaper.update({ theme, width: 1920, height: 1080, reducedMotion: false });
  assert.equal(f.errors.length, 1);
  assert.equal(f.canvas.width * f.canvas.height, 0);
  f.wallpaper.dispose();
});

test('optional wallpaper preferences are strict and preserve the existing v5 defaults and other effects', () => {
  const configuration = memoryConfiguration();
  assert.equal(configuration.snapshot.theme.wallpaper, undefined);
  for (const value of [null, {}, { mode: 'video', reducedMotion: false }, { mode: 'aurora', reducedMotion: 1 },
    { mode: 'aurora', reducedMotion: false, fps: 120 }]) {
    assert.throws(() => wallpaperPreferences(value));
    assert.throws(() => configuration.update({ theme: { ...configuration.snapshot.theme, wallpaper: value } }));
  }
  const policy = { mode: 'aurora', reducedMotion: true };
  configuration.update({ theme: { ...configuration.snapshot.theme, wallpaper: policy, switcherStyle: 'thumbnails' } });
  configuration.update({ theme: { ...configuration.snapshot.theme, id: 'bigsur', windowOpacityPercent: 75 } });
  assert.deepEqual(configuration.snapshot.theme.wallpaper, policy);
  assert.equal(configuration.snapshot.theme.switcherStyle, 'thumbnails');
  configuration.close();
});

test('wallpaper Settings snapshots reject unknown fields and malformed capability or policy', () => {
  const appearance = { version: 1, revision: 1, catalogRevision: 1, themeId: theme.id,
    catalog: BUILTIN_THEME_CATALOG, themeFilesEnabled: false, themeFilesAvailable: true,
    status: '', error: '', build: { version: 'fixture', revision: 'unknown', sourceDirty: null },
    wallpaper: { mode: 'aurora', reducedMotion: true, available: true, reason: '', error: '' } };
  assert.equal(parseAppearance(JSON.stringify(appearance)).wallpaper.reducedMotion, true);
  for (const patch of [{ mode: 'video' }, { reducedMotion: null }, { available: 1 }, { error: [] }, { fps: 60 }])
    assert.throws(() => parseAppearance(JSON.stringify({ ...appearance, wallpaper: { ...appearance.wallpaper, ...patch } })));
});
