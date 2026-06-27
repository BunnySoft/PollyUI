// worker_primes.js — runs inside a Worker: a separate QuickJS context on its
// own thread, with no DOM. It talks to the UI only via messages.

function countPrimes(n) {
    let c = 0;
    for (let i = 2; i < n; i++) {
        let prime = true;
        for (let j = 2; j * j <= i; j++) {
            if (i % j === 0) { prime = false; break; }
        }
        if (prime) c++;
    }
    return c;
}

onmessage = (e) => {
    const n = e.data.n;
    postMessage({ n: n, primes: countPrimes(n) });
};

console.log('worker_primes.js: ready');
