import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseArguments, runCLI, products } from '../tools/build-os.mjs';
import { loadConfig, packageStages, resolvePlan, legacyConfig } from '../tools/live-config.mjs';
import { parseArguments as parseLegacy } from '../tools/build-live-skus.mjs';

const entry = fileURLToPath(new URL('../tools/build-os.mjs', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const configFile = fileURLToPath(new URL('../release/debian/configs/standard.yaml', import.meta.url));
const inputs = ['--lock', 'lock', '--runtime-bundle', 'runtime', '--runtime-image', 'runtime-id', '--tools-image', 'tools-id'];

test('only three product names are accepted, with explicit execution mode', () => {
  assert.deepEqual(products, ['mini', 'compact', 'standard']);
  for (const args of [
    [], ['micro', '--plan'], ['thin', '--plan'], ['full', '--plan'],
    ['mini'], ['mini', '--plan', '--build'], ['mini', '--build'],
    ['mini', 'one', 'two', '--plan'], ['mini', '--plan', '--plan'],
    ['compact', '--hardware', 'intel', '--plan'], ['mini', '--runtime-image', 'x', '--plan'],
    ['standard', '--sku', 'intel', '--plan'], ['mini', '--clean', '--build'],
    ['standard', '--lock', 'lock', '--plan'],
  ]) assert.throws(() => parseArguments(args), undefined, JSON.stringify(args));
});

test('Mini planning is read-only and routes to the real Alpine Shell recipe', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'polly-os-plan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'uncreated');
  const result = spawnSync(process.execPath, [entry, 'mini', output, '--plan'],
    { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.product, 'mini');
  assert.equal(plan.entry, 'desktop/release/micro/build-shell.sh');
  assert.equal(plan.target.libc, 'musl');
  assert.deepEqual(plan.artifacts, ['mini.iso', 'mini.json']);
  assert.deepEqual(plan.capabilities, { chinese: false, ime: false, webgl2: false, webgpu: false, canvas2d: 'cpu' });
  assert.deepEqual(readdirSync(directory), []);
});

test('Compact explicitly blocks rather than relabelling a historical demo or vendor edition', async () => {
  const plan = await runCLI(['compact', '--plan']);
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.display, 'uefi-gop-simpledrm');
  assert.equal(plan.target.distribution, 'debian13');
  await assert.rejects(runCLI(['compact', 'out', '--build'], {
    platform: 'linux', spawnSync() { assert.fail('Blocked Compact must not spawn'); },
  }), /Compact build blocked/);
});

test('Standard new configuration preserves the real full hardware/package contract', async () => {
  const configuration = await loadConfig(configFile);
  assert.equal(configuration.name, 'standard');
  assert.equal(configuration.hardware, 'full');
  assert.ok(packageStages(configuration).runtime.includes('gpgv'),
    'The actual configured runtime must provide its pinned-signature verifier before offline preflight');
  assert.deepEqual(packageStages(configuration), packageStages(legacyConfig('full')));
  const plan = await runCLI(['standard', '--plan']);
  assert.equal(plan.debian.configuration.name, 'standard');
  assert.equal(plan.hardware, 'full');
  assert.equal(plan.configurationFile, 'desktop/release/debian/configs/standard.yaml');
  assert.equal(plan.debian.native.nativeVariant, 'standard-effects4');
  assert.equal(plan.status, 'unresolved');
  assert.equal(plan.debian.size.isoBytes, null);
  assert.notEqual(plan.debian.configSha256, resolvePlan(legacyConfig('full')).configSha256);
});

test('Mini build forwards output and explicit product identity without changing the legacy default', async () => {
  let call;
  const output = path.resolve('private-mini-output');
  const result = await runCLI(['mini', output, '--build'], {
    platform: 'linux',
    spawnSync(program, args, options) { call = { program, args, options }; return { status: 0 }; },
  });
  assert.equal(call.program, 'sh');
  assert.equal(call.args[0], path.join(root, 'desktop/release/micro/build-shell.sh'));
  assert.equal(call.options.env.MICRO_WORK, output);
  assert.equal(call.options.env.MICRO_PRODUCT, 'mini');
  assert.equal(result.iso, path.join(output, 'mini.iso'));
  assert.equal(result.status, 'built-not-boot-tested');
  await assert.rejects(runCLI(['mini', output, '--build'], {
    platform: 'linux', spawnSync: () => ({ status: 7 }),
  }), /Mini build failed \(7\)/);
});

test('Standard delegates to the existing guarded config/lock build, not the legacy relabel path', async () => {
  let args;
  const result = await runCLI(['standard', 'out', '--build', ...inputs], {
    platform: 'linux', runLive: async values => { args = values; return { status: 'complete', artifacts: [] }; },
  });
  assert.deepEqual(args, [path.resolve('out'), '--config', configFile, '--build', ...inputs]);
  assert.equal(result.product, 'standard');
  assert.equal(result.hardware, 'full');
  await assert.rejects(runCLI(['standard', 'out', '--build'], {
    platform: 'linux', runLive() { assert.fail('Missing lock cannot reach builder'); },
  }), /requires lock/);
  await assert.rejects(runCLI(['mini', 'out', '--build'], { platform: 'win32' }), /require Linux/);
});

test('legacy hardware selection and default full are unchanged', () => {
  assert.deepEqual(parseLegacy(['--plan']).skus, ['full']);
  assert.deepEqual(parseLegacy(['--sku', 'intel', '--plan']).skus, ['intel']);
});

test('top-level --os help bypasses native prerequisites and rejects mixed modes', () => {
  const help = spawnSync('bash', [path.join(root, 'tools/build.sh'), '--os', '--help'],
    { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Products: mini, compact, standard/);
  for (const args of [['--metal', '--os', 'mini', '--plan'],
    ['--live', '--os', 'mini', '--plan'], ['--os', 'mini', '--live', '--plan']]) {
    const result = spawnSync('bash', [path.join(root, 'tools/build.sh'), ...args],
      { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
  }
});

test('canonical source does not create unimplemented Compact vendor configs', () => {
  const directory = fileURLToPath(new URL('../release/debian/configs/', import.meta.url));
  assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('compact-')), []);
  assert.match(readFileSync(path.join(root, 'desktop/release/micro/build-shell.sh'), 'utf8'),
    /product=\$\{MICRO_PRODUCT:-micro\}/);
});
