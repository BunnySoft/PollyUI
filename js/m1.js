// m1.js — exercises the M1 ScriptEngine: console, arithmetic, microtasks,
// timers, and error handling. Run with:  pollyui js/m1.js

console.log('M1: QuickJS is alive');
console.log('1 + 2 =', 1 + 2);
console.log('engine check:', typeof globalThis, Array.isArray([1, 2, 3]));

// Microtask (promise job) — runs after the top-level script, in the event loop.
Promise.resolve('microtask ran').then((v) => console.log('then:', v));

// Timer — fires from the event loop after the delay.
setTimeout(() => console.log('timer fired (~120ms)'), 120);

// A cancelled timer should never fire.
const doomed = setTimeout(() => console.log('THIS SHOULD NOT PRINT'), 60);
clearTimeout(doomed);

// Error handling.
try {
    const o = null;
    o.x;
} catch (e) {
    console.log('caught:', e.message);
}

console.log('end of top-level script');
