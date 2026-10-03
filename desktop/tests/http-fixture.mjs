import http from 'node:http';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ui = resolve(process.argv[2]);
const httpOnly = process.argv.includes('--http-only');
const directory = await mkdtemp(join(tmpdir(), 'pollyui-http-'));
const servers = [];
let plainURL;

function handler(request, response) {
  response.on('error', error => {
    if (!['ECONNRESET', 'EPIPE'].includes(error.code)) console.error(error);
  });
  const send = (body, status = 200, headers = {}) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    response.writeHead(status, { 'Content-Length': data.length, ...headers });
    response.end(request.method === 'HEAD' ? undefined : data);
  };
  if (request.url === '/redirect') {
    send('', 302, { Location: '/json?redirected=1' });
  } else if (request.url === '/downgrade') {
    send('', 302, { Location: plainURL + '/json' });
  } else if (request.url === '/missing') {
    send('missing', 404);
  } else if (request.url === '/nul') {
    send(Buffer.from([97, 0, 98]));
  } else if (request.url === '/bad-json') {
    send('{"value":1}\0tail');
  } else if (request.url === '/slow') {
    setTimeout(() => send('slow'), 3000).unref();
  } else if (request.method === 'POST') {
    const chunks = [];
    let length = 0;
    request.on('data', chunk => {
      length += chunk.length;
      if (length > 1024 * 1024) { request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => send(JSON.stringify({
      body: Buffer.concat(chunks).toString(), method: request.method,
      custom: request.headers['x-pollyui'], contentType: request.headers['content-type'],
      empty: request.headers['x-empty'],
    })));
  } else {
    send(JSON.stringify({ path: request.url }));
  }
}

async function listen(server) {
  servers.push(server);
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return server.address().port;
}

async function execute(config, environment, shutdown = false) {
  const script = join(directory, shutdown ? 'shutdown.mjs' : 'client.mjs');
  const name = shutdown ? 'shutdown' : 'run';
  await writeFile(script, `import { ${name} } from './desktop/tests/http-client.mjs';\n${name}(${JSON.stringify(config)});\n`);
  const started = Date.now();
  const args = shutdown ? [script] : ['--test', script];
  const child = spawn(ui, args, { env: environment });
  let output = '', timedOut = false;
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20000);
  let code;
  try {
    code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  } finally {
    clearTimeout(timer);
  }
  const marker = shutdown ? 'PASS: closing with a pending HTTP request' : 'PASS: HTTP suite complete';
  if (code !== 0 || timedOut || !output.includes(marker) || output.includes('FAIL:')) {
    throw new Error(`HTTP fixture status ${code}:\n${output}`);
  }
  if (shutdown && Date.now() - started > 8000) throw new Error('Request/worker/task shutdown exceeded its bound');
  console.log(output.trim());
}

try {
  const port = await listen(http.createServer(handler));
  plainURL = `http://127.0.0.1:${port}`;
  const config = { http: `http://127.0.0.1:${port}`, effectiveURL: true };
  let cert;
  if (!httpOnly) {
    cert = join(directory, 'cert.pem');
    const key = join(directory, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
      '-keyout', key, '-out', cert], { stdio: 'ignore' });
    const securePort = await listen(https.createServer({ key: await readFile(key), cert: await readFile(cert) }, handler));
    config.https = `https://localhost:${securePort}`;
  }
  const environment = { ...process.env, NO_PROXY: 'localhost,127.0.0.1',
    PU_TEST_STORAGE: join(directory, 'storage.dat'), SDL_VIDEODRIVER: 'dummy',
    SDL_RENDER_DRIVER: 'software', PU_RENDERER: 'raster' };
  delete environment.PU_CA_BUNDLE;
  await execute(config, environment);
  if (!httpOnly) await execute({ ...config, trusted: true }, { ...environment, PU_CA_BUNDLE: cert });
  await execute(config, environment, true);
  console.log('PASS: local HTTP/HTTPS and request/worker/task shutdown fixture');
} finally {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
  await rm(directory, { recursive: true });
}
