// threads.js — demonstrates "UI thread + work threads".
//
// On load it kicks off heavy background work via BOTH facilities:
//   • computeAsync(n, cb)  — native compute on a pool thread
//   • new Worker(...)       — JS on a separate thread
// while a live tick counter keeps updating (driven by setTimeout), proving the
// UI thread stays responsive the whole time. Results arrive via callbacks /
// onmessage marshaled back to the UI thread.

const el = (s, p) => { const n = document.createElement('view'); if (s) for (const k in s) n.style[k] = s[k]; if (p) p.appendChild(n); return n; };
const text = (str, s, p) => { const n = el(s, p); n.textContent = str; return n; };
const C = { page: '#0f172a', card: '#1e293b', ink: '#e2e8f0', muted: '#94a3b8', blue: '#3b82f6', green: '#22c55e', amber: '#f59e0b' };

document.body.style.backgroundColor = C.page;
document.body.style.justifyContent = 'center';
document.body.style.alignItems = 'center';

const card = el({ backgroundColor: C.card, padding: 32, width: 460, flexDirection: 'column' }, document.body);
text('UI thread + work threads', { fontSize: 22, color: C.ink, marginBottom: 4 }, card);
text('Heavy work runs off-thread; the tick keeps moving.', { fontSize: 13, color: C.muted, marginBottom: 24 }, card);

function row(label, color) {
    const r = el({ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }, card);
    el({ width: 10, height: 10, backgroundColor: color, marginRight: 12 }, r);
    text(label, { fontSize: 14, color: C.muted, width: 150 }, r);
    return text('…', { fontSize: 15, color: C.ink }, r);
}

const tickLabel    = row('UI tick (alive)', C.green);
const computeLabel = row('computeAsync', C.blue);
const workerLabel  = row('Worker', C.amber);

// Live UI tick via self-rescheduling setTimeout — keeps running during the work.
let ticks = 0;
(function tick() {
    tickLabel.textContent = String(++ticks);
    setTimeout(tick, 100);
})();

// (B) native background compute.
computeLabel.textContent = 'computing primes < 1,000,000 …';
computeAsync(1000000, (count) => {
    computeLabel.textContent = count + ' primes (done)';
});

// (A) JS worker.
workerLabel.textContent = 'worker computing …';
const w = new Worker('js/worker_primes.js');
w.onmessage = (e) => {
    workerLabel.textContent = e.data.primes + ' primes (worker)';
    w.terminate();
};
w.postMessage({ n: 300000 });

console.log('threads.js: background work dispatched');
