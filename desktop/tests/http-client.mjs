function check(name, condition) {
  if (!condition) throw new Error(name);
  console.log('PASS: ' + name);
}
async function rejects(action) {
  try { await action(); return false; } catch (_) { return true; }
}

export async function run(config) {
  try {
    const response = await fetch(config.http + '/json?query=kept');
    check('HTTP status and JSON response', response.status === 200 && response.ok);
    check('query string reaches the server', (await response.json()).path === '/json?query=kept');
    check('URI schemes are case-insensitive', (await fetch(config.http.replace('http:', 'HTTP:') + '/json')).ok);
    const redirected = await fetch(config.http + '/redirect');
    check('redirect response succeeds', redirected.ok && (await redirected.json()).path === '/json?redirected=1');
    if (config.effectiveURL) check('effective response URL follows redirects', redirected.url.endsWith('/json?redirected=1'));
    const guarded = await fetch(config.http + '/redirect', { headers: { 'X-PollyUI': 'private' } });
    check('custom headers are not automatically forwarded across redirects', guarded.status === 302 && !guarded.ok);
    const body = '\u4e2d\u0000\u6587';
    const posted = await fetch(config.http + '/echo', { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'X-PollyUI': 'first', 'x-pollyui': 'last', 'X-Empty': '' } });
    const echoed = await posted.json();
    check('POST preserves UTF-8 and embedded NUL', echoed.body === body && echoed.method === 'POST');
    check('headers are case-insensitive and preserve empty values',
      echoed.custom === 'last' && echoed.contentType === 'application/json' && echoed.empty === '');
    const missing = await fetch(config.http + '/missing');
    check('HTTP error status is a response, not a transport rejection', missing.status === 404 && !missing.ok);
    const empty = await fetch(config.http + '/json', { method: 'HEAD' });
    check('HEAD has an empty body', empty.ok && await empty.text() === '');
    check('response text preserves embedded NUL', await (await fetch(config.http + '/nul')).text() === 'a\u0000b');
    check('JSON rejects trailing NUL instead of truncating', await rejects(async () => (await fetch(config.http + '/bad-json')).json()));
    check('unsupported URL schemes are rejected', await rejects(() => fetch('ftp://127.0.0.1/file')));
    check('method injection is rejected', await rejects(() => fetch(config.http, { method: 'GET\r\nX-Test: bad' })));
    check('method NUL is rejected', await rejects(() => fetch(config.http, { method: 'GET\u0000POST' })));
    check('header injection is rejected', await rejects(() => fetch(config.http, { headers: { 'X-Test': 'one\r\ntwo' } })));
    check('transport headers cannot override message framing',
      await rejects(() => fetch(config.http, { headers: { 'Content-Length': '999' } })));
    check('unsupported redirect controls are not silently ignored',
      await rejects(() => fetch(config.http, { redirect: 'error' })));
    if (config.https) {
      if (config.trusted) {
        check('trusted HTTPS works', (await fetch(config.https + '/json')).ok);
        check('TLS hostname verification stays enabled', await rejects(() => fetch(config.https.replace('localhost', '127.0.0.1') + '/json')));
        check('HTTPS cannot redirect to plaintext', await rejects(() => fetch(config.https + '/downgrade')));
      } else {
        check('untrusted HTTPS certificate is rejected', await rejects(() => fetch(config.https + '/json')));
      }
    }
    console.log('PASS: HTTP suite complete');
  } catch (error) {
    console.error('FAIL: HTTP suite: ' + error.message);
  }
}

export function shutdown(config) {
  const worker = new Worker('desktop/tests/busy-worker.js');
  worker.onmessage = () => {};
  computeAsync(100000000, () => console.error('FAIL: compute callback delivered after close'));
  fetch(config.http + '/slow').then(
    () => console.error('FAIL: pending HTTP request delivered after close'),
    () => console.error('FAIL: pending HTTP rejection delivered after close'));
  setTimeout(() => { console.log('PASS: closing with a pending HTTP request'); window.close(); }, 100);
}
