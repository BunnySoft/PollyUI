import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCLI as runLive } from './build-live-skus.mjs';
import { loadConfig, resolvePlan } from './live-config.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const products = ['mini', 'compact', 'standard'];
export const usage = `Usage: bash tools/build.sh --os PRODUCT [OUTPUT] --plan | --build [OPTIONS]
Products: mini, compact, standard (smallest to general-purpose).
  mini       Former Micro: Alpine/musl CPU desktop; no Chinese, IME or 3D.
  compact    Debian Chinese CPU desktop with basic GOP/simpledrm display, no vendor editions.
             Build blocked until its paired native/Chinese/boot recipe is integrated.
  standard   Debian desktop with the full existing general-purpose driver/firmware set.
Debian build options: --lock DIR --runtime-bundle DIR --runtime-image ID --tools-image ID
--plan is read-only and needs no output, runtime, Linux, Podman or APT lock.
Product --plan takes no build inputs; use the legacy --config --plan --lock entry for lock-aware plans.
--build requires Linux and an output directory. Debian builds retain all existing
clean-source, native/ABI, package-lock and media checks; no old ISO is renamed.
Standard currently reuses standard-effects4, including its existing 3D libraries.
General-purpose drivers do not certify all physical hardware.
Mini reuses MICRO_BUILDER, MICRO_SHELL_BUILDER, MICRO_SDK and PU_BUILD_JOBS.
Mini outputs mini.iso and mini.json; direct historical Micro scripts keep micro-shell.*.
Old --live --sku/--skus and direct prototype scripts remain compatible.
Use --os --help for this help. Micro/Thin/Full are historical names, not extra products.`;

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const [product, ...remaining] = args;
  if (!products.includes(product)) throw new Error('Expected --os mini|compact|standard.\n' + usage);
  const options = { product };
  const fields = new Map([['--lock', 'lock'],
    ['--runtime-bundle', 'runtimeBundle'], ['--runtime-image', 'runtimeImage'], ['--tools-image', 'toolsImage']]);
  const seen = new Set();
  for (let index = 0; index < remaining.length; index++) {
    const name = remaining[index];
    if (!name.startsWith('--')) {
      if (options.output) throw new Error('Only one output directory is allowed');
      options.output = path.resolve(name);
      continue;
    }
    if (seen.has(name)) throw new Error('Duplicate option: ' + name);
    seen.add(name);
    if (name === '--plan' || name === '--build') { options[name.slice(2)] = true; continue; }
    const value = remaining[++index];
    if (!fields.has(name) || !value || value.startsWith('--')) throw new Error('Unknown or incomplete option: ' + name);
    options[fields.get(name)] = value;
  }
  if (Boolean(options.plan) === Boolean(options.build)) throw new Error('Choose exactly one of --plan or --build');
  if (options.build && !options.output) throw new Error('--build requires an output directory');
  if (options.plan && [...fields.values()].some(name => options[name]))
    throw new Error('Product --plan does not consume build inputs; use --config --plan --lock for lock-aware plans');
  if (product === 'mini' || product === 'compact') {
    if ([...fields.values()].some(name => options[name]))
      throw new Error('Mini/Compact do not consume the frozen standard Debian build inputs');
  }
  return options;
}

export async function runCLI(args, backend = {}) {
  const options = parseArguments(args);
  if (options.help) return usage;
  const { product } = options;
  const plan = { schemaVersion: 1, kind: 'polly-os-build-plan', product,
    output: options.output ?? null, status: 'prerequisites-required', blockers: [],
    limits: ['Build configuration is not a boot result, hardware qualification or measured image size.'] };
  let configPath;
  if (product === 'mini') {
    plan.entry = 'desktop/release/micro/build-shell.sh';
    plan.target = { distribution: 'alpine3.24', architecture: 'x86_64', libc: 'musl' };
    plan.capabilities = { chinese: false, ime: false, webgl2: false, webgpu: false, canvas2d: 'cpu' };
    plan.requirements = ['Existing paired Debian SDK sources and an Alpine builder; Linux and Podman.',
      'The Mini entry rebuilds native Alpine inputs and ISO; it does not perform QEMU or physical validation.'];
    plan.artifacts = ['mini.iso', 'mini.json'];
  } else if (product === 'compact') {
    plan.target = { distribution: 'debian13', architecture: 'x86_64', libc: 'glibc' };
    plan.status = 'blocked';
    plan.display = 'uefi-gop-simpledrm';
    plan.blockers = ['The Compact Debian CPU Shell + Chinese fonts/IME + basic GOP/simpledrm recipe is not integrated.',
      'No paired native bundle, package closure and verified basic-display kernel input for this product.',
      'Historical thin tinywl demos and minimal-zh experiments are not a Compact delivery.'];
  } else {
    plan.configurationFile = 'desktop/release/debian/configs/standard.yaml';
    configPath = path.join(repo, plan.configurationFile);
    const configuration = await (backend.loadConfig ?? loadConfig)(configPath);
    const hardware = 'full';
    if (configuration.name !== 'standard' ||
        configuration.hardware !== hardware || configuration.nativeVariant !== 'standard-effects4')
      throw new Error('Product configuration does not match its declared name, hardware and native variant');
    plan.debian = resolvePlan(configuration);
    plan.hardware = hardware;
    plan.status = plan.debian.status;
    plan.requirements = ['Frozen standard-effects4 runtime and trusted offline APT lock for this configuration.',
      'Complete paired GLES desktop effects, native local-video decoder and exact current runtime source bytes.',
      'A clean fixed source checkout; no automatic native rebuild, boot, publication or stable-alias update.'];
  }
  if (options.plan) return plan;
  if (plan.status === 'blocked') throw new Error('Compact build blocked: ' + plan.blockers.join(' '));
  if ((backend.platform ?? process.platform) !== 'linux') throw new Error('OS builds require Linux/WSL and Podman');
  if (product === 'mini') {
    const command = ['sh', path.join(repo, plan.entry)];
    const result = (backend.spawnSync ?? spawnSync)(command[0], command.slice(1),
      { cwd: repo, stdio: 'inherit', env: { ...process.env, MICRO_WORK: options.output, MICRO_PRODUCT: 'mini' } });
    if (result.error || result.status !== 0)
      throw new Error('Mini build failed (' + (result.status ?? result.signal) + ')', { cause: result.error });
    return { product, output: options.output, entry: plan.entry,
      status: 'built-not-boot-tested', iso: path.join(options.output, 'mini.iso') };
  }
  for (const name of ['lock', 'runtimeBundle', 'runtimeImage', 'toolsImage'])
    if (!options[name]) throw new Error('Debian product build requires ' + name);
  const live = await (backend.runLive ?? runLive)([options.output, '--config', configPath, '--build',
    '--lock', options.lock, '--runtime-bundle', options.runtimeBundle,
    '--runtime-image', options.runtimeImage, '--tools-image', options.toolsImage]);
  return { product, hardware: plan.hardware, configurationFile: plan.configurationFile, live };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCLI(process.argv.slice(2));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('[build-os] ' + String(error));
    process.exitCode = 1;
  }
}
