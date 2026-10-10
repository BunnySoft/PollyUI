await Promise.resolve();
if (failPrelude) throw new Error('Expected GUI context prelude failure');
globalThis.preludeReady = true;
