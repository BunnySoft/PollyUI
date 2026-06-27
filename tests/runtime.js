// runtime.js — headless test of requestAnimationFrame + setInterval.

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }

// --- requestAnimationFrame: each host.render() advances one frame ---
let frames = 0, tsOk = true;
function loop(ts) { frames++; if (typeof ts !== 'number') tsOk = false; if (frames < 3) requestAnimationFrame(loop); }
requestAnimationFrame(loop);
host.render();   // frame 1 (re-registers)
host.render();   // frame 2 (re-registers)
host.render();   // frame 3 (stops)
host.render();   // nothing pending
check('rAF fired exactly 3 times', frames === 3);
check('rAF callback gets a numeric timestamp', tsOk);

// --- cancelAnimationFrame ---
let canceled = 0;
const cid = requestAnimationFrame(() => { canceled++; });
cancelAnimationFrame(cid);
host.render();
check('cancelAnimationFrame prevents the callback', canceled === 0);

// --- setInterval: repeats via the event loop, then clears itself ---
let ticks = 0;
const iid = setInterval(() => {
    ticks++;
    if (ticks >= 3) {
        clearInterval(iid);
        check('setInterval fired 3 times then cleared', ticks === 3);
        console.log('\n' + pass + ' passed, ' + fail + ' failed');
    }
}, 3);
