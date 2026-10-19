import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkus, hardwareProfile } from './live-profiles.mjs';
import { sourceInventory, validateFrozenRuntime } from './package-contract.mjs';
import { inspectRelease } from './release-report.mjs';
import { verifyBundle } from './publish-live-iso.mjs';
import { legacyConfig, loadConfig, resolvePlan, validateLock, verifyLockFiles, configIdentity,
  objectHash } from './live-config.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const imageID = value => /^(?:sha256:)?[0-9a-f]{64}$/.test(value);
export const usage = 'Usage: sh desktop/tools/build-live.sh --debian OUTPUT --runtime-bundle DIRECTORY ' +
  '--runtime-image IMAGE --tools-image IMAGE [--sku NAME | --skus NAME,...] [--basic-kernel-pack DIR]\n' +
  'Config: node desktop/tools/build-live-skus.mjs [OUTPUT] --config FILE --plan [--lock DIR]\n' +
  'Build: tools/build.sh --live OUTPUT --config FILE --build --lock DIR --runtime-bundle DIR ' +
  '--runtime-image ID --tools-image ID [--basic-kernel-pack DIR]\n' +
  '--plan prints JSON without output creation or external commands; --config requires --plan or --build.\n' +
  'minimal-zh-* plans are blocked: the paired CPU native variant is not available; no minimal ISO exists.\n' +
  'SKUs: basic,vm,intel,nvidia,amd,full (default: full)\n' +
  'One frozen runtime; sequential independent Live media. No native rebuild or stable publication.\n' +
  'basic requires an explicit verified dedicated simpledrm kernel pack; stock kernel is unsupported.\n' +
  'Use --help alone for this help without runtime inputs or output creation.';

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (!args.length) throw new Error(usage);
  args = [...args];
  const options = { skus: parseSkus() };
  if (!args[0].startsWith('--')) options.output = path.resolve(args.shift());
  const fields = new Map([['--runtime-bundle', 'runtimeBundle'], ['--runtime-image', 'runtimeImage'],
    ['--tools-image', 'toolsImage'], ['--skus', 'skus'], ['--sku', 'skus'], ['--basic-kernel-pack', 'basicKernelPack'],
    ['--config', 'config'], ['--lock', 'lockDirectory']]);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (seen.has(name)) throw new Error('Duplicate option: ' + name);
    seen.add(name);
    if (name === '--plan' || name === '--build') { options[name.slice(2)] = true; continue; }
    const value = args[++i];
    if (!fields.has(name) || !value || value.startsWith('--')) throw new Error(usage);
    if (name === '--sku' || name === '--skus') {
      if (seen.has(name === '--sku' ? '--skus' : '--sku')) throw new Error('Use --sku or --skus, not both');
      options.skus = parseSkus(value);
      if (name === '--sku' && options.skus.length !== 1) throw new Error('--sku requires exactly one SKU');
    } else options[fields.get(name)] = value;
  }
  if (options.plan && options.build) throw new Error('Use --plan or --build, not both');
  if (options.config && (seen.has('--sku') || seen.has('--skus')))
    throw new Error('--config cannot be combined with --sku/--skus');
  if (options.config && !options.plan && !options.build)
    throw new Error('--config requires explicit --plan or --build');
  if (options.lockDirectory && !options.config) throw new Error('--lock requires --config');
  if (!options.plan) {
    for (const name of ['output', 'runtimeBundle', 'runtimeImage', 'toolsImage'])
      if (!options[name]) throw new Error(usage);
  }
  if (options.runtimeBundle) options.runtimeBundle = path.resolve(options.runtimeBundle);
  if (!options.config && !options.plan && options.skus.includes('basic') !== Boolean(options.basicKernelPack))
    throw new Error('basic requires --basic-kernel-pack; that option is only valid when basic is selected');
  if (options.config) options.config = path.resolve(options.config);
  if (options.lockDirectory) options.lockDirectory = path.resolve(options.lockDirectory);
  if (options.basicKernelPack) options.basicKernelPack = path.resolve(options.basicKernelPack);
  return options;
}

export async function runCLI(args, backend = {}) {
  const options = parseArguments(args);
  if (options.help) return usage;
  if (options.config) {
    const config = await loadConfig(options.config);
    options.skus = [config.hardware];
    options.lock = options.lockDirectory ?
      JSON.parse(fs.readFileSync(path.join(options.lockDirectory, 'packages.lock.json'), 'utf8')) : null;
    options.resolvedPlan = resolvePlan(config, options.lock);
    if (options.plan) return options.resolvedPlan;
    if (options.resolvedPlan.status === 'blocked')
      throw new Error('Native variant unavailable: ' + options.resolvedPlan.blockers.join(' '));
    if (!options.lock) throw new Error('Build requires a saved APT resolution (--lock); plan is unresolved');
    if (options.skus.includes('basic') !== Boolean(options.basicKernelPack))
      throw new Error('basic requires --basic-kernel-pack; it is invalid for other hardware');
    verifyLockFiles(options.lockDirectory, options.lock);
  } else if (options.plan) {
    return { schemaVersion: 1, plans: options.skus.map(sku => resolvePlan(legacyConfig(sku))) };
  }
  return buildSkus(options, backend);
}

export async function buildSkus(options, backend = {}) {
  const root = backend.repo ?? repo;
  const platform = backend.platform ?? process.platform;
  const inventory = backend.sourceInventory ?? sourceInventory;
  const inspect = backend.inspectRelease ?? inspectRelease;
  const verify = backend.verifyBundle ?? verifyBundle;
  const validateRuntime = backend.validateRuntime ?? validateFrozenRuntime;
  if (options.resolvedPlan) {
    const checked = resolvePlan(options.resolvedPlan.configuration, options.lock);
    if (objectHash(checked) !== objectHash(options.resolvedPlan) || checked.status !== 'resolved-unverified')
      throw new Error('Configured build requires an exact available resolved plan');
  }
  if (platform !== 'linux') throw new Error('Run SKU assembly on Linux with Node.js and Podman');
  if (fs.existsSync(options.output)) throw new Error('Refusing to overwrite an existing SKU run');
  const within = (parent, child) => {
    const relative = path.relative(parent, child);
    return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  if (within(root, options.output) || within(options.runtimeBundle, options.output) ||
      within(options.output, options.runtimeBundle))
    throw new Error('SKU output must be outside source and runtime inputs');
  // The original checkout is consulted once; every heavy step consumes the private frozen copy.
  const git = backend.git ?? (args => execFileSync('git', ['-c', 'safe.directory=' + root, ...args],
    { cwd: root, encoding: 'utf8' }).trim());
  const revision = git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(revision) || git(['status', '--porcelain', '--untracked-files=normal']))
    throw new Error('SKU assembly requires an actual clean fixed Git checkout');
  const report = await inspect(options.runtimeBundle);
  const read = name => JSON.parse(fs.readFileSync(path.join(options.runtimeBundle, name), 'utf8'));
  const runtime = read('manifest.json'), inputs = read('build-inputs.json');
  validateRuntime(runtime, inputs);
  if (report.kind !== 'runtime' || report.distribution !== 'debian13')
    throw new Error('SKU assembly requires a frozen Debian native runtime bundle');
  if (options.resolvedPlan) {
    const plan = options.resolvedPlan, lock = options.lock;
    validateLock(lock, plan);
    if (hash(fs.readFileSync(path.join(options.runtimeBundle, 'manifest.json'))) !== lock.runtimeManifestSha256 ||
        options.runtimeImage !== lock.runtimeImageID)
      throw new Error('Configured build runtime differs from locked native bundle/image');
    const pins = new Map(fs.readFileSync(path.join(options.runtimeBundle, 'runtime-packages.txt'), 'utf8')
      .trim().split(/\r?\n/).map(line => line.replace(/:amd64=/, '=').split('=')));
    for (const item of plan.stages.runtime) {
      const [name, pin] = item.split('=');
      if (!pins.has(name) || pin && pins.get(name) !== pin) throw new Error('Native bundle misses configured runtime root: ' + item);
    }
    if (plan.configuration.nativeVariant !== 'standard-effects4') throw new Error('Unavailable native variant');
  }
  const sourceFiles = inventory(root);
  fs.mkdirSync(options.output, { recursive: true });
  const common = path.join(options.output, 'common'), source = path.join(common, 'source');
  fs.mkdirSync(source, { recursive: true });
  const log = path.join(options.output, 'build.log');
  const run = (program, args) => {
    fs.appendFileSync(log, '\n$ ' + JSON.stringify([program, ...args]) + '\n');
    const result = (backend.spawnSync ?? spawnSync)(program, args, { cwd: root, encoding: 'utf8', timeout: 1800000,
      maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    fs.appendFileSync(log, String(result.stdout || '') + String(result.stderr || ''));
    if (result.error || result.status !== 0)
      throw new Error(`SKU command failed (${result.status ?? result.signal}): ${program}; see ${log}`,
        { cause: result.error });
    return result.stdout.trim();
  };
  const podman = args => run('podman', args);
  const inspectImage = image => {
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
      fs.copyFileSync(path.join(root, file.path), target, fs.constants.COPYFILE_EXCL);
      if (hash(fs.readFileSync(target)) !== file.sha256) throw new Error('Source changed during freeze: ' + file.path);
    }
    if (!isSame(inventory(root), sourceFiles)) throw new Error('Source changed during freeze');
    fs.writeFileSync(path.join(common, 'source-inputs.json'), JSON.stringify({
      revision, sha256: state.sourceSha256, files: sourceFiles,
    }, null, 2) + '\n');
    const bundle = path.join(common, 'runtime');
    fs.cpSync(options.runtimeBundle, bundle, { recursive: true, errorOnExist: true, force: false });
    if (!isSame(await inspect(bundle), report)) throw new Error('Runtime changed during freeze');
    const runtimeID = inspectImage(options.runtimeImage), toolsID = inspectImage(options.toolsImage);
    if (options.lock && runtimeID !== options.lock.runtimeImageID)
      throw new Error('Actual runtime image differs from locked identity');
    state.nativeRuntime = { imageID: runtimeID, sourceRevision: runtime.revision,
      manifestSha256: hash(fs.readFileSync(path.join(bundle, 'manifest.json'))) };
    state.imageToolsID = toolsID;
    const mounts = ['-v', source + ':/workspace:ro', '-v', bundle + ':/runtime:ro'];
    const tool = (extra, command) => podman(['run', '--rm', '--pull=never', '--network=none',
      ...mounts, ...extra, '--entrypoint', 'python3', toolsID, '-I', '-B', ...command]);
    let configDirectory = path.join(common, 'config-none');
    fs.mkdirSync(configDirectory);
    if (options.resolvedPlan) {
      const plan = options.resolvedPlan;
      configDirectory = path.join(common, 'configuration');
      fs.cpSync(options.lockDirectory, configDirectory, { recursive: true, force: false, errorOnExist: true });
      if (objectHash(JSON.parse(fs.readFileSync(path.join(configDirectory, 'packages.lock.json'), 'utf8'))) !==
          objectHash(options.lock)) throw new Error('APT lock changed during freeze');
      verifyLockFiles(configDirectory, options.lock);
      fs.writeFileSync(path.join(configDirectory, 'resolved-plan.json'), JSON.stringify(plan, null, 2) + '\n');
      state.configuration = configIdentity(plan);
      save();
    }
    const kernelNone = path.join(common, 'kernel-none');
    fs.mkdirSync(kernelNone);
    let kernelDirectory = kernelNone;
    if (options.basicKernelPack) {
      const retained = path.join(common, 'basic-kernel');
      fs.mkdirSync(retained);
      for (const name of ['kernel-pack.json', 'kernel.config', 'kernel-image.deb']) {
        const input = path.join(options.basicKernelPack, name);
        if (!fs.lstatSync(input).isFile()) throw new Error('Basic kernel pack requires regular files');
        fs.copyFileSync(input, path.join(retained, name), fs.constants.COPYFILE_EXCL);
      }
      kernelDirectory = retained;
      state.basicKernelInput = JSON.parse(tool(['-v', retained + ':/kernel-pack:ro'],
        ['/workspace/desktop/release/debian/basic-kernel.py', 'verify', '/kernel-pack']));
      const sourceInputsFile = path.join(common, 'source-inputs.json');
      const sourceInputs = JSON.parse(fs.readFileSync(sourceInputsFile, 'utf8'));
      fs.writeFileSync(sourceInputsFile, JSON.stringify({ ...sourceInputs, kernelInput: state.basicKernelInput }, null, 2) + '\n');
      save();
    }
    if (options.resolvedPlan) {
      podman(['run', '--rm', '--pull=never', '--network=none', '--user', '0', ...mounts,
        '-v', configDirectory + ':/configuration:ro',
        ...(options.basicKernelPack ? ['-v', kernelDirectory + ':/kernel-pack:ro'] : []),
        '--entrypoint', 'python3', runtimeID, '-I', '-B',
        '/workspace/desktop/release/debian/live-config.py', 'preflight', '/configuration']);
    }
    tool([], ['/workspace/desktop/tests/package-modes.py', '/runtime']);
    podman(['run', '--rm', '--pull=never', '--network=none', ...mounts, '--entrypoint', 'python3',
      runtimeID, '-I', '-B', '/workspace/desktop/release/debian/live-profile.py', 'clean-runtime']);
    const assertFrozen = () => {
      if (!isSame(inventory(source), sourceFiles) ||
          state.nativeRuntime.manifestSha256 !== hash(fs.readFileSync(path.join(bundle, 'manifest.json'))))
        throw new Error('Shared frozen SKU inputs changed');
      if (state.basicKernelInput &&
          (hash(fs.readFileSync(path.join(kernelDirectory, 'kernel-pack.json'))) !== state.basicKernelInput.packManifestSha256 ||
           hash(fs.readFileSync(path.join(kernelDirectory, 'kernel.config'))) !== state.basicKernelInput.configSha256 ||
           hash(fs.readFileSync(path.join(kernelDirectory, 'kernel-image.deb'))) !== state.basicKernelInput.package.sha256))
        throw new Error('Shared dedicated basic kernel inputs changed');
      if (options.resolvedPlan) {
        verifyLockFiles(configDirectory, options.lock);
        if (objectHash(JSON.parse(fs.readFileSync(path.join(configDirectory, 'resolved-plan.json'), 'utf8'))) !==
            objectHash(options.resolvedPlan) ||
            objectHash(JSON.parse(fs.readFileSync(path.join(configDirectory, 'packages.lock.json'), 'utf8'))) !==
            objectHash(options.lock)) throw new Error('Frozen configuration inputs changed');
      }
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
        podman(['build', '--quiet', '--pull=never',
          ...(options.resolvedPlan ? ['--network=none'] : []), '--target', target,
          '--build-context', 'basic-kernel-pack=' + (sku === 'basic' ? kernelDirectory : kernelNone),
          '--build-context', 'live-configuration=' + configDirectory,
          '--build-arg', 'RUNTIME_IMAGE=' + runtimeID, '--build-arg', 'HARDWARE_SKU=' + sku,
          ...(options.resolvedPlan ? ['--build-arg', 'CONFIGURED_BUILD=1'] : []),
          '-t', tag, '-f', path.join(source, 'desktop/release/debian/Containerfile.live'), path.join(source, 'desktop')]);
        return inspectImage(tag);
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
      verify(path.join(directory, 'media'));
      if (options.resolvedPlan) {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'media/live-manifest.json'), 'utf8'));
        if (objectHash(manifest.configuration) !== objectHash(state.configuration))
          throw new Error('Actual media omitted or changed requested configuration');
      }
      const media = await inspect(path.join(directory, 'media'));
      assertFrozen();
      state.artifacts.push({ sku, hardwareProfile: hardwareProfile(sku), platformImageID: platformID,
        liveImageID: liveID, tags, media: path.join(sku, 'media'), report: media });
      save();
    }
    if (!isSame(await inspect(path.join(common, 'runtime')), report))
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
    const result = await runCLI(process.argv.slice(2));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('[build-live-skus] ' + String(error));
    process.exitCode = 1;
  }
}
