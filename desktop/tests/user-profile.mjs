import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { parseLocalUserProfile, readUserProfile, validateUserProfile } = await import('../shared/user-profile.mjs');
const { encodeUtf8 } = await import('../../sysrt/sdk/js/encoding.mjs');

const secret = 'not-a-real-password-field';
const record = (uid = '1000', name = 'alice', gecos = 'Alice Example') =>
  [name, secret, uid, '1000', gecos, '/private/home', '/private/shell'].join(':') + '\n';
function failed(value, uid, pattern) {
  assert.deepEqual(Object.keys(value), ['version', 'uid', 'username', 'displayName', 'error']);
  assert.equal(value.version, 1);
  assert.equal(value.uid, uid);
  assert.equal(value.username, '');
  assert.equal(value.displayName, '');
  assert.match(value.error, pattern);
  assert.ok(Object.isFrozen(value));
  assert.doesNotMatch(JSON.stringify(value), /not-a-real-password-field|private\/home|private\/shell|RAW_FAILURE/);
}
function provider(text = record()) {
  const state = { uid: 1000, euid: 1000, text };
  const calls = [];
  const metadata = { type: 'file', uid: 0, permissions: '0644', bytes: encodeUtf8(text).length,
    identity: '8:1:123:1:100644:1:2:0:3:0', path: '/etc/passwd' };
  const source = {
    uid() { calls.push(['uid']); return state.uid; },
    euid() { calls.push(['euid']); return state.euid; },
    fileSystem: {
      stat(path, follow) { calls.push(['stat', path, follow]); return { ...metadata }; },
      readText(path, expected) {
        calls.push(['readText', path, expected]);
        return { ...metadata, text: state.text, contentIdentity: 'sha256:unused-by-profile' };
      },
      writeText() { assert.fail('Profile must never write'); },
      listDirectory() { assert.fail('Profile must never enumerate'); },
      locations() { assert.fail('Profile must never infer a user from HOME'); },
    },
  };
  return { state, calls, metadata, source };
}

test('display snapshot injection validates the readonly shape and takes an immutable copy', () => {
  for (const source of [parseLocalUserProfile(record(), 1000), parseLocalUserProfile('', 1000),
    parseLocalUserProfile('', undefined)]) {
    const input = { ...source }, value = validateUserProfile(input);
    input.username = 'changed';
    assert.deepEqual(value, source);
    assert.ok(Object.isFrozen(value));
  }
  const valid = parseLocalUserProfile(record(), 1000);
  for (const value of [null, [], { ...valid, version: 2 }, { ...valid, uid: null }, { ...valid, uid: -1 },
    { ...valid, displayName: '' }, { ...valid, username: '\ud800' }, { ...valid, displayName: 'x'.repeat(257) },
    { ...valid, password: secret }, { ...valid, error: 'Unavailable' },
    { ...valid, username: '', displayName: '', error: 'Invalid\ntext' }])
    assert.throws(() => validateUserProfile(value), /local display profile snapshot/);
});

test('exact UID match scans the whole local database and returns only frozen display metadata', () => {
  const value = parseLocalUserProfile(record('0', 'root', 'Root') + record('1001', 'alice-other') +
    record('1000', 'alice', '\u7231\u4e3d\u4e1d \ud83d\udc30,Room 1,555-0100'), 1000);
  assert.deepEqual(value, { version: 1, uid: 1000, username: 'alice',
    displayName: '\u7231\u4e3d\u4e1d \ud83d\udc30', error: '' });
  assert.ok(Object.isFrozen(value));
  assert.throws(() => { value.displayName = 'changed'; }, TypeError);
  assert.doesNotMatch(JSON.stringify(value), /not-a-real-password-field|private|Room|555/);
  assert.equal(parseLocalUserProfile(record('1000', 'actual-name', ''), 1000).displayName, 'actual-name');
  assert.equal(parseLocalUserProfile(record('1000', 'actual-name', ',unused'), 1000).displayName, 'actual-name');
  assert.equal(parseLocalUserProfile('# local records only\n\n' + record(), 1000).username, 'alice');
});

test('canonical UID numbers are bounded, exact and cannot select a leading-zero or partial numeric alias', () => {
  for (const uid of ['01000', '+1000', ' 1000', '1000 ', '1e3', '1000junk', '4294967296', '-1', ''])
    failed(parseLocalUserProfile(record(uid), 1000), 1000, /malformed/);
  for (const uid of [-1, 4294967296, 1000.5, NaN, Infinity, '1000', 1000n, undefined])
    failed(parseLocalUserProfile(record(), uid), null, /user ID is invalid/);
  assert.equal(parseLocalUserProfile(record('4294967295'), 4294967295).error, '');
  assert.equal(parseLocalUserProfile(record('0', 'root'), 0).username, 'root', 'pure parsing does not grant native root access');
  failed(parseLocalUserProfile(record('1001'), 1000), 1000, /no local passwd record/);
});

test('duplicate UID records, even aliases or later entries, never choose an arbitrary local name', () => {
  for (const text of [record() + record('1000', 'alias'), record('1000', 'alias') + record(),
    record() + record(), record() + 'malformed:RAW_FAILURE:1000\n', record('01000') + record()])
    failed(parseLocalUserProfile(text, 1000), 1000, /multiple|malformed/);
  failed(parseLocalUserProfile(record() + record('1000', '', ''), 1000), 1000, /multiple/);
});

test('selected names and complete text reject invalid Unicode, controls, empty names and excess bytes without truncation', () => {
  for (const text of [record('1000', '', 'Name'), record('1000', ' ', 'Name'),
    record('1000', 'a'.repeat(257)), record('1000', 'alice', 'x'.repeat(257)),
    record('1000', 'alice', '\u4e2d'.repeat(86)), record('1000', '\ud800'),
    record('1000', 'alice', 'A\tB'), record('1000', 'alice', 'A\u0085B'),
    record('1000', 'alice', 'A\0B'), record('1000', 'alice', 'A\rB'),
    record('1000', 'alice', 'A\nRAW_FAILURE'), record() + '# \udfff\n',
    record() + 'broken:RAW_FAILURE\n'])
    failed(parseLocalUserProfile(text, 1000), 1000, /invalid|malformed|bounded/);
  const exactName = 'a'.repeat(256);
  assert.equal(parseLocalUserProfile(record('1000', exactName, ''), 1000).displayName, exactName);
  const line = record(), complete = '#' + 'x'.repeat(1048576 - encodeUtf8(line).length - 2) + '\n' + line;
  assert.equal(parseLocalUserProfile(complete, 1000).username, 'alice', 'complete bounded database is accepted');
  failed(parseLocalUserProfile(complete + '\n', 1000), 1000, /bounded/);
  failed(parseLocalUserProfile(null, 1000), 1000, /bounded/);
});

test('readonly orchestration uses only fixed passwd stat/read with the observed identity and confirms OS identity', () => {
  const f = provider();
  assert.equal(readUserProfile(f.source).displayName, 'Alice Example');
  assert.deepEqual(f.calls, [['uid'], ['euid'], ['stat', '/etc/passwd', false],
    ['readText', '/etc/passwd', f.metadata.identity], ['stat', '/etc/passwd', false], ['uid'], ['euid']]);
  f.state.text = record('1000', 'real-current', 'Updated local name');
  f.metadata.bytes = encodeUtf8(f.state.text).length;
  assert.equal(readUserProfile(f.source).username, 'real-current', 'each request obtains a new display snapshot without caching a name');
});

test('missing/invalid UID, mixed effective identity and root do not invent names or attempt passwd IO', () => {
  const f = provider();
  f.source.uid = () => { throw new Error('RAW_FAILURE ' + secret); };
  failed(readUserProfile(f.source), null, /user ID could not be read/);
  assert.deepEqual(f.calls, []);
  for (const uid of [undefined, '1000', -1, 1000.5, 4294967296]) {
    const f = provider(); f.state.uid = uid;
    failed(readUserProfile(f.source), null, /user ID is invalid/);
    assert.deepEqual(f.calls, [['uid']]);
  }
  for (const effective of [0, 1001, -1, '1000', undefined]) {
    const f = provider(); f.state.euid = effective;
    failed(readUserProfile(f.source), 1000, /IDs differ|Effective user ID is invalid/);
    assert.deepEqual(f.calls, [['uid'], ['euid']]);
  }
  const root = provider(); root.state.uid = root.state.euid = 0;
  failed(readUserProfile(root.source), 0, /privileged/);
  assert.deepEqual(root.calls, [['uid'], ['euid']]);
  const unreadable = provider();
  unreadable.source.euid = () => { throw new Error(secret); };
  failed(readUserProfile(unreadable.source), 1000, /Effective user ID could not be read/);
  assert.deepEqual(unreadable.calls, [['uid']]);
});

test('unsafe passwd metadata and oversized/non-regular observations fail before reading text', () => {
  for (const change of [{ type: 'symlink' }, { type: 'directory' }, { uid: 1000 }, { uid: '0' },
    { permissions: '0664' }, { permissions: '0646' }, { permissions: '644' }, { permissions: '0644\n' }, { permissions: 0o644 },
    { bytes: 1048577 }, { bytes: -1 }, { bytes: 1n }, { bytes: 2.5 }, { identity: '' }, { identity: '\0' },
    { identity: 'a'.repeat(192) }]) {
    const f = provider(); Object.assign(f.metadata, change);
    failed(readUserProfile(f.source), 1000, /not a trusted bounded regular file/);
    assert.equal(f.calls.some(([name]) => name === 'readText'), false);
  }
});

test('IO/UTF-8/observation failure reports a generic diagnostic and never exposes an exception or passwd field', () => {
  for (const operation of ['stat', 'readText']) {
    for (const code of ['EACCES', 'ENOENT', 'ESTALE', 'EILSEQ', 'RAW_FAILURE']) {
      const f = provider();
      f.source.fileSystem[operation] = () => { throw Object.assign(new Error(secret + ':RAW_FAILURE:' + record()), { code }); };
      failed(readUserProfile(f.source), 1000, /could not be read safely/);
    }
  }
  for (const change of [{ identity: 'different-observation' }, { uid: 1000 }, { permissions: '0666' }, { bytes: 1 }]) {
    const f = provider(), read = f.source.fileSystem.readText;
    f.source.fileSystem.readText = (...args) => ({ ...read(...args), ...change });
    failed(readUserProfile(f.source), 1000, /observation changed/);
  }
  const replaced = provider(), stat = replaced.source.fileSystem.stat;
  let calls = 0;
  replaced.source.fileSystem.stat = (...args) => ({ ...stat(...args), ...(calls++ ? { identity: 'replaced-file' } : {}) });
  failed(readUserProfile(replaced.source), 1000, /observation changed/);
  for (const text of [record().slice(0, -2), record().replace('Alice', '\ud800')]) {
    const f = provider(); f.state.text = text;
    failed(readUserProfile(f.source), 1000, /complete observation|valid UTF-8/);
  }
});

test('UID/effective UID changes or failed confirmation after IO discard the name and preserve only a known numeric UID', () => {
  for (const change of [{ uid: 1001 }, { euid: 1001 }]) {
    const f = provider(), read = f.source.fileSystem.readText;
    f.source.fileSystem.readText = (...args) => { const result = read(...args); Object.assign(f.state, change); return result; };
    failed(readUserProfile(f.source), change.uid ?? 1000, /identity changed/);
  }
  const f = provider();
  let reads = 0;
  f.source.uid = () => { if (reads++) throw new Error(secret); return 1000; };
  failed(readUserProfile(f.source), null, /could not be confirmed/);
  const effective = provider();
  let effectiveReads = 0;
  effective.source.euid = () => { if (effectiveReads++) throw new Error(secret); return 1000; };
  failed(readUserProfile(effective.source), 1000, /Effective user ID could not be confirmed/);
  assert.throws(() => readUserProfile(), /explicit.*providers/);
});
