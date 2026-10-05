import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const data = process.env.XDG_DATA_HOME, config = process.env.XDG_CONFIG_HOME;
assert.ok(data?.startsWith('/tmp/') && config?.startsWith('/tmp/'), 'fixture only writes its isolated runtime');
const directory = path.join(data, 'pollyui/themes/file-theme');
const overrides = path.join(config, 'pollyui/theme-overrides.json');
mkdirSync(directory, { recursive: true, mode: 0o700 });
mkdirSync(path.dirname(overrides), { recursive: true, mode: 0o700 });
const file = path.join(directory, 'theme.json'), backup = path.join(directory, 'saved.json');
const mode = process.argv[2];
if (mode === 'create' || mode === 'update' || mode === 'recolor' || mode === 'details') {
  const builtin = JSON.parse(readFileSync('desktop/themes/builtin.json', 'utf8'));
  const theme = builtin.themes.find(item => item.id === 'bigsur');
  theme.id = 'file-theme'; theme.name = 'Theme from a user file';
  const color = mode === 'create' ? '#673ab7' : mode === 'update' ? '#28744d' : '#245dc9';
  Object.assign(theme.window, { titleHeight: mode === 'create' ? 48 : 56, borderWidth: 2, texture: 'none',
    titleFrom: color, titleTo: color });
  theme.desktop.asset = 'wallpaper.png';
  if (mode === 'details') {
    Object.assign(theme.window, { controlSize: 20, controlGap: 8, controlInset: 10,
      fontSize: 20, fontWeight: 700, fontFamily: 'serif', textAlign: 'center' });
    Object.assign(theme.layout, { menuBarHeight: 34, dockBaseWidth: 420, dockWindowWidth: 92, windowGap: 8 });
  }
  execFileSync('python3', ['-c', 'from PIL import Image; import sys; Image.new("RGB", (2, 2), (32, 144, 224)).save(sys.argv[1])',
    path.join(directory, 'wallpaper.png')]);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, theme }), { mode: 0o600 });
} else if (mode === 'invalid') {
  writeFileSync(overrides, '{"schemaVersion":100,"themes":{}}', { mode: 0o600 });
} else if (mode === 'repair') {
  if (existsSync(overrides)) unlinkSync(overrides);
} else if (mode === 'symlink') {
  renameSync(file, backup);
  symlinkSync('/etc/passwd', file);
} else if (mode === 'unsymlink') {
  unlinkSync(file); renameSync(backup, file);
} else if (mode === 'bad-image') {
  writeFileSync(path.join(directory, 'wallpaper.png'), 'not a bitmap');
} else throw new Error('Unknown theme fixture action');
