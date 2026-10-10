// storage.js — localStorage API + cross-run persistence.
// Run twice: the second run sees the 'marker' the first run wrote (persistence).

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }

// Read any marker left by a previous run BEFORE we clear.
const marker = localStorage.getItem('marker');

localStorage.clear();
check('clear empties the store', localStorage.length === 0);

localStorage.setItem('a', '1');
localStorage.setItem('b', 'two');
check('getItem returns the set value', localStorage.getItem('a') === '1');
check('length counts the entries', localStorage.length === 2);
check('a missing key reads as null', localStorage.getItem('missing') === null);

const keys = [localStorage.key(0), localStorage.key(1)].sort().join(',');
check('key(i) enumerates the keys', keys === 'a,b');

localStorage.setItem('a', 'updated');
check('setItem overwrites', localStorage.getItem('a') === 'updated' && localStorage.length === 2);

localStorage.removeItem('a');
check('removeItem deletes the key', localStorage.getItem('a') === null && localStorage.length === 1);

// Persistence: only assertable on the 2nd+ run, when a marker exists.
if (marker !== null) check('value persisted across process runs', marker === 'ok');

// Leave a marker (after clearing 'a'/'b' churn) for the next run to find.
localStorage.setItem('marker', 'ok');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
