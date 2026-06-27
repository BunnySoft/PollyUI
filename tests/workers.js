// workers.js — headless test of both concurrency facilities:
//   (A) Worker        — separate JS context on a thread, message passing
//   (B) computeAsync  — native background compute, callback marshaled to UI
//
// The event loop stays alive until both async operations complete (the
// dispatcher's outstanding-ref count keeps it running), then exits.

let pass = 0, fail = 0, completed = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('PASS: ' + name); }
    else      { fail++; console.log('FAIL: ' + name); }
}
function maybeDone() {
    if (++completed === 2) console.log('\n' + pass + ' passed, ' + fail + ' failed');
}

// (A) JS Worker round-trip.
const w = new Worker('js/worker_primes.js');
w.onmessage = (e) => {
    check('worker computed primes<100 == 25', e.data.primes === 25);
    check('worker echoed n back', e.data.n === 100);
    w.terminate();
    maybeDone();
};
w.postMessage({ n: 100 });

// (B) native async task -> UI callback.
computeAsync(100, (count) => {
    check('computeAsync primes<100 == 25', count === 25);
    maybeDone();
});

console.log('workers.js: dispatched Worker + computeAsync');
