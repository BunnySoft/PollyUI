import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const user = mkdtempSync(path.join(tmpdir(), 'polly-ime-installed-'));
try {
  const output = execFileSync(path.resolve(process.argv[2]),
    ['/usr/share/rime-data', user, 'luna_pinyin_simp'], { encoding: 'utf8', timeout: 60000 });
  assert.match(output, /PASS: installed Rime schema commits Chinese/);
  process.stdout.write(output);
} finally { rmSync(user, { recursive: true, force: true }); }
