import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [command, ...args] = process.argv.slice(2);
const root = process.env.POLLY_SKU_FIXTURE_ROOT;
const stateFile = path.join(root, 'backend.json'), trace = path.join(root, 'trace.jsonl');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
let owned = false, phase = command, sku = null, status = 0;
const active = path.join(root, 'backend-active');
try {
  fs.closeSync(fs.openSync(active, 'wx'));
  owned = true;
  const state = read(stateFile);
  const value = flag => args[args.indexOf(flag) + 1];
  const mounts = new Map(args.flatMap((arg, index) =>
    arg === '-v' ? [[args[index + 1].split(':')[1], args[index + 1].split(':')[0]]] : []));
  if (command === 'git') phase = args.includes('rev-parse') ? 'git-head' : 'git-status';
  else if (args[0] === 'image') {
    const ref = args.at(-1);
    phase = ref === 'fixture-runtime' ? 'inspect-runtime' : ref === 'fixture-tools' ? 'inspect-tools' :
      ref.includes('-platform:') ? 'inspect-platform' : 'inspect-live';
  } else if (args[0] === 'build') {
    sku = args.find(arg => arg.startsWith('HARDWARE_SKU='))?.slice('HARDWARE_SKU='.length);
    phase = value('--target') === 'platform-base' ? 'build-platform' : 'build-live';
  } else if (args[0] === 'export') {
    sku = state.containers[args.at(-1)];
    phase = 'export';
  } else if (args[0] === 'rm') phase = 'rm';
  else if (args[0] === 'run') {
    if (args.includes('clean-runtime')) phase = 'clean-runtime';
    else if (args.some(arg => arg.endsWith('/basic-kernel.py'))) phase = 'kernel-pack';
    else if (args.some(arg => arg.endsWith('/package-modes.py'))) phase = 'package-modes';
    else if (args.some(arg => arg.endsWith('/debian-live-payload.sh'))) {
      phase = args.at(-2) === 'template' ? 'qualify-template' : 'qualify-live';
      sku = args.at(-1);
    } else if (args.includes('assembled')) {
      phase = 'assembled'; sku = value('--sku');
    } else if (args.some(arg => arg.endsWith('/retain-live-inputs.py'))) phase = 'retain';
    else if (args.some(arg => arg.endsWith('/build-live-image.py'))) phase = 'media';
    else if (args.some(arg => arg.endsWith('/verify-live-runtime.py'))) phase = 'verify';
    else throw new Error('Unexpected run command');
    if (mounts.has('/sku')) sku = path.basename(mounts.get('/sku'));
  } else throw new Error('Unexpected backend command');
  fs.appendFileSync(trace, JSON.stringify({ event: 'start', phase, sku, args, mounts: [...mounts] }) + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  if (state.mutated && command === 'git') throw new Error('Entry consulted dynamic source after freeze');
  if (process.env.POLLY_SKU_FIXTURE_FAIL === `${sku}:${phase}`) {
    status = 42;
    throw new Error('injected backend failure');
  }
  if (command === 'git') {
    const result = spawnSync(process.env.POLLY_SKU_FIXTURE_REAL_GIT, args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    process.stdout.write(result.stdout);
  } else if (args[0] === 'image') {
    const ref = args.at(-1);
    if (ref === 'fixture-runtime' || ref === 'fixture-tools') {
      const key = ref === 'fixture-runtime' ? 'runtimeLookups' : 'toolsLookups';
      state[key]++;
      if (state[key] !== 1) throw new Error('Mutable common image reference was resolved again');
      process.stdout.write(ref === 'fixture-runtime' ? state.runtimeID : state.toolsID);
      if (!state.mutated) {
        fs.writeFileSync(path.join(state.source, 'gui/probe.mjs'), 'DYNAMIC SOURCE CHANGED AFTER FREEZE\n');
        fs.appendFileSync(path.join(state.source, 'desktop/release/debian/Containerfile.live'), '\n# changed after freeze\n');
        state.mutated = true;
      }
    } else {
      if (!state.tags[ref]) throw new Error('Unbuilt SKU tag');
      process.stdout.write(state.tags[ref]);
    }
  } else if (args[0] === 'build') {
    if (!['platform-base', 'live-base'].includes(value('--target'))) throw new Error('Entry rebuilt tools/native');
    if (!args.includes('RUNTIME_IMAGE=' + state.runtimeID)) throw new Error('Build used a mutable runtime');
    if (value('--build-context') !== 'basic-kernel-pack=' + path.join(state.output, 'common',
      sku === 'basic' ? 'basic-kernel' : 'kernel-none'))
      throw new Error('Build did not isolate basic kernel input from stock profiles');
    const recipe = value('-f');
    if (!recipe.startsWith(state.output + '/common/source/') ||
        fs.readFileSync(recipe, 'utf8').includes('changed after freeze'))
      throw new Error('Build used dynamic source recipe');
    state.tags[value('-t')] = sha(value('-t'));
  } else if (args[0] === 'export') {
    fs.writeFileSync(value('--output'), 'external export boundary fixture, not a real root tar');
  } else if (args[0] === 'rm') {
    delete state.containers[args.at(-1)];
  } else {
    const source = mounts.get('/workspace'), bundle = mounts.get('/runtime');
    if (source !== path.join(state.output, 'common/source') || bundle !== path.join(state.output, 'common/runtime') ||
        fs.readFileSync(path.join(source, 'gui/probe.mjs'), 'utf8') !== 'FROZEN SOURCE\n')
      throw new Error('Run did not use shared frozen inputs');
    const entry = args.indexOf('--entrypoint');
    const id = args[entry + 2];
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Run used a mutable image reference');
    if (['package-modes', 'retain', 'media', 'verify'].includes(phase) && id !== state.toolsID)
      throw new Error('Tool image identity changed');
    if (phase === 'clean-runtime' && id !== state.runtimeID) throw new Error('Runtime identity changed');
    if (phase === 'clean-runtime' && process.env.POLLY_SKU_FIXTURE_TAMPER) {
      const file = { source: path.join(source, 'gui/probe.mjs'), runtime: path.join(bundle, 'manifest.json'),
        kernel: path.join(state.output, 'common/basic-kernel/kernel-image.deb') }[process.env.POLLY_SKU_FIXTURE_TAMPER];
      fs.appendFileSync(file, '\nchanged frozen input\n');
    }
    if (phase === 'kernel-pack') {
      const result = spawnSync('python3', ['-I', '-B', path.join(source, 'desktop/release/debian/basic-kernel.py'),
        'verify', mounts.get('/kernel-pack')], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      state.kernelInput = JSON.parse(result.stdout);
      fs.appendFileSync(path.join(state.kernelExternal, 'kernel-image.deb'), 'changed external source pack after freeze');
      process.stdout.write(result.stdout);
    }
    if (phase === 'assembled') state.containers[value('--name')] = sku;
    if (phase === 'retain') fs.mkdirSync(path.join(mounts.get('/sku'), 'inputs/frozen-overlays'));
    if (phase === 'media') {
      const profileTools = await import(pathToFileURL(path.join(source, 'desktop/tools/live-profiles.mjs')));
      const profile = profileTools.hardwareProfile(sku);
      const nativeManifest = fs.readFileSync(path.join(bundle, 'manifest.json'));
      const native = { imageID: state.runtimeID, sourceRevision: JSON.parse(nativeManifest).revision,
        manifestSha256: sha(nativeManifest) };
      const directory = path.join(mounts.get('/sku'), 'media');
      fs.mkdirSync(directory);
      const prefix = `pollydesktop-0.1.0-alpha.8-debian13-${sku}-x86_64-`;
      const artifact = suffix => {
        const name = prefix + suffix, bytes = Buffer.from('synthetic orchestration fixture: ' + name);
        fs.writeFileSync(path.join(directory, name), bytes);
        return { name, size: bytes.length, sha256: sha(bytes) };
      };
      const iso = artifact('uefi-live.iso'), usb = artifact('uefi-usb.img'), config = 'synthetic config\n';
      fs.writeFileSync(path.join(directory, 'grub.cfg'), config);
      const packages = [...profile.requiredPackages,
        ...(sku === 'basic' ? [state.kernelInput.package.name + '=' + state.kernelInput.package.version] : [])].map(spec => {
        const [name, version = '1.0'] = spec.split('=');
        return { name, version, architecture: 'amd64', installedSizeBytes: 1024, regularFileBytes: 10 };
      });
      const layout = { kind: 'squashfs-ram-overlay', path: 'boot/root.squashfs', size: 100, sha256: 'd'.repeat(64),
        copyToRam: true, writable: 'tmpfs-overlay', mediaIdentity: 'e'.repeat(32),
        hardwareProfile: { sku, manifestSha256: profile.manifestSha256 },
        displayPolicy: profile.displayPolicy,
        ...(sku === 'basic' ? { kernelInput: state.kernelInput } : {}),
        bootstrap: { path: 'boot/initramfs.gz', size: 20, sha256: 'f'.repeat(64), uncompressedBytes: 40,
          graphicsModules: profile.displayPolicy.bootstrapModules } };
      write(path.join(directory, 'live-manifest.json'), {
        schemaVersion: 2, stage: 'development-live-image', version: '0.1.0-alpha.8',
        architecture: 'x86_64', distribution: 'debian13', sku, hardwareProfile: profile,
        ...(sku === 'basic' ? { kernelInput: state.kernelInput } : {}),
        sourceRevision: value('--source-revision'), sourceDirty: false, runtimeImage: state.runtimeID,
        nativeRuntime: native, imageToolsID: state.toolsID, root: layout,
        grub: { templateSha256: 'a'.repeat(64), embeddedSha256: sha(config),
          kernelArguments: profile.displayPolicy.kernelArguments },
        iso, usb, files: 5, uncompressedPayloadBytes: 500,
        packages: packages.map(({ name, version }) => ({ name, version })),
        sizeReport: { schemaVersion: 1, sku, manifestSha256: profile.manifestSha256, packages,
          limits: ['Synthetic external boundary data for entry control flow, not package/media qualification.'],
          media: { isoBytes: iso.size, usbBytes: usb.size, rootBytes: 100, rootUncompressedBytes: 500,
            bootstrapBytes: 20, bootstrapUncompressedBytes: 40 } },
      });
    }
    if (phase === 'verify') {
      const directory = path.join(mounts.get('/sku'), 'media'), manifest = read(path.join(directory, 'live-manifest.json'));
      write(path.join(directory, 'candidate-origin.json'), {
        schemaVersion: 2, runtimeSourceRevision: manifest.nativeRuntime.sourceRevision, runtimeSourceDirty: false,
        runtimeManifestSha256: manifest.nativeRuntime.manifestSha256, mediaProducerRevision: manifest.sourceRevision,
        runtimeImageID: state.runtimeID, isoSha256: manifest.iso.sha256, isoPayloadFilesVerified: 5,
        usbSha256: manifest.usb.sha256, usbPayloadFilesVerified: 5, bootstrapVerified: true, rootLayout: manifest.root,
        ...Object.fromEntries(['sku', 'hardwareProfile', 'nativeRuntime', 'imageToolsID', 'sizeReport', 'kernelInput']
          .map(key => [key, manifest[key]])),
      });
      fs.writeFileSync(path.join(directory, 'SHA256SUMS'), fs.readdirSync(directory).sort()
        .map(name => sha(fs.readFileSync(path.join(directory, name))) + '  ' + name).join('\n') + '\n');
    }
    if (phase !== 'kernel-pack') process.stdout.write('PASS: external orchestration boundary fixture ' + phase);
  }
  write(stateFile, state);
} catch (error) {
  status ||= 1;
  process.stderr.write(String(error) + '\n');
} finally {
  if (owned) {
    fs.appendFileSync(trace, JSON.stringify({ event: 'end', phase, sku, status }) + '\n');
    fs.unlinkSync(active);
  }
}
process.exitCode = status;
