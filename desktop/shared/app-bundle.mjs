const MAX_MANIFEST_BYTES = 65536;

function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)))
    throw new TypeError('Invalid application manifest fields');
}

function utf8Length(value) {
  let length = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) throw new TypeError('Invalid Unicode in application manifest');
    length += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return length;
}
function text(value, name, maximum, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > maximum ||
      /[\u0000-\u001f\u007f]/.test(value))
    throw new TypeError('Invalid application ' + name);
  if (utf8Length(value) > maximum) throw new RangeError('Application ' + name + ' exceeds its byte limit');
  return value;
}

export function validateBundleId(value) {
  text(value, 'ID', 128);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\.[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value))
    throw new TypeError('Application ID must be a lowercase dotted identifier');
  return value;
}

export function bundleRelativePath(value) {
  text(value, 'relative path', 1024);
  if (value.startsWith('/') || /[\\:]/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..'))
    throw new TypeError('Application path must remain relative to its bundle');
  return value;
}

export function validateBundleManifest(value) {
  object(value, ['schemaVersion', 'id', 'name', 'version', 'target', 'launch', 'data'], ['icon']);
  if (value.schemaVersion !== 1) throw new TypeError('Unsupported application manifest version');
  const id = validateBundleId(value.id);
  const name = text(value.name, 'name', 256);
  if (!name.trim()) throw new TypeError('Application name cannot be blank');
  const version = text(value.version, 'version', 64);
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(version))
    throw new TypeError('Application version must use major.minor.patch with an optional prerelease');
  object(value.target, ['os', 'architecture', 'libc']);
  if (value.target.os !== 'linux' || value.target.architecture !== 'x86_64' ||
      !['glibc', 'musl'].includes(value.target.libc))
    throw new TypeError('Unsupported application target');
  object(value.launch, ['kind', 'entry'], ['arguments']);
  if (!['pollyui', 'native'].includes(value.launch.kind)) throw new TypeError('Unsupported application launch kind');
  const entry = bundleRelativePath(value.launch.entry);
  if (value.launch.kind === 'pollyui' && !/\.(mjs|js)$/.test(entry))
    throw new TypeError('PollyUI bundle entry must be a JavaScript module or script');
  const args = value.launch.arguments === undefined ? [] : value.launch.arguments;
  if (!Array.isArray(args) || args.length > 64) throw new RangeError('Application arguments must be a bounded array');
  const argv = Array.from(args, argument => text(argument, 'argument', 4096, true));
  object(value.data, ['layout', 'schema']);
  if (value.data.layout !== (value.launch.kind === 'pollyui' ? 'pollyui' : 'xdg') ||
      !Number.isSafeInteger(value.data.schema) || value.data.schema < 1 || value.data.schema > 65535)
    throw new TypeError('Invalid application data contract');
  const icon = value.icon === undefined ? undefined : bundleRelativePath(value.icon);
  if (icon && !/\.(png|jpg|jpeg)$/.test(icon)) throw new TypeError('Application icon must be a local PNG or JPEG');
  const result = { schemaVersion: 1, id, name, version,
    target: { ...value.target }, launch: { kind: value.launch.kind, entry, arguments: argv }, data: { ...value.data },
    ...(icon === undefined ? {} : { icon }) };
  text(JSON.stringify(result), 'manifest', MAX_MANIFEST_BYTES);
  Object.freeze(result.target); Object.freeze(result.launch.arguments);
  Object.freeze(result.launch); Object.freeze(result.data);
  return Object.freeze(result);
}

export function parseBundleManifest(source) {
  if (typeof source !== 'string' || source.length > MAX_MANIFEST_BYTES || utf8Length(source) > MAX_MANIFEST_BYTES)
    throw new RangeError('Application manifest must fit in 64 KiB');
  return validateBundleManifest(JSON.parse(source));
}

function absolutePath(value, name) {
  text(value, name, 4096);
  if (!value.startsWith('/') || value.includes('\\') ||
      (value !== '/' && value.split('/').slice(1).some(part => !part || part === '.' || part === '..')))
    throw new TypeError(name + ' must be a normalized absolute Linux path');
  return value;
}
function join(base, suffix) { return (base === '/' ? '' : base) + '/' + suffix; }
function overlaps(first, second) {
  return first === second || first.startsWith(second === '/' ? '/' : second + '/') ||
    second.startsWith(first === '/' ? '/' : first + '/');
}

export function bundleDataPaths(id, environment) {
  validateBundleId(id);
  const paths = {};
  for (const [name, variable, fallback] of [
    ['configDir', 'XDG_CONFIG_HOME', '.config'],
    ['dataDir', 'XDG_DATA_HOME', '.local/share'],
    ['cacheDir', 'XDG_CACHE_HOME', '.cache'],
    ['stateDir', 'XDG_STATE_HOME', '.local/state'],
  ]) {
    const configured = environment[variable];
    const base = configured === undefined || configured === '' ?
      join(absolutePath(environment.HOME, 'HOME'), fallback) : absolutePath(configured, variable);
    paths[name] = join(base, 'pollyui/' + id);
  }
  const directories = Object.values(paths);
  for (let i = 0; i < directories.length; i++)
    for (let j = i + 1; j < directories.length; j++)
      if (overlaps(directories[i], directories[j]))
        throw new Error('Application config, data, cache and state directories must be separate');
  return Object.freeze(paths);
}

export function planBundleLaunch(value, { bundleRoot, platform, environment, pollyuiExecutable }) {
  const manifest = validateBundleManifest(value);
  absolutePath(bundleRoot, 'Bundle root');
  if (!platform || ['os', 'architecture', 'libc'].some(field => platform[field] !== manifest.target[field]))
    throw new Error('Application target does not match the installed runtime');
  const paths = bundleDataPaths(manifest.id, environment);
  for (const directory of Object.values(paths)) {
    if (overlaps(directory, bundleRoot))
      throw new Error('Application data must be outside the program bundle');
  }
  const entry = join(bundleRoot, manifest.launch.entry);
  const args = manifest.launch.kind === 'pollyui' ?
    [absolutePath(pollyuiExecutable, 'PollyUI runtime'), '--app-id', manifest.id, entry, ...manifest.launch.arguments] :
    [entry, ...manifest.launch.arguments];
  const overrides = manifest.launch.kind === 'pollyui' ? {} : {
    XDG_CONFIG_HOME: paths.configDir, XDG_DATA_HOME: paths.dataDir,
    XDG_CACHE_HOME: paths.cacheDir, XDG_STATE_HOME: paths.stateDir,
  };
  return Object.freeze({ appId: manifest.id, version: manifest.version, dataSchema: manifest.data.schema,
    cwd: bundleRoot, argv: Object.freeze(args), environmentOverrides: Object.freeze(overrides), paths });
}
