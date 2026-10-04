import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'polly-ime-engine-'));
const shared = path.join(root, 'shared'), user = path.join(root, 'user');
try {
  const binary = path.resolve(process.argv[2]);
  if (!process.argv[3]) {
    const dependencies = execFileSync('ldd', [binary], { encoding: 'utf8', timeout: 5000 });
    assert.doesNotMatch(dependencies, /lib(?:glib|gio|gobject)-2\.0/);
  }
  mkdirSync(shared); mkdirSync(user, { mode: 0o700 });
  chmodSync(shared, 0o755);
  writeFileSync(path.join(shared, 'default.yaml'), `config_version: '1'
schema_list:
  - schema: polly_test
menu:
  page_size: 5
`);
  writeFileSync(path.join(shared, 'polly_test.schema.yaml'), `schema:
  schema_id: polly_test
  name: Polly Test
  version: '1'
switches:
  - name: ascii_mode
    reset: 0
    states: [Chinese, ASCII]
engine:
  processors: [ascii_composer, speller, selector, navigator, express_editor]
  segmentors: [ascii_segmentor, abc_segmentor, fallback_segmentor]
  translators: [table_translator]
speller:
  alphabet: abcdefghijklmnopqrstuvwxyz
  delimiter: " '"
  max_code_length: 10
translator:
  dictionary: polly_test
  enable_user_dict: false
  enable_completion: false
`);
  writeFileSync(path.join(shared, 'polly_test.dict.yaml'), `---
name: polly_test
version: '1'
sort: by_weight
...
\u4f60\u597d\tnihao\t100
\u62df\u597d\tnihao\t1
\u4f60\tni\t100
\u597d\thao\t100
`);
  const output = process.argv[3] ?
    execFileSync('sh', ['desktop/tests/runtime-client.sh', binary, path.resolve(process.argv[3]),
      'desktop/tests/ime-shell.mjs', 'ime'], {
      encoding: 'utf8', timeout: 90000, env: { ...process.env, POLLY_IME_TEST_DATA: shared },
    }) : execFileSync(binary, [shared, user], { encoding: 'utf8', timeout: 25000 });
  assert.match(output, process.argv[3] ? /PASS: real Rime, native candidate popup/ : /PASS: independent Rime engine/);
  process.stdout.write(output);
} finally {
  rmSync(root, { recursive: true, force: true });
}
