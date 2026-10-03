for (let i = 0; i < 8; i++) postMessage(i);
for (;;) {} // The runtime interrupt handler must make shutdown bounded.
