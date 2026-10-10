import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

register('./root-loader.mjs', import.meta.url);
const { parseDesktopEntry, applicationCatalog, expandExec } = await import('../shell/applications.mjs');
const { resolveMimeApplications } = await import('../shell/documents.mjs');
const asset = name => ({ id: name, path: '/usr/share/applications/' + name,
  contents: readFileSync(new URL('../release/' + name, import.meta.url), 'utf8') });

test('Files and File Text are ordinary Apps entries; the document-only entry is not a broken empty --file launch', () => {
  const catalog = applicationCatalog(['polly-files.desktop', 'polly-file-text.desktop',
    'polly-file-text-open.desktop'].map(asset));
  assert.deepEqual(catalog.map(entry => entry.id).sort(), ['polly-file-text.desktop', 'polly-files.desktop']);
  assert.deepEqual(catalog.find(entry => entry.id === 'polly-file-text.desktop').argv, ['/usr/bin/polly-file-text']);
  assert.deepEqual(catalog.find(entry => entry.id === 'polly-files.desktop').argv, ['/usr/bin/polly-files']);
});

test('standalone Settings has an ordinary fixed launcher entry without desktop privilege flags', () => {
  const entry = parseDesktopEntry(asset('polly-settings.desktop'));
  assert.equal(entry.name, 'Settings');
  assert.deepEqual(entry.argv, ['polly-settings']);
  const wrapper = readFileSync(new URL('../tools/polly-settings.in', import.meta.url), 'utf8');
  assert.match(wrapper, /--app-id org\.pollyui\.settings/);
  assert.doesNotMatch(wrapper, /--desktop/);
});

test('installed document handler uses exact absolute --file %f with literal single filename and no URI/shell expansion', () => {
  const entry = parseDesktopEntry(asset('polly-file-text-open.desktop'), { documentHandlers: true });
  const path = '/private/space "quoted" %u; \u4e2d\u6587.txt';
  assert.deepEqual(expandExec(entry.exec, entry, [path]),
    ['/usr/bin/polly-file-text', '--file', path]);
  assert.deepEqual(entry.mimeTypes, ['text/plain', 'text/markdown']);
});

test('product data-directory text defaults remain below existing user XDG defaults', () => {
  const product = parseDesktopEntry(asset('polly-file-text-open.desktop'), { documentHandlers: true });
  const user = { ...product, id: 'user-text.desktop', name: 'User choice',
    path: '/private/data/applications/user-text.desktop' };
  const defaults = { path: '/usr/share/applications/polly-mimeapps.list',
    contents: readFileSync(new URL('../release/polly-mimeapps.list', import.meta.url), 'utf8'),
    directory: '', desktopSpecific: true };
  const userDefaults = { path: '/private/config/mimeapps.list',
    contents: '[Default Applications]\ntext/plain=user-text.desktop;\n',
    directory: '', desktopSpecific: false };
  const directory = path => ({ path, directory: path, contents: '', desktopSpecific: false });
  assert.equal(resolveMimeApplications('text/plain', [product, user],
    [userDefaults, directory('/private/data/applications'), defaults, directory('/usr/share/applications')]).defaultApplication, user.id);
  assert.equal(resolveMimeApplications('text/plain', [product],
    [defaults, directory('/usr/share/applications')]).defaultApplication, product.id);
});
