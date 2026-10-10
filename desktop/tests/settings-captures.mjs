import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the UI native flow retains at least seven distinct capture names', () => {
  const source = readFileSync(new URL('./settings-shell.mjs', import.meta.url), 'utf8');
  const run = source.slice(source.indexOf('async function run()'), source.indexOf('run().catch'));
  const names = [...run.matchAll(/await capture\(\w+, '([^']+)'\)/g)].map(match => match[1]);
  const pages = run.match(/for \(const page of \[([^\]]+)\]\)/);
  assert.ok(pages, 'the actual native navigation capture loop is present');
  names.push(...[...pages[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
  assert.ok(new Set(names).size >= 7,
    'revisiting a page overwrites its first PNG; only distinct names count');
  const keyboard = run.indexOf("await capture(settings, 'keyboard-activated-appearance')");
  assert.ok(keyboard > run.indexOf("'ordinary native Enter activates current page'") &&
    keyboard < run.indexOf("await signal('fixture-settings-close"),
    'the additional actual capture belongs to the confirmed native-keyboard phase before WM close');
});
