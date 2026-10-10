if (typeof localStorage !== 'undefined' || typeof fetch !== 'undefined' || typeof desktop !== 'undefined')
  throw new Error('GUI context must not install system APIs');
if (!globalThis.preludeReady) throw new Error('Prelude must complete before the app entry');
document.body.style.backgroundColor = '#304050';
if (failScript) throw new Error('Expected GUI context script failure');
await new Promise(resolve => setTimeout(resolve, 1));
