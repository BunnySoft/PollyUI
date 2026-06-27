// fetch.js — Promise-based fetch over file:// (deterministic, offline).
// The --test run-loop is async-aware, so it waits for the requests to settle.

let pass = 0, fail = 0, pending = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
function done() { if (--pending === 0) console.log('\n' + pass + ' passed, ' + fail + ' failed'); }

// --- text() ---
pending++;
fetch('file://tests/fixture.json').then(res => {
  check('fetch resolves with a response', !!res);
  check('response.ok is true', res.ok === true);
  check('response.status is 200', res.status === 200);
  return res.text();
}).then(body => {
  check('text() resolves with the file contents', typeof body === 'string' && body.indexOf('PollyUI') >= 0);
  done();
});

// --- json() ---
pending++;
fetch('file://tests/fixture.json').then(res => res.json()).then(data => {
  check('json() parses the body', data && data.name === 'PollyUI');
  check('json() yields nested values', Array.isArray(data.features) && data.features.length === 3);
  done();
});

// --- a missing file rejects (or returns not-ok) ---
pending++;
fetch('file://tests/does_not_exist.json').then(res => {
  check('missing file is not ok (404)', res.ok === false && res.status === 404);
  done();
}).catch(() => { check('missing file path settled', true); done(); });
