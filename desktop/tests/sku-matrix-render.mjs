import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mergedRows, renderMatrix } from '../tools/render-sku-matrix.mjs';

test('shared component implementation spans all three SKUs', () => {
  const rows = mergedRows([
    ['Window manager', 'PollyWM', 'Same implementation', 'Same implementation'],
  ], true);
  assert.deepEqual(rows[0][1], { value: 'PollyWM', column: 1, colspan: 3 });
});

test('matching inclusion cells span columns but every feature retains its own row', () => {
  const rows = mergedRows([
    ['Chinese fonts', '❌', '✅', '✅'],
    ['Chinese input', '❌', '✅', '✅'],
  ]);
  assert.deepEqual(rows[0][2], { value: '✅', column: 2, colspan: 2 });
  assert.equal(rows[1].length, 3);
  assert.equal(rows[1][0].value, 'Chinese input');
  assert.deepEqual(rows[1][2], { value: '✅', column: 2, colspan: 2 });
  assert.ok(!renderMatrix('# Matrix\n\n| Feature | Mini | Compact | Standard |\n' +
    '|---|---|---|---|\n| Chinese fonts | ❌ | ✅ | ✅ |\n' +
    '| Chinese input | ❌ | ✅ | ✅ |\n').includes('rowspan='));
});

test('rendering escapes markup and rejects malformed column counts', () => {
  const source = '# Matrix\n\n| Feature | Mini | Compact | Standard |\n|---|---|---|---|\n' +
    '| <script>alert(1)</script> | ❌ | ✅ | ✅ |\n';
  const html = renderMatrix(source);
  assert.ok(html.includes('colspan="2"'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert'));
  assert.throws(() => renderMatrix(source.replace(' | ✅ | ✅ |', ' | ✅ |')), /column count/);
});

test('current feature and component matrices keep the approved SKU order and historical identities', () => {
  const markdown = readFileSync(new URL('../../docs/SKU-MATRIX.md', import.meta.url), 'utf8');
  for (const label of ['Feature', 'Component'])
    assert.ok(markdown.includes(`| ${label} | Mini | Compact | Standard |`));
  assert.ok(!markdown.includes('| Feature | Micro | Thin |'));
  assert.ok(!markdown.includes('Compact-VM'));
  assert.match(markdown, /rather than vendor-specific/);
  assert.match(markdown, /Historical `thin`/);
});
