import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkus, hardwareProfile } from './live-profiles.mjs';
import { sourceInventory, validateFrozenRuntime } from './package-contract.mjs';
import { inspectRelease } from './release-report.mjs';
import { verifyBundle } from './publish-live-iso.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const imageID = value => /^(?:sha256:)?[0-9a-f]{64}$/.test(value);
const usage = 'Usage: node desktop/tools/build-live-skus.mjs OUTPUT --runtime-bundle DIRECTORY ' +
  '--runtime-image IMAGE --tools-image IMAGE [--skus full,vm,intel,nvidia]';

export function parseArguments(args) {
  if (!args.length || !args[0] || args[0].startsWith('--')) throw new Error(usage);
  const options = { output: path.resolve(args[0]), skus: parseSkus() };
  const fields = new Map([['--runtime-bundle', 'runtimeBundle'], ['--runtime-image', 'runtimeImage'],
    ['--tools-image', 'toolsImage'], ['--skus', 'skus']]);
  const seen = new Set();
  for (let i = 1; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!fields.has(name) || seen.has(name) || !value || value.startsWith('--')) throw new Error(usage);
    seen.add(name);
    options[fields.get(name)] = name === '--skus' ? parseSkus(value) : value;
  }
  for (const name of ['runtimeBundle', 'runtimeImage', 'toolsImage'])
    if (!options[name]) throw new Error(usage);
  options.runtimeBundle = path.resolve(options.runtimeBundle);
  return options;
}

export async function buildSkus(options) {
  if (process.platform !== 'linux') throw new Error('Run SKU assembly on Linux with Node.js and Podman');
  if (fs.existsSync(options.output)) throw new Error('Refusing to overwrite an existing SKU run');
  const within = (parent, child) => {
    const relative = path.relative(parent, child);
    return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  if (within(repo, options.output) || within(options.runtimeBundle, options.output) ||
      within(options.output, options.runtimeBundle))
    throw new Error('SKU output must be outside source and runtime inputs');
  // The original checkout is consulted once; every heavy step consumes the private frozen copy.
  const git = args => execFileSync('git', ['-c', 'safe.directory=' + repo, ...args],
    { cwd: repo, encoding: 'utf8' }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(revision) || git(['status', '--porcelain', '--untracked-files=normal']))
    throw new Error('SKU assembly requires an actual clean fixed Git checkout');
  const report = await inspectRelease(options.runtimeBundle);
  const read = name => JSON.parse(fs.readFileSync(path.join(options.runtimeBundle, name), 'utf8'));
  const runtime = read('manifest.json'), inputs = read('build-inputs.json');
  validateFrozenRuntime(runtime, inputs);
  if (report.kind !== 'runtime' || report.distribution !== 'debian13')
    throw new Error('SKU assembly requires a frozen Debian native runtime bundle');
  const sourceFiles = sourceInventory(repo);
  fs.mkdirSync(options.output, { recursive: true });
  const common = path.join(options.output, 'common'), source = path.join(common, 'source');
  fs.mkdirSync(source, { recursive: true });
  const log = path.join(options.output, 'build.log');
  const run = (program, args) => {
    fs.appendFileSync(log, '\n$ ' + JSON.stringify([program, ...args]) + '\n');
    const result = spawnSync(program, args, { cwd: repo, encoding: 'utf8', timeout: 1800000,
      maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    fs.appendFileSync(log, String(result.stdout || '') + String(result.stderr || ''));
    if (result.error || result.status !== 0)
      throw new Error(`SKU command failed (${result.status ?? result.signal}): ${program}; see ${log}`,
        { cause: result.error });
    return result.stdout.trim();
  };
  const podman = args => run('podman', args);
  const inspect = image => {
    const id = podman(['image', 'inspect', '--format', '{{.Id}}', image]);
    if (!imageID(id)) throw new Error('Expected an immutable Podman image ID: ' + image);
    return id;
  };
  const token = randomUUID().replaceAll('-', '').slice(0, 16);
  const state = { schemaVersion: 1, kind: 'polly-live-sku-run', status: 'preparing',
    sourceRevision: revision, sourceSha256: hash(JSON.stringify(sourceFiles)), skus: options.skus,
    artifacts: [], limits: ['Package/media integrity only; no guest boot, installer or hardware certification.',
      'This entry never builds native runtime/SDK/tools and never publishes or changes a stable alias.'] };
  const save = () => fs.writeFileSync(path.join(options.output, 'build-run.json'), JSON.stringify(state, null, 2) + '\n');
  save();
  try {
    for (const file of sourceFiles) {
      const target = path.join(source, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repo, file.path), target, fs.constants.COPYFILE_EXCL);
      if (hash(fs.readFileSync(target)) !== file.sha256) throw new Error('Source changed during freeze: ' + file.path);
    }
    if (!isSame(sourceInventory(repo), sourceFiles)) throw new Error('Source changed during freeze');
    fs.writeFileSync(path.join(common, 'source-inputs.json'), JSON.stringify({
      revision, sha256: state.sourceSha256, files: sourceFiles,
    }, null, 2) + '\n');
    const bundle = path.join(common, 'runtime');
    fs.cpSync(options.runtimeBundle, bundle, { recursive: true, errorOnExist: true, force: false });
    if (!isSame(await inspectRelease(bundle), report)) throw new Error('Runtime changed during freeze');
    const runtimeID = inspect(options.runtimeImage), toolsID = inspect(options.toolsImage);
    state.nativeRuntime = { imageID: runtimeID, sourceRevision: runtime.revision,
      manifestSha256: hash(fs.readFileSync(path.join(bundle, 'manifest.json'))) };
    state.imageToolsID = toolsID;
    const mounts = ['-v', source + ':/workspace:ro', '-v', bundle + ':/runtime:ro'];
    const tool = (extra, command) => podman(['run', '--rm', '--pull=never', '--network=none',
      ...mounts, ...extra, '--entrypoint', 'python3', toolsID, '-I', '-B', ...command]);
    tool([], ['/workspace/desktop/tests/package-modes.py', '/runtime']);
    podman(['run', '--rm', '--pull=never', '--network=none', ...mounts, '--entrypoint', 'python3',
      runtimeID, '-I', '-B', '/workspace/desktop/release/debian/live-profile.py', 'clean-runtime']);
    const assertFrozen = () => {
      if (!isSame(sourceInventory(source), sourceFiles) ||
          state.nativeRuntime.manifestSha256 !== hash(fs.readFileSync(path.join(bundle, 'manifest.json'))))
        throw new Error('Shared frozen SKU inputs changed');
    };
    state.status = 'assembling';
    save();
    for (const sku of options.skus) {
      assertFrozen();
      const directory = path.join(options.output, sku), retained = path.join(directory, 'inputs');
      fs.mkdirSync(retained, { recursive: true });
      const tags = { platform: `localhost/polly-sku-${sku}-platform:${token}`,
        live: `localhost/polly-sku-${sku}-live:${token}` };
      const build = target => {
        const tag = target === 'platform-base' ? tags.platform : tags.live;
        podman(['build', '--quiet', '--pull=never', '--target', target,
          '--build-arg', 'RUNTIME_IMAGE=' + runtimeID, '--build-arg', 'HARDWARE_SKU=' + sku,
          '-t', tag, '-f', path.join(source, 'desktop/release/debian/Containerfile.live'), path.join(source, 'desktop')]);
        return inspect(tag);
      };
      const platformID = build('platform-base'), liveID = build('live-base');
      podman(['run', '--rm', '--pull=never', '--network=none', ...mounts, '--entrypoint', 'sh',
        platformID, '/workspace/desktop/tests/debian-live-payload.sh', 'template', sku]);
      podman(['run', '--rm', '--pull=never', '--network=none', ...mounts, '--entrypoint', 'sh',
        liveID, '/workspace/desktop/tests/debian-live-payload.sh', 'live', sku]);
      const container = `polly-sku-${sku}-${token}`;
      try {
        podman(['run', '--name', container, '--pull=never', '--network=none', ...mounts,
          '--entrypoint', 'python3', liveID, '-I', '-B', '/workspace/desktop/tools/offline-live-overlay.py',
          'assembled', '/runtime', '/workspace', '--runtime-revision', runtime.revision,
          '--producer-revision', revision, '--base-image', runtimeID,
          '--recipe', '/workspace/desktop/release/debian/Containerfile.live', '--sku', sku, '--tools-image', toolsID]);
        podman(['export', '--output', path.join(retained, 'root.tar'), container]);
      } finally {
        podman(['rm', '-f', '--ignore', container]);
      }
      const outputMount = ['-v', directory + ':/sku'];
      tool(outputMount, ['/workspace/desktop/tools/retain-live-inputs.py', '/sku/inputs']);
      tool(outputMount, ['/workspace/desktop/tools/build-live-image.py', '/sku/inputs/root.tar', '/sku/media',
        '--source-revision', revision, '--source-dirty', '0', '--runtime-image', runtimeID,
        '--distribution', 'debian13', '--sku', sku]);
      tool(outputMount, ['/workspace/desktop/tools/verify-live-runtime.py', '/sku/media', '/runtime', '/sku/inputs',
        '--producer-revision', revision]);
      verifyBundle(path.join(directory, 'media'));
      const media = await inspectRelease(path.join(directory, 'media'));
      assertFrozen();
      state.artifacts.push({ sku, hardwareProfile: hardwareProfile(sku), platformImageID: platformID,
        liveImageID: liveID, tags, media: path.join(sku, 'media'), report: media });
      save();
    }
    if (!isSame(await inspectRelease(path.join(common, 'runtime')), report))
      throw new Error('Shared runtime input changed during assembly');
    state.status = 'complete';
    save();
    return state;
  } catch (error) {
    state.status = 'failed';
    state.error = String(error);
    save();
    throw error;
  }
}
const isSame = (left, right) => JSON.stringify(left) === JSON.stringify(right);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await buildSkus(parseArguments(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error('[build-live-skus] ' + String(error));
    process.exitCode = 1;
  }
}
