import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

register('./root-loader.mjs', import.meta.url);
const { parseDesktopEntry } = await import('./desktop/shell/applications.mjs');

const source = name => readFileSync(new URL('../release/' + name, import.meta.url), 'utf8');
const entry = name => ({ id: name, path: '/usr/share/applications/' + name,
  contents: source(name).replaceAll('@CMAKE_INSTALL_FULL_DATADIR@', '/usr/share') });

test('the ordinary Foot entry uses a registered bitmap and the real foot app ID', () => {
  const parsed = parseDesktopEntry(entry('foot.desktop'));
  assert.deepEqual(parsed.argv, ['foot']);
  assert.equal(parsed.appId, 'foot');
  assert.equal(parsed.icon, '/usr/share/icons/hicolor/64x64/apps/polly-foot.png');
  assert.equal(parsed.terminal, false);
});

test('Foot server and client remain installed helpers but are absent from application menus', () => {
  for (const name of ['foot-server.desktop', 'footclient.desktop']) {
    const file = entry(name);
    assert.match(file.contents, /^NoDisplay=true$/m);
    assert.doesNotMatch(file.contents, /^Hidden=true$/m);
    assert.equal(parseDesktopEntry(file), null);
    const helper = parseDesktopEntry(file, { documentHandlers: true });
    assert.deepEqual(helper.argv, name === 'foot-server.desktop' ? ['foot', '--server'] : ['footclient']);
  }
});

test('process monitor and terminal have different original 64px artwork', () => {
  const files = ['polly-processes.png', 'polly-foot.png'].map(name =>
    readFileSync(new URL('../resources/application-icons/' + name, import.meta.url)));
  for (const image of files) {
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(image.readUInt32BE(16), 64);
    assert.equal(image.readUInt32BE(20), 64);
    assert.equal(image[25], 6, 'RGBA artwork preserves transparent margins');
  }
  assert.notDeepEqual(files[0], files[1]);
});
